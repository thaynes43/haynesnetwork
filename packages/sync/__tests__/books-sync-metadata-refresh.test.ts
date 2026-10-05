// Issue #712 — a metadata-only edit in Kavita (the language tag of 18 series, 2026-10-05) reaches
// `books_items.attrs.language` on the next books-sync even though the series' list stamp did not move. End to end
// through runSync on embedded PG16, stub Kavita/ABS clients (no live API — ADR-010).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { booksItems } from '@hnet/db';
import { syncBooks, type BooksItemInput } from '@hnet/domain';
import type { KavitaSeries } from '@hnet/books';
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

const STAMP = '2026-07-10T16:47:24';
const series = {
  id: 697,
  name: 'An English Book',
  sortName: 'English Book',
  format: 3,
  libraryId: 1,
  libraryName: 'Books',
  pages: 300,
  folderPath: '/data/EBooks/Some Author',
  lowestFolderPath: '/data/EBooks/Some Author/An English Book',
  lastChapterAddedUtc: STAMP,
} as unknown as KavitaSeries;

const mirrorRow = (language: string): BooksItemInput => ({
  source: 'kavita',
  mediaKind: 'book',
  externalId: '697',
  libraryId: '1',
  libraryName: 'Books',
  title: 'An English Book',
  sortTitle: 'english book',
  author: 'Some Author',
  narrator: null,
  seriesName: null,
  year: null,
  releasedAt: null,
  genres: [],
  coverRef: null,
  deepLinkUrl: 'https://kavita.example/library/1/series/697',
  pageCount: null,
  wordCount: null,
  durationSeconds: null,
  sizeBytes: null,
  // Held books already stored: only the metadata gate is under test.
  attrs: { format: 3, language, heldBooks: [{ title: 'An English Book', author: 'Some Author', isbn: null }] },
  sourceAddedAt: null,
  sourceUpdatedAt: new Date(STAMP),
  summary: 'Old summary',
  metadataSyncedAt: new Date('2026-07-17T00:00:00Z'),
});

function stubBundle(language: string) {
  const metadataCalls: string[] = [];
  const bundle = {
    kavitaPublicUrl: 'https://kavita.example',
    audiobookshelfPublicUrl: 'https://abs.example',
    kavita: {
      listLibraries: async () => [{ id: 1, name: 'Books', type: 2 }],
      listSeriesPage: async () => ({ items: [series], total: 1, hasAuthoritativeTotal: true }),
      getSeriesMetadata: async (id: string) => {
        metadataCalls.push(id);
        return { summary: 'New summary', genres: [], publishers: [], writers: [{ name: 'Some Author' }], language, releaseYear: 2009 };
      },
      listSeriesVolumes: async () => [],
    },
    audiobookshelf: { listLibraries: async () => [], getMe: async () => ({ mediaProgress: [] }) },
  } as unknown as BooksSyncBundle;
  return { bundle, metadataCalls };
}

describe('runSync --mode=books-sync — metadata edits (issue #712)', () => {
  it('a language corrected in Kavita (list stamp unchanged) reaches attrs.language, and stays once English', async () => {
    await syncBooks({ db: t.db, rows: [mirrorRow('nl')], syncedSources: [] });

    const first = stubBundle('en');
    const r1 = await runSync({ mode: 'books-sync', clients: {} as SyncClients, db: t.db, books: first.bundle });
    expect(r1.totalFailure).toBe(false);
    expect(first.metadataCalls).toEqual(['697']);
    const [row] = await t.db.select().from(booksItems).where(eq(booksItems.externalId, '697'));
    expect((row!.attrs as Record<string, unknown>).language).toBe('en');
    expect(row!.summary).toBe('New summary');
    expect(row!.metadataSyncedAt!.getTime()).toBeGreaterThan(new Date('2026-07-17T00:00:00Z').getTime());

    // Now English and freshly read: the next run is gated out again (no per-run cost once fixed).
    const second = stubBundle('en');
    await runSync({ mode: 'books-sync', clients: {} as SyncClients, db: t.db, books: second.bundle });
    expect(second.metadataCalls).toEqual([]);
  });

  it('an English series with a stale read picks up a metadata-only edit through the rolling refresh', async () => {
    await t.db.delete(booksItems).where(eq(booksItems.externalId, '697'));
    await syncBooks({ db: t.db, rows: [mirrorRow('en')], syncedSources: [] });
    const s = stubBundle('en');
    await runSync({ mode: 'books-sync', clients: {} as SyncClients, db: t.db, books: s.bundle });
    expect(s.metadataCalls).toEqual(['697']); // last read 2026-07-17, far past the minimum age
    const [row] = await t.db.select().from(booksItems).where(eq(booksItems.externalId, '697'));
    expect(row!.summary).toBe('New summary');
  });
});
