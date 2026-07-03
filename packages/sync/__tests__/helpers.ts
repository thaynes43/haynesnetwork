// Test harness for the sync runner: embedded PG16 + fixture-driven fetch-stubbed
// @hnet/arr read clients (ADR-010 — fully offline; DESIGN-005 test strategy reuses the
// sanitized packages/arr/__fixtures__ recordings).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { startPostgres } from '@hnet/test-utils';
import { runMigrations } from '@hnet/db/migrate';
import * as schema from '@hnet/db/schema';
import type { Database } from '@hnet/db';
import { LidarrClient, RadarrClient, SeerrClient, SonarrClient } from '@hnet/arr/read';
import type { SyncClients } from '../src/index';

// ---------------------------------------------------------------------------------
// Embedded DB (same pattern as packages/domain/__tests__/helpers.ts)
// ---------------------------------------------------------------------------------

export interface TestDb {
  db: Database;
  pool: Pool;
  stop: () => Promise<void>;
}

export async function bootMigratedDb(): Promise<TestDb> {
  const started = await startPostgres();
  await runMigrations({ databaseUrl: started.connectionString });
  const pool = new Pool({ connectionString: started.connectionString });
  const db = drizzle(pool, { schema }) as Database;
  return {
    db,
    pool,
    stop: async () => {
      await pool.end();
      await started.stop();
    },
  };
}

let emailSeq = 0;

/** Insert a plain user row (user creation is Better Auth's job, not a guarded write). */
export async function createUser(
  db: Database,
  overrides: Partial<typeof schema.users.$inferInsert> = {},
): Promise<typeof schema.users.$inferSelect> {
  const [row] = await db
    .insert(schema.users)
    .values({
      email: overrides.email ?? `user-${++emailSeq}@example.com`,
      displayName: overrides.displayName ?? `User ${emailSeq}`,
      ...overrides,
    })
    .returning();
  if (!row) throw new Error('user insert returned no row');
  return row;
}

// ---------------------------------------------------------------------------------
// Fixtures (reused from packages/arr — DESIGN-005 test strategy) + fetch stubs
// ---------------------------------------------------------------------------------

const arrFixturesDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'arr',
  '__fixtures__',
);

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(arrFixturesDir, `${name}.json`), 'utf8')) as T;
}

export interface StubRoute {
  method?: string; // default GET
  /** Exact pathname (e.g. '/api/v3/series') or RegExp. */
  path: string | RegExp;
  status?: number; // default 200
  /** Static body, or a function of the request URL (for page-dependent responses). */
  body?: unknown | ((url: URL) => unknown);
  /** Override status per call (e.g. fail page 2 of a walk). */
  statusFor?: (url: URL) => number;
}

export interface RecordedCall {
  method: string;
  url: URL;
}

