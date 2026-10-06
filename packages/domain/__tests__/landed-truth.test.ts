// Issue #715 / DESIGN-028 amendment 2026-10-05 — a `landed` format is only true while something holds it.
// `advanceStatus` never regresses a positive, and a both-landed request was never reconciled again, so a request that
// landed through a library match (or a LazyLibrarian `Open`) kept reading `landed` after the match was removed, after
// LazyLibrarian lost the file, and after its LazyLibrarian book turned out to be another volume. Proves, on embedded
// Postgres 16 with a stub LazyLibrarian: a landed format stays landed while LazyLibrarian holds it; it leaves `landed`
// when the file is gone, when the library match is gone (the Azazel case), when the request's book is another volume,
// when LazyLibrarian no longer has the book, and when there is no book at all; a library match is never reverted; the
// pairing reconcile does the same for an unpaired anchor and leaves a paired one alone; a landed comic follows Kapowarr.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  bookRequests,
  booksCollections,
  booksFormatPairs,
  booksItems,
  gbCallBudget,
  gbQuotaState,
  integrationShelfItems,
  permissionAudit,
  userIntegrations,
} from '@hnet/db';
import {
  linkIntegration,
  revertLandedFormats,
  runFormatPairing,
  syncGoodreadsIntegration,
  unheldFormatStatus,
  type EnrichedShelfItem,
  type LazyLibrarianClientBundle,
  type LlSnapshotRow,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);
const noPace = async () => {};

type Row = Partial<LlSnapshotRow>;

/** A stub LazyLibrarian whose snapshot is a real Map (a filler row keeps it non-empty). Records every write. */
function stubLl(rows: Record<string, Row> = {}) {
  const calls: Array<{ cmd: string; id: string; format?: string }> = [];
  const snapshot = (): Map<string, LlSnapshotRow> => {
    const map = new Map<string, LlSnapshotRow>([
      [
        'filler-1',
        {
          title: 'Something Else Entirely',
          author: 'Nobody Here',
          ebookStatus: 'Open',
          audioStatus: 'Skipped',
        },
      ],
    ]);
    for (const [id, r] of Object.entries(rows)) map.set(id, { ...r });
    return map;
  };
  const bundle = {
    write: {
      addBook: async (id: string) => {
        calls.push({ cmd: 'addBook', id });
        return 'true';
      },
      queueBook: async (id: string, format: string) => {
        calls.push({ cmd: 'queueBook', id, format });
      },
      searchBook: async (id: string, format: string) =>
        void calls.push({ cmd: 'searchBook', id, format }),
    },
    read: { getAllBookStatuses: async () => snapshot() },
  } as unknown as LazyLibrarianClientBundle;
  return { calls, bundle };
}

// ---------------------------------------------------------------------------
// The pure answer.
// ---------------------------------------------------------------------------

