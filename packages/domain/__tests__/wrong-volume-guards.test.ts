// Issue #693 (DESIGN-028 / DESIGN-038 amendments 2026-10-05) — requests pinned to another volume's or work's
// LazyLibrarian (LL) book read `landed` or queued the wrong book. Proves the title check (`llBookMismatch` /
// `llBookNamesTitle`), the three guards that use it (collection force-search, the collection wants pass, the goodreads
// push + reconcile) and the one-off repair (`repairWrongVolumeRequests`). Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  bookRequests,
  booksCollections,
  booksFormatPairs,
  booksItems,
  integrationShelfItems,
  permissionAudit,
  userIntegrations,
} from '@hnet/db';
import {
  forceSearchFindMissingCollections,
  linkIntegration,
  llBookMismatch,
  llBookNamesTitle,
  loadParkedWantRefs,
  parkCollectionWant,
  repairWrongVolumeRequests,
  runCollectionWantsSync,
  settleParkedPairingWant,
  syncBooksCollections,
  syncCollectionWants,
  syncGoodreadsIntegration,
  type CollectionWantsLibretto,
  type EnrichedShelfItem,
  type LazyLibrarianClientBundle,
} from '../src';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});
beforeEach(async () => {
  await t.db.delete(bookRequests);
  await t.db.delete(booksFormatPairs);
  await t.db.delete(integrationShelfItems);
  await t.db.delete(userIntegrations);
  await t.db.delete(booksCollections);
  await t.db.delete(booksItems);
  await t.db.delete(permissionAudit);
});

// ---------------------------------------------------------------------------
// 1. The pure checks.
// ---------------------------------------------------------------------------

describe('llBookMismatch (lenient)', () => {
  it('another WORK: "BBC Radio Drama Collection" pinned to "Terry Pratchett\'s Discworld"', () => {
    // The author's name is no evidence of the same work, so the shared "Terry Pratchett" counts for nothing.
    expect(
      llBookMismatch(
        { title: 'Terry Pratchett: The BBC Radio Drama Collection', author: null },
        { title: "Terry Pratchett's Discworld", author: 'Terry Pratchett' },
      ),
    ).toBe('work');
  });

  it('another VOLUME: "Court of Thorns and Roses bk 2" pinned to book 1', () => {
    expect(
      llBookMismatch(
        { title: 'Court of Thorns and Roses bk 2', author: 'Sarah J. Maas' },
        { title: 'A Court of Thorns and Roses', author: 'Sarah J. Maas' },
      ),
    ).toBe('volume');
  });

  it('a decorated title is still the book: "Caliban\'s War: The Expanse, Book 2" ⇄ "Caliban\'s War"', () => {
    expect(
      llBookMismatch(
        { title: "Caliban's War: The Expanse, Book 2", author: 'James S. A. Corey' },
        { title: "Caliban's War", author: 'James S. A. Corey' },
      ),
    ).toBeNull();
  });

  it('a want titled by the book\'s SUBTITLE is the book: "The Globe" ⇄ "The Science of Discworld II: The Globe"', () => {
    expect(
      llBookMismatch(
        { title: 'The Globe', author: 'Terry Pratchett' },
        { title: 'The Science of Discworld II', subtitle: 'The Globe', author: 'Terry Pratchett' },
      ),
    ).toBeNull();
  });

  it('series decoration is not the work: "The Serpent and the Wings of Night (Crowns of Nyaxia, #1)" ⇄ "Mother of Death and Dawn"', () => {
    expect(
      llBookMismatch(
        {
          title: 'The Serpent and the Wings of Night (Crowns of Nyaxia, #1)',
          author: 'Carissa Broadbent',
        },
        { title: 'Mother of Death and Dawn', author: 'Carissa Broadbent' },
      ),
    ).toBe('work');
  });

  it('no book (LL does not hold the id, or the read failed) is never a mismatch', () => {
    expect(llBookMismatch({ title: 'Anything', author: null }, undefined)).toBeNull();
  });
});