/** Route-table fetch stub (mirrors packages/arr/__tests__/helpers.ts). */
export function stubFetch(routes: StubRoute[]) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({ method, url });
    const route = routes.find(
      (r) =>
        (r.method ?? 'GET') === method &&
        (typeof r.path === 'string' ? url.pathname === r.path : r.path.test(url.pathname)),
    );
    if (!route) {
      return new Response(JSON.stringify({ message: `no stub for ${method} ${url.pathname}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    const status = route.statusFor?.(url) ?? route.status ?? 200;
    const body = typeof route.body === 'function' ? route.body(url) : route.body;
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const CLIENT_OPTS = { apiKey: 'test-api-key', retryDelayMs: 0 } as const;

export function sonarrStub(routes: StubRoute[]): SonarrClient {
  return new SonarrClient({
    baseUrl: 'http://sonarr.test:8989',
    fetchImpl: stubFetch(routes).fetchImpl,
    ...CLIENT_OPTS,
  });
}

export function radarrStub(routes: StubRoute[]): RadarrClient {
  return new RadarrClient({
    baseUrl: 'http://radarr.test:7878',
    fetchImpl: stubFetch(routes).fetchImpl,
    ...CLIENT_OPTS,
  });
}

export function lidarrStub(routes: StubRoute[]): LidarrClient {
  return new LidarrClient({
    baseUrl: 'http://lidarr.test:8686',
    fetchImpl: stubFetch(routes).fetchImpl,
    ...CLIENT_OPTS,
  });
}

export function seerrStub(routes: StubRoute[]): SeerrClient {
  return new SeerrClient({
    baseUrl: 'http://seerr.test:5055',
    fetchImpl: stubFetch(routes).fetchImpl,
    ...CLIENT_OPTS,
  });
}

/** Fixture-backed full *arr client set (3-item libraries per kind). */
export function fixtureArrClients(): SyncClients {
  return {
    sonarr: sonarrStub([
      { path: '/api/v3/series', body: fixture('sonarr.series-list') },
      { path: '/api/v3/qualityprofile', body: fixture('sonarr.qualityprofile') },
      { path: '/api/v3/tag', body: fixture('sonarr.tag') },
    ]),
    radarr: radarrStub([
      { path: '/api/v3/movie', body: fixture('radarr.movie-list') },
      { path: '/api/v3/qualityprofile', body: fixture('radarr.qualityprofile') },
      { path: '/api/v3/tag', body: fixture('radarr.tag') },
    ]),
    lidarr: lidarrStub([
      { path: '/api/v1/artist', body: fixture('lidarr.artist-list') },
      { path: '/api/v1/qualityprofile', body: fixture('lidarr.qualityprofile') },
      { path: '/api/v1/tag', body: fixture('lidarr.tag') },
    ]),
  };
}

// ---------------------------------------------------------------------------------
// Synthetic *arr payload builders (fixture-shaped, ids under test control)
// ---------------------------------------------------------------------------------

/** A minimal fixture-shaped Sonarr series record. */
export function seriesJson(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Series ${id}`,
    sortTitle: `series ${id}`,
    year: 2020,
    tvdbId: 100_000 + id,
    monitored: true,
    monitorNewItems: 'all',
    qualityProfileId: 1,
    rootFolderPath: '/data/haynestower/Media/TV Shows',
    path: `/data/haynestower/Media/TV Shows/Series ${id}`,
    tags: [1],
    statistics: { episodeFileCount: 8, episodeCount: 10, totalEpisodeCount: 10, sizeOnDisk: 1_000 },
    seriesType: 'standard',
    seasonFolder: true,
    status: 'continuing',
    ended: false,
    added: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

/** A minimal fixture-shaped Sonarr history record. */
export function sonarrHistoryJson(
  id: number,
  eventType: string,
  date: string,
  seriesId: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    eventType,
    date,
    seriesId,
    episodeId: seriesId * 100 + 1,
    sourceTitle: `Series ${seriesId} S01E01 1080p WEB-DL`,
    downloadId: `dl-${id}`,
    quality: { quality: { id: 4, name: 'WEBDL-1080p' } },
    data: { indexer: 'TestIndexer', releaseGroup: 'GRP', downloadClient: 'sabnzbd' },
    ...overrides,
  };
}

/** Wrap history records in the paged envelope (`GET /history`). */
export function historyPage(records: unknown[], page: number, pageSize: number, total: number) {
  return {
    page,
    pageSize,
    sortKey: 'date',
    sortDirection: 'descending',
    totalRecords: total,
    records,
  };
}

/** A minimal fixture-shaped Seerr request record. */
export function seerrRequestJson(
  id: number,
  type: 'movie' | 'tv',
  createdAt: string,
  media: { tmdbId?: number | null; tvdbId?: number | null },
  requestedBy: { email?: string | null; plexUsername?: string | null } = {},
) {
  return {
    id,
    type,
    status: 2,
    createdAt,
    media: {
      tmdbId: media.tmdbId ?? null,
      tvdbId: media.tvdbId ?? null,
      mediaType: type,
      status: 3,
    },
    requestedBy: {
      id: 1,
      email: requestedBy.email ?? null,
      plexUsername: requestedBy.plexUsername ?? null,
      plexId: 10_000_001,
      displayName: requestedBy.plexUsername ?? 'someone',
    },
  };
}

/** Wrap Seerr requests in the `GET /request` envelope. */
export function seerrRequestPage(results: unknown[], page = 1, pages = 1, pageSize = 100) {
  return {
    pageInfo: { pages, pageSize, results: results.length, page },
    results,
  };
}