describe('unheldFormatStatus', () => {
  it('is null while LazyLibrarian holds the format: a status, or a file or library date', () => {
    expect(unheldFormatStatus({ ebookStatus: 'Open' }, 'ebook')).toBeNull();
    expect(unheldFormatStatus({ audioStatus: 'Have' }, 'audiobook')).toBeNull();
    // A `Skipped` row that nevertheless carries a file is one LazyLibrarian HAS.
    expect(
      unheldFormatStatus({ ebookStatus: 'Skipped', ebookFile: '/books/a.epub' }, 'ebook'),
    ).toBeNull();
    expect(
      unheldFormatStatus({ audioStatus: 'Wanted', audioLibrary: '2026-01-01' }, 'audiobook'),
    ).toBeNull();
  });

  it('is the status LazyLibrarian shows once it does not hold the format, never landed', () => {
    expect(unheldFormatStatus({ ebookStatus: 'Wanted' }, 'ebook')).toBe('wanted');
    expect(unheldFormatStatus({ audioStatus: 'Snatched' }, 'audiobook')).toBe('grabbed');
    expect(unheldFormatStatus({ ebookStatus: 'Skipped' }, 'ebook')).toBe('missing');
    expect(unheldFormatStatus({ ebookStatus: 'Ignored' }, 'ebook')).toBe('missing');
    expect(unheldFormatStatus({ audioStatus: '' }, 'audiobook')).toBe('missing');
    expect(unheldFormatStatus({}, 'ebook')).toBe('missing');
  });

  it('decides nothing for an absent book (the gone rule owns it) or a status it cannot read', () => {
    expect(unheldFormatStatus(undefined, 'ebook')).toBeNull();
    expect(unheldFormatStatus(null, 'audiobook')).toBeNull();
    expect(unheldFormatStatus({ ebookStatus: 'Processing' }, 'ebook')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The DB-backed vertical.
// ---------------------------------------------------------------------------

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
  await t.db.delete(booksItems);
  await t.db.delete(booksCollections);
  await t.db.delete(permissionAudit);
  await t.db.delete(gbQuotaState);
  await t.db.delete(gbCallBudget);
});

let seq = 0;
async function getRequest(id: string) {
  const [row] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, id));
  return row!;
}

describe('revertLandedFormats (the single writer)', () => {
  async function seedRequest(over: Partial<typeof bookRequests.$inferInsert> = {}) {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: String(++seq),
      profileRef: String(seq),
      actorId: user.id,
    });
    const [shelf] = await t.db
      .insert(integrationShelfItems)
      .values({
        integrationId: integration.id,
        shelf: 'to-read',
        externalBookId: `gr-${seq}`,
        title: 'Some Book',
        author: 'Some One',
        shelvedAt: new Date(),
      })
      .returning({ id: integrationShelfItems.id });
    const [row] = await t.db
      .insert(bookRequests)
      .values({
        integrationId: integration.id,
        shelfItemId: shelf!.id,
        title: 'Some Book',
        author: 'Some One',
        llBookId: 'll-1',
        ebookStatus: 'landed',
        audioStatus: 'landed',
        ...over,
      })
      .returning({ id: bookRequests.id });
    return row!.id;
  }

  it('moves only a format that reads landed, and only off landed', async () => {
    const id = await seedRequest({ audioStatus: 'wanted' });
    const result = await revertLandedFormats({
      db: t.db,
      requestId: id,
      llBookId: 'll-1',
      ebook: 'missing',
      audio: 'missing',
    });
    expect(result).toEqual({ ebook: true, audio: false, comic: false, fromGrabbed: [] });
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'missing', audioStatus: 'wanted' });
    // `landed` is never a revert target.
    const again = await revertLandedFormats({
      db: t.db,
      requestId: id,
      llBookId: 'll-1',
      ebook: 'landed',
    });
    expect(again.ebook).toBe(false);
  });

  it('refuses a request the library holds, and one that points at another book now', async () => {
    const [item] = await t.db
      .insert(booksItems)
      .values({
        source: 'kavita',
        mediaKind: 'book',
        externalId: 'm-1',
        libraryId: '1',
        libraryName: 'L',
        title: 'Some Book',
        sortTitle: 'some book',
        author: 'Some One',
        deepLinkUrl: 'http://x',
      })
      .returning({ id: booksItems.id });
    const matched = await seedRequest({ matchedBooksItemId: item!.id });
    expect(
      (
        await revertLandedFormats({
          db: t.db,
          requestId: matched,
          llBookId: 'll-1',
          ebook: 'missing',
          audio: 'missing',
        })
      ).ebook,
    ).toBe(false);
    expect(await getRequest(matched)).toMatchObject({
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });

    const moved = await seedRequest({ llBookId: 'll-2' });
    expect(
      (
        await revertLandedFormats({
          db: t.db,
          requestId: moved,
          llBookId: 'll-1',
          ebook: 'missing',
        })
      ).ebook,
    ).toBe(false);
    expect((await getRequest(moved)).ebookStatus).toBe('landed');
  });
});

