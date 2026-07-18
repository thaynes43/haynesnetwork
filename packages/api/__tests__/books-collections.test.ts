// ADR-066 / DESIGN-038 D-05/D-06/D-10 (PLAN-051) — the books Collections group listing + drill:
//   • the `books` section LEVEL SEAM gates collectionGroups AND the collection-narrowed search
//     server-side (FORBIDDEN for a Disabled caller — the same gate as the walls).
//   • the wall-mapping MAJORITY rule: a mixed collection cards ONLY its majority wall; the count is
//     the WALL kind's resolved live members (never the raw source item_count).
//   • covers cap at 4 in member-position order; the `ordered` flag flows to the wire.
//   • `?group=` = ONE books.search EXISTS predicate; `position` sorts by member position and the
//     schema REFUSES it without a collection.
// Seeded through the sanctioned domain writers (syncBooks + syncBooksCollections) — never a direct
// insert (the no-direct-state-writes guard).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { booksCollections } from '@hnet/db';
import { syncBooks, syncBooksCollections, type BooksItemInput } from '@hnet/domain';
import {
  bootMigratedDb,
  caller,
  createUser,
  makeCtx,
  sessionUser,
  type Caller,
  type TestDb,
} from './helpers';

let t: TestDb;
let adminCaller: Caller;
let disabledCaller: Caller;
let readerCaller: Caller;
let readingListId: string; // kavita/reading_list '11' (ordered — books majority)
let kavitaCollectionId: string; // kavita/collection '4' (unordered — comics majority)

function bookRow(
  o: Partial<BooksItemInput> &
    Pick<BooksItemInput, 'source' | 'mediaKind' | 'externalId' | 'title'>,
): BooksItemInput {
  return {
    libraryId: '1',
    libraryName: 'Books',
    sortTitle: o.title.toLowerCase(),
    author: null,
    narrator: null,
    seriesName: null,
    year: null,
    releasedAt: null,
    genres: [],
    coverRef: 'v1.png',
    deepLinkUrl: 'http://x',
    pageCount: null,
    wordCount: null,
    durationSeconds: null,
    sizeBytes: null,
    attrs: {},
    sourceAddedAt: null,
    sourceUpdatedAt: null,
    ...o,
  };
}

