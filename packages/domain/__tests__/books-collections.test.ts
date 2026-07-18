// ADR-066 / DESIGN-038 D-04 (PLAN-051) — the syncBooksCollections single-writer: upsert on
// (source, external_id, kind), OPPORTUNISTIC member resolution against LIVE books_items rows
// (refreshed every run), and reconcile scoped to fully-read collections / (source, kind) families —
// a partial read never tombstones. Embedded PG16; books_items seeded through the sanctioned
// syncBooks writer (never a direct insert).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { booksCollections, booksCollectionMembers } from '@hnet/db';
import type { Database } from '@hnet/db';
import { syncBooks, syncBooksCollections, type BooksItemInput } from '../src';
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