describe('syncGoodreadsIntegration — a landed request stays truthful (issue #715)', () => {
  const azazel: EnrichedShelfItem = {
    shelf: 'to-read',
    externalBookId: 'gr-azazel',
    title: 'Azazel',
    author: 'Isaac Asimov',
    isbn: null,
    gbVolumeId: 'PitFPgAACAAJ',
    coverUrl: null,
    shelvedAt: new Date(),
    isComic: false,
  };

  async function link() {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '1',
      profileRef: '1',
      actorId: user.id,
    });
    return integration.id;
  }

  const run = (integrationId: string, ll: LazyLibrarianClientBundle, extra: { now?: Date } = {}) =>
    syncGoodreadsIntegration({
      db: t.db,
      integrationId,
      items: [azazel],
      syncedShelves: ['to-read'],
      ll,
      pacer: noPace,
      ...extra,
    });

  /** The want landed through a library match (a Kavita series), then the match was removed from the library. */
  async function seedLandedThenUnmatched(integrationId: string, ll: LazyLibrarianClientBundle) {
    const [kavita] = await t.db
      .insert(booksItems)
      .values({
        source: 'kavita',
        mediaKind: 'book',
        externalId: 'k-1906',
        libraryId: '1',
        libraryName: 'EBooks',
        title: 'Azazel',
        sortTitle: 'azazel',
        author: 'Isaac Asimov',
        deepLinkUrl: 'http://x',
      })
      .returning({ id: booksItems.id });
    await run(integrationId, ll);
    const [matched] = await t.db
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.integrationId, integrationId));
    expect(matched).toMatchObject({
      matchedBooksItemId: kavita!.id,
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });
    await t.db
      .update(booksItems)
      .set({ deletedAt: new Date() })
      .where(eq(booksItems.id, kavita!.id));
    return matched!.id;
  }

  const azazelRow: Row = {
    title: 'Azazel',
    author: 'Isaac Asimov',
    ebookStatus: 'Skipped',
    audioStatus: 'Wanted',
    language: 'es',
  };

  it('Azazel: the library match is removed and LazyLibrarian holds neither format, so neither reads landed', async () => {
    const integrationId = await link();
    const ll = stubLl({ PitFPgAACAAJ: azazelRow });
    const id = await seedLandedThenUnmatched(integrationId, ll.bundle);
    const report = await run(integrationId, ll.bundle);
    expect(report.requestsLandedReverted).toBe(1);
    expect(await getRequest(id)).toMatchObject({
      matchedBooksItemId: null,
      ebookStatus: 'missing', // `Skipped`, and a Spanish edition is never re-queued (the F10 rule)
      audioStatus: 'wanted', // LazyLibrarian is searching it
    });
    expect(ll.calls).toEqual([]);
  });

  it('an English book LazyLibrarian has parked `Skipped` is re-queued by the sweep once it leaves landed', async () => {
    const integrationId = await link();
    const ll = stubLl({ PitFPgAACAAJ: { ...azazelRow, language: 'en' } });
    const id = await seedLandedThenUnmatched(integrationId, ll.bundle);
    const report = await run(integrationId, ll.bundle);
    expect(report).toMatchObject({ requestsLandedReverted: 1, requestsRequeued: 1 });
    expect(ll.calls.filter((c) => c.cmd === 'queueBook')).toEqual([
      { cmd: 'queueBook', id: 'PitFPgAACAAJ', format: 'ebook' },
    ]);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'wanted' });
  });

  it('stays landed while LazyLibrarian still holds the format', async () => {
    const integrationId = await link();
    const ll = stubLl({
      PitFPgAACAAJ: {
        title: 'Azazel',
        author: 'Isaac Asimov',
        ebookStatus: 'Open',
        audioStatus: 'Skipped',
        audioFile: '/audio/azazel.m4b',
        language: 'en',
      },
    });
    const id = await seedLandedThenUnmatched(integrationId, ll.bundle);
    const report = await run(integrationId, ll.bundle);
    expect(report.requestsLandedReverted).toBe(0);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'landed' });
    // And every run after that.
    expect((await run(integrationId, ll.bundle)).requestsLandedReverted).toBe(0);
    expect(ll.calls).toEqual([]);
  });

  it('reverts only the format whose file is gone when the other is still held', async () => {
    const integrationId = await link();
    const ll = stubLl({
      PitFPgAACAAJ: {
        title: 'Azazel',
        author: 'Isaac Asimov',
        ebookStatus: 'Open',
        audioStatus: 'Snatched',
        language: 'en',
      },
    });
    const id = await seedLandedThenUnmatched(integrationId, ll.bundle);
    await run(integrationId, ll.bundle);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'grabbed' });
  });

  it('reverts when the request no longer points at a matching LazyLibrarian book (another volume)', async () => {
    const integrationId = await link();
    const ll = stubLl({ PitFPgAACAAJ: { ...azazelRow, language: 'en' } });
    const id = await seedLandedThenUnmatched(integrationId, ll.bundle);
    // LazyLibrarian's row for that id now names a different work, and it holds both formats.
    const other = stubLl({
      PitFPgAACAAJ: {
        title: 'Foundation and Empire',
        author: 'Isaac Asimov',
        ebookStatus: 'Open',
        audioStatus: 'Open',
      },
    });
    const report = await run(integrationId, other.bundle);
    expect(report.requestsLandedReverted).toBe(1);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'missing', audioStatus: 'missing' });
    expect(other.calls).toEqual([]);
  });

  it('settles `missing` when LazyLibrarian no longer has the book, once past the grace (no LL write of its own)', async () => {
    const integrationId = await link();
    const ll = stubLl({ PitFPgAACAAJ: { ...azazelRow, language: 'en' } });
    const id = await seedLandedThenUnmatched(integrationId, ll.bundle);
    await t.db
      .update(bookRequests)
      .set({ llRerequestedAt: daysAgo(1) })
      .where(eq(bookRequests.id, id)); // its one re-request is spent
    const empty = stubLl({}); // only the filler row: the book is absent
    // Inside the grace nothing changes.
    expect((await run(integrationId, empty.bundle)).requestsLandedReverted).toBe(0);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'landed' });
    const later = await run(integrationId, empty.bundle, { now: new Date(Date.now() + 2 * DAY) });
    expect(later.llGoneSettled).toBe(1);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'missing', audioStatus: 'missing' });
    expect(empty.calls).toEqual([]);
  });

  it('goes back to requested when the request has no LazyLibrarian book at all', async () => {
    const integrationId = await link();
    const ll = stubLl({});
    const unresolved: EnrichedShelfItem = { ...azazel, gbVolumeId: null };
    const [kavita] = await t.db
      .insert(booksItems)
      .values({
        source: 'kavita',
        mediaKind: 'book',
        externalId: 'k-2',
        libraryId: '1',
        libraryName: 'EBooks',
        title: 'Azazel',
        sortTitle: 'azazel',
        author: 'Isaac Asimov',
        deepLinkUrl: 'http://x',
      })
      .returning({ id: booksItems.id });
    const sync = () =>
      syncGoodreadsIntegration({
        db: t.db,
        integrationId,
        items: [unresolved],
        syncedShelves: ['to-read'],
        ll: ll.bundle,
        pacer: noPace,
      });
    await sync();
    const [matched] = await t.db
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.integrationId, integrationId));
    expect(matched).toMatchObject({ ebookStatus: 'landed', llBookId: null });
    await t.db
      .update(booksItems)
      .set({ deletedAt: new Date() })
      .where(eq(booksItems.id, kavita!.id));
    await sync();
    expect(await getRequest(matched!.id)).toMatchObject({
      matchedBooksItemId: null,
      ebookStatus: 'requested',
      audioStatus: 'requested',
    });
  });

  it('never reverts a request the library still holds', async () => {
    const integrationId = await link();
    await t.db
      .insert(booksItems)
      .values({
        source: 'kavita',
        mediaKind: 'book',
        externalId: 'k-3',
        libraryId: '1',
        libraryName: 'EBooks',
        title: 'Azazel',
        sortTitle: 'azazel',
        author: 'Isaac Asimov',
        deepLinkUrl: 'http://x',
      });
    const ll = stubLl({ PitFPgAACAAJ: { ...azazelRow, language: 'en' } });
    await run(integrationId, ll.bundle);
    const report = await run(integrationId, ll.bundle);
    expect(report.requestsLandedReverted).toBe(0);
    const [row] = await t.db
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.integrationId, integrationId));
    expect(row).toMatchObject({ ebookStatus: 'landed', audioStatus: 'landed' });
    expect(ll.calls).toEqual([]);
  });
});

