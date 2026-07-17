// ADR-066 / DESIGN-038 (PLAN-051) — the books collections mirror: the two-server fetcher (Kavita
// collections + reading lists, ABS collections) + the syncBooksCollections single-writer (upsert +
// reconcile SCOPED to fully-read (source, kind) families / collections — a partial read never
// tombstones). Proven against an embedded PG16 with fetch-free stub clients (no live servers).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { booksCollections, booksCollectionMembers } from '@hnet/db';
import type { Database } from '@hnet/db';
import { syncBooks, syncBooksCollections, type BooksItemInput } from '@hnet/domain';
import type { AudiobookshelfClient, KavitaClient } from '@hnet/books/read';
import {
  KAVITA_COLLECTION_PAGE_SIZE,
  KAVITA_READING_LIST_PAGE_SIZE,
  dedupeReadingListItems,
  fetchBooksCollectionsSnapshot,
} from '../src/books-collections';
import type { BooksSyncBundle } from '../src/books';
import { bootMigratedDb, type TestDb } from './helpers';

/** A fake Kavita: one collection (2 series) + one reading list whose CHAPTER items repeat series. */
function fakeKavita(overrides: Partial<KavitaClient> = {}): KavitaClient {
  return {
    async listCollections() {
      return [{ id: 4, title: 'Harry Potter Collection', promoted: false, itemCount: 2 }];
    },
    async listCollectionSeriesPage(collectionId: number) {
      if (collectionId !== 4) throw new Error(`unexpected collection ${collectionId}`);
      return {
        items: [
          { id: 501, name: 'HP Book 1', libraryId: 1 },
          { id: 502, name: 'HP Book 2', libraryId: 1 },
        ],
        total: 2,
        hasAuthoritativeTotal: true,
      };
    },
    async listReadingListsPage() {
      return {
        items: [{ id: 11, title: 'HP Reading Order', promoted: false, itemCount: 3 }],
        total: 1,
        hasAuthoritativeTotal: true,
      };
    },
    async listReadingListItems(readingListId: number) {
      if (readingListId !== 11) throw new Error(`unexpected list ${readingListId}`);
      // CHAPTER grain — series 502 appears at orders 0+2, series 501 at order 1 (D-09 dedupe).
      return [
        { id: 900, order: 0, seriesId: 502 },
        { id: 901, order: 1, seriesId: 501 },
        { id: 902, order: 2, seriesId: 502 },
      ];
    },
    ...overrides,
  } as unknown as KavitaClient;
}

/** A fake ABS: one ordered collection of two items (the array order IS the curated order). */
function fakeAbs(overrides: Partial<AudiobookshelfClient> = {}): AudiobookshelfClient {
  return {
    async listCollections() {
      return [
        {
          id: 'col-abs-1',
          libraryId: 'lib-1',
          name: 'Discworld in Order',
          books: [{ id: 'a2' }, { id: 'a1' }],
        },
      ];
    },
    ...overrides,
  } as unknown as AudiobookshelfClient;
}

function bundle(kavita: KavitaClient, audiobookshelf: AudiobookshelfClient): BooksSyncBundle {
  return {
    kavita,
    audiobookshelf,
    kavitaPublicUrl: 'https://kavita.test',
    audiobookshelfPublicUrl: 'https://abs.test',
  };
}

