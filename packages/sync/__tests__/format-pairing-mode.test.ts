// ADR-065 / DESIGN-036 (PLAN-050) — the `format-pairing` standalone sync mode: derives from the
// books_items mirror (no external snapshot), pairs + mints + pushes the missing format through the
// injected confined LL bundle, and degrades honestly without one. No sync_runs row is written.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { bookRequests, booksFormatPairs } from '@hnet/db';
import { syncBooks, type LazyLibrarianClientBundle } from '@hnet/domain';
import { runSync } from '../src/orchestrator';
import { bootMigratedDb, type TestDb } from './helpers';
import type { SyncClients } from '../src/clients';

let t: TestDb;

beforeAll(async () => {
  t = await bootMigratedDb();
  // Seed the mirror through its single-writer: a paired title + an unpaired book.
  const base = {
    libraryId: '1',
    libraryName: 'Lib',
    narrator: null,
    seriesName: null,
    year: null,
    releasedAt: null,
    genres: [],
    coverRef: null,
    pageCount: null,
    wordCount: null,
    durationSeconds: null,
    sizeBytes: null,
    attrs: {},
    sourceAddedAt: null,
    sourceUpdatedAt: null,
  };
  await syncBooks({
    db: t.db,
    syncedSources: ['kavita', 'audiobookshelf'],
    rows: [
      { ...base, source: 'kavita', mediaKind: 'book', externalId: 'k-hyp', title: 'Hyperion', sortTitle: 'hyperion', author: 'Dan Simmons', deepLinkUrl: 'http://kavita/1' },
      { ...base, source: 'audiobookshelf', mediaKind: 'audiobook', externalId: 'a-hyp', title: 'Hyperion', sortTitle: 'hyperion', author: 'Dan Simmons', deepLinkUrl: 'http://abs/1' },
      { ...base, source: 'kavita', mediaKind: 'book', externalId: 'k-solo', title: 'The Martian', sortTitle: 'martian', author: 'Andy Weir', deepLinkUrl: 'http://kavita/2' },
    ],
  });
});

afterAll(async () => {
  await t?.stop();
});

function stubLl() {
  const calls: Array<{ cmd: string; id: string; format?: string }> = [];
  return {
    calls,
    bundle: {
      write: {
        addBook: async (id: string) => {
          calls.push({ cmd: 'addBook', id });
          return 'OK';
        },
        queueBook: async (id: string, format: string) => {
          calls.push({ cmd: 'queueBook', id, format });
          return 'OK';
        },
        searchBook: async (id: string, format: string) => {
          calls.push({ cmd: 'searchBook', id, format });
          return 'OK';
        },
      },
      read: { getAllBookStatuses: async () => new Map() },
    } as unknown as LazyLibrarianClientBundle,
  };
}

describe('runSync --mode=format-pairing', () => {
  it('pairs from the mirror, mints the missing-format want, pushes via the injected bundle, writes NO sync_runs row', async () => {
    const ll = stubLl();
    const report = await runSync({
      mode: 'format-pairing',
      clients: {} as SyncClients, // no *arr source is touched — the mode derives from books_items
      db: t.db,
      lazyLibrarian: ll.bundle,
      pairingGb: { resolveVolume: async () => ({ volumeId: 'gb-martian' }) },
    });

    expect(report.totalFailure).toBe(false);
    expect(report.formatPairing).toMatchObject({
      paired: 1,
      added: 1,
      candidates: 1,
      minted: 1,
      pushed: 1,
    });
    expect(report.sources).toEqual([]);

    // The pair persisted; the unpaired book minted an audio-leg pairing want.
    expect(await t.db.select().from(booksFormatPairs)).toHaveLength(1);
    const [want] = await t.db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'));
    expect(want).toMatchObject({ llBookId: 'gb-martian', ebookStatus: 'landed', audioStatus: 'wanted' });
    expect(ll.calls.filter((c) => c.cmd === 'queueBook').map((c) => c.format)).toEqual(['audiobook']);

    // Standalone: the mode writes NO sync_runs row.
    const runs = await t.db.execute(sql`SELECT count(*)::int AS n FROM sync_runs`);
    expect((runs.rows?.[0] as { n: number }).n).toBe(0);
  });

  it('degrades honestly with no LL bundle and no GB resolver (mint-only, unmintable retryable)', async () => {
    const report = await runSync({ mode: 'format-pairing', clients: {} as SyncClients, db: t.db });
    expect(report.totalFailure).toBe(false);
    // The want already exists from the prior run (one per anchor) — nothing new mints, nothing pushes.
    expect(report.formatPairing).toMatchObject({ minted: 0, pushed: 0 });
  });
});
