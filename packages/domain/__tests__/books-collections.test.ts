// ADR-066 / DESIGN-038 D-04 (PLAN-051) — the syncBooksCollections single-writer: upsert on
// (source, external_id, kind), OPPORTUNISTIC member resolution against LIVE books_items rows
// (refreshed every run), and reconcile scoped to fully-read collections / (source, kind) families —
// a partial read never tombstones. Embedded PG16; books_items seeded through the sanctioned
// syncBooks writer (never a direct insert).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { bookRequests, booksCollections, booksCollectionMembers } from '@hnet/db';
import type { BooksSource, Database } from '@hnet/db';
import { LibrettoUnreachableError } from '@hnet/libretto';
import {
  collectionMemberRef,
  getCollectionWantedBookRequests,
  getWantedBookRequests,
  runCollectionWantsSync,
  syncBooks,
  syncBooksCollections,
  syncCollectionWants,
  type BooksItemInput,
  type CollectionWantsLibretto,
} from '../src';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;

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

async function collectionRows(db: Database) {
  return db
    .select({
      source: booksCollections.source,
      externalId: booksCollections.externalId,
      kind: booksCollections.kind,
      title: booksCollections.title,
      ordered: booksCollections.ordered,
      createdBy: booksCollections.createdBy,
    })
    .from(booksCollections)
    .orderBy(
      asc(booksCollections.source),
      asc(booksCollections.kind),
      asc(booksCollections.externalId),
    );
}

async function memberRows(
  db: Database,
  externalId: string,
  kind: 'collection' | 'reading_list' = 'reading_list',
) {
  const [col] = await t.db
    .select({ id: booksCollections.id })
    .from(booksCollections)
    .where(and(eq(booksCollections.externalId, externalId), eq(booksCollections.kind, kind)));
  if (!col) return [];
  return t.db
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
  // The library mirror the member resolution reads: two Kavita books + one ABS audiobook.
  await syncBooks({
    db: t.db,
    syncedSources: ['kavita', 'audiobookshelf'],
    rows: [
      bookRow({ source: 'kavita', mediaKind: 'book', externalId: '501', title: 'HP Book 1' }),
      bookRow({ source: 'kavita', mediaKind: 'book', externalId: '502', title: 'HP Book 2' }),
      bookRow({
        source: 'audiobookshelf',
        mediaKind: 'audiobook',
        externalId: 'abs-1',
        title: 'Listen One',
      }),
    ],
  });
});

afterAll(async () => {
  await t?.stop();
});

