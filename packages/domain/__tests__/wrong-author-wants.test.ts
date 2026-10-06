// Issue #771 (DESIGN-028 amendment 2026-10-06, the Author Check, glossary T-286) — collection wants resolved, title-only,
// to another author's book. "Gray Dawn" (Walter Mosley) sat on Stewart Edward White's "The Gray Dawn" and "Shift" (Hugh
// Howey) on Stephen King's "Night Shift"; LazyLibrarian held both, so the force-search push guard skipped them as held,
// stamped them, and a week later skipped them again: never searched. Proves the pure check, the sweep that releases such
// a want whatever its cooldown (no LazyLibrarian write, its book released), the search of the member's own book once the
// wants pass resolves it again, the resolve that vouches for a book (no loop), the on-demand Force Search, and the
// Downloaded rule's use of the check. Embedded PG16.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { bookRequests, booksCollections, llFormatReleases, permissionAudit } from '@hnet/db';
import {
  collectionWantDownloaded,
  forceSearchCollectionNow,
  forceSearchFindMissingCollections,
  llBookAuthorMismatch,
  syncBooksCollections,
  syncCollectionWants,
  type CollectionWantsLibretto,
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
  await t.db.delete(booksCollections);
  await t.db.delete(llFormatReleases);
  await t.db.delete(permissionAudit);
});

// ---------------------------------------------------------------------------
// 1. The pure check.
// ---------------------------------------------------------------------------