describe('syncGoodreadsIntegration — a landed comic follows Kapowarr (issue #715)', () => {
  it('leaves landed only when the volume no longer holds every issue', async () => {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '9',
      profileRef: '9',
      actorId: user.id,
    });
    const comic: EnrichedShelfItem = {
      shelf: 'to-read',
      externalBookId: 'gr-comic',
      title: 'Scott Pilgrim',
      author: 'Bryan Lee OMalley',
      isbn: null,
      gbVolumeId: null,
      coverUrl: null,
      shelvedAt: new Date(),
      isComic: true,
    };
    let volume = { id: 7, monitored: true, issueCount: 6, issuesDownloaded: 6 };
    const kapowarr = {
      read: {
        getRootFolders: async () => [{ id: 1 }],
        searchVolumes: async () => [],
        getVolume: async () => volume,
      },
      write: { addVolume: async () => 7 },
    } as never;
    const sync = () =>
      syncGoodreadsIntegration({
        db: t.db,
        integrationId: integration.id,
        items: [comic],
        syncedShelves: ['to-read'],
        kapowarr,
        pacer: noPace,
      });
    await sync();
    const [first] = await t.db
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.integrationId, integration.id));
    await t.db
      .update(bookRequests)
      .set({ kapowarrVolumeId: '7', comicStatus: 'landed', unroutableReason: null })
      .where(eq(bookRequests.id, first!.id));
    expect((await sync()).requestsLandedReverted).toBe(0);
    expect((await getRequest(first!.id)).comicStatus).toBe('landed');
    volume = { id: 7, monitored: true, issueCount: 6, issuesDownloaded: 4 };
    expect((await sync()).requestsLandedReverted).toBe(1);
    expect((await getRequest(first!.id)).comicStatus).toBe('grabbed');
  });
});

