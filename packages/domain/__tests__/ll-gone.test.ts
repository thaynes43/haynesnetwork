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

/** Like LazyLibrarian: `addBook` seats the book (`Skipped/Skipped`) unless `refuseAdd`, and `queueBook` flips that
 *  format to `Wanted`, so a later read in the same test sees what the writes left behind. */
function stubLl(
  initial: Record<string, Row> = {},
  opts: { empty?: boolean; failRead?: boolean; refuseAdd?: boolean } = {},
) {
  const rows: Record<string, Row> = { ...initial };
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
      // LazyLibrarian answers `addBook&wait` with its add_bookid_to_db result: `true`, or `false` when it refused.
      addBook: async (id: string) => {
        calls.push({ cmd: 'addBook', id });
        if (opts.refuseAdd) return 'false';
        if (!rows[id]) rows[id] = { ebookStatus: 'Skipped', audioStatus: 'Skipped' };
        return 'true';
      },
      queueBook: async (id: string, format: string) => {
        calls.push({ cmd: 'queueBook', id, format });
        const row = rows[id];
        if (row)
          rows[id] = { ...row, [format === 'audiobook' ? 'audioStatus' : 'ebookStatus']: 'Wanted' };
      },
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
  /** Issue #668: set to say the want already had its one re-request (so a settle stands). */
  llRerequestedAt?: Date | null;
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
      llRerequestedAt: opts.llRerequestedAt ?? null,
      createdAt: daysAgo(60),
    })
    .returning({ id: bookRequests.id });
  return want!.id;
}