describe('llBookAuthorMismatch', () => {
  const book = (author: string | null) => ({ title: 'x', author });

  it.each([
    ['Walter Mosley', 'Stewart Edward White'],
    ['Hugh Howey', 'Stephen King'],
    ['Terry Pratchett', 'Paul Luckraft'],
    ['Rick Riordan', 'Rick Harrison'], // a shared first name is no agreement
    ['Dennis E. Taylor', 'Rick Harrison'],
  ])('%s is not %s', (want, theirs) => {
    expect(llBookAuthorMismatch(want, book(theirs))).toBe(true);
  });

  it.each([
    ['Frank Herbert', 'Brian Herbert'], // one family's series: the surname agrees
    ['J.R.R. Tolkien', 'J. R. R. Tolkien'],
    ['Ursula K. Le Guin', 'Ursula K. LeGuin'],
    ['Terry Pratchett, Neil Gaiman', 'Neil Gaiman'], // any credit of the want's
    ['Robert Jordan & Brandon Sanderson', 'Brandon Sanderson'],
    ['Mosley, Walter', 'Walter Mosley'],
    ['George R. R. Martin', 'George R.R. Martin Jr.'],
    ['James S.A. Corey', 'James S. A. Corey'],
    ['Veronica Roth', 'Veronica Roth (1)'],
  ])('%s agrees with %s', (want, theirs) => {
    expect(llBookAuthorMismatch(want, book(theirs))).toBe(false);
  });

  it('decides nothing without an author on both sides', () => {
    expect(llBookAuthorMismatch(null, book('Stewart Edward White'))).toBe(false);
    expect(llBookAuthorMismatch('Walter Mosley', book(null))).toBe(false);
    expect(llBookAuthorMismatch('Walter Mosley', undefined)).toBe(false);
    expect(llBookAuthorMismatch('  ', book('Stewart Edward White'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

interface StubRow {
  title?: string;
  author?: string;
  ebookStatus?: string;
  audioStatus?: string;
  ebookLibrary?: string;
}

/** A recording LazyLibrarian bundle over a real, usable `getAllBooks` snapshot. */
function stubLl(rows: Record<string, StubRow>) {
  const calls: Array<{ cmd: string; id: string; format?: string }> = [];
  const snapshot = new Map(
    Object.entries(rows).map(([id, r]) => [
      id,
      {
        bookId: id,
        title: r.title ?? null,
        subtitle: null,
        author: r.author ?? null,
        ebookStatus: r.ebookStatus ?? null,
        audioStatus: r.audioStatus ?? null,
        ebookLibrary: r.ebookLibrary ?? null,
        audioLibrary: null,
        ebookFile: null,
        audioFile: null,
      },
    ]),
  );
  const bundle = {
    write: {
      addBook: async (id: string) => void calls.push({ cmd: 'addBook', id }),
      queueBook: async (id: string, format: string) => void calls.push({ cmd: 'queueBook', id, format }),
      searchBook: async (id: string, format: string) => void calls.push({ cmd: 'searchBook', id, format }),
    },
    read: { getAllBookStatuses: async () => snapshot },
  } as unknown as Parameters<typeof forceSearchFindMissingCollections>[0]['ll'];
  return { calls, bundle };
}

async function seedCollection(
  externalId: string,
  recipeId: string,
  source: 'kavita' | 'audiobookshelf' = 'kavita',
): Promise<string> {
  await syncBooksCollections({
    db: t.db,
    collections: [
      {
        source,
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
    .where(and(eq(booksCollections.externalId, externalId), eq(booksCollections.kind, 'collection')));
  return row!.id;
}

const libretto = (recipeIds: string[]): CollectionWantsLibretto =>
  ({
    listRecipes: async () => ({
      recipes: recipeIds.map((id) => ({
        id,
        builder: { type: 'hardcover_series', ref: id },
        variables: { acquisitionEnabled: true },
      })),
      issues: [],
    }),
  }) as unknown as CollectionWantsLibretto;

const wantByRef = async (collectionId: string, ref: string) => {
  const [row] = await t.db
    .select()
    .from(bookRequests)
    .where(and(eq(bookRequests.collectionId, collectionId), eq(bookRequests.collectionMemberRef, ref)));
  return row!;
};

const noPace = () => Promise.resolve();
const NOW = new Date('2026-10-06T16:00:00Z');

// The live rows (2026-10-06): LazyLibrarian holds both wrong books, and searches Matt Howarth's "Gray Dawn" audiobook.
const LL_ROWS: Record<string, StubRow> = {
  vkDiAAAAMAAJ: {
    title: 'The Gray Dawn',
    author: 'Stewart Edward White',
    ebookStatus: 'Open',
    ebookLibrary: '2026-09-29 16:07:34',
  },
  ZNTZzQEACAAJ: {
    title: 'Gray Dawn',
    author: 'Matt Howarth',
    ebookStatus: 'Skipped',
    audioStatus: 'Wanted',
  },
  cxT4Hz7kNnsC: {
    title: 'Always Outnumbered, Always Outgunned',
    author: 'Walter Mosley',
    ebookStatus: 'Skipped',
  },
};

// ---------------------------------------------------------------------------
// 2. The cron force-search.
// ---------------------------------------------------------------------------

describe('collection force-search — the Author Check (cron)', () => {
  it('releases a want held on another author’s book whatever its cooldown, with no LazyLibrarian write for it', async () => {
    const colId = await seedCollection('easy-rawlins', 'easy-rawlins');
    await syncCollectionWants({
      db: t.db,
      collectionId: colId,
      format: 'ebook',
      members: [
        { memberRef: 'isbn:9780316573238', title: 'Gray Dawn', author: 'Walter Mosley', llBookId: 'vkDiAAAAMAAJ' },
        // A member with no author is never judged by it (no evidence), even on that same book.
        { memberRef: 'isbn:none', title: 'Gray Dawn', author: null, llBookId: 'vkDiAAAAMAAJ' },
        // The member's own author's book is searched as usual.
        { memberRef: 'isbn:aoao', title: 'Always Outnumbered, Always Outgunned', author: 'Walter Mosley', llBookId: 'cxT4Hz7kNnsC' },
      ],
    });
    // The held-skip stamped Gray Dawn three days ago; the week-long cooldown would keep it out of the gather.
    await t.db
      .update(bookRequests)
      .set({ lastSearchedAt: new Date('2026-10-03T11:28:54Z') })
      .where(eq(bookRequests.collectionMemberRef, 'isbn:9780316573238'));
    const ll = stubLl(LL_ROWS);

    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: libretto(['easy-rawlins']),
      ll: ll.bundle,
      pacer: noPace,
      now: NOW,
      cooldownMs: 7 * 24 * 60 * 60 * 1000,
    });

    expect(report.releasedWrongAuthor).toBe(1);
    expect(ll.calls.some((c) => c.id === 'vkDiAAAAMAAJ')).toBe(false);
    expect(ll.calls.filter((c) => c.cmd === 'searchBook').map((c) => c.id)).toEqual(['cxT4Hz7kNnsC']);

    const grayDawn = await wantByRef(colId, 'isbn:9780316573238');
    expect(grayDawn.llBookId).toBeNull();
    expect(grayDawn.wrongAuthorLlBookId).toBe('vkDiAAAAMAAJ');
    expect(grayDawn.lastSearchedAt).toBeNull(); // due the moment it has a book again
    expect(grayDawn.ebookStatus).toBe('requested');
    expect(grayDawn.unroutableReason).toBeNull(); // released, not parked: the member's book is still wanted
    // The book LazyLibrarian was searching for it is released (the drain decides; held, so it drops it).
    const releases = await t.db.select().from(llFormatReleases);
    expect(releases).toEqual([
      expect.objectContaining({ llBookId: 'vkDiAAAAMAAJ', format: 'ebook', reason: 'released:wrong_author', requestId: grayDawn.id }),
    ]);
    // The authorless want keeps its book (held, so the push guard skips it as before).
    expect((await wantByRef(colId, 'isbn:none')).llBookId).toBe('vkDiAAAAMAAJ');
  });

  it('searches the member’s own book once the wants pass resolves it again', async () => {
    const colId = await seedCollection('easy-rawlins', 'easy-rawlins');
    const members = (llBookId: string | null) => [
      { memberRef: 'isbn:9780316573238', title: 'Gray Dawn', author: 'Walter Mosley', llBookId },
    ];
    await syncCollectionWants({ db: t.db, collectionId: colId, format: 'ebook', members: members('vkDiAAAAMAAJ') });
    const ll = stubLl(LL_ROWS);
    const run = () =>
      forceSearchFindMissingCollections({
        db: t.db,
        libretto: libretto(['easy-rawlins']),
        ll: ll.bundle,
        pacer: noPace,
        now: NOW,
      });

    expect((await run()).releasedWrongAuthor).toBe(1);
    // The next hour's wants pass resolves the member with its author: Walter Mosley's "Gray Dawn".
    await syncCollectionWants({ db: t.db, collectionId: colId, format: 'ebook', members: members('GkU_EQAAQBAJ') });
    const second = await run();
    expect(second.searched).toBe(1);
    expect(ll.calls).toEqual([
      { cmd: 'addBook', id: 'GkU_EQAAQBAJ' },
      { cmd: 'queueBook', id: 'GkU_EQAAQBAJ', format: 'ebook' },
      { cmd: 'searchBook', id: 'GkU_EQAAQBAJ', format: 'ebook' },
    ]);
    expect((await wantByRef(colId, 'isbn:9780316573238')).lastSearchedAt).not.toBeNull();
  });

  it('a book an author-guarded resolve names again is vouched for: no second release, no loop', async () => {
    const colId = await seedCollection('easy-rawlins', 'easy-rawlins');
    const members = (llBookId: string | null) => [
      { memberRef: 'isbn:9780316573238', title: 'Gray Dawn', author: 'Walter Mosley', llBookId },
    ];
    await syncCollectionWants({ db: t.db, collectionId: colId, format: 'ebook', members: members('vkDiAAAAMAAJ') });
    const ll = stubLl(LL_ROWS);
    const run = () =>
      forceSearchFindMissingCollections({
        db: t.db,
        libretto: libretto(['easy-rawlins']),
        ll: ll.bundle,
        pacer: noPace,
        now: NOW,
      });
    await run();
    // The resolve, with the author, names the same book (its author is written another way in LazyLibrarian).
    await syncCollectionWants({ db: t.db, collectionId: colId, format: 'ebook', members: members('vkDiAAAAMAAJ') });
    const second = await run();
    expect(second.releasedWrongAuthor).toBe(0);
    expect(second.skippedHeld).toBe(1); // judged like any other held book
    expect((await wantByRef(colId, 'isbn:9780316573238')).llBookId).toBe('vkDiAAAAMAAJ');
  });

  it('an audiobook want on another author’s Wanted book goes back to requested and that format is released', async () => {
    const colId = await seedCollection('easy-rawlins-audio', 'easy-rawlins-audiobooks', 'audiobookshelf');
    await syncCollectionWants({
      db: t.db,
      collectionId: colId,
      format: 'audiobook',
      members: [
        { memberRef: 'isbn:9780316573238', title: 'Gray Dawn', author: 'Walter Mosley', llBookId: 'ZNTZzQEACAAJ' },
      ],
    });
    await t.db
      .update(bookRequests)
      .set({ audioStatus: 'wanted', lastSearchedAt: new Date('2026-10-04T19:27:38Z') })
      .where(eq(bookRequests.collectionId, colId));
    const ll = stubLl(LL_ROWS);

    const report = await forceSearchFindMissingCollections({
      db: t.db,
      libretto: libretto(['easy-rawlins-audiobooks']),
      ll: ll.bundle,
      pacer: noPace,
      now: NOW,
    });

    expect(report.releasedWrongAuthor).toBe(1);
    expect(ll.calls).toEqual([]);
    const want = await wantByRef(colId, 'isbn:9780316573238');
    expect(want.audioStatus).toBe('requested');
    expect(want.ebookStatus).toBe('landed'); // the other format sits landed by construction
    const releases = await t.db.select().from(llFormatReleases);
    expect(releases.map((r) => [r.llBookId, r.format])).toEqual([['ZNTZzQEACAAJ', 'audiobook']]);
  });
});

// ---------------------------------------------------------------------------
// 3. The on-demand collection Force Search.
// ---------------------------------------------------------------------------

describe('collection force-search — the Author Check (on demand)', () => {
  it('releases the wrong book, resolves the member again and searches its own book in the same click', async () => {
    const caller = await createUser(t.db);
    const colId = await seedCollection('silo', 'silo');
    await syncCollectionWants({
      db: t.db,
      collectionId: colId,
      format: 'ebook',
      members: [{ memberRef: 'isbn:9780099580478', title: 'Shift', author: 'Hugh Howey', llBookId: 'K47JTah91MkC' }],
    });
    const resolved: Array<{ title?: string; author?: string }> = [];
    const onDemand = {
      read: {
        listMissingMembers: async () => ({
          missing: [{ isbn: '9780099580478', title: 'Shift', authors: ['Hugh Howey'] }],
        }),
        resolve: async (req: { title?: string; author?: string }) => {
          resolved.push(req);
          return req.author === 'Hugh Howey' ? { volumeId: 'HOWEY_SHIFT' } : { volumeId: 'K47JTah91MkC' };
        },
      },
      write: { applyScope: async () => 'run-silo' },
    } as unknown as Parameters<typeof forceSearchCollectionNow>[0]['libretto'];
    const ll = stubLl({
      K47JTah91MkC: { title: 'Night Shift', author: 'Stephen King', ebookStatus: 'Open', ebookLibrary: '2026-09-28' },
    });

    const report = await forceSearchCollectionNow({
      db: t.db,
      libretto: onDemand,
      ll: ll.bundle,
      recipeId: 'silo',
      actorId: caller.id,
      pacer: noPace,
      now: NOW,
    });

    expect(report.releasedWrongAuthor).toBe(1);
    expect(report.searched).toBe(1);
    expect(resolved).toEqual([expect.objectContaining({ title: 'Shift', author: 'Hugh Howey' })]);
    expect(ll.calls.some((c) => c.id === 'K47JTah91MkC')).toBe(false);
    expect(ll.calls.map((c) => [c.cmd, c.id])).toEqual([
      ['addBook', 'HOWEY_SHIFT'],
      ['queueBook', 'HOWEY_SHIFT'],
      ['searchBook', 'HOWEY_SHIFT'],
    ]);
    expect((await wantByRef(colId, 'isbn:9780099580478')).llBookId).toBe('HOWEY_SHIFT');
  });
});

// ---------------------------------------------------------------------------
// 4. The Downloaded rule.
// ---------------------------------------------------------------------------

describe('collectionWantDownloaded — the Author Check', () => {
  const held = {
    bookId: 'vkDiAAAAMAAJ',
    title: 'The Gray Dawn',
    subtitle: null,
    author: 'Stewart Edward White',
    ebookStatus: 'Open',
    audioStatus: 'Skipped',
    ebookLibrary: '2026-09-29 16:07:34',
    audioLibrary: null,
    ebookFile: null,
    audioFile: null,
  };

  it('another author’s book never says the member was downloaded, unless a resolve vouched for it', () => {
    const want = { title: 'Gray Dawn', author: 'Walter Mosley', llBookId: 'vkDiAAAAMAAJ' };
    expect(collectionWantDownloaded({ want, book: held, format: 'ebook', libraryKeys: [] })).toBe(false);
    expect(
      collectionWantDownloaded({
        want: { ...want, wrongAuthorLlBookId: 'vkDiAAAAMAAJ' },
        book: held,
        format: 'ebook',
        libraryKeys: [],
      }),
    ).toBe(true);
    // No author on the want: judged on the titles alone, as before.
    expect(
      collectionWantDownloaded({ want: { ...want, author: null }, book: held, format: 'ebook', libraryKeys: [] }),
    ).toBe(true);
  });
});