describe('runFormatPairing — a landed missing format stays truthful (issue #715)', () => {
  /** An ebook anchor and its pairing want, both formats `landed` (the missing audiobook landed through LazyLibrarian). */
  async function seedLandedPairingWant(
    llBookId: string,
    over: Partial<typeof bookRequests.$inferInsert> = {},
  ) {
    seq += 1;
    const title = `Landed Book ${seq}`;
    const [anchor] = await t.db
      .insert(booksItems)
      .values({
        source: 'kavita',
        mediaKind: 'book',
        externalId: `p-${seq}`,
        libraryId: '1',
        libraryName: 'EBooks',
        title,
        sortTitle: title.toLowerCase(),
        author: 'Some Author',
        deepLinkUrl: 'http://x',
        attrs: { heldBooks: [{ title, author: 'Some Author', isbn: null }] },
      })
      .returning({ id: booksItems.id });
    const [want] = await t.db
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: anchor!.id,
        title,
        author: 'Some Author',
        llBookId,
        ebookStatus: 'landed',
        audioStatus: 'landed',
        lastReconciledAt: daysAgo(1),
        createdAt: daysAgo(60),
        ...over,
      })
      .returning({ id: bookRequests.id });
    return { id: want!.id, title, anchorId: anchor!.id };
  }

  const llRow = (title: string, over: Row): Row => ({
    title,
    author: 'Some Author',
    ebookStatus: 'Open',
    audioStatus: 'Open',
    language: 'en',
    ...over,
  });

  it('stays landed while LazyLibrarian holds the audiobook', async () => {
    const { id, title } = await seedLandedPairingWant('ll-held');
    const ll = stubLl({ 'll-held': llRow(title, {}) });
    const report = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(report.requestsLandedReverted).toBe(0);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'landed' });
  });

  it('reverts the audiobook when LazyLibrarian lost the file, and the open-want reconcile then works it', async () => {
    const { id, title } = await seedLandedPairingWant('ll-lost');
    const ll = stubLl({ 'll-lost': llRow(title, { audioStatus: 'Skipped' }) });
    const report = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(report.requestsLandedReverted).toBe(1);
    expect(report.requeued).toBe(1);
    expect(ll.calls.filter((c) => c.cmd === 'queueBook')).toEqual([
      { cmd: 'queueBook', id: 'll-lost', format: 'audiobook' },
    ]);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'wanted' });
  });

  it('does not keep landed from a book that names another volume (the mint identity check clears it, #693)', async () => {
    const { id } = await seedLandedPairingWant('ll-other');
    const ll = stubLl({
      'll-other': {
        title: 'A Completely Different Work',
        author: 'Some Author',
        ebookStatus: 'Open',
        audioStatus: 'Open',
      },
    });
    await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    // The identity check runs first and clears the id; the format reads `requested` again, never `landed`.
    expect(await getRequest(id)).toMatchObject({
      ebookStatus: 'landed',
      audioStatus: 'requested',
      llBookId: null,
    });
    expect(ll.calls).toEqual([]);
  });

  it('settles `missing` when LazyLibrarian no longer has the book, past the grace', async () => {
    const { id } = await seedLandedPairingWant('ll-deleted', {
      llRerequestedAt: daysAgo(1),
      lastReconciledAt: daysAgo(3),
    });
    const ll = stubLl({});
    const report = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(report.requestsLandedReverted).toBe(1);
    expect(report.llGoneSettled).toBe(1);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'missing' });
  });

  it('leaves a paired anchor alone: the library holds the audiobook whatever LazyLibrarian says', async () => {
    const { id, title } = await seedLandedPairingWant('ll-paired');
    await t.db.insert(booksItems).values({
      source: 'audiobookshelf',
      mediaKind: 'audiobook',
      externalId: 'abs-paired',
      libraryId: '1',
      libraryName: 'Audio',
      title,
      sortTitle: title.toLowerCase(),
      author: 'Some Author',
      deepLinkUrl: 'http://x',
    });
    const ll = stubLl({ 'll-paired': llRow(title, { audioStatus: 'Skipped' }) });
    const report = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(report.paired).toBe(1);
    expect(report.requestsLandedReverted).toBe(0);
    expect(await getRequest(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'landed' });
  });

  it('leaves a want whose anchor left the library, and a parked want, alone', async () => {
    const gone = await seedLandedPairingWant('ll-history');
    await t.db
      .update(booksItems)
      .set({ deletedAt: new Date() })
      .where(eq(booksItems.id, gone.anchorId));
    const parked = await seedLandedPairingWant('ll-parked', { unroutableReason: 'wrong_volume' });
    const ll = stubLl({
      'll-history': llRow(gone.title, { audioStatus: 'Skipped' }),
      'll-parked': llRow(parked.title, { audioStatus: 'Skipped' }),
    });
    const report = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(report.requestsLandedReverted).toBe(0);
    expect((await getRequest(gone.id)).audioStatus).toBe('landed');
    expect((await getRequest(parked.id)).audioStatus).toBe('landed');
  });
});