/** Mark a want as having had its one re-request (issue #668), so a test of the settle rule sees only the settle. */
async function markRerequested(id: string) {
  await t.db
    .update(bookRequests)
    .set({ llRerequestedAt: daysAgo(1) })
    .where(eq(bookRequests.id, id));
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
      llRerequestedAt: daysAgo(1), // already had its one re-request (issue #668)
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
      llRerequestedAt: daysAgo(1), // already had its one re-request (issue #668)
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
      llRerequestedAt: daysAgo(1), // already had its one re-request (issue #668)
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
      llRerequestedAt: daysAgo(1), // already had its one re-request (issue #668)
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
      llRerequestedAt: daysAgo(1), // already had its one re-request (issue #668)
    });
    const fresh = await seedPairingWant({
      title: 'Heartfire',
      author: 'Orson Scott Card',
      llBookId: 'gb-b',
      llRerequestedAt: daysAgo(1), // already had its one re-request (issue #668)
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
// Issue #668 (owner ruling 2026-10-04, "Add them all back now") — the ONE re-request of a settled want.
// addBook (only for a book LazyLibrarian lacks) + queueBook, never a searchBook: LazyLibrarian's daily backlog search
// looks for it. A held format lands instead; a want lost again stays missing.
// ---------------------------------------------------------------------------

describe('runFormatPairing — the one re-request of a settled want (issue #668)', () => {
  const settled = {
    title: 'Saints',
    author: 'Orson Scott Card',
    llBookId: 'gb-gone',
    audioStatus: 'missing' as const,
  };
  const searches = (calls: Array<{ cmd: string }>) => calls.filter((c) => c.cmd === 'searchBook');

  it('hands it back once: addBook + queueBook for its format, never a search; the next run writes nothing', async () => {
    const id = await seedPairingWant(settled);
    const ll = stubLl();
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({
      llRerequested: 1,
      llRerequestLanded: 0,
      llRerequestNotAdded: 0,
      pushed: 0,
    });
    expect(ll.calls).toEqual([
      { cmd: 'addBook', id: 'gb-gone' },
      { cmd: 'queueBook', id: 'gb-gone', format: 'audiobook' },
    ]);
    const want = await getWant(id);
    expect(want).toMatchObject({
      ebookStatus: 'landed',
      audioStatus: 'wanted',
      llBookId: 'gb-gone',
    });
    expect(want.llRerequestedAt).not.toBeNull();

    const again = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(again).toMatchObject({ llRerequested: 0, requeued: 0, pushed: 0 });
    expect(ll.calls).toHaveLength(2);
    expect(searches(ll.calls)).toEqual([]);
  });

  it('a want lost again after its re-request settles missing and is never handed back again (no loop)', async () => {
    const id = await seedPairingWant({
      ...settled,
      audioStatus: 'wanted',
      llRerequestedAt: daysAgo(3),
      lastReconciledAt: daysAgo(2),
    });
    const ll = stubLl();
    const first = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(first).toMatchObject({ llGoneSettled: 1, llRerequested: 0 });
    await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(ll.calls).toEqual([]);
    expect((await getWant(id)).audioStatus).toBe('missing');
  });

  it('lands instead when the library holds the format (the anchor is paired now): no LL write', async () => {
    const id = await seedPairingWant(settled);
    seq += 1;
    await t.db.insert(booksItems).values({
      source: 'audiobookshelf',
      mediaKind: 'audiobook',
      externalId: `ext-${seq}`,
      libraryId: '2',
      libraryName: 'AudioBooks',
      title: 'Saints',
      sortTitle: 'saints',
      author: 'Orson Scott Card',
      deepLinkUrl: 'http://x',
    });
    const ll = stubLl();
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ paired: 1, llRerequestLanded: 1, llRerequested: 0 });
    expect(ll.calls).toEqual([]);
    expect(await getWant(id)).toMatchObject({ audioStatus: 'landed', llRerequestedAt: null });
  });

  it("lands on LazyLibrarian's row for the same book when that row holds the format: repointed, no LL write", async () => {
    const id = await seedPairingWant(settled);
    const ll = stubLl({
      'll-saints': {
        title: 'Saints',
        author: 'Orson Scott Card',
        ebookStatus: 'Skipped',
        audioStatus: 'Open',
      },
    });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ llRerequestLanded: 1, llRerequested: 0 });
    expect(ll.calls).toEqual([]);
    expect(await getWant(id)).toMatchObject({ llBookId: 'll-saints', audioStatus: 'landed' });
  });

  it("queues LazyLibrarian's existing row for the same book instead of adding a second one", async () => {
    const id = await seedPairingWant(settled);
    const ll = stubLl({
      'll-saints': {
        title: 'Saints',
        author: 'Orson Scott Card',
        ebookStatus: 'Open',
        audioStatus: 'Skipped',
      },
    });
    await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(ll.calls).toEqual([{ cmd: 'queueBook', id: 'll-saints', format: 'audiobook' }]);
    expect(await getWant(id)).toMatchObject({ llBookId: 'll-saints', audioStatus: 'wanted' });
  });

  it('a refused add counts a refusal (no queue); it is tried a day later, and the third refusal ends it', async () => {
    const id = await seedPairingWant(settled);
    const ll = stubLl({}, { refuseAdd: true });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ llRerequestNotAdded: 1, llRerequested: 0 });
    expect(ll.calls).toEqual([{ cmd: 'addBook', id: 'gb-gone' }]);
    let want = await getWant(id);
    expect(want).toMatchObject({
      audioStatus: 'missing',
      llRerequestFailures: 1,
      llRerequestedAt: null,
    });

    // Within the day: not tried again.
    await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(ll.calls).toHaveLength(1);

    // A day later, twice more: the third refusal ends the re-request; it stays missing and is never tried again.
    for (const days of [1, 2]) {
      await runFormatPairing({
        db: t.db,
        ll: ll.bundle,
        pacer: noPace,
        now: new Date(Date.now() + days * DAY),
      });
    }
    want = await getWant(id);
    expect(want).toMatchObject({ audioStatus: 'missing', llRerequestFailures: 3 });
    expect(want.llRerequestedAt).not.toBeNull();
    await runFormatPairing({
      db: t.db,
      ll: ll.bundle,
      pacer: noPace,
      now: new Date(Date.now() + 4 * DAY),
    });
    expect(ll.calls).toHaveLength(3);
  });

  it("three refused adds in a row end the pass's adds (the shared Google Books key is out of quota)", async () => {
    for (const title of ['A One', 'B Two', 'C Three', 'D Four', 'E Five']) {
      await seedPairingWant({ ...settled, title, llBookId: `gb-${title}` });
    }
    const ll = stubLl({}, { refuseAdd: true });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ llRerequestNotAdded: 3, llRerequestDeferred: 2 });
    expect(ll.calls.filter((c) => c.cmd === 'addBook')).toHaveLength(3);
  });

  it("defers adds while the app's Google Books breaker is open; a queue on LL's own row still runs", async () => {
    await seedPairingWant(settled);
    const twin = await seedPairingWant({
      ...settled,
      title: 'The Road',
      author: 'Cormac McCarthy',
      llBookId: 'gb-road',
    });
    await t.db.insert(gbQuotaState).values({
      id: 'gb',
      exhaustedUntil: new Date(Date.now() + 3 * 60 * 60 * 1000),
      tripReason: 'daily',
    });
    const ll = stubLl({
      'll-road': {
        title: 'The Road',
        author: 'Cormac McCarthy',
        ebookStatus: 'Open',
        audioStatus: 'Skipped',
      },
    });
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ llRerequested: 1, llRerequestDeferred: 1 });
    expect(ll.calls).toEqual([{ cmd: 'queueBook', id: 'll-road', format: 'audiobook' }]);
    expect((await getWant(twin)).llBookId).toBe('ll-road');
  });

  it("defers pairing adds while a person's re-request is still waiting (people's wants go first)", async () => {
    await seedPairingWant(settled);
    const user = await createUser(t.db);
    const { integration } = await linkIntegration({
      db: t.db,
      userId: user.id,
      provider: 'goodreads',
      externalUserId: '9',
      profileRef: '9',
      actorId: user.id,
    });
    const [shelf] = await t.db
      .insert(integrationShelfItems)
      .values({
        integrationId: integration.id,
        shelf: 'to-read',
        externalBookId: 'gr-9',
        title: 'Waiting',
        author: 'Some Person',
      })
      .returning({ id: integrationShelfItems.id });
    await t.db.insert(bookRequests).values({
      origin: 'goodreads',
      integrationId: integration.id,
      shelfItemId: shelf!.id,
      title: 'Waiting',
      author: 'Some Person',
      llBookId: 'gb-person',
      ebookStatus: 'missing',
      audioStatus: 'missing',
    });
    const ll = stubLl();
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run).toMatchObject({ llRerequested: 0, llRerequestDeferred: 1 });
    expect(ll.calls).toEqual([]);

    // Review finding (PR #675): a shelf no sync has read for a day cannot be reached by the goodreads leg, so it
    // stops holding the app's adds back.
    await t.db
      .update(integrationShelfItems)
      .set({ lastSeenAt: daysAgo(2) })
      .where(eq(integrationShelfItems.id, shelf!.id));
    const later = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(later).toMatchObject({ llRerequested: 1, llRerequestDeferred: 0 });
  });

  it('two wants on one lost book share one addBook and one queueBook', async () => {
    await seedPairingWant(settled);
    await seedPairingWant({ ...settled, title: 'Saints (Unabridged)' });
    const ll = stubLl();
    const run = await runFormatPairing({ db: t.db, ll: ll.bundle, pacer: noPace });
    expect(run.llRerequested).toBe(2);
    expect(ll.calls).toEqual([
      { cmd: 'addBook', id: 'gb-gone' },
      { cmd: 'queueBook', id: 'gb-gone', format: 'audiobook' },
    ]);
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
    await markRerequested(wantId); // its one re-request is spent (issue #668)
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

  it('the same run re-requests it once: addBook + queueBook per format, never a search (issue #668)', async () => {
    const { integration, wantId } = await seedPushed();
    const ll = stubLl();
    const later = await syncGoodreadsIntegration({
      db: t.db,
      integrationId: integration.id,
      items,
      syncedShelves: ['to-read'],
      ll: ll.bundle,
      pacer: noPace,
      now: new Date(Date.now() + 2 * DAY),
    });
    expect(later).toMatchObject({ llGoneSettled: 1, llRerequested: 1, requestsPushed: 0 });
    expect(ll.calls).toEqual([
      { cmd: 'addBook', id: 'gb-gone' },
      { cmd: 'queueBook', id: 'gb-gone', format: 'ebook' },
      { cmd: 'queueBook', id: 'gb-gone', format: 'audiobook' },
    ]);
    const want = await getWant(wantId);
    expect(want).toMatchObject({ ebookStatus: 'wanted', audioStatus: 'wanted' });
    expect(want.llRerequestedAt).not.toBeNull();
  });

  it('Search again re-adds the gone book (addBook, queueBook per format, ONE search) and it reads wanted again', async () => {
    const { user, integration, wantId } = await seedPushed();
    await markRerequested(wantId); // its one re-request is spent (issue #668)
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
    await markRerequested(wantId); // its one re-request is spent (issue #668)
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
    await markRerequested(wantId); // its one re-request is spent (issue #668)
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
    llRerequestedAt?: Date | null;
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
      llRerequestedAt: opts.llRerequestedAt ?? null,
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
      llRerequestedAt: daysAgo(1),
      lastSearchedAt: daysAgo(8),
    });
    const notDue = await seedCollectionWant(cid, {
      ref: 'm2',
      title: 'Theatre of Cruelty',
      llBookId: 'gb-notdue',
      llRerequestedAt: daysAgo(1),
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
      llRerequestedAt: daysAgo(1),
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

  it('hands a settled collection want back once (addBook + queueBook, no search) and its cooldown keeps the cron off it', async () => {
    const cid = await seedCollection('c6', 'recipe-6');
    const id = await seedCollectionWant(cid, {
      ref: 'm1',
      title: 'Troll Bridge',
      llBookId: 'gb-lost',
      lastSearchedAt: daysAgo(10),
      ebookStatus: 'missing',
    });
    const ll = stubLl();
    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: libretto('recipe-6'),
      ll: ll.bundle,
      pacer: noPace,
    });
    expect(report).toMatchObject({ llRerequested: 1, searched: 0, candidates: 0 });
    expect(ll.calls).toEqual([
      { cmd: 'addBook', id: 'gb-lost' },
      { cmd: 'queueBook', id: 'gb-lost', format: 'ebook' },
    ]);
    const want = await getWant(id);
    expect(want.ebookStatus).toBe('wanted');
    expect(want.llRerequestedAt).not.toBeNull();
    expect(Date.now() - want.lastSearchedAt!.getTime()).toBeLessThan(60_000);
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
