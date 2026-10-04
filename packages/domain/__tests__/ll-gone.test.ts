// Issue #665 / DESIGN-028 amendment 2026-10-04 — a want whose LazyLibrarian book is GONE. LazyLibrarian deletes
// books on its own (its startup `check_db` removes every author it counts as bookless, and books cascade), so a
// want pushed long ago can point at an id `getAllBooks` no longer returns. Proves: the pure decision (usable
// snapshot, grace, pushed formats, the re-key match); each unattended reconcile (format-pairing, goodreads-sync,
// the collection force-search cron) re-keys or settles such a want WITHOUT any LazyLibrarian write; an empty
// snapshot and a recent push decide nothing; the user's Search again re-adds a gone book; and every LL push site
// skips `addBook` for a book LazyLibrarian holds. Embedded PG16 + a stub LazyLibrarian.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
  decideLlGoneWant,
  forceSearchCollectionNow,
  forceSearchFindMissingCollections,
  linkIntegration,
  LlRekeyIndex,
  llRekeyTitleKey,
  llSnapshotUsable,
  runFormatPairing,
  runManualBookSearch,
  syncBooksCollections,
  syncGoodreadsIntegration,
  type CollectionWantsLibretto,
  type EnrichedShelfItem,
  type LazyLibrarianClientBundle,
  type LlSnapshotRow,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number): Date => new Date(Date.now() - n * DAY);

// ---------------------------------------------------------------------------
// A stub LazyLibrarian whose `getAllBooks` is a REAL Map (the shape the ACL returns), plus a filler row so the
// snapshot is never empty unless a test asks for it.
// ---------------------------------------------------------------------------

type Row = Omit<LlSnapshotRow, 'title' | 'author'> & { title?: string; author?: string };

function stubLl(
  rows: Record<string, Row> = {},
  opts: { empty?: boolean; failRead?: boolean } = {},
) {
  const calls: Array<{ cmd: string; id: string; format?: string }> = [];
  const snapshot = (): Map<string, LlSnapshotRow> => {
    if (opts.empty) return new Map();
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
    for (const [id, r] of Object.entries(rows)) {
      map.set(id, {
        title: r.title ?? null,
        author: r.author ?? null,
        ebookStatus: r.ebookStatus ?? null,
        audioStatus: r.audioStatus ?? null,
        ebookLibrary: r.ebookLibrary ?? null,
        audioLibrary: r.audioLibrary ?? null,
        ebookFile: r.ebookFile ?? null,
        audioFile: r.audioFile ?? null,
      });
    }
    return map;
  };
  const bundle = {
    write: {
      addBook: async (id: string) => void calls.push({ cmd: 'addBook', id }),
      queueBook: async (id: string, format: string) =>
        void calls.push({ cmd: 'queueBook', id, format }),
      searchBook: async (id: string, format: string) =>
        void calls.push({ cmd: 'searchBook', id, format }),
    },
    read: {
      getAllBookStatuses: async () => {
        if (opts.failRead) throw new Error('LL down');
        return snapshot();
      },
    },
  } as unknown as LazyLibrarianClientBundle;
  return { calls, bundle };
}

const noPace = async () => {};

// ---------------------------------------------------------------------------
// The pure decision.
// ---------------------------------------------------------------------------

describe('llSnapshotUsable', () => {
  it('only a non-empty Map can decide that a book is gone', () => {
    expect(llSnapshotUsable(new Map())).toBe(false);
    expect(llSnapshotUsable(null)).toBe(false);
    // An older test stub that only implements `get` is inert.
    expect(llSnapshotUsable({ get: () => undefined } as unknown as Map<string, unknown>)).toBe(
      false,
    );
    expect(llSnapshotUsable(new Map([['b1', {}]]))).toBe(true);
  });
});