describe('syncBooksCollections (ADR-066 / DESIGN-038 D-04)', () => {
  it('upserts collections + RAW members, resolving refs against LIVE books_items rows', async () => {
    const report = await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: 'kavita',
          externalId: '11',
          kind: 'reading_list',
          libraryId: null,
          title: 'HP Reading Order',
          itemCount: 3,
          ordered: true,
          createdBy: 'libretto', // marker present in the source summary
          category: null,
          members: [
            { externalRef: '501', position: 0 },
            { externalRef: '502', position: 1 },
            { externalRef: '999', position: 2 }, // no mirror row (e.g. a Manga-library series)
          ],
          fullyRead: true,
        },
        {
          source: 'audiobookshelf',
          externalId: 'col-abs-1',
          kind: 'collection',
          libraryId: 'lib-1',
          title: 'Discworld in Order',
          itemCount: 1,
          ordered: true,
          createdBy: 'audiobookshelf',
          category: null,
          members: [{ externalRef: 'abs-1', position: 0 }],
          fullyRead: true,
        },
      ],
      scopedFamilies: [
        { source: 'kavita', kind: 'reading_list' },
        { source: 'audiobookshelf', kind: 'collection' },
      ],
    });
    expect(report.collectionsUpserted).toBe(2);
    expect(report.membersUpserted).toBe(4);
    expect(report.membersResolved).toBe(3); // 501 + 502 + abs-1; '999' stays raw
    const members = await memberRows(t.db, '11');
    expect(members.map((m) => `${m.externalRef}:${m.booksItemId !== null}`)).toEqual([
      '501:true',
      '502:true',
      '999:false',
    ]);
  });

  it('the SAME Kavita id in the other kind space is a different row (identity includes kind)', async () => {
    await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: 'kavita',
          externalId: '11',
          kind: 'collection', // same id as the reading list above — a distinct id space
          libraryId: null,
          title: 'HP Collection',
          itemCount: 2,
          ordered: false,
          createdBy: 'kavita', // hand-made — no marker
          category: null,
          members: [{ externalRef: '501', position: 0 }],
          fullyRead: true,
        },
      ],
      scopedFamilies: [], // partial run — nothing reconciles
    });
    const rows = await collectionRows(t.db);
    expect(rows).toEqual([
      {
        source: 'audiobookshelf',
        externalId: 'col-abs-1',
        kind: 'collection',
        title: 'Discworld in Order',
        ordered: true,
        createdBy: 'audiobookshelf',
      },
      {
        source: 'kavita',
        externalId: '11',
        kind: 'collection',
        title: 'HP Collection',
        ordered: false,
        createdBy: 'kavita',
      },
      // Provenance persisted through the upsert — the marker-derived 'libretto' for the reading list.
      {
        source: 'kavita',
        externalId: '11',
        kind: 'reading_list',
        title: 'HP Reading Order',
        ordered: true,
        createdBy: 'libretto',
      },
    ]);
  });

  it('a non-fullyRead collection never member-tombstones; unscoped families never collection-tombstone', async () => {
    // Re-sync the reading list with ONE member and fullyRead: false — 501/502/999 must survive.
    const report = await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: 'kavita',
          externalId: '11',
          kind: 'reading_list',
          libraryId: null,
          title: 'HP Reading Order',
          itemCount: 3,
          ordered: true,
          createdBy: 'libretto',
          category: null,
          members: [{ externalRef: '501', position: 0 }],
          fullyRead: false,
        },
      ],
      scopedFamilies: [], // the ABS family was not read this run — its collection must survive
    });
    expect(report.membersRemoved).toBe(0);
    expect(report.collectionsRemoved).toBe(0);
    expect((await memberRows(t.db, '11')).map((m) => m.externalRef).sort()).toEqual([
      '501',
      '502',
      '999',
    ]);
    expect((await collectionRows(t.db)).length).toBe(3);
  });

  it('reconciles vanished members (fully-read) and vanished collections (scoped family; CASCADE)', async () => {
    const report = await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: 'kavita',
          externalId: '11',
          kind: 'reading_list',
          libraryId: null,
          title: 'HP Reading Order (renamed)',
          itemCount: 2,
          ordered: true,
          createdBy: 'libretto',
          category: null,
          members: [
            { externalRef: '502', position: 0 },
            { externalRef: '501', position: 1 }, // reordered — positions advance on upsert
          ],
          fullyRead: true,
        },
      ],
      // BOTH kavita families fully read this run — the 'HP Collection' (kavita/collection) vanished.
      scopedFamilies: [
        { source: 'kavita', kind: 'reading_list' },
        { source: 'kavita', kind: 'collection' },
      ],
    });
    expect(report.membersRemoved).toBe(1); // '999' left the fully-read list
    expect(report.collectionsRemoved).toBe(1); // kavita/collection '11' vanished (members CASCADE)
    expect(await memberRows(t.db, '11')).toEqual([
      { externalRef: '502', booksItemId: expect.any(String), position: 0 },
      { externalRef: '501', booksItemId: expect.any(String), position: 1 },
    ]);
    // The unscoped ABS collection survived untouched.
    const rows = await collectionRows(t.db);
    expect(rows.map((r) => `${r.source}/${r.kind}/${r.externalId}`)).toEqual([
      'audiobookshelf/collection/col-abs-1',
      'kavita/reading_list/11',
    ]);
    expect(rows[1]?.title).toBe('HP Reading Order (renamed)');
  });

  it('the resolution REFRESHES every run — a tombstoned item nulls, a re-appeared one resolves', async () => {
    // Tombstone 502 (a fully-synced kavita run without it), keep 501.
    await syncBooks({
      db: t.db,
      syncedSources: ['kavita'],
      rows: [
        bookRow({ source: 'kavita', mediaKind: 'book', externalId: '501', title: 'HP Book 1' }),
      ],
    });
    await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: 'kavita',
          externalId: '11',
          kind: 'reading_list',
          libraryId: null,
          title: 'HP Reading Order (renamed)',
          itemCount: 2,
          ordered: true,
          createdBy: 'libretto',
          category: null,
          members: [
            { externalRef: '502', position: 0 },
            { externalRef: '501', position: 1 },
          ],
          fullyRead: true,
        },
      ],
      scopedFamilies: [{ source: 'kavita', kind: 'reading_list' }],
    });
    expect(
      (await memberRows(t.db, '11')).map((m) => `${m.externalRef}:${m.booksItemId !== null}`),
    ).toEqual([
      '502:false', // tombstoned — resolution nulled (drops off the wall count)
      '501:true',
    ]);
  });

  it('CATEGORY (D-12) — a source value wins, a null PRESERVES the prior (agent-set survives re-sync)', async () => {
    const readCategory = async (externalId: string, kind: 'reading_list' | 'collection') => {
      const [row] = await t.db
        .select({ category: booksCollections.category })
        .from(booksCollections)
        .where(and(eq(booksCollections.externalId, externalId), eq(booksCollections.kind, kind)));
      return row?.category ?? null;
    };
    const upsert = (category: string | null, title = 'Cat List') =>
      syncBooksCollections({
        db: t.db,
        collections: [
          {
            source: 'kavita',
            externalId: 'cat-1',
            kind: 'reading_list',
            libraryId: null,
            title,
            itemCount: 1,
            ordered: true,
            createdBy: 'libretto',
            category,
            members: [{ externalRef: '501', position: 0 }],
            fullyRead: true,
          },
        ],
        scopedFamilies: [{ source: 'kavita', kind: 'reading_list' }],
      });

    // 1. INSERT with a source-derived category (a Libretto `cat=` marker) — stored verbatim.
    await upsert('Series');
    expect(await readCategory('cat-1', 'reading_list')).toBe('Series');

    // 2. Agent-set path: an app/agent sets the category directly on the mirror row (the ratified L2).
    await t.db
      .update(booksCollections)
      .set({ category: 'Event' })
      .where(
        and(eq(booksCollections.externalId, 'cat-1'), eq(booksCollections.kind, 'reading_list')),
      );

    // 3. A re-sync whose source carries NO `cat=` marker (category null) PRESERVES the agent-set value.
    await upsert(null, 'Cat List (renamed)');
    expect(await readCategory('cat-1', 'reading_list')).toBe('Event');

    // 4. A re-sync whose source DOES carry a `cat=` marker WINS (mirror doctrine — source authoritative).
    await upsert('List');
    expect(await readCategory('cat-1', 'reading_list')).toBe('List');
  });
});

