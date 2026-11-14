// DESIGN-008 D-03 (2026-11-13) — the household history is paged to the end, and a finished read
// stores 0 for a movie or show with no joined play. An unfinished read stores no zero.
// Embedded PG16 + a fetch-stubbed Tautulli. No account's plays are asserted by name.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mediaItems, mediaMetadata } from '@hnet/db/schema';
import { upsertMediaMetadataBatch } from '@hnet/domain';
import { TautulliClient } from '@hnet/arr/read';
import { plexRatingGuidKey } from '../src/db-reads';
import { noopLogger } from '../src/logger';
import {
  buildMetadataContext,
  readHouseholdWatch,
  runMetadataRefreshForKind,
} from '../src/metadata-refresh';
import { runSync } from '../src/index';
import { parseWatchHistoryBackfillArgs } from '../src/scripts/watch-history-backfill';
import { backfillWatchHistory } from '../src/watch-history-backfill';
import { bootMigratedDb, fixtureArrClients, stubFetch, type TestDb } from './helpers';

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

const GUIDS: Record<string, unknown> = {
  '101': { guids: ['tmdb://8388'], media_type: 'movie' },
  '202': { guids: ['tmdb://252178'], media_type: 'movie' },
};

function row(ratingKey: number, stopped: string) {
  return {
    rating_key: ratingKey,
    media_type: 'movie',
    date: unix(stopped) - 60,
    stopped: unix(stopped),
    watched_status: 1,
    user_id: 1,
  };
}

function tautulli(rows: object[], metadata: 'error' | Record<string, unknown> = GUIDS) {
  const { fetchImpl, calls } = stubFetch([
    {
      path: '/api/v2',
      statusFor: (url) =>
        metadata === 'error' && url.searchParams.get('cmd') === 'get_metadata' ? 500 : 200,
      body: (url: URL) => {
        const cmd = url.searchParams.get('cmd');
        if (cmd === 'get_history') {
          const start = Number(url.searchParams.get('start') ?? 0);
          const length = Number(url.searchParams.get('length') ?? rows.length);
          return {
            response: {
              result: 'success',
              message: null,
              data: {
                data: rows.slice(start, start + length),
                recordsFiltered: rows.length,
                recordsTotal: rows.length,
              },
            },
          };
        }
        if (cmd === 'get_metadata' && metadata !== 'error') {
          const key = url.searchParams.get('rating_key') ?? '';
          return {
            response: { result: 'success', message: null, data: metadata[key] ?? {} },
          };
        }
        return { response: { result: 'error', message: 'metadata failed', data: {} } };
      },
    },
  ]);
  return {
    calls,
    client: new TautulliClient({
      baseUrl: 'http://tautulli.test:8181',
      apiKey: 'test-key',
      retryDelayMs: 0,
      fetchImpl,
    }),
  };
}

describe('watch-history backfill args', () => {
  it('requires exactly one mode', () => {
    expect(parseWatchHistoryBackfillArgs(['--dry-run'])).toEqual({ apply: false });
    expect(parseWatchHistoryBackfillArgs(['--apply'])).toEqual({ apply: true });
    expect(parseWatchHistoryBackfillArgs(['--help'])).toBe('help');
    expect(() => parseWatchHistoryBackfillArgs([])).toThrow(/required/);
    expect(() => parseWatchHistoryBackfillArgs(['--dry-run', '--apply'])).toThrow(/exclusive/);
  });

  it('treats a metadata lookup that throws as an unfinished read', async () => {
    const stub = tautulli([row(101, '2024-01-01T00:00:00Z')], 'error');
    const read = await readHouseholdWatch({
      sources: { tautulli: [{ slug: 'haynesops', client: stub.client }] },
      logger: noopLogger,
      ratingKeyGuids: new Map(),
    });
    expect(read.complete).toBe(false);
    expect(read.instances[0]).toMatchObject({ finished: true, metadataErrors: 1 });
  });
});

