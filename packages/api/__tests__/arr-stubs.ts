// Fetch-stubbed *arr client bundles for the router tests (ADR-010 — fully offline).
// Mirrors packages/arr/__tests__/helpers.ts' route-table stub, plus recorded request
// bodies so the D-15/D-16 write payloads (search ids, addOptions) are assertable.
// The bundle is built through @hnet/domain's buildArrClientBundle so this package
// never touches the guarded *arr write entrypoint directly (the D-12 guard).
import { buildArrClientBundle, type ArrClientBundle } from '@hnet/domain';

export interface RecordedArrCall {
  method: string;
  url: URL;
  /** JSON-parsed request body, or undefined when none was sent. */
  body: unknown;
}

export interface ArrStubRoute {
  method?: string; // default GET
  /** Exact pathname (e.g. '/api/v3/series') or RegExp. */
  path: string | RegExp;
  status?: number; // default 200
  /** Static body or a function of the request URL (query-dependent responses). */
  body?: unknown | ((url: URL) => unknown);
}

export interface StubbedArrBundle {
  bundle: ArrClientBundle;
  /** Every request any client made, in order, across all three kinds. */
  calls: RecordedArrCall[];
  callsFor: (method: string, pathPrefix: string) => RecordedArrCall[];
}

/**
 * One route table serves all three kinds (they run against distinct fake hosts, so
 * `/api/v3` vs `/api/v1` paths plus the URL host disambiguate when needed).
 */
export function stubArrBundle(routes: ArrStubRoute[]): StubbedArrBundle {
  const calls: RecordedArrCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    // STRICT paged-/history contract: the real *arr binds `eventType` to the INTEGER
    // enum (grabbed === 1); a lowercase string 400s (the fix/history-eventtype-enum prod
    // bug). Enforce it before route matching so every grab lookup proves the integer
    // round trip and a regression to the string form fails here with the real 400 shape.
    if (method === 'GET' && /\/api\/v[13]\/history$/.test(url.pathname)) {
      const eventType = url.searchParams.get('eventType');
      if (eventType !== null && !/^\d+$/.test(eventType)) {
        return new Response(JSON.stringify(invalidEventTypeBody(eventType)), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
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
    const body = typeof route.body === 'function' ? route.body(url) : route.body;
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const opts = { apiKey: 'test-api-key', retryDelayMs: 0, fetchImpl } as const;
  return {
    bundle: buildArrClientBundle({
      sonarr: { baseUrl: 'http://sonarr.test:8989', ...opts },
      radarr: { baseUrl: 'http://radarr.test:7878', ...opts },
      lidarr: { baseUrl: 'http://lidarr.test:8686', ...opts },
    }),
    calls,
    callsFor: (method, pathPrefix) =>
      calls.filter((c) => c.method === method && c.url.pathname.startsWith(pathPrefix)),
  };
}

// ---------------------------------------------------------------------------------
// Synthetic *arr payload builders (fixture-shaped, ids under test control)
// ---------------------------------------------------------------------------------

/** Minimal Sonarr episode record for `GET /episode?seriesId=`. */
export function episodeJson(
  id: number,
  seasonNumber: number,
  episodeNumber: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    seriesId: 501,
    seasonNumber,
    episodeNumber,
    title: `Episode ${episodeNumber}`,
    airDateUtc: '2021-03-02T01:00:00Z',
    hasFile: true,
    monitored: true,
    episodeFileId: id * 10,
    ...overrides,
  };
}

/** Minimal grabbed-history record shared shape (per-kind target ids via overrides). */
export function grabHistoryJson(id: number, date: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    eventType: 'grabbed',
    date,
    sourceTitle: 'Some.Release.1080p.WEB-DL',
    downloadId: `dl-${id}`,
    quality: { quality: { id: 4, name: 'WEBDL-1080p' } },
    data: { indexer: 'TestIndexer' },
    ...overrides,
  };
}

/**
 * The real ASP.NET ValidationProblemDetails body the paged `/history` endpoint returns
 * for a non-integer `eventType` (captured live 2026-07-03). Mirrored so ArrHttpError
 * sees the exact 400 shape production does.
 */
export function invalidEventTypeBody(value: string) {
  return {
    type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1',
    title: 'One or more validation errors occurred.',
    status: 400,
    traceId: '00-arrstub0000000000000000000000-0000000000000000-00',
    errors: { eventType: [`The value '${value}' is not valid.`] },
  };
}

/** Wrap history records in the paged envelope (`GET /history`). */
export function historyPage(records: unknown[]) {
  return {
    page: 1,
    pageSize: 20,
    sortKey: 'date',
    sortDirection: 'descending',
    totalRecords: records.length,
    records,
  };
}

/** Minimal Sonarr series resource for `POST /series` responses / `GET /series`. */
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
    statistics: { episodeFileCount: 8, episodeCount: 10, totalEpisodeCount: 10, sizeOnDisk: 1000 },
    seriesType: 'standard',
    seasonFolder: true,
    status: 'continuing',
    ended: false,
    added: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

/** Minimal Radarr movie resource. */
export function movieJson(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Movie ${id}`,
    sortTitle: `movie ${id}`,
    year: 2019,
    tmdbId: 200_000 + id,
    monitored: true,
    qualityProfileId: 1,
    rootFolderPath: '/data/haynestower/Media/Movies',
    path: `/data/haynestower/Media/Movies/Movie ${id}`,
    tags: [],
    hasFile: true,
    movieFileId: id * 10,
    sizeOnDisk: 5000,
    statistics: { movieFileCount: 1 },
    minimumAvailability: 'released',
    status: 'released',
    isAvailable: true,
    added: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}