function bookRow(
  o: Partial<BooksItemInput> & Pick<BooksItemInput, 'source' | 'mediaKind' | 'externalId' | 'title'>,
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
    coverRef: null,
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

let t: TestDb;

async function collectionKeys(db: Database): Promise<string[]> {
  const rows = await db
    .select({
      source: booksCollections.source,
      kind: booksCollections.kind,
      externalId: booksCollections.externalId,
    })
    .from(booksCollections)
    .orderBy(asc(booksCollections.source), asc(booksCollections.kind), asc(booksCollections.externalId));
  return rows.map((r) => `${r.source}/${r.kind}/${r.externalId}`);
}

async function memberRows(db: Database, externalId: string, kind: 'collection' | 'reading_list') {
  const [col] = await db
    .select({ id: booksCollections.id })
    .from(booksCollections)
    .where(and(eq(booksCollections.externalId, externalId), eq(booksCollections.kind, kind)));
  if (!col) return [];
  return db
    .select({
      externalRef: booksCollectionMembers.externalRef,
      booksItemId: booksCollectionMembers.booksItemId,
      position: booksCollectionMembers.position,
    })
    .from(booksCollectionMembers)
    .where(eq(booksCollectionMembers.collectionId, col.id))
    .orderBy(asc(booksCollectionMembers.position));
}

beforeAll(async () => {
  t = await bootMigratedDb();
  // The books_items mirror the member resolution reads (seeded through the sanctioned writer).
  await syncBooks({
    db: t.db,
    syncedSources: ['kavita', 'audiobookshelf'],
    rows: [
      bookRow({ source: 'kavita', mediaKind: 'book', externalId: '501', title: 'HP Book 1' }),
      bookRow({ source: 'kavita', mediaKind: 'book', externalId: '502', title: 'HP Book 2' }),
      bookRow({ source: 'audiobookshelf', mediaKind: 'audiobook', externalId: 'a1', title: 'Listen One' }),
      bookRow({ source: 'audiobookshelf', mediaKind: 'audiobook', externalId: 'a2', title: 'Listen Two' }),
    ],
  });
});

afterAll(async () => {
  await t?.stop();
});

describe('dedupeReadingListItems (DESIGN-038 D-09)', () => {
  it('dedupes chapter-grain items to series grain at the EARLIEST order, re-densified', () => {
    expect(
      dedupeReadingListItems([
        { order: 0, seriesId: 502 },
        { order: 1, seriesId: 501 },
        { order: 2, seriesId: 502 },
      ]),
    ).toEqual([
      { externalRef: '502', position: 0 },
      { externalRef: '501', position: 1 },
    ]);
  });

  it('is deterministic on order ties (series id ascending)', () => {
    expect(
      dedupeReadingListItems([
        { order: 5, seriesId: 9 },
        { order: 5, seriesId: 3 },
      ]),
    ).toEqual([
      { externalRef: '3', position: 0 },
      { externalRef: '9', position: 1 },
    ]);
  });
});

describe('fetchBooksCollectionsSnapshot + syncBooksCollections (ADR-066)', () => {
  it('mirrors all three families with honest ordered flags + resolved members', async () => {
    const snap = await fetchBooksCollectionsSnapshot({ books: bundle(fakeKavita(), fakeAbs()) });
    expect(snap.stats.collectionsFetched).toBe(3);
    expect(snap.scopedFamilies).toEqual([
      { source: 'kavita', kind: 'collection' },
      { source: 'kavita', kind: 'reading_list' },
      { source: 'audiobookshelf', kind: 'collection' },
    ]);
    const kavitaCol = snap.collections.find((c) => c.kind === 'collection' && c.source === 'kavita')!;
    expect(kavitaCol.ordered).toBe(false); // Kavita collections carry no member order (D-09)
    const readingList = snap.collections.find((c) => c.kind === 'reading_list')!;
    expect(readingList.ordered).toBe(true);
    expect(readingList.members).toEqual([
      { externalRef: '502', position: 0 }, // earliest chapter order wins; positions densify
      { externalRef: '501', position: 1 },
    ]);
    const absCol = snap.collections.find((c) => c.source === 'audiobookshelf')!;
    expect(absCol).toMatchObject({ ordered: true, libraryId: 'lib-1', itemCount: 2 });
    expect(absCol.members).toEqual([
      { externalRef: 'a2', position: 0 },
      { externalRef: 'a1', position: 1 },
    ]);

    const report = await syncBooksCollections({
      db: t.db,
      collections: snap.collections,
      scopedFamilies: snap.scopedFamilies,
    });
    expect(report.collectionsUpserted).toBe(3);
    expect(report.membersUpserted).toBe(6);
    expect(report.membersResolved).toBe(6); // every ref has a live mirror row
    expect(await collectionKeys(t.db)).toEqual([
      'audiobookshelf/collection/col-abs-1',
      'kavita/collection/4',
      'kavita/reading_list/11',
    ]);
    expect(
      (await memberRows(t.db, 'col-abs-1', 'collection')).map((m) => `${m.externalRef}@${m.position}`),
    ).toEqual(['a2@0', 'a1@1']);
  });

  it('a Kavita outage unscopes ONLY the Kavita families — ABS still mirrors, nothing of Kavita reconciles', async () => {
    const downKavita = fakeKavita({
      listCollections: async () => {
        throw new Error('kavita down');
      },
      listReadingListsPage: async () => {
        throw new Error('kavita down');
      },
    } as Partial<KavitaClient>);
    const snap = await fetchBooksCollectionsSnapshot({ books: bundle(downKavita, fakeAbs()) });
    expect(snap.scopedFamilies).toEqual([{ source: 'audiobookshelf', kind: 'collection' }]);
    expect(snap.stats.unscopedFamilies).toBe(2);
    const report = await syncBooksCollections({
      db: t.db,
      collections: snap.collections,
      scopedFamilies: snap.scopedFamilies,
    });
    expect(report.collectionsRemoved).toBe(0);
    // The prior Kavita mirror survives untouched.
    expect(await collectionKeys(t.db)).toEqual([
      'audiobookshelf/collection/col-abs-1',
      'kavita/collection/4',
      'kavita/reading_list/11',
    ]);
  });

  it('a failed MEMBER read keeps the collection row but never reconciles its members', async () => {
    const memberFailKavita = fakeKavita({
      listCollectionSeriesPage: async () => {
        throw new Error('series read failed');
      },
    } as Partial<KavitaClient>);
    const snap = await fetchBooksCollectionsSnapshot({ books: bundle(memberFailKavita, fakeAbs()) });
    const kavitaCol = snap.collections.find((c) => c.kind === 'collection' && c.source === 'kavita')!;
    expect(kavitaCol.fullyRead).toBe(false);
    expect(kavitaCol.members).toEqual([]);
    expect(snap.stats.truncatedCollections).toBe(1);
    // The listing itself succeeded, so the family IS scoped (a vanished collection would drop) —
    // but this collection's members are protected by its own un-fullyRead flag.
    expect(snap.scopedFamilies).toContainEqual({ source: 'kavita', kind: 'collection' });
    await syncBooksCollections({
      db: t.db,
      collections: snap.collections,
      scopedFamilies: snap.scopedFamilies,
    });
    expect((await memberRows(t.db, '4', 'collection')).map((m) => m.externalRef)).toEqual([
      '501',
      '502',
    ]);
  });

  it('reconciles a vanished reading list once its family reads fully again (members CASCADE)', async () => {
    const noListsKavita = fakeKavita({
      listReadingListsPage: async () => ({ items: [], total: 0, hasAuthoritativeTotal: true }),
    } as Partial<KavitaClient>);
    const snap = await fetchBooksCollectionsSnapshot({ books: bundle(noListsKavita, fakeAbs()) });
    const report = await syncBooksCollections({
      db: t.db,
      collections: snap.collections,
      scopedFamilies: snap.scopedFamilies,
    });
    expect(report.collectionsRemoved).toBe(1); // reading list 11 vanished from the scoped family
    expect(await collectionKeys(t.db)).toEqual([
      'audiobookshelf/collection/col-abs-1',
      'kavita/collection/4',
    ]);
    expect(await memberRows(t.db, '11', 'reading_list')).toHaveLength(0);
  });

  // Adversarial-review fix — a page-length total is NOT authoritative: a FULL page without the
  // Pagination header can never prove completion, so degradation is keep-don't-reconcile.
  describe('missing/malformed Pagination header (the non-authoritative-total contract)', () => {
    it('a FULL member page WITHOUT an authoritative total is TRUNCATED — never member-reconciled', async () => {
      const fullPageKavita = fakeKavita({
        listCollectionSeriesPage: async () => ({
          items: Array.from({ length: KAVITA_COLLECTION_PAGE_SIZE }, (_, i) => ({
            id: 10_000 + i,
            name: `Tail Book ${i}`,
            libraryId: 1,
          })),
          total: KAVITA_COLLECTION_PAGE_SIZE, // the legacy page-length fallback value
          hasAuthoritativeTotal: false,
        }),
      } as Partial<KavitaClient>);
      const snap = await fetchBooksCollectionsSnapshot({ books: bundle(fullPageKavita, fakeAbs()) });
      const kavitaCol = snap.collections.find((c) => c.kind === 'collection' && c.source === 'kavita')!;
      expect(kavitaCol.fullyRead).toBe(false); // cannot prove completion — truncated
      expect(kavitaCol.members).toHaveLength(KAVITA_COLLECTION_PAGE_SIZE);
      expect(snap.stats.truncatedCollections).toBe(1);
      // The write keeps the previously-mirrored members alongside the fresh page: ZERO deletes.
      const report = await syncBooksCollections({
        db: t.db,
        collections: snap.collections,
        scopedFamilies: snap.scopedFamilies,
      });
      expect(report.membersRemoved).toBe(0);
      expect(report.collectionsRemoved).toBe(0);
      const members = await memberRows(t.db, '4', 'collection');
      expect(members).toHaveLength(KAVITA_COLLECTION_PAGE_SIZE + 2); // the fresh page + old 501/502
      expect(members.map((m) => m.externalRef)).toEqual(expect.arrayContaining(['501', '502']));
    });

    it('a SHORT member page WITHOUT a header is an honest completion (fullyRead)', async () => {
      const shortPageKavita = fakeKavita({
        listCollectionSeriesPage: async () => ({
          items: [
            { id: 501, name: 'HP Book 1', libraryId: 1 },
            { id: 502, name: 'HP Book 2', libraryId: 1 },
          ],
          total: 2,
          hasAuthoritativeTotal: false,
        }),
      } as Partial<KavitaClient>);
      const snap = await fetchBooksCollectionsSnapshot({ books: bundle(shortPageKavita, fakeAbs()) });
      const kavitaCol = snap.collections.find((c) => c.kind === 'collection' && c.source === 'kavita')!;
      expect(kavitaCol.fullyRead).toBe(true);
      expect(snap.stats.truncatedCollections).toBe(0);
      // A fully-read write reconciles the truncation-test tail back out (the rebuildable cache).
      const report = await syncBooksCollections({
        db: t.db,
        collections: snap.collections,
        scopedFamilies: snap.scopedFamilies,
      });
      expect(report.membersRemoved).toBe(KAVITA_COLLECTION_PAGE_SIZE);
      expect((await memberRows(t.db, '4', 'collection')).map((m) => m.externalRef).sort()).toEqual([
        '501',
        '502',
      ]);
    });

    it('a FULL reading-list LISTING page WITHOUT a header never scopes the family (no hard-deletes)', async () => {
      // Seed reading list 11 back first (it reconciled away in the vanish test above).
      await syncBooksCollections({
        db: t.db,
        collections: [
          {
            source: 'kavita',
            externalId: '11',
            kind: 'reading_list',
            libraryId: null,
            title: 'HP Reading Order',
            itemCount: 2,
            ordered: true,
            createdBy: 'kavita',
            members: [{ externalRef: '501', position: 0 }],
            fullyRead: true,
          },
        ],
        scopedFamilies: [],
      });
      // The truncated listing returns a FULL page of OTHER lists — 11 is beyond the page.
      const fullListingKavita = fakeKavita({
        listReadingListsPage: async () => ({
          items: Array.from({ length: KAVITA_READING_LIST_PAGE_SIZE }, (_, i) => ({
            id: 5_000 + i,
            title: `Tail List ${i}`,
            promoted: false,
            itemCount: 0,
          })),
          total: KAVITA_READING_LIST_PAGE_SIZE, // the legacy page-length fallback value
          hasAuthoritativeTotal: false,
        }),
        listReadingListItems: async () => [],
      } as Partial<KavitaClient>);
      const snap = await fetchBooksCollectionsSnapshot({ books: bundle(fullListingKavita, fakeAbs()) });
      expect(snap.scopedFamilies).not.toContainEqual({ source: 'kavita', kind: 'reading_list' });
      expect(snap.stats.unscopedFamilies).toBe(1);
      const report = await syncBooksCollections({
        db: t.db,
        collections: snap.collections,
        scopedFamilies: snap.scopedFamilies,
      });
      // List 11 is ABSENT from the truncated listing yet SURVIVES (the family never reconciles).
      expect(report.collectionsRemoved).toBe(0);
      expect(await collectionKeys(t.db)).toContain('kavita/reading_list/11');
    });

    it('a SHORT listing page WITHOUT a header is an honest completion (family scoped)', async () => {
      const snap = await fetchBooksCollectionsSnapshot({
        books: bundle(
          fakeKavita({
            listReadingListsPage: async () => ({
              items: [{ id: 11, title: 'HP Reading Order', promoted: false, itemCount: 3 }],
              total: 1,
              hasAuthoritativeTotal: false,
            }),
          } as Partial<KavitaClient>),
          fakeAbs(),
        ),
      });
      expect(snap.scopedFamilies).toContainEqual({ source: 'kavita', kind: 'reading_list' });
      expect(snap.stats.unscopedFamilies).toBe(0);
    });
  });
});