describe('LlRekeyIndex (the re-key match)', () => {
  const snapshot = new Map<string, LlSnapshotRow>([
    ['ll-client', { title: 'The Client', author: 'John Grisham' }],
    ['ll-kane', { title: 'The Kane Chronicles', author: 'Rick Riordan' }],
    ['ll-fish-1', { title: "Gone Fishin'", author: 'Walter Mosley' }],
    ['ll-fish-2', { title: "Gone Fishin'", author: 'Walter Mosley' }],
    ['ll-hp', { title: "Harry Potter and the Sorcerer's Stone", author: 'J. K. Rowling' }],
    ['ll-dot', { title: 'Shadows of Self. A Mistborn Novel', author: 'Brandon Sanderson' }],
  ]);
  const index = new LlRekeyIndex(snapshot);

  it('finds the one row with the same title and an agreeing author', () => {
    expect(index.find('The Client', 'John Grisham')).toBe('ll-client');
    expect(index.find('Harry Potter and the Sorcerer’s Stone', 'J.K. Rowling')).toBe('ll-hp');
    // LazyLibrarian writes a title's colon as a full stop; the key absorbs both.
    expect(index.find('Shadows of Self: A Mistborn Novel', 'Brandon Sanderson')).toBe('ll-dot');
  });

  it('keeps the subtitle: a different book in the same series never matches', () => {
    expect(llRekeyTitleKey('The Kane Chronicles: Survival Guide')).not.toBe(
      llRekeyTitleKey('The Kane Chronicles'),
    );
    expect(index.find('The Kane Chronicles: Survival Guide', 'Rick Riordan')).toBeNull();
  });

  it('needs an author, an agreeing one, and exactly one row', () => {
    expect(index.find('The Client', null)).toBeNull();
    expect(index.find('The Client', 'Somebody Else')).toBeNull();
    expect(index.find("Gone Fishin'", 'Walter Mosley')).toBeNull(); // two rows: ambiguous
  });
});