describe('llBookNamesTitle (strict)', () => {
  it('the same title is named', () => {
    expect(llBookNamesTitle('The Score', { title: 'The Score' })).toBe(true);
  });
  it('another book of the author is not named ("Twilight" vs "Breaking Dawn")', () => {
    expect(llBookNamesTitle('Twilight', { title: 'Breaking Dawn' })).toBe(false);
  });
  it('a book whose SUBTITLE alone matches is not named (strict: "The Final Empire" vs "Mistborn: The Final Empire")', () => {
    expect(
      llBookNamesTitle('The Final Empire', { title: 'Mistborn', subtitle: 'The Final Empire' }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared harness.
// ---------------------------------------------------------------------------

interface StubRow {
  title?: string;
  subtitle?: string | null;
  author?: string | null;
  ebookStatus?: string | null;
  audioStatus?: string | null;
}

/** A recording LL bundle whose snapshot is a REAL Map (`llSnapshotUsable` rejects a get-only stub), carrying title/author. */
function stubLl(rows: Record<string, StubRow>) {
  const calls: Array<{ cmd: 'addBook' | 'queueBook' | 'searchBook'; id: string; format?: string }> =
    [];
  const snapshot = new Map(
    Object.entries(rows).map(([id, r]) => [
      id,
      {
        bookId: id,
        title: r.title ?? null,
        subtitle: r.subtitle ?? null,
        author: r.author ?? null,
        ebookStatus: r.ebookStatus ?? null,
        audioStatus: r.audioStatus ?? null,
        ebookLibrary: null,
        audioLibrary: null,
        ebookFile: null,
        audioFile: null,
      },
    ]),
  );
  const bundle = {
    write: {
      addBook: async (id: string) => {
        calls.push({ cmd: 'addBook', id });
        return 'OK';
      },
      queueBook: async (id: string, format: string) => {
        calls.push({ cmd: 'queueBook', id, format });
        return 'OK';
      },
      searchBook: async (id: string, format: string) => {
        calls.push({ cmd: 'searchBook', id, format });
        return 'OK';
      },
    },
    read: { getAllBookStatuses: async () => snapshot },
  } as unknown as LazyLibrarianClientBundle;
  return { calls, bundle, snapshot };
}

async function seedCollection(externalId: string, recipeId: string): Promise<string> {
  await syncBooksCollections({
    db: t.db,
    collections: [
      {
        source: 'kavita',
        externalId,
        kind: 'collection',
        libraryId: null,
        title: `Collection ${externalId}`,
        itemCount: 0,
        ordered: false,
        createdBy: 'libretto',
        librettoRecipeId: recipeId,
        category: null,
        members: [],
        fullyRead: true,
      },
    ],
    scopedFamilies: [],
  });
  const [row] = await t.db
    .select({ id: booksCollections.id })
    .from(booksCollections)
    .where(
      and(eq(booksCollections.externalId, externalId), eq(booksCollections.kind, 'collection')),
    );
  return row!.id;
}

const wantByRef = async (collectionId: string, ref: string) =>
  (
    await t.db
      .select()
      .from(bookRequests)
      .where(
        and(eq(bookRequests.collectionId, collectionId), eq(bookRequests.collectionMemberRef, ref)),
      )
  )[0]!;

const BBC = 'Terry Pratchett: The BBC Radio Drama Collection';
const noPace = () => Promise.resolve();

// ---------------------------------------------------------------------------
// 2. Collection force-search.
// ---------------------------------------------------------------------------

describe('collection force-search — the wrong-volume guard', () => {
  it('parks a want whose LL book is another work (no LL write) and still searches the correct want', async () => {
    const colId = await seedCollection('discworld', 'recipe-dw');
    await syncCollectionWants({
      db: t.db,
      collectionId: colId,
      format: 'ebook',
      members: [
        { memberRef: 'isbn:bbc', title: BBC, author: null, llBookId: 'YVfJMgEACAAJ' },
        {
          memberRef: 'isbn:guards',
          title: 'Guards! Guards!',
          author: 'Terry Pratchett',
          llBookId: 'gbGuards',
        },
      ],
    });
    const ll = stubLl({
      // The live shape (issue #693): the BBC want sat on the Discworld series row, Skipped.
      YVfJMgEACAAJ: {
        title: "Terry Pratchett's Discworld",
        author: 'Terry Pratchett',
        ebookStatus: 'Skipped',
        audioStatus: 'Skipped',
      },
      gbGuards: {
        title: 'Guards! Guards!',
        author: 'Terry Pratchett',
        ebookStatus: 'Skipped',
        audioStatus: 'Skipped',
      },
    });

    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: {
        listRecipes: async () => ({
          recipes: [
            {
              id: 'recipe-dw',
              builder: { type: 'hardcover_series', ref: 'x' },
              variables: { acquisitionEnabled: true },
            },
          ],
          issues: [],
        }),
      } as unknown as CollectionWantsLibretto,
      ll: ll.bundle,
      pacer: noPace,
    });

    expect(report.parkedWrongVolume).toBe(1);
    expect(report.searched).toBe(1);
    // No LL write of any kind for the mismatched id; the correct want ran the confined chain.
    expect(ll.calls.some((c) => c.id === 'YVfJMgEACAAJ')).toBe(false);
    expect(ll.calls.filter((c) => c.id === 'gbGuards').map((c) => c.cmd)).toContain('searchBook');

    const bbc = await wantByRef(colId, 'isbn:bbc');
    expect(bbc.unroutableReason).toBe('wrong_volume');
    expect(bbc.llBookId).toBeNull();
    expect(bbc.lastSearchedAt).toBeNull();
    const guards = await wantByRef(colId, 'isbn:guards');
    expect(guards.unroutableReason).toBeNull();
    expect(guards.llBookId).toBe('gbGuards');
    expect(guards.lastSearchedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. The collection wants pass keeps a park parked.
// ---------------------------------------------------------------------------

describe('collection wants pass — a parked want stays parked', () => {
  const libretto = (resolveCalls: string[]): CollectionWantsLibretto =>
    ({
      listMissingMembers: async () => ({
        missing: [{ title: BBC, isbn: '9781473200001', identifiers: [] }],
      }),
      // The resolver that caused the incident: it names the Discworld series row again.
      resolve: async (req: { title?: string }) => {
        resolveCalls.push(req.title ?? '');
        return { volumeId: 'YVfJMgEACAAJ' };
      },
    }) as unknown as CollectionWantsLibretto;

  it('runCollectionWantsSync never resolves a parked member and never refills its id', async () => {
    const colId = await seedCollection('discworld-wants', 'recipe-dw-wants');
    await syncCollectionWants({
      db: t.db,
      collectionId: colId,
      format: 'ebook',
      members: [
        { memberRef: 'isbn:9781473200001', title: BBC, author: null, llBookId: 'YVfJMgEACAAJ' },
      ],
    });
    const before = await wantByRef(colId, 'isbn:9781473200001');
    expect(
      await parkCollectionWant({ db: t.db, requestId: before.id, llBookId: 'YVfJMgEACAAJ' }),
    ).toBe(true);
    // The guard in the writer: a second park of the same (now cleared) id is a no-op.
    expect(
      await parkCollectionWant({ db: t.db, requestId: before.id, llBookId: 'YVfJMgEACAAJ' }),
    ).toBe(false);
    expect([...(await loadParkedWantRefs(t.db, colId))]).toEqual(['isbn:9781473200001']);

    const resolveCalls: string[] = [];
    const report = await runCollectionWantsSync({ db: t.db, libretto: libretto(resolveCalls) });

    expect(resolveCalls).toEqual([]);
    expect(report.parked).toBe(1);
    expect(report.resolved).toBe(0);
    const after = await wantByRef(colId, 'isbn:9781473200001');
    expect(after.llBookId).toBeNull();
    expect(after.unroutableReason).toBe('wrong_volume');
  });

  it("syncCollectionWants itself keeps a parked want's empty id even when the member arrives resolved", async () => {
    const colId = await seedCollection('discworld-sync', 'recipe-dw-sync');
    await syncCollectionWants({
      db: t.db,
      collectionId: colId,
      format: 'ebook',
      members: [{ memberRef: 'isbn:bbc', title: BBC, author: null, llBookId: 'YVfJMgEACAAJ' }],
    });
    const want = await wantByRef(colId, 'isbn:bbc');
    await parkCollectionWant({ db: t.db, requestId: want.id, llBookId: 'YVfJMgEACAAJ' });

    await syncCollectionWants({
      db: t.db,
      collectionId: colId,
      format: 'ebook',
      members: [{ memberRef: 'isbn:bbc', title: BBC, author: null, llBookId: 'YVfJMgEACAAJ' }],
    });
    const after = await wantByRef(colId, 'isbn:bbc');
    expect(after).toMatchObject({ llBookId: null, unroutableReason: 'wrong_volume' });
  });
});

// ---------------------------------------------------------------------------
// 4. goodreads-sync push + reconcile.
// ---------------------------------------------------------------------------

describe('goodreads-sync — the wrong-work guard', () => {
  const SERPENT = 'The Serpent and the Wings of Night (Crowns of Nyaxia, #1)';
  const items: EnrichedShelfItem[] = [
    {
      shelf: 'to-read',
      externalBookId: 'gr-serpent',
      title: SERPENT,
      author: 'Carissa Broadbent',
      isbn: null,
      gbVolumeId: 'gbMother',
      coverUrl: null,
      shelvedAt: new Date(),
      isComic: false,
    },
  ];

  async function seed() {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '202652880',
      profileRef: '202652880',
      actorId: user.id,
    });
    return integration;
  }
  const run = (integrationId: string, ll: ReturnType<typeof stubLl>) =>
    syncGoodreadsIntegration({
      db: t.db,
      integrationId,
      items,
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: async () => {},
    });
  const theWant = async () => (await t.db.select().from(bookRequests))[0]!;

  // The want's gb id resolved to "Mother of Death and Dawn" (another Broadbent work): both formats Open there.
  const mother = {
    title: 'Mother of Death and Dawn',
    author: 'Carissa Broadbent',
    ebookStatus: 'Open',
    audioStatus: 'Open',
  };

  it('a never-pushed (`requested`) want is NOT pushed to the wrong book, and is not landed from it', async () => {
    const integration = await seed();
    const ll = stubLl({ gbMother: mother });

    const report = await run(integration.id, ll);

    expect(report.requestsMinted).toBe(1);
    expect(report.requestsPushed).toBe(0);
    expect(ll.calls).toEqual([]);
    expect(await theWant()).toMatchObject({
      llBookId: 'gbMother',
      ebookStatus: 'requested',
      audioStatus: 'requested',
    });
  });

  it('an in-flight want is NOT reconciled to landed from the wrong book (both Open), nor queued again', async () => {
    const integration = await seed();
    const ll = stubLl({ gbMother: mother });
    await run(integration.id, ll); // mints the want
    await t.db.update(bookRequests).set({ ebookStatus: 'wanted', audioStatus: 'wanted' });

    await run(integration.id, ll);

    expect(await theWant()).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'wanted' });
    expect(ll.calls).toEqual([]);
  });

  it('the Skipped sweep does not re-queue or re-search the wrong book either', async () => {
    const integration = await seed();
    const ll = stubLl({ gbMother: { ...mother, ebookStatus: 'Skipped', audioStatus: 'Skipped' } });
    await run(integration.id, ll);
    await t.db.update(bookRequests).set({ ebookStatus: 'wanted', audioStatus: 'wanted' });

    await run(integration.id, ll);

    expect(ll.calls).toEqual([]);
    expect(await theWant()).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'wanted' });
  });

  it('control: the same want on its OWN book is still pushed (the guard only fires on a mismatch)', async () => {
    const integration = await seed();
    const ll = stubLl({
      gbMother: {
        title: 'The Serpent and the Wings of Night',
        author: 'Carissa Broadbent',
        ebookStatus: null,
        audioStatus: null,
      },
    });

    const report = await run(integration.id, ll);

    expect(report.requestsPushed).toBe(1);
    expect(ll.calls.some((c) => c.cmd === 'queueBook' && c.id === 'gbMother')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The repair.
// ---------------------------------------------------------------------------

describe('repairWrongVolumeRequests', () => {
  async function seedWorld() {
    const colId = await seedCollection('repair-col', 'recipe-repair');
    await syncCollectionWants({
      db: t.db,
      collectionId: colId,
      format: 'ebook',
      members: [
        // Another work: parked by the repair.
        { memberRef: 'isbn:bbc', title: BBC, author: null, llBookId: 'YVfJMgEACAAJ' },
        // Another work too, but its id is on the skip list (a record another repair owns): left alone.
        {
          memberRef: 'isbn:skipped',
          title: "The Wise Man's Fear",
          author: 'Patrick Rothfuss',
          llBookId: 'ik6xzgEACAAJ',
        },
      ],
    });

    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '202652880',
      profileRef: '202652880',
      actorId: user.id,
    });
    const [shelf] = await t.db
      .insert(integrationShelfItems)
      .values({
        integrationId: integration.id,
        shelf: 'to-read',
        externalBookId: 'gr-serpent',
        title: 'The Serpent and the Wings of Night (Crowns of Nyaxia, #1)',
        author: 'Carissa Broadbent',
        gbVolumeId: 'gbSerpent',
      })
      .returning();
    const [gr] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'goodreads',
        integrationId: integration.id,
        shelfItemId: shelf!.id,
        title: shelf!.title,
        author: shelf!.author,
        llBookId: 'gbMother',
        ebookStatus: 'landed',
        audioStatus: 'wanted',
      })
      .returning();

    // A pairing want whose anchor LEFT the library, still holding another book's id.
    const [anchor] = await t.db
      .insert(booksItems)
      .values({
        source: 'kavita',
        mediaKind: 'book',
        externalId: 'removed-mistborn',
        libraryId: '1',
        libraryName: 'EBooks',
        title: 'Mistborn: The Final Empire',
        sortTitle: 'mistborn the final empire',
        author: 'Brandon Sanderson',
        deepLinkUrl: 'http://x',
        deletedAt: new Date('2026-10-01T00:00:00Z'),
        attrs: {},
      })
      .returning();
    const [pairing] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: anchor!.id,
        title: 'The Well of Ascension',
        author: 'Brandon Sanderson',
        ebookStatus: 'landed',
        audioStatus: 'requested',
        llBookId: 't_ZYYXZq4RgC',
      })
      .returning();

    const ll = stubLl({
      YVfJMgEACAAJ: {
        title: "Terry Pratchett's Discworld",
        author: 'Terry Pratchett',
        ebookStatus: 'Skipped',
        audioStatus: 'Skipped',
      },
      ik6xzgEACAAJ: {
        title: 'The Name of the Wind',
        author: 'Patrick Rothfuss',
        ebookStatus: 'Skipped',
        audioStatus: 'Skipped',
      },
      gbMother: {
        title: 'Mother of Death and Dawn',
        author: 'Carissa Broadbent',
        ebookStatus: 'Open',
        audioStatus: 'Open',
      },
      t_ZYYXZq4RgC: {
        title: 'Mistborn',
        subtitle: 'The Final Empire',
        author: 'Brandon Sanderson',
        ebookStatus: 'Open',
        audioStatus: 'Skipped',
      },
    });
    const input = {
      db: t.db,
      snapshot: ll.snapshot,
      skipLlBookIds: new Set(['ik6xzgEACAAJ']),
      removedAnchorWants: [{ requestId: pairing!.id, llBookId: 't_ZYYXZq4RgC' }],
    };
    return { colId, gr: gr!, pairing: pairing!, input };
  }

  const snapshotOfRows = async () =>
    (await t.db.select().from(bookRequests))
      .map((r) => ({
        id: r.id,
        llBookId: r.llBookId,
        unroutableReason: r.unroutableReason,
        ebookStatus: r.ebookStatus,
        audioStatus: r.audioStatus,
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

  it('dry run lists the rows and changes nothing', async () => {
    const { input } = await seedWorld();
    const before = await snapshotOfRows();

    const report = await repairWrongVolumeRequests({ ...input, dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.rows.map((r) => `${r.origin}:${r.action}`).sort()).toEqual([
      'collection:park',
      'goodreads:repoint',
      'pairing:settle',
    ]);
    expect(report.rows.every((r) => !r.applied)).toBe(true);
    // The skipped id is never listed.
    expect(report.rows.some((r) => r.llBookId === 'ik6xzgEACAAJ')).toBe(false);
    expect(await snapshotOfRows()).toEqual(before);
  });

  it('apply parks, re-points, settles — and leaves the skipped row alone; a second apply changes nothing', async () => {
    const { colId, gr, pairing, input } = await seedWorld();

    const report = await repairWrongVolumeRequests({ ...input, dryRun: false });
    expect(report.rows).toHaveLength(3);
    expect(report.rows.every((r) => r.applied)).toBe(true);

    // Collection: parked, id cleared.
    expect(await wantByRef(colId, 'isbn:bbc')).toMatchObject({
      unroutableReason: 'wrong_volume',
      llBookId: null,
    });
    // The skipped id's want: untouched.
    expect(await wantByRef(colId, 'isbn:skipped')).toMatchObject({
      unroutableReason: null,
      llBookId: 'ik6xzgEACAAJ',
    });
    // Goodreads: re-pointed to the shelf's volume, both formats re-opened.
    const [grAfter] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, gr.id));
    expect(grAfter).toMatchObject({
      llBookId: 'gbSerpent',
      ebookStatus: 'requested',
      audioStatus: 'requested',
    });
    // Removed-anchor pairing want: id cleared, the missing format (audio, for a book anchor) settled; held format kept.
    const [pairAfter] = await t.db
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.id, pairing.id));
    expect(pairAfter).toMatchObject({
      llBookId: null,
      audioStatus: 'missing',
      ebookStatus: 'landed',
    });

    const after = await snapshotOfRows();
    const again = await repairWrongVolumeRequests({ ...input, dryRun: false });
    expect(again.rows.filter((r) => r.applied)).toEqual([]);
    expect(await snapshotOfRows()).toEqual(after);
  });
});

// ---------------------------------------------------------------------------
// The hand parks: wants another repair parked with a direct write, conformed through the writer.
// ---------------------------------------------------------------------------

describe('settleParkedPairingWant (wants parked by hand)', () => {
  async function seedAnchor(opts: {
    externalId: string;
    mediaKind: 'book' | 'audiobook';
    removed: boolean;
  }) {
    const [anchor] = await t.db
      .insert(booksItems)
      .values({
        source: opts.mediaKind === 'book' ? 'kavita' : 'audiobookshelf',
        mediaKind: opts.mediaKind,
        externalId: opts.externalId,
        libraryId: '1',
        libraryName: 'Lib',
        title: 'Chroniken der Unterwelt (4-6)',
        sortTitle: 'chroniken der unterwelt (4-6)',
        author: 'Cassandra Clare',
        deepLinkUrl: 'http://x',
        deletedAt: opts.removed ? new Date('2026-10-05T15:22:00Z') : null,
        attrs: {},
      })
      .returning();
    return anchor!.id;
  }
  async function seedWant(anchorId: string, values: Partial<typeof bookRequests.$inferInsert>) {
    const [want] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: anchorId,
        title: 'Chroniken der Unterwelt (4-6)',
        author: 'Cassandra Clare',
        ebookStatus: 'landed',
        audioStatus: 'landed',
        ...values,
      })
      .returning();
    return want!.id;
  }

  it('settles the missing format a hand park left claiming the German omnibus, and is idempotent', async () => {
    // c0afcc7e's shape: an audiobook anchor that left the library, eBook still `wanted` from the omnibus.
    const removed = await seedAnchor({
      externalId: 'abs-de',
      mediaKind: 'audiobook',
      removed: true,
    });
    const c0 = await seedWant(removed, {
      ebookStatus: 'wanted',
      unroutableReason: 'wrong_volume',
      llBookId: null,
    });
    // 525913ff's shape: a live, unpaired audiobook anchor whose eBook reads `landed` from the omnibus.
    const live = await seedAnchor({
      externalId: 'abs-live',
      mediaKind: 'audiobook',
      removed: false,
    });
    const w5 = await seedWant(live, { unroutableReason: 'wrong_volume', llBookId: null });

    expect(await settleParkedPairingWant({ db: t.db, requestId: c0 })).toEqual({
      ebookStatus: 'missing',
      audioStatus: 'landed',
    });
    expect(await settleParkedPairingWant({ db: t.db, requestId: w5 })).toEqual({
      ebookStatus: 'missing',
      audioStatus: 'landed',
    });
    // A second run changes nothing.
    expect(await settleParkedPairingWant({ db: t.db, requestId: c0 })).toBeNull();
    const rows = await t.db.select().from(bookRequests);
    for (const r of rows)
      expect(r).toMatchObject({ unroutableReason: 'wrong_volume', llBookId: null });
  });

  it('lands the format a paired anchor holds, and leaves anything that is not a hand park alone', async () => {
    const audio = await seedAnchor({
      externalId: 'abs-paired',
      mediaKind: 'audiobook',
      removed: false,
    });
    const book = await seedAnchor({
      externalId: 'kavita-paired',
      mediaKind: 'book',
      removed: false,
    });
    await t.db
      .insert(booksFormatPairs)
      .values({ bookItemId: book, audioItemId: audio, matchedVia: 'title_author' });
    const paired = await seedWant(audio, {
      ebookStatus: 'wanted',
      unroutableReason: 'wrong_volume',
      llBookId: null,
    });
    expect(await settleParkedPairingWant({ db: t.db, requestId: paired })).toEqual({
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });

    // Still pointing at a book, or parked for another reason: not a hand park of this kind.
    const other = await seedAnchor({
      externalId: 'abs-other',
      mediaKind: 'audiobook',
      removed: false,
    });
    const withId = await seedWant(other, {
      unroutableReason: 'wrong_volume',
      llBookId: 'ik6xzgEACAAJ',
    });
    expect(await settleParkedPairingWant({ db: t.db, requestId: withId })).toBeNull();
    const [kept] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, withId));
    expect(kept).toMatchObject({ llBookId: 'ik6xzgEACAAJ', ebookStatus: 'landed' });
  });

  it('runs inside the repair for named rows only, never re-pointing a park', async () => {
    const removed = await seedAnchor({
      externalId: 'abs-de-2',
      mediaKind: 'audiobook',
      removed: true,
    });
    const c0 = await seedWant(removed, {
      ebookStatus: 'wanted',
      unroutableReason: 'wrong_volume',
      llBookId: null,
    });
    const snapshot = new Map([
      ['ik6xzgEACAAJ', { title: 'Chroniken der Unterwelt', author: 'Cassandra Clare' }],
    ]);
    const dry = await repairWrongVolumeRequests({
      db: t.db,
      snapshot,
      dryRun: true,
      parkedPairingWants: [c0],
    });
    // The dry run shows the change it would make, and makes none.
    expect(dry.rows).toEqual([
      expect.objectContaining({
        requestId: c0,
        action: 'settle',
        applied: false,
        detail: 'wanted/landed → missing/landed',
      }),
    ]);
    const [untouched] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, c0));
    expect(untouched!.ebookStatus).toBe('wanted');
    const applied = await repairWrongVolumeRequests({
      db: t.db,
      snapshot,
      dryRun: false,
      parkedPairingWants: [c0],
    });
    expect(applied.rows[0]).toMatchObject({
      applied: true,
      detail: 'wanted/landed → missing/landed',
    });
    const [row] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, c0));
    expect(row).toMatchObject({
      llBookId: null,
      unroutableReason: 'wrong_volume',
      ebookStatus: 'missing',
    });
  });
});