describe('lifetime household watch (DESIGN-008 D-03)', () => {
  let t: TestDb;
  let cakeId: string;

  const plays = () =>
    t.db
      .select({
        tmdbId: mediaItems.tmdbId,
        playCount: mediaMetadata.playCount,
        lastViewedAt: mediaMetadata.lastViewedAt,
      })
      .from(mediaMetadata)
      .innerJoin(mediaItems, eq(mediaItems.id, mediaMetadata.mediaItemId));

  beforeAll(async () => {
    t = await bootMigratedDb();
    const full = await runSync({
      mode: 'full',
      sources: ['radarr'],
      db: t.db,
      clients: fixtureArrClients(),
    });
    expect(full.totalFailure).toBe(false);
    const rows = await t.db
      .select({ id: mediaItems.id, tmdbId: mediaItems.tmdbId })
      .from(mediaItems);
    cakeId = rows.find((r) => r.tmdbId === 1233620)!.id;
  });

  afterAll(async () => {
    await t?.stop();
  });

  it('joins a rating key the match table already resolved and stores 0 for the rest', async () => {
    const stub = tautulli([row(101, '2024-01-02T00:00:00Z')]);
    const context = await buildMetadataContext({
      sources: { tautulli: [{ slug: 'haynesops', client: stub.client }] },
      logger: noopLogger,
      db: t.db,
      ratingKeyGuids: new Map([
        [plexRatingGuidKey('haynesops', '101'), { arrKind: 'radarr', tmdbId: 8388 }],
      ]),
    });
    expect(context.watchComplete).toBe(true);
    const stats = await runMetadataRefreshForKind({
      db: t.db,
      clients: fixtureArrClients(),
      sources: { tautulli: [{ slug: 'haynesops', client: stub.client }] },
      context,
      arrKind: 'radarr',
      logger: noopLogger,
      staleThresholdMs: 0,
    });
    expect(stats).toMatchObject({ tierTautulli: 1, watchComplete: true, watchZeros: 2 });
    expect(stub.calls.filter((c) => c.url.searchParams.get('cmd') === 'get_metadata')).toEqual([]);
    const stored = await plays();
    expect(stored.find((r) => r.tmdbId === 8388)?.playCount).toBe(1);
    expect(stored.find((r) => r.tmdbId === 1233620)?.playCount).toBe(0);
    expect(stored.find((r) => r.tmdbId === 252178)?.playCount).toBe(0);
  });

  it('reads past the old 20-page window and keeps the oldest play', async () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row(202, '2024-06-01T01:00:00Z')),
      row(101, '2020-01-01T01:00:00Z'),
    ];
    const stub = tautulli(rows);
    const run = await runSync({
      mode: 'metadata-refresh',
      sources: ['radarr'],
      db: t.db,
      clients: fixtureArrClients(),
      metadataSources: { tautulli: [{ slug: 'haynesops', client: stub.client }] },
      // A negative cut is in the future, so the rows the previous test just wrote are stale.
      metadataStaleThresholdMs: -86_400_000,
      tautulliPageSize: 1,
    });
    expect(run.totalFailure).toBe(false);
    expect(run.sources[0]!.stats).toMatchObject({ watchComplete: true, watchZeros: 1 });
    const stored = await plays();
    expect(stored.find((r) => r.tmdbId === 252178)?.playCount).toBe(20);
    expect(stored.find((r) => r.tmdbId === 8388)).toMatchObject({
      playCount: 1,
      lastViewedAt: new Date('2020-01-01T01:00:00Z'),
    });
    expect(stored.find((r) => r.tmdbId === 1233620)?.playCount).toBe(0);
  });

  it('backfill dry-run writes nothing, apply stores the zero, and a second apply writes nothing', async () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row(202, '2024-06-01T01:00:00Z')),
      row(101, '2020-01-01T01:00:00Z'),
    ];
    const source = () => [{ slug: 'haynesops', client: tautulli(rows).client }];
    const dry = await backfillWatchHistory({
      db: t.db,
      tautulli: source(),
      logger: noopLogger,
      apply: false,
      pageSize: 1,
    });
    expect(dry).toMatchObject({
      apply: false,
      complete: true,
      candidates: 3,
      played: 2,
      zeros: 1,
      written: 0,
    });
    expect(dry.played + (dry.zeros ?? 0)).toBe(dry.candidates);
    const before = await plays();
    expect(before.find((r) => r.tmdbId === 1233620)?.playCount).toBe(0);

    await upsertMediaMetadataBatch({ db: t.db, rows: [{ mediaItemId: cakeId, playCount: 5 }] });
    const apply = await backfillWatchHistory({
      db: t.db,
      tautulli: source(),
      logger: noopLogger,
      apply: true,
      pageSize: 1,
    });
    expect(apply.complete).toBe(true);
    expect(apply.written).toBeGreaterThanOrEqual(1);
    expect((await plays()).find((r) => r.tmdbId === 1233620)?.playCount).toBe(0);

    const again = await backfillWatchHistory({
      db: t.db,
      tautulli: source(),
      logger: noopLogger,
      apply: true,
      pageSize: 1,
    });
    expect(again).toMatchObject({ complete: true, written: 0, changed: 0 });
  });

  it('an unfinished read writes nothing and does not store a zero', async () => {
    await upsertMediaMetadataBatch({ db: t.db, rows: [{ mediaItemId: cakeId, playCount: 7 }] });
    const rows = Array.from({ length: 5 }, () => row(101, '2024-02-01T00:00:00Z'));
    const refused = await backfillWatchHistory({
      db: t.db,
      tautulli: [{ slug: 'haynesops', client: tautulli(rows).client }],
      logger: noopLogger,
      apply: true,
      pageSize: 1,
      maxPages: 2,
    });
    expect(refused).toMatchObject({ complete: false, written: 0, zeros: null });
    expect((await plays()).find((r) => r.tmdbId === 1233620)?.playCount).toBe(7);

    const run = await runSync({
      mode: 'metadata-refresh',
      sources: ['radarr'],
      db: t.db,
      clients: fixtureArrClients(),
      metadataSources: { tautulli: [{ slug: 'haynesops', client: tautulli(rows).client }] },
      metadataStaleThresholdMs: -86_400_000,
      tautulliPageSize: 1,
      tautulliMaxPages: 2,
    });
    expect(run.totalFailure).toBe(false);
    expect(run.sources[0]!.stats).toMatchObject({ watchComplete: false, watchZeros: 0 });
    const stored = await plays();
    expect(stored.find((r) => r.tmdbId === 8388)?.playCount).toBe(2);
    expect(stored.find((r) => r.tmdbId === 252178)?.playCount).toBeNull();
    expect(stored.find((r) => r.tmdbId === 1233620)?.playCount).toBeNull();
  });
});