beforeAll(async () => {
  t = await bootMigratedDb();
  const admin = await createUser(t.db, { admin: true, displayName: 'Admin Ada' });
  const disabled = await createUser(t.db, { displayName: 'Member Mia' });
  const reader = await createUser(t.db, { displayName: 'Reader Rae' });
  adminCaller = caller(makeCtx(t.db, sessionUser(admin)));
  disabledCaller = caller(makeCtx(t.db, sessionUser(disabled)));
  readerCaller = caller(makeCtx(t.db, sessionUser(reader, { books: 'read_only' })));

  // The library mirror: 3 Kavita books, 2 Kavita comics, 2 ABS audiobooks (+ 1 book WITHOUT cover).
  await syncBooks({
    db: t.db,
    syncedSources: ['kavita', 'audiobookshelf'],
    rows: [
      bookRow({ source: 'kavita', mediaKind: 'book', externalId: '501', title: 'HP Book 1' }),
      bookRow({ source: 'kavita', mediaKind: 'book', externalId: '502', title: 'HP Book 2' }),
      bookRow({
        source: 'kavita',
        mediaKind: 'book',
        externalId: '503',
        title: 'HP Book 3',
        coverRef: null,
      }),
      bookRow({ source: 'kavita', mediaKind: 'comic', externalId: '601', title: 'Comic One' }),
      bookRow({ source: 'kavita', mediaKind: 'comic', externalId: '602', title: 'Comic Two' }),
      bookRow({
        source: 'audiobookshelf',
        mediaKind: 'audiobook',
        externalId: 'a1',
        title: 'Listen One',
      }),
      bookRow({
        source: 'audiobookshelf',
        mediaKind: 'audiobook',
        externalId: 'a2',
        title: 'Listen Two',
      }),
    ],
  });

  await syncBooksCollections({
    db: t.db,
    collections: [
      // A MIXED ordered reading list: 3 books + 1 comic + 1 unresolvable ref → BOOKS wall
      // (majority), count 3 (the wall's kind only), positions carry the reading order.
      {
        source: 'kavita',
        externalId: '11',
        kind: 'reading_list',
        libraryId: null,
        title: 'HP Reading Order',
        itemCount: 99, // deliberately wrong raw count — must NEVER be the wire count
        ordered: true,
        createdBy: 'libretto',
        category: 'Series', // D-12 — the owner category chip (agent-set / marker-derived)
        members: [
          { externalRef: '503', position: 0 },
          { externalRef: '502', position: 1 },
          { externalRef: '601', position: 2 }, // the comic minority
          { externalRef: '501', position: 3 },
          { externalRef: '999', position: 4 }, // no mirror row — invisible in reads
        ],
        fullyRead: true,
      },
      // A pure-comic unordered Kavita collection → COMICS wall.
      {
        source: 'kavita',
        externalId: '4',
        kind: 'collection',
        libraryId: null,
        title: 'Capes',
        itemCount: 2,
        ordered: false,
        createdBy: 'kavita',
        category: 'Event', // D-12 — a comic crossover Event chip
        members: [
          { externalRef: '601', position: 0 },
          { externalRef: '602', position: 1 },
        ],
        fullyRead: true,
      },
      // An ABS collection → AUDIOBOOKS wall (ordered).
      {
        source: 'audiobookshelf',
        externalId: 'col-abs-1',
        kind: 'collection',
        libraryId: 'lib-1',
        title: 'Discworld in Order',
        itemCount: 2,
        ordered: true,
        createdBy: 'audiobookshelf',
        category: 'Series', // D-12 — a book series chip on the Audiobooks wall
        members: [
          { externalRef: 'a2', position: 0 },
          { externalRef: 'a1', position: 1 },
        ],
        fullyRead: true,
      },
      // A collection with ZERO resolvable members — absent from every wall.
      {
        source: 'kavita',
        externalId: '5',
        kind: 'collection',
        libraryId: null,
        title: 'Ghost Shelf',
        itemCount: 3,
        ordered: false,
        createdBy: 'kavita',
        category: 'List', // present in data but the card is absent (0 resolved members) — no chip
        members: [{ externalRef: '888', position: 0 }],
        fullyRead: true,
      },
    ],
    scopedFamilies: [
      { source: 'kavita', kind: 'collection' },
      { source: 'kavita', kind: 'reading_list' },
      { source: 'audiobookshelf', kind: 'collection' },
    ],
  });

  const [list] = await t.db
    .select({ id: booksCollections.id })
    .from(booksCollections)
    .where(eq(booksCollections.kind, 'reading_list'));
  readingListId = list!.id;
  const [capes] = await t.db
    .select({ id: booksCollections.id })
    .from(booksCollections)
    .where(eq(booksCollections.title, 'Capes'));
  kavitaCollectionId = capes!.id;
});

afterAll(async () => {
  await t.stop();
});

