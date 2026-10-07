// Issue #661 (DESIGN-024 D-03 amendment 2026-10-04) — the books-sync's held-books read, end to end through
// runSync: the change-gate loader carries `attrs.heldBooks` forward for an unchanged series, including a
// BOOK row with no author (re-enriched every run for the writers fallback, but never re-read for its held
// books once they are stored). Embedded PG16; stub Kavita/ABS clients (no live API — ADR-010).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { bookRequests, booksItems } from '@hnet/db';
import {
  insertBookRequest,
  runFormatPairing,
  syncBooks,
  withRequestEventScope, type BooksItemInput,
  type LazyLibrarianClientBundle,
  type LlSnapshotRow,
} from '@hnet/domain';
import type { KavitaSeries, KavitaVolume } from '@hnet/books';
import { runSync } from '../src/orchestrator';
import type { BooksSyncBundle } from '../src/books';
import type { SyncClients } from '../src/clients';
import { bootMigratedDb, type TestDb } from './helpers';

let t: TestDb;
afterEach(() => {
  vi.unstubAllEnvs();
});
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
  { name: '5', chapters: [{ title: '-100000', titleName: 'Murtagh', isbn: '', writers: [{ name: 'Christopher Paolini' }],
      },
    ],
  },
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
        return { summary: 'A dragon rider.', genres: [], publishers: [], writers: [], language: 'en', releaseYear: 2023,
        };
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
    const r1 = await runSync({ mode: 'books-sync', clients: {} as SyncClients, db: t.db, books: first.bundle,
    });
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
    await runSync({ mode: 'books-sync', clients: {} as SyncClients, db: t.db, books: second.bundle,
    });
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
      pageCount: 700,
      wordCount: null,
      durationSeconds: null,
      sizeBytes: null,
      attrs: { format: 3, language: 'en' },
      sourceAddedAt: null,
      sourceUpdatedAt: new Date(STAMP),
      summary: 'Kept',
      // Just read: inside the rolling-refresh minimum age (issue #712), so only the gate decides.
      metadataSyncedAt: new Date(),
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
    (s.bundle.kavita as unknown as { listSeriesVolumes: unknown }).listSeriesVolumes = async (id: string,
    ) => {
      s.volumeCalls.push(id);
      return [{ name: '0.5', chapters: [{ title: '-100000', titleName: 'Fire & Blood', isbn: '9781524796280', writers: [{ name: 'George R. R. Martin' }],
            },
          ],
        },
      ];
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

describe('runSync --mode=books-sync — a flat-layout author survives a carried-forward run (issue #761)', () => {
  it('keeps the writers-derived author when the series is unchanged, and does not re-fetch it', async () => {
    const series = {
      ...flatSeries,
      id: 761,
      name: 'Wool',
      folderPath: '/data/EBooks/Wool',
      lowestFolderPath: '/data/EBooks/Wool',
    } as unknown as KavitaSeries;
    const bundle = () => {
      const metadataCalls: string[] = [];
      const b = {
        ...stubBundle().bundle,
        kavita: {
          listLibraries: async () => [{ id: 1, name: 'Books', type: 2 }],
          listSeriesPage: async () => ({ items: [series], total: 1, hasAuthoritativeTotal: true }),
          getSeriesMetadata: async (id: string) => {
            metadataCalls.push(id);
            return { summary: 'A silo.', genres: [], publishers: [], writers: [{ name: 'Hugh Howey' }], language: 'en', releaseYear: 2011,
            };
          },
          listSeriesVolumes: async () => [{ name: '1', chapters: [{ title: '-100000', titleName: 'Wool', isbn: '', writers: [] }],
            },
          ],
        },
      } as unknown as BooksSyncBundle;
      return { b, metadataCalls };
    };
    const authorOf = async () => (await t.db.select().from(booksItems).where(eq(booksItems.externalId, '761')))[0]!.author;

    const first = bundle();
    await runSync({ mode: 'books-sync', clients: {} as SyncClients, db: t.db, books: first.b });
    expect(first.metadataCalls).toEqual(['761']);
    expect(await authorOf()).toBe('Hugh Howey');

    // Two more runs over the unchanged series: the enrichment is carried forward (no metadata call) and the author stays.
    for (let i = 0; i < 2; i += 1) {
      const next = bundle();
      await runSync({ mode: 'books-sync', clients: {} as SyncClients, db: t.db, books: next.b });
      expect(next.metadataCalls).toEqual([]);
      expect(await authorOf()).toBe('Hugh Howey');
    }
  });
});

describe('runSync books-sync — retained series ids after chapter changes (issue #825)', () => {
  it('a forced chapter-read failure cannot re-request the stale absent LL id; a confirmed one-book read resumes retry', async () => {
    const now = new Date('2026-10-08T00:00:00Z');
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: stubBundle().bundle,
      now,
    });
    const [anchor] = await t.db.select().from(booksItems).where(eq(booksItems.externalId, '457'));
    const request = await withRequestEventScope({ actor: 'repair', site: 'test-fixture' }, () =>
      t.db.transaction((tx) =>
        insertBookRequest(
          tx,
          { writer: 'test-fixture', reason: 'pairing_want_minted' },
          {
            origin: 'pairing',
            pairingBooksItemId: anchor!.id,
            title: 'Murtagh',
            author: 'Christopher Paolini',
            llBookId: 'old-murtagh',
            ebookStatus: 'landed',
            audioStatus: 'missing',
            createdAt: now,
          },
        ),
      ),
    );
    vi.stubEnv('KAVITA_FORCE_HELD_BOOKS_REFRESH', '1');
    const failed = stubBundle();
    (failed.bundle.kavita as unknown as { listSeriesVolumes: unknown }).listSeriesVolumes =
      async () => {
        throw new Error('detail read failed');
      };
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: failed.bundle,
      now,
    });
    const [unread] = await t.db.select().from(booksItems).where(eq(booksItems.id, anchor!.id));
    expect(unread!.attrs).not.toHaveProperty('heldBooks');
    const calls: Array<{ cmd: string; id: string; format?: string }> = [];
    let added = false;
    let queued = false;
    const ll = {
      read: {
        getAllBookStatuses: async () => {
          const map = new Map<string, LlSnapshotRow>([
            [
              'filler',
              {
                title: 'Another Book',
                author: 'Another Writer',
                ebookStatus: 'Open',
                language: 'en',
              },
            ],
          ]);
          if (added)
            map.set('old-murtagh', {
              title: 'Murtagh',
              author: 'Christopher Paolini',
              language: 'en',
              ebookStatus: 'Open',
              audioStatus: queued ? 'Wanted' : 'Skipped',
            });
          return map;
        },
      },
      write: {
        addBook: async (id: string) => {
          calls.push({ cmd: 'addBook', id });
          added = true;
          return 'true';
        },
        queueBook: async (id: string, format: string) => {
          calls.push({ cmd: 'queueBook', id, format });
          queued = true;
        },
        searchBook: async (id: string, format: string) =>
          void calls.push({ cmd: 'searchBook', id, format }),
        unqueueBook: async (id: string, format: string) =>
          void calls.push({ cmd: 'unqueueBook', id, format }),
      },
    } as unknown as LazyLibrarianClientBundle;
    const blocked = await runFormatPairing({ db: t.db, ll, cap: 0, now, pacer: async () => {} });
    expect(blocked).toMatchObject({ llRerequested: 0, reconciled: 0, requeued: 0 });
    expect(calls).toEqual([]);
    const [unchanged] = await t.db
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.id, request!.id));
    expect(unchanged).toMatchObject({
      llBookId: 'old-murtagh',
      ebookStatus: 'landed',
      audioStatus: 'missing',
      llRerequestedAt: null,
    });

    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: stubBundle().bundle,
      now,
    });
    const resumed = await runFormatPairing({ db: t.db, ll, cap: 0, now, pacer: async () => {} });
    expect(resumed.llRerequested).toBe(1);
    expect(calls).toEqual([
      { cmd: 'addBook', id: 'old-murtagh' },
      { cmd: 'queueBook', id: 'old-murtagh', format: 'audiobook' },
    ]);
  });
  const nextVolumes: KavitaVolume[] = [
    {
      name: '1',
      chapters: [
        {
          titleName: 'Eragon',
          title: '-100000',
          isbn: '',
          writers: [{ name: 'Christopher Paolini' }],
        },
      ],
    },
  ];
  const mirroredHeld = async () =>
    (await t.db.select().from(booksItems).where(eq(booksItems.externalId, '457')))[0]!.attrs;
  it('a page-count change re-reads chapters even if lastChapterAddedUtc stays put', async () => {
    const first = stubBundle();
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: first.bundle,
    });
    const second = stubBundle();
    (second.bundle.kavita as unknown as { listSeriesPage: unknown }).listSeriesPage = async () => ({
      items: [{ ...flatSeries, pages: 350 }],
      total: 1,
      hasAuthoritativeTotal: true,
    });
    (second.bundle.kavita as unknown as { listSeriesVolumes: unknown }).listSeriesVolumes = async (
      id: string,
    ) => {
      second.volumeCalls.push(id);
      return nextVolumes;
    };
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: second.bundle,
    });
    expect(second.volumeCalls).toEqual(['457']);
    expect(await mirroredHeld()).toMatchObject({
      heldBooks: [{ title: 'Eragon', author: 'Christopher Paolini', isbn: null }],
    });
  });

  it('bounded rolling refresh sees equal-page chapter changes under the same id and stamp', async () => {
    const now = new Date();
    const first = stubBundle();
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: first.bundle,
      now: new Date(now.getTime() - 7 * 3600_000),
    });
    const second = stubBundle();
    (second.bundle.kavita as unknown as { listSeriesVolumes: unknown }).listSeriesVolumes = async (
      id: string,
    ) => {
      second.volumeCalls.push(id);
      return nextVolumes;
    };
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: second.bundle,
      now,
    });
    expect(second.volumeCalls).toEqual(['457']);
    expect(await mirroredHeld()).toMatchObject({
      heldBooks: [{ title: 'Eragon', author: 'Christopher Paolini', isbn: null }],
    });
  });

  it('the production force-refresh environment flag reads current chapters without waiting for rotation', async () => {
    const first = stubBundle();
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: first.bundle,
    });
    vi.stubEnv('KAVITA_FORCE_HELD_BOOKS_REFRESH', '1');
    const second = stubBundle();
    (second.bundle.kavita as unknown as { listSeriesVolumes: unknown }).listSeriesVolumes = async (
      id: string,
    ) => {
      second.volumeCalls.push(id);
      return nextVolumes;
    };
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: second.bundle,
    });
    expect(second.volumeCalls).toEqual(['457']);
    expect(await mirroredHeld()).toMatchObject({
      heldBooks: [{ title: 'Eragon', author: 'Christopher Paolini', isbn: null }],
    });
  });

  it('a changed-series detail failure clears stale held identity and the next unchanged-stamp run retries', async () => {
    const first = stubBundle();
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: first.bundle,
    });
    const changed = { ...flatSeries, pages: 351 };
    const failed = stubBundle();
    (failed.bundle.kavita as unknown as { listSeriesPage: unknown }).listSeriesPage = async () => ({
      items: [changed],
      total: 1,
      hasAuthoritativeTotal: true,
    });
    (failed.bundle.kavita as unknown as { listSeriesVolumes: unknown }).listSeriesVolumes =
      async () => {
        throw new Error('detail read failed');
      };
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: failed.bundle,
    });
    expect(await mirroredHeld()).not.toHaveProperty('heldBooks');
    const retry = stubBundle();
    (retry.bundle.kavita as unknown as { listSeriesPage: unknown }).listSeriesPage = async () => ({
      items: [changed],
      total: 1,
      hasAuthoritativeTotal: true,
    });
    (retry.bundle.kavita as unknown as { listSeriesVolumes: unknown }).listSeriesVolumes = async (
      id: string,
    ) => {
      retry.volumeCalls.push(id);
      return nextVolumes;
    };
    await runSync({
      mode: 'books-sync',
      clients: {} as SyncClients,
      db: t.db,
      books: retry.bundle,
    });
    expect(retry.volumeCalls).toEqual(['457']);
    expect(await mirroredHeld()).toMatchObject({
      heldBooks: [{ title: 'Eragon', author: 'Christopher Paolini', isbn: null }],
    });
  });
});