describe('decideLlGoneWant', () => {
  const snapshot = new Map<string, LlSnapshotRow>([
    [
      'll-new',
      { title: 'Hyperion', author: 'Dan Simmons', ebookStatus: 'Open', audioStatus: 'Wanted' },
    ],
    [
      'll-skip',
      { title: 'Endymion', author: 'Dan Simmons', ebookStatus: 'Open', audioStatus: 'Skipped' },
    ],
  ]);
  const index = new LlRekeyIndex(snapshot);
  const want = {
    llBookId: 'gb-old',
    title: 'Some Book',
    author: 'Some Author',
    ebookStatus: 'landed' as const,
    audioStatus: 'wanted' as const,
    lastSeenAt: daysAgo(40),
  };
  const now = new Date();

  it('settles the pushed formats of a want LazyLibrarian has not shown for the grace', () => {
    expect(decideLlGoneWant({ want, snapshot, index, now })).toEqual({
      kind: 'settle',
      formats: ['audiobook'],
    });
    expect(
      decideLlGoneWant({ want: { ...want, ebookStatus: 'grabbed' }, snapshot, index, now }),
    ).toEqual({ kind: 'settle', formats: ['ebook', 'audiobook'] });
  });

  it('re-keys when LazyLibrarian holds the same book under another id and already tracks the format', () => {
    expect(
      decideLlGoneWant({
        want: { ...want, title: 'Hyperion', author: 'Dan Simmons' },
        snapshot,
        index,
        now,
      }),
    ).toEqual({ kind: 'rekey', toLlBookId: 'll-new' });
  });

  it("settles instead when that row holds the format `Skipped` (re-keying would hand it to the sweep's search)", () => {
    expect(
      decideLlGoneWant({
        want: { ...want, title: 'Endymion', author: 'Dan Simmons' },
        snapshot,
        index,
        now,
      }),
    ).toEqual({ kind: 'settle', formats: ['audiobook'] });
  });

  it('decides nothing for a present id, an empty snapshot, a recent sighting, or nothing pushed', () => {
    expect(
      decideLlGoneWant({ want: { ...want, llBookId: 'll-new' }, snapshot, index, now }).kind,
    ).toBe('not_gone');
    expect(decideLlGoneWant({ want, snapshot: new Map(), index: null, now }).kind).toBe('not_gone');
    expect(
      decideLlGoneWant({ want: { ...want, lastSeenAt: daysAgo(0.5) }, snapshot, index, now }).kind,
    ).toBe('not_gone');
    expect(
      decideLlGoneWant({ want: { ...want, lastSeenAt: null }, snapshot, index, now }).kind,
    ).toBe('not_gone');
    // `requested` was never pushed; `missing` is already settled.
    expect(
      decideLlGoneWant({ want: { ...want, audioStatus: 'requested' }, snapshot, index, now }).kind,
    ).toBe('not_gone');
    expect(
      decideLlGoneWant({ want: { ...want, audioStatus: 'missing' }, snapshot, index, now }).kind,
    ).toBe('not_gone');
  });

  it('a collection want settles from `requested` (its force-search never marks it pushed)', () => {
    expect(
      decideLlGoneWant({
        want: { ...want, ebookStatus: 'requested', audioStatus: 'landed' },
        snapshot,
        index,
        now,
        formats: ['ebook'],
        collection: true,
      }),
    ).toEqual({ kind: 'settle', formats: ['ebook'] });
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

/** An ebook anchor (a Kavita series holding one book) and its PUSHED pairing want for the audiobook. */
async function seedPairingWant(opts: {
  title: string;
  author: string;
  llBookId: string;
  ebookStatus?: 'landed' | 'grabbed' | 'wanted';
  audioStatus?: 'wanted' | 'grabbed' | 'requested' | 'missing';
  lastReconciledAt?: Date;
}): Promise<string> {
  seq += 1;
  const [anchor] = await t.db
    .insert(booksItems)
    .values({
      source: 'kavita',
      mediaKind: 'book',
      externalId: `ext-${seq}`,
      libraryId: '1',
      libraryName: 'EBooks',
      title: opts.title,
      sortTitle: opts.title.toLowerCase(),
      author: opts.author,
      deepLinkUrl: 'http://x',
      attrs: { heldBooks: [{ title: opts.title, author: opts.author, isbn: null }] },
    })
    .returning({ id: booksItems.id });
  const [want] = await t.db
    .insert(bookRequests)
    .values({
      origin: 'pairing',
      pairingBooksItemId: anchor!.id,
      title: opts.title,
      author: opts.author,
      llBookId: opts.llBookId,
      ebookStatus: opts.ebookStatus ?? 'landed',
      audioStatus: opts.audioStatus ?? 'wanted',
      lastReconciledAt: opts.lastReconciledAt ?? daysAgo(40),
      createdAt: daysAgo(60),
    })
    .returning({ id: bookRequests.id });
  return want!.id;
}

async function getWant(id: string) {
  const [row] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, id));
  return row!;
}

describe('runFormatPairing — a pushed want whose LazyLibrarian book is gone', () => {
  it('settles the missing format `missing` with no LazyLibrarian write, once', async () => {
    const id = await seedPairingWant({
      title: 'Saints',
      author: 'Orson Scott Card',
      llBookId: 'gb-gone',
    });
    const ll = stubLl();
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ llGoneSettled: 1, llGoneRekeyed: 0, reconciled: 0, requeued: 0 });
    expect(ll.calls).toEqual([]);
    const want = await getWant(id);
    expect(want).toMatchObject({
      ebookStatus: 'landed',
      audioStatus: 'missing',
      llBookId: 'gb-gone',
    });

    // Idempotent: the next run finds nothing left to settle and still writes nothing to LazyLibrarian.
    const again = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(again).toMatchObject({ llGoneSettled: 0, llGoneRekeyed: 0 });
    expect(ll.calls).toEqual([]);
  });

  it('settles a `grabbed` format too, and lands the anchor-held format a July want left stale', async () => {
    const id = await seedPairingWant({
      title: 'Pastwatch',
      author: 'Orson Scott Card',
      llBookId: 'gb-gone',
      ebookStatus: 'grabbed',
      audioStatus: 'grabbed',
    });
    const ll = stubLl();
    await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(await getWant(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'missing' });
    expect(ll.calls).toEqual([]);
  });

  // A July want whose HELD format read `grabbed` made the old format guess pick the held eBook for the Skipped
  // sweep. The anchor's media kind decides now, and the held format is set `landed` (ADR-065 C-03).
  it('sweeps the anchor-missing format, not a stale held one, and lands the held format', async () => {
    const id = await seedPairingWant({
      title: 'Grave Sight',
      author: 'Charlaine Harris',
      llBookId: 'll-gs',
      ebookStatus: 'grabbed',
      audioStatus: 'wanted',
      lastReconciledAt: new Date(),
    });
    const ll = stubLl({
      'll-gs': {
        title: 'Grave Sight',
        author: 'Charlaine Harris',
        ebookStatus: 'Skipped',
        audioStatus: 'Skipped',
      },
    });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ heldLanded: 1, requeued: 1 });
    expect(ll.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.format)).toEqual([
      'audiobook',
    ]);
    expect(await getWant(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'wanted' });
  });

  it('lands a stale held format on a want whose own format already settled (and touches nothing else)', async () => {
    const id = await seedPairingWant({
      title: 'Rework',
      author: 'Jason Fried',
      llBookId: 'gb-gone',
      ebookStatus: 'grabbed',
      audioStatus: 'missing',
    });
    const ll = stubLl();
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ heldLanded: 1, llGoneSettled: 0 });
    expect(ll.calls).toEqual([]);
    expect(await getWant(id)).toMatchObject({ ebookStatus: 'landed', audioStatus: 'missing' });
  });

  // Review finding (PR #670): a removed (soft-deleted) anchor no longer holds its format, so it is not landed.
  it('never lands the held format of a want whose anchor left the library', async () => {
    const id = await seedPairingWant({
      title: 'Rework',
      author: 'Jason Fried',
      llBookId: 'gb-gone',
      ebookStatus: 'grabbed',
      audioStatus: 'missing',
    });
    const [want] = await t.db.select().from(bookRequests).where(eq(bookRequests.id, id));
    await t.db
      .update(booksItems)
      .set({ deletedAt: new Date() })
      .where(eq(booksItems.id, want!.pairingBooksItemId!));
    const run = await runFormatPairing({ db: t.db, ll: stubLl().bundle, pacer: noPace });
    expect(run.heldLanded).toBe(0);
    expect((await getWant(id)).ebookStatus).toBe('grabbed');
  });

  it('re-keys to the row LazyLibrarian holds for the same book and reconciles from it', async () => {
    const id = await seedPairingWant({
      title: 'The Client',
      author: 'John Grisham',
      llBookId: 'gb-old',
    });
    const ll = stubLl({
      'll-new': {
        title: 'The Client',
        author: 'John Grisham',
        ebookStatus: 'Skipped',
        audioStatus: 'Open',
      },
    });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ llGoneRekeyed: 1, llGoneSettled: 0 });
    expect(ll.calls).toEqual([]);
    expect(await getWant(id)).toMatchObject({
      llBookId: 'll-new',
      ebookStatus: 'landed',
      audioStatus: 'landed',
    });
  });

  it('settles (keeping its id) when the same book sits `Skipped` under another id, and no sweep follows', async () => {
    const id = await seedPairingWant({
      title: 'The Road',
      author: 'Cormac McCarthy',
      llBookId: 'gb-old',
    });
    const rows = {
      'll-road': {
        title: 'The Road',
        author: 'Cormac McCarthy',
        ebookStatus: 'Open',
        audioStatus: 'Skipped',
      },
    };
    const ll = stubLl(rows);
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ llGoneRekeyed: 0, llGoneSettled: 1 });
    expect(await getWant(id)).toMatchObject({ llBookId: 'gb-old', audioStatus: 'missing' });
    const next = await runFormatPairing({ db: t.db, ll: stubLl(rows).bundle, pacer: noPace });
    expect(next.requeued).toBe(0);
    expect(ll.calls).toEqual([]);
  });

  it('decides nothing on an empty snapshot (an LL error answer), or inside the grace', async () => {
    const stale = await seedPairingWant({
      title: 'Saints',
      author: 'Orson Scott Card',
      llBookId: 'gb-a',
    });
    const fresh = await seedPairingWant({
      title: 'Heartfire',
      author: 'Orson Scott Card',
      llBookId: 'gb-b',
      lastReconciledAt: new Date(Date.now() - 60 * 60 * 1000),
    });
    const empty = stubLl({}, { empty: true });
    await runFormatPairing({ db: t.db, ll: empty.bundle, pacer: noPace });
    expect((await getWant(stale)).audioStatus).toBe('wanted');

    const ll = stubLl();
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run.llGoneSettled).toBe(1);
    expect((await getWant(stale)).audioStatus).toBe('missing');
    expect((await getWant(fresh)).audioStatus).toBe('wanted'); // seen an hour ago: not gone yet
  });

  it('leaves a want the mint just pushed alone, even though the pre-mint snapshot lacks it', async () => {
    seq += 1;
    await t.db.insert(booksItems).values({
      source: 'kavita',
      mediaKind: 'book',
      externalId: `ext-${seq}`,
      libraryId: '1',
      libraryName: 'EBooks',
      title: 'Hyperion',
      sortTitle: 'hyperion',
      author: 'Dan Simmons',
      deepLinkUrl: 'http://x',
      attrs: { heldBooks: [{ title: 'Hyperion', author: 'Dan Simmons', isbn: null }] },
    });
    const ll = stubLl();
    const run = await runFormatPairing({
      db: t.db,
      ll: ll.bundle,
      gb: { resolveVolume: async () => ({ volumeId: 'gb-hyp' }) },
      pacer: noPace,
    });
    expect(run).toMatchObject({ pushed: 1, llGoneSettled: 0 });
    const [want] = await t.db.select().from(bookRequests);
    expect(want!.audioStatus).toBe('wanted');
  });
});