describe('books.collectionGroups gate (DESIGN-038 D-10 — the books section is THE gate)', () => {
  it('REFUSES a Disabled (default non-admin) caller with FORBIDDEN', async () => {
    await expect(
      disabledCaller.books.collectionGroups({ mediaKind: 'book' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('a Read-Only role row opts a member in (same seam as the wall)', async () => {
    const { groups } = await readerCaller.books.collectionGroups({ mediaKind: 'book' });
    expect(groups).toHaveLength(1);
  });
});

describe('books.collectionGroups (DESIGN-038 D-05 — wall mapping + honest counts)', () => {
  it('maps a mixed collection to its MAJORITY wall with the WALL kind count (never the raw item_count)', async () => {
    const { groups } = await adminCaller.books.collectionGroups({ mediaKind: 'book' });
    expect(groups).toHaveLength(1);
    const card = groups[0]!;
    expect(card.key).toBe(readingListId);
    expect(card.label).toBe('HP Reading Order');
    expect(card.count).toBe(3); // 3 books — not the comic, not the raw 99, not the ghost ref
    expect(card.ordered).toBe(true);
    expect(card.imageUrl).toBeNull();
    // PROVENANCE badge — the marker-derived 'libretto' resolves to its display name.
    expect(card.provenance).toBe('Libretto');
    // Covers in member-position order, cover-less members contribute none (503 has no coverRef).
    expect(card.coverUrls).toEqual([
      '/api/books/cover?source=kavita&id=502&v=v1.png',
      '/api/books/cover?source=kavita&id=501&v=v1.png',
    ]);
  });

  it('the minority wall never cards the mixed collection; pure collections land on their wall', async () => {
    const { groups: comics } = await adminCaller.books.collectionGroups({ mediaKind: 'comic' });
    expect(comics.map((g) => g.label)).toEqual(['Capes']); // the mixed list is NOT here
    expect(comics[0]).toMatchObject({ count: 2, ordered: false, provenance: 'Kavita' });
    const { groups: audiobooks } = await adminCaller.books.collectionGroups({
      mediaKind: 'audiobook',
    });
    expect(audiobooks.map((g) => g.label)).toEqual(['Discworld in Order']);
    expect(audiobooks[0]).toMatchObject({ count: 2, ordered: true, provenance: 'Audiobookshelf' });
  });

  it('a collection with zero resolved live members is absent from every wall', async () => {
    for (const mediaKind of ['book', 'comic', 'audiobook'] as const) {
      const { groups } = await adminCaller.books.collectionGroups({ mediaKind });
      expect(groups.map((g) => g.label)).not.toContain('Ghost Shelf');
    }
  });

  it('CATEGORY (D-12) — cards carry the category and categoryCounts covers only present cards per wall', async () => {
    const books = await adminCaller.books.collectionGroups({ mediaKind: 'book' });
    // The one book-wall card (HP Reading Order) carries its category; the chip counts reflect it.
    expect(books.groups[0]!.category).toBe('Series');
    expect(books.categoryCounts).toEqual({ Series: 1 });
    // The Ghost Shelf carries a 'List' category in data but shows NO card (0 resolved members), so it
    // must NOT leak into the chip counts — a chip can never advertise a card the wall can't show.
    expect(books.categoryCounts.List).toBeUndefined();

    const comics = await adminCaller.books.collectionGroups({ mediaKind: 'comic' });
    expect(comics.groups[0]!.category).toBe('Event');
    expect(comics.categoryCounts).toEqual({ Event: 1 });

    const audiobooks = await adminCaller.books.collectionGroups({ mediaKind: 'audiobook' });
    expect(audiobooks.categoryCounts).toEqual({ Series: 1 });
  });
});

describe('the collection drill (DESIGN-038 D-06 — one EXISTS predicate + the position sort)', () => {
  it('narrows the wall to the collection members of the wall kind', async () => {
    const result = await adminCaller.books.search({
      mediaKind: 'book',
      collection: readingListId,
    });
    // Title default sort; only the 3 resolved BOOK members (the comic is another wall's grid).
    expect(result.items.map((i) => i.title)).toEqual(['HP Book 1', 'HP Book 2', 'HP Book 3']);
  });

  it('sorts by member position (reading order) inside the drill', async () => {
    const result = await adminCaller.books.search({
      mediaKind: 'book',
      collection: readingListId,
      sort: 'position',
    });
    expect(result.items.map((i) => i.title)).toEqual(['HP Book 3', 'HP Book 2', 'HP Book 1']);
    // The explicit desc flip inverts it (R5 "+direction").
    const flipped = await adminCaller.books.search({
      mediaKind: 'book',
      collection: readingListId,
      sort: 'position',
      dir: 'desc',
    });
    expect(flipped.items.map((i) => i.title)).toEqual(['HP Book 1', 'HP Book 2', 'HP Book 3']);
  });

  it('the drill composes with the wall facets (an added query narrows the drilled grid)', async () => {
    const result = await adminCaller.books.search({
      mediaKind: 'book',
      collection: readingListId,
      query: 'Book 2',
    });
    expect(result.items.map((i) => i.title)).toEqual(['HP Book 2']);
  });

  it('REFUSES the position sort without a collection (the D-06 refinement)', async () => {
    await expect(
      adminCaller.books.search({ mediaKind: 'book', sort: 'position' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('the collection-narrowed search rides the SAME books gate', async () => {
    await expect(
      disabledCaller.books.search({ mediaKind: 'comic', collection: kavitaCollectionId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