// DESIGN-038 D-13 — the COLLECTION Wanted-tiles pass: a books/audiobooks collection's MISSING members
// minted as book_requests (origin='collection'), rebuilt from Libretto's current missing set. Shares this
// file's booted DB (one embedded PG per file — no new instance). The describe-scoped beforeEach wipes
// book_requests + books_collections, which is safe: the mirror describe above has already run.
describe('collection wants (DESIGN-038 D-13 — Wanted tiles from Libretto missing set)', () => {
  beforeEach(async () => {
    await t.db.delete(bookRequests);
    await t.db.delete(booksCollections);
  });

  async function seedCollection(opts: {
    source: BooksSource;
    externalId: string;
    recipeId: string;
  }): Promise<string> {
    await syncBooksCollections({
      db: t.db,
      collections: [
        {
          source: opts.source,
          externalId: opts.externalId,
          kind: 'collection',
          libraryId: null,
          title: `Collection ${opts.externalId}`,
          itemCount: 0,
          ordered: false,
          createdBy: 'libretto',
          librettoRecipeId: opts.recipeId,
          category: null,
          members: [],
          fullyRead: true,
        },
      ],
      // No scoped family ⇒ no reconcile: seeding a 2nd collection must not tombstone the 1st.
      scopedFamilies: [],
    });
    const [row] = await t.db
      .select({ id: booksCollections.id })
      .from(booksCollections)
      .where(
        and(
          eq(booksCollections.externalId, opts.externalId),
          eq(booksCollections.kind, 'collection'),
        ),
      );
    if (!row) throw new Error('collection seed returned no row');
    return row.id;
  }

  async function wantRows(collectionId: string) {
    return t.db
      .select({
        memberRef: bookRequests.collectionMemberRef,
        title: bookRequests.title,
        ebookStatus: bookRequests.ebookStatus,
        audioStatus: bookRequests.audioStatus,
        llBookId: bookRequests.llBookId,
        origin: bookRequests.origin,
      })
      .from(bookRequests)
      .where(eq(bookRequests.collectionId, collectionId));
  }

  it('collectionMemberRef prefers ISBN, then an identifier, then the normalized title', () => {
    expect(collectionMemberRef({ isbn: '9781234567890', title: 'X' })).toBe('isbn:9781234567890');
    expect(collectionMemberRef({ identifiers: ['asin:B01'], title: 'X' })).toBe('asin:B01');
    expect(collectionMemberRef({ title: 'The Way of Kings' })).toBe('title:way of kings');
    expect(collectionMemberRef({ title: '   ' })).toBeNull();
  });

  it('mints one origin=collection want per missing member (ebook active, audio landed)', async () => {
    const id = await seedCollection({ source: 'kavita', externalId: 'k1', recipeId: 'r1' });
    const res = await syncCollectionWants({
      db: t.db,
      collectionId: id,
      format: 'ebook',
      members: [
        { memberRef: 'isbn:1', title: 'Book One', author: 'A', llBookId: 'gb1' },
        { memberRef: 'isbn:2', title: 'Book Two', author: null, llBookId: null },
      ],
    });
    expect(res.minted).toBe(2);
    expect(res.removed).toBe(0);
    const rows = await wantRows(id);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.origin).toBe('collection');
      expect(r.ebookStatus).not.toBe('landed');
      expect(r.audioStatus).toBe('landed');
    }
    expect(rows.find((r) => r.memberRef === 'isbn:1')?.llBookId).toBe('gb1');
  });

  it('is IDEMPOTENT — a re-run of the same missing set dupes nothing', async () => {
    const id = await seedCollection({ source: 'kavita', externalId: 'k1', recipeId: 'r1' });
    const members = [{ memberRef: 'isbn:1', title: 'Book One', author: 'A', llBookId: 'gb1' }];
    await syncCollectionWants({ db: t.db, collectionId: id, format: 'ebook', members });
    const second = await syncCollectionWants({ db: t.db, collectionId: id, format: 'ebook', members });
    expect(second.minted).toBe(0);
    expect(second.updated).toBe(1);
    expect(await wantRows(id)).toHaveLength(1);
  });

  it('RECONCILES — a member no longer missing (became held) resolves its want', async () => {
    const id = await seedCollection({ source: 'kavita', externalId: 'k1', recipeId: 'r1' });
    await syncCollectionWants({
      db: t.db,
      collectionId: id,
      format: 'ebook',
      members: [
        { memberRef: 'isbn:1', title: 'One', author: null, llBookId: null },
        { memberRef: 'isbn:2', title: 'Two', author: null, llBookId: null },
      ],
    });
    const res = await syncCollectionWants({
      db: t.db,
      collectionId: id,
      format: 'ebook',
      members: [{ memberRef: 'isbn:1', title: 'One', author: null, llBookId: null }],
    });
    expect(res.removed).toBe(1);
    expect((await wantRows(id)).map((r) => r.memberRef)).toEqual(['isbn:1']);
  });

  it('an AUDIOBOOK collection runs the audio format (ebook landed)', async () => {
    const id = await seedCollection({ source: 'audiobookshelf', externalId: 'a1', recipeId: 'ar1' });
    await syncCollectionWants({
      db: t.db,
      collectionId: id,
      format: 'audiobook',
      members: [{ memberRef: 'isbn:1', title: 'Listen', author: null, llBookId: null }],
    });
    const [row] = await wantRows(id);
    expect(row?.audioStatus).not.toBe('landed');
    expect(row?.ebookStatus).toBe('landed');
  });

  it('empty missing set removes all of a collection’s wants (a full collection)', async () => {
    const id = await seedCollection({ source: 'kavita', externalId: 'k1', recipeId: 'r1' });
    await syncCollectionWants({
      db: t.db,
      collectionId: id,
      format: 'ebook',
      members: [{ memberRef: 'isbn:1', title: 'One', author: null, llBookId: null }],
    });
    const res = await syncCollectionWants({ db: t.db, collectionId: id, format: 'ebook', members: [] });
    expect(res.removed).toBe(1);
    expect(await wantRows(id)).toHaveLength(0);
  });

  it('getCollectionWantedBookRequests returns the collection’s live wants; the household overlay never sees them', async () => {
    const id = await seedCollection({ source: 'kavita', externalId: 'k1', recipeId: 'r1' });
    await syncCollectionWants({
      db: t.db,
      collectionId: id,
      format: 'ebook',
      members: [{ memberRef: 'isbn:1', title: 'One', author: 'Sanderson', llBookId: 'gb1' }],
    });
    const views = await getCollectionWantedBookRequests({ db: t.db, collectionId: id });
    expect(views).toHaveLength(1);
    expect(views[0]?.origin).toBe('collection');
    expect(views[0]?.integrationUserId).toBeNull();
    expect(views[0]?.llBookId).toBe('gb1');
    // Isolation: a collection want NEVER appears in the top-level wall's household overlay.
    expect(await getWantedBookRequests({ db: t.db, format: 'ebook' })).toHaveLength(0);
  });

  describe('runCollectionWantsSync — the Libretto pass', () => {
    function stubLibretto(over: Partial<CollectionWantsLibretto> = {}): CollectionWantsLibretto {
      return {
        listMissingMembers: async () => ({
          missing: [{ title: 'Missing One', authors: ['Author'], isbn: '9781', identifiers: [] }],
        }),
        resolve: async () => ({ volumeId: 'gbResolved' }),
        ...over,
      } as CollectionWantsLibretto;
    }

    it('mints wants from listMissingMembers and resolves the LL id', async () => {
      const id = await seedCollection({ source: 'kavita', externalId: 'k1', recipeId: 'r1' });
      const report = await runCollectionWantsSync({ db: t.db, libretto: stubLibretto() });
      expect(report.collectionsProcessed).toBe(1);
      expect(report.minted).toBe(1);
      expect(report.resolved).toBe(1);
      const rows = await wantRows(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.llBookId).toBe('gbResolved');
    });

    it('skips ONLY the failing collection on a per-collection read error', async () => {
      const good = await seedCollection({ source: 'kavita', externalId: 'k1', recipeId: 'good' });
      await seedCollection({ source: 'kavita', externalId: 'k2', recipeId: 'bad' });
      const libretto = stubLibretto({
        listMissingMembers: async (recipeId: string) => {
          if (recipeId === 'bad') throw new Error('boom');
          return { missing: [{ title: 'Only', identifiers: ['isbn:1'] }] };
        },
      });
      const report = await runCollectionWantsSync({ db: t.db, libretto });
      expect(report.collectionsSkipped).toBe(1);
      expect(report.collectionsProcessed).toBe(1);
      expect(await wantRows(good)).toHaveLength(1);
    });

    it('DEGRADES on Libretto unreachable — no mint, no reconcile', async () => {
      const id = await seedCollection({ source: 'kavita', externalId: 'k1', recipeId: 'r1' });
      await syncCollectionWants({
        db: t.db,
        collectionId: id,
        format: 'ebook',
        members: [{ memberRef: 'isbn:pre', title: 'Prior', author: null, llBookId: null }],
      });
      const libretto = stubLibretto({
        listMissingMembers: async () => {
          throw new LibrettoUnreachableError('GET', '/api/collections/r1/missing');
        },
      });
      const report = await runCollectionWantsSync({ db: t.db, libretto });
      expect(report.unreachable).toBe(true);
      expect(report.minted).toBe(0);
      expect(await wantRows(id)).toHaveLength(1); // the prior want SURVIVES (never reconciled)
    });
  });
});