// ---------------------------------------------------------------------------
// goodreads-sync.
// ---------------------------------------------------------------------------

describe('syncGoodreadsIntegration — a shelf want whose LazyLibrarian book is gone', () => {
  const items: EnrichedShelfItem[] = [
    {
      shelf: 'to-read',
      externalBookId: 'gr-1',
      title: 'The Changed Man',
      author: 'Orson Scott Card',
      isbn: null,
      gbVolumeId: 'gb-gone',
      coverUrl: null,
      shelvedAt: new Date(),
      isComic: false,
    },
  ];

  async function seedPushed() {
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '1',
      profileRef: '1',
      actorId: user.id,
    });
    // First sync pushes it (LL accepts the add; a later LazyLibrarian restart deletes it).
    const first = stubLl({
      'gb-gone': {
        title: 'The Changed Man',
        author: 'Orson Scott Card',
        ebookStatus: 'Wanted',
        audioStatus: 'Wanted',
      },
    });
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: first.bundle,
      pacer: noPace,
    });
    const [want] = await t.db
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.integrationId, integration.id));
    expect(want).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'wanted' });
    return { user, integration, wantId: want!.id };
  }

  it('settles both formats `missing` once the book has been gone past the grace, with no LL write', async () => {
    const { integration, wantId } = await seedPushed();
    const ll = stubLl();
    // Inside the grace: untouched.
    const early = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: noPace,
    });
    expect(early.llGoneSettled).toBe(0);
    expect((await getWant(wantId)).ebookStatus).toBe('wanted');

    const later = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: noPace,
      now: new Date(Date.now() + 2 * DAY),
    });
    expect(later).toMatchObject({ llGoneSettled: 1, requestsPushed: 0, requestsRequeued: 0 });
    expect(await getWant(wantId)).toMatchObject({
      ebookStatus: 'missing',
      audioStatus: 'missing',
      llBookId: 'gb-gone',
    });
    expect(ll.calls).toEqual([]);
  });

  it('Search again re-adds the gone book (addBook, queueBook per format, ONE search) and it reads wanted again', async () => {
    const { user, integration, wantId } = await seedPushed();
    const ll = stubLl();
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: noPace,
      now: new Date(Date.now() + 2 * DAY),
    });
    expect((await getWant(wantId)).ebookStatus).toBe('missing');

    const result = await runManualBookSearch({
      db: t.db,
      requestId: wantId,
      userId: user.id,
      actorId: user.id,
      ll: ll.bundle,
    });
    expect(result).toMatchObject({ searched: true, reseated: true });
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook', 'queueBook', 'queueBook', 'searchBook']);
    expect(await getWant(wantId)).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'wanted' });
  });

  it('Search again repoints to the row LazyLibrarian holds for the same book and queues THAT row (no addBook)', async () => {
    const { user, integration, wantId } = await seedPushed();
    const rows = {
      'll-cm': {
        title: 'The Changed Man',
        author: 'Orson Scott Card',
        ebookStatus: 'Skipped',
        audioStatus: 'Skipped',
      },
    };
    // The unattended reconcile settles it: the twin is Skipped, so it is not re-keyed there.
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: stubLl(rows).bundle,
      pacer: noPace,
      now: new Date(Date.now() + 2 * DAY),
    });
    expect(await getWant(wantId)).toMatchObject({
      llBookId: 'gb-gone',
      ebookStatus: 'missing',
      audioStatus: 'missing',
    });

    const ll = stubLl(rows);
    const result = await runManualBookSearch({
      db: t.db,
      requestId: wantId,
      userId: user.id,
      actorId: user.id,
      ll: ll.bundle,
    });
    expect(result).toMatchObject({ searched: true, rekeyedTo: 'll-cm' });
    expect(ll.calls).toEqual([
      { cmd: 'queueBook', id: 'll-cm', format: 'ebook' },
      { cmd: 'queueBook', id: 'll-cm', format: 'audiobook' },
      { cmd: 'searchBook', id: 'll-cm', format: 'ebook' },
    ]);
    expect(await getWant(wantId)).toMatchObject({
      llBookId: 'll-cm',
      ebookStatus: 'wanted',
      audioStatus: 'wanted',
    });
  });

  // Review finding (PR #669): the repoint is guarded on the id the click read; if another writer moved the want
  // meanwhile, the click must not queue or search a row the want no longer points at.
  it('Search again fires nothing when another writer repointed the want first', async () => {
    const { user, integration, wantId } = await seedPushed();
    const rows = {
      'll-cm': {
        title: 'The Changed Man',
        author: 'Orson Scott Card',
        ebookStatus: 'Skipped',
        audioStatus: 'Skipped',
      },
    };
    await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: stubLl(rows).bundle,
      pacer: noPace,
      now: new Date(Date.now() + 2 * DAY),
    });
    const ll = stubLl(rows);
    const read = ll.bundle.read.getAllBookStatuses.bind(ll.bundle.read);
    // The race: between the click's request read and its repoint, another writer moves the want.
    (ll.bundle.read as { getAllBookStatuses: () => Promise<unknown> }).getAllBookStatuses =
      async () => {
        await t.db
          .update(bookRequests)
          .set({ llBookId: 'gb-elsewhere' })
          .where(eq(bookRequests.id, wantId));
        return read();
      };
    const result = await runManualBookSearch({
      db: t.db,
      requestId: wantId,
      userId: user.id,
      actorId: user.id,
      ll: ll.bundle,
    });
    expect(result).toEqual({ searched: false, formats: [] });
    expect(ll.calls).toEqual([]);
    expect((await getWant(wantId)).llBookId).toBe('gb-elsewhere');
  });

  it('Search again never re-adds on a failed or empty read (only the search fires, as before)', async () => {
    const { user, wantId } = await seedPushed();
    for (const ll of [stubLl({}, { failRead: true }), stubLl({}, { empty: true })]) {
      const result = await runManualBookSearch({
        db: t.db,
        requestId: wantId,
        userId: user.id,
        actorId: user.id,
        ll: ll.bundle,
      });
      expect(result.reseated).toBeUndefined();
      expect(ll.calls.map((c) => c.cmd)).toEqual(['searchBook']);
    }
  });
});

