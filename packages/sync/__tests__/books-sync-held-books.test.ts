// Issue #661 (DESIGN-024 D-03 amendment 2026-10-04) — the books-sync's held-books read, end to end through
// runSync: the change-gate loader carries `attrs.heldBooks` forward for an unchanged series, including a
// BOOK row with no author (re-enriched every run for the writers fallback, but never re-read for its held
// books once they are stored). Embedded PG16; stub Kavita/ABS clients (no live API — ADR-010).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { booksItems } from '@hnet/db';
import { syncBooks, type BooksItemInput } from '@hnet/domain';
import type { KavitaSeries, KavitaVolume } from '@hnet/books';
import { runSync } from '../src/orchestrator';
import type { BooksSyncBundle } from '../src/books';
import type { SyncClients } from '../src/clients';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;
beforeAll(async () => {
  t = await bootMigratedDb();
});
afterAll(async () => {
  await t?.stop();
});

const STAMP = '2026-07-09T12:00:00';

// Murtagh's live shape: no author folder (flat layout) and no series writer, so the row author is null.
const flatSeries = {
  id: 457,
  name: 'The Inheritance Cycle',
  sortName: 'Inheritance Cycle',
  format: 3,
  libraryId: 1,
  libraryName: 'Books',
  pages: 700,
  folderPath: '/data/EBooks/The Inheritance Cycle',
  lowestFolderPath: '/data/EBooks/The Inheritance Cycle',
  lastChapterAddedUtc: STAMP,
} as unknown as KavitaSeries;

const MURTAGH: KavitaVolume[] = [
  { name: '5', chapters: [{ title: '-100000', titleName: 'Murtagh', isbn: '', writers: [{ name: 'Christopher Paolini' }] }] },
];

function stubBundle() {
  const volumeCalls: string[] = [];
  const metadataCalls: string[] = [];
  const bundle = {
    kavitaPublicUrl: 'https://kavita.example',
    audiobookshelfPublicUrl: 'https://abs.example',
    kavita: {
      listLibraries: async () => [{ id: 1, name: 'Books', type: 2 }],
      listSeriesPage: async () => ({ items: [flatSeries], total: 1, hasAuthoritativeTotal: true }),
      getSeriesMetadata: async (id: string) => {
        metadataCalls.push(id);
        return { summary: 'A dragon rider.', genres: [], publishers: [], writers: [], language: 'en', releaseYear: 2023 };
      },
      listSeriesVolumes: async (id: string) => {
        volumeCalls.push(id);
        return MURTAGH;
      },
    },
    audiobookshelf: {
      listLibraries: async () => [],
      getMe: async () => ({ mediaProgress: [] }),
    },
  } as unknown as BooksSyncBundle;
  return { bundle, volumeCalls, metadataCalls };
}

describe('runSync --mode=books-sync — the held books (issue #661)', () => {
  it('reads a series once, then carries its held books forward, even for a row with no author', async () => {
    const first = stubBundle();
    const r1 = await runSync({ mode: 'books-sync', clients: {} as SyncClients, db: t.db, books: first.bundle });
    expect(r1.totalFailure).toBe(false);
    expect(first.volumeCalls).toEqual(['457']);
    const [row] = await t.db.select().from(booksItems).where(eq(booksItems.externalId, '457'));
    expect(row!.author).toBeNull(); // the live Murtagh row: no folder author, no series writer
    expect((row!.attrs as Record<string, unknown>).heldBooks).toEqual([
      { title: 'Murtagh', author: 'Christopher Paolini', isbn: null },
    ]);

    // The series is unchanged: the authorless row is still re-enriched (the writers fallback), but its
    // held books are carried forward, not re-read.
    const second = stubBundle();
    await runSync({ mode: 'books-sync', clients: {} as SyncClients, db: t.db, books: second.bundle });
    expect(second.metadataCalls).toEqual(['457']);
    expect(second.volumeCalls).toEqual([]);
    const [after] = await t.db.select().from(booksItems).where(eq(booksItems.externalId, '457'));
    expect((after!.attrs as Record<string, unknown>).heldBooks).toEqual([
      { title: 'Murtagh', author: 'Christopher Paolini', isbn: null },
    ]);
    expect(after!.summary).toBe('A dragon rider.');
  });

  it('backfills a pre-#661 row (no heldBooks key) once, without re-fetching its metadata', async () => {
    const row: BooksItemInput = {
      source: 'kavita',
      mediaKind: 'book',
      externalId: '659',
      libraryId: '1',
      libraryName: 'Books',
      title: 'A Song of Ice and Fire',
      sortTitle: 'song of ice and fire',
      author: 'George R.R. Martin',
      narrator: null,
      seriesName: null,
      year: null,
      releasedAt: null,
      genres: [],
      coverRef: null,
      deepLinkUrl: 'https://kavita.example/library/1/series/659',
      pageCount: null,
      wordCount: null,
      durationSeconds: null,
      sizeBytes: null,
      attrs: { format: 3, language: 'en' },
      sourceAddedAt: null,
      sourceUpdatedAt: new Date(STAMP),
      summary: 'Kept',
      metadataSyncedAt: new Date('2026-07-16T00:00:00Z'),
    };
    await syncBooks({ db: t.db, rows: [row], syncedSources: [] });
    const series = {
      ...flatSeries,
      id: 659,
      name: 'A Song of Ice and Fire',
      folderPath: '/data/EBooks/George R.R. Martin',
      lowestFolderPath: '/data/EBooks/George R.R. Martin/A Song of Ice and Fire',
    } as unknown as KavitaSeries;
    const s = stubBundle();
    (s.bundle.kavita as unknown as { listSeriesPage: unknown }).listSeriesPage = async () => ({
      items: [series],
      total: 1,
      hasAuthoritativeTotal: true,
    });
    (s.bundle.kavita as unknown as { listSeriesVolumes: unknown }).listSeriesVolumes = async (id: string) => {
      s.volumeCalls.push(id);
      return [{ name: '0.5', chapters: [{ title: '-100000', titleName: 'Fire & Blood', isbn: '9781524796280', writers: [{ name: 'George R. R. Martin' }] }] }];
    };
    await runSync({ mode: 'books-sync', clients: {} as SyncClients, db: t.db, books: s.bundle });
    expect(s.volumeCalls).toEqual(['659']);
    expect(s.metadataCalls).toEqual([]); // unchanged and enriched: the metadata gate is untouched
    const [after] = await t.db.select().from(booksItems).where(eq(booksItems.externalId, '659'));
    expect((after!.attrs as Record<string, unknown>).heldBooks).toEqual([
      { title: 'Fire & Blood', author: 'George R. R. Martin', isbn: '9781524796280' },
    ]);
    expect(after!.summary).toBe('Kept');
  });
});