// ---------------------------------------------------------------------------
// The collection force-search cron.
// ---------------------------------------------------------------------------

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

function libretto(recipeId: string): CollectionWantsLibretto {
  return {
    listRecipes: async () => ({
      recipes: [
        {
          id: recipeId,
          builder: { type: 'hardcover_series', ref: recipeId },
          variables: { acquisitionEnabled: true },
        },
      ],
      issues: [],
    }),
  } as unknown as CollectionWantsLibretto;
}

async function seedCollectionWant(
  collectionId: string,
  opts: {
    ref: string;
    title: string;
    author?: string | null;
    llBookId: string;
    lastSearchedAt: Date | null;
    ebookStatus?: 'requested' | 'missing';
  },
) {
  const [row] = await t.db
    .insert(bookRequests)
    .values({
      origin: 'collection',
      collectionId,
      collectionMemberRef: opts.ref,
      title: opts.title,
      author: opts.author ?? null,
      llBookId: opts.llBookId,
      ebookStatus: opts.ebookStatus ?? 'requested',
      audioStatus: 'landed',
      lastSearchedAt: opts.lastSearchedAt,
      lastReconciledAt: new Date(),
    })
    .returning({ id: bookRequests.id });
  return row!.id;
}

describe('forceSearchFindMissingCollections — a force-searched want whose LazyLibrarian book is gone', () => {
  it('settles it `missing` instead of re-adding it, due or not; a never-pushed want still gets its first push', async () => {
    const cid = await seedCollection('c1', 'recipe-1');
    const due = await seedCollectionWant(cid, {
      ref: 'm1',
      title: 'Troll Bridge',
      llBookId: 'gb-due',
      lastSearchedAt: daysAgo(8),
    });
    const notDue = await seedCollectionWant(cid, {
      ref: 'm2',
      title: 'Theatre of Cruelty',
      llBookId: 'gb-notdue',
      lastSearchedAt: daysAgo(2),
    });
    const fresh = await seedCollectionWant(cid, {
      ref: 'm3',
      title: 'Gray Dawn',
      llBookId: 'gb-fresh',
      lastSearchedAt: null,
    });

    const ll = stubLl();
    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: libretto('recipe-1'),
      ll: ll.bundle,
      pacer: noPace,
    });
    expect(report).toMatchObject({ llGoneSettled: 2, searched: 1 });
    expect((await getWant(due)).ebookStatus).toBe('missing');
    expect((await getWant(notDue)).ebookStatus).toBe('missing');
    // Only the never-pushed want touched LazyLibrarian: its first add, queue and search.
    expect(ll.calls).toEqual([
      { cmd: 'addBook', id: 'gb-fresh' },
      { cmd: 'queueBook', id: 'gb-fresh', format: 'ebook' },
      { cmd: 'searchBook', id: 'gb-fresh', format: 'ebook' },
    ]);
    expect((await getWant(fresh)).ebookStatus).toBe('requested');

    // A settled want stays out of every later cron run.
    const ll2 = stubLl();
    const again = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: libretto('recipe-1'),
      ll: ll2.bundle,
      pacer: noPace,
      now: new Date(Date.now() + 30 * DAY),
    });
    expect(again.llGoneSettled).toBe(1); // the fresh one, pushed 30 days earlier and still absent
    expect(ll2.calls.some((c) => c.id === 'gb-due' || c.id === 'gb-notdue')).toBe(false);
  });

  // Review finding (PR #669): the cron re-stamps `last_searched_at` every cooldown (12 h by default), so a 24 h
  // grace could never be reached and the cron would keep re-adding a lost book. The collection grace is 1 h.
  it('settles a lost book before it comes due again, at the default 12 h cooldown', async () => {
    const cid = await seedCollection('c4', 'recipe-4');
    const due = await seedCollectionWant(cid, {
      ref: 'm1',
      title: 'Troll Bridge',
      llBookId: 'gb-lost',
      lastSearchedAt: new Date(Date.now() - 12.5 * 60 * 60 * 1000),
    });
    const recent = await seedCollectionWant(cid, {
      ref: 'm2',
      title: 'Gray Dawn',
      llBookId: 'gb-recent',
      lastSearchedAt: new Date(Date.now() - 20 * 60 * 1000),
    });
    const ll = stubLl();
    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: libretto('recipe-4'),
      ll: ll.bundle,
      pacer: noPace,
      cooldownMs: 12 * 60 * 60 * 1000,
    });
    expect(report).toMatchObject({ llGoneSettled: 1, searched: 0 });
    expect((await getWant(due)).ebookStatus).toBe('missing');
    expect((await getWant(recent)).ebookStatus).toBe('requested'); // inside the grace, and not due
    expect(ll.calls).toEqual([]);
  });

  it('skips addBook for a book LazyLibrarian holds (its upsert would reset both formats to Skipped)', async () => {
    const cid = await seedCollection('c2', 'recipe-2');
    await seedCollectionWant(cid, {
      ref: 'm1',
      title: 'Chain of Gold',
      llBookId: 'll-held',
      lastSearchedAt: daysAgo(8),
    });
    const ll = stubLl({
      'll-held': { title: 'Chain of Gold', ebookStatus: 'Skipped', audioStatus: 'Open' },
    });
    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: libretto('recipe-2'),
      ll: ll.bundle,
      pacer: noPace,
    });
    expect(report).toMatchObject({ searched: 1, llGoneSettled: 0 });
    expect(ll.calls.map((c) => c.cmd)).toEqual(['queueBook', 'searchBook']);
  });

  it("a person's on-demand Force Search re-adds a settled want and returns it to `requested`", async () => {
    const cid = await seedCollection('c3', 'recipe-3');
    const id = await seedCollectionWant(cid, {
      ref: 'isbn:111',
      title: 'Troll Bridge',
      llBookId: 'gb-gone',
      lastSearchedAt: daysAgo(8),
      ebookStatus: 'missing',
    });
    const user = await createUser(t.db);
    const ll = stubLl();
    const report = await forceSearchCollectionNow({
      db: t.db,
      libretto: {
        read: {
          listMissingMembers: async () => ({ missing: [{ isbn: '111', title: 'Troll Bridge' }] }),
          resolve: async () => null,
        },
        write: { applyScope: async () => 'run-1' },
      } as unknown as Parameters<typeof forceSearchCollectionNow>[0]['libretto'],
      ll: ll.bundle,
      recipeId: 'recipe-3',
      actorId: user.id,
      pacer: noPace,
    });
    expect(report.searched).toBe(1);
    expect(ll.calls.map((c) => c.cmd)).toEqual(['addBook', 'queueBook', 'searchBook']);
    expect((await getWant(id)).ebookStatus).toBe('requested');
  });
});
