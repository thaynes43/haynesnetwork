// DESIGN-005 test strategy — stub *arr HTTP server for e2e (mirrors the stub-OIDC
// pattern; extracted from the packages/sync fetch-stub approach into a real HTTP
// server because the Next dev server calls the *arrs over the network). Serves the
// fixture-shaped READ endpoints the fix flow resolves against and accepts the two
// sanctioned WRITE endpoints (history/failed, command), RECORDING every mutating
// call so specs can assert AC-07's blocklist+search happened with the right ids.
//
// One server stands in for all four services (SONARR_URL etc. all point here) —
// the suite only drives the Sonarr fix journey; the others just need parseable
// endpoints if ever touched.
//
// Control endpoints:
//   GET  /_stub/calls  → { calls: [{method, path, query, body}] } (writes only)
//   POST /_stub/reset  → 204 (clears recorded calls + the staged queue)
//   POST /_stub/queue  → 204 (stage the scriptable download queue: { records: [...] })
//                        PLAN-015 / D-20 — drives the Action Feedback progress derivation
//                        deterministically (queued → downloading with a shrinking sizeleft →
//                        importing → empty-after-import). GET /queue serves the staged records,
//                        server-side filtered by seriesIds/movieIds/artistIds like the real *arrs.
//   POST /_stub/seerr-watchlist → 204; body { userId, results? } — ADR-093: that Seerr user's watchlist
//                        (Seerr result rows: ratingKey, title, mediaType, tmdbId); no `results` restores the default.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { clearStubArrDeleted, stubArrDeleted } from './stub-arr-state';

export interface RecordedArrWrite {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface StubArrServer {
  baseUrl: string;
  port: number;
  /** Recorded mutating calls (POST/DELETE) — the spec-facing audit trail. */
  calls: RecordedArrWrite[];
  stop: () => Promise<void>;
}

/** The seeded Sonarr series the e2e ledger row mirrors (see seed-ledger.ts). */
export const STUB_SERIES_ID = 501;
export const STUB_SERIES_TVDB_ID = 990001;
/** The seeded Lidarr artist + its one on-disk album (ADR-016 / D-19 no-subtitle-radio assertion). */
export const STUB_ARTIST_ID = 701;
export const STUB_ALBUM_ID = 7011;
/** Grab-history ids are derived so specs can predict them: 700000 + episodeId. */
export const grabHistoryIdFor = (episodeId: number) => 700_000 + episodeId;

const EPISODE_COUNT = 10;

/**
 * ADR-018 / DESIGN-008 D-14 — the metadata a harvest reads off the item resources
 * (ratings/images/genres/runtime) + the poster a /api/posters proxy streams. A 1x1 PNG stands
 * in for the *arr's pre-resized MediaCover variant so the poster route runs hermetically.
 */
const POSTER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
export const STUB_MOVIE_ID = 601;
export const STUB_MOVIE_TMDB_ID = 880001;
/** DESIGN-009 (ledger e2e) — a live movie that is PRESENT but UNMONITORED with no file: the
 *  bulk Monitor-&-search's monitor-flip outcome (ADR-022 C-01). Mirrors the tombstoned
 *  'Vanished Heist' ledger row (seed-ledger.ts) by tmdbId. */
export const STUB_VANISHED_ID = 604;
export const STUB_VANISHED_TMDB_ID = 880004;

/**
 * ADR-059 / DESIGN-030 D-08 (PLAN-048 — Activity / In-Flight) — the *arr Activity queue fixtures: a
 * DOWNLOADING movie (The Fixture, ~45% → `downloading`) + a manual-import BLOCKED movie (Vanished Heist,
 * `trackedDownloadState: 'importBlocked'` with a status message → `import_blocked`). Staged via
 * `POST /_stub/queue` and served by `GET /queue` (unfiltered), these drive the live Activity tab's *arr
 * leg AND — read by the `activity-scan` seed — the durable import_blocked failure ledger row. `radarr`
 * queue records carry `movieId` so only the Radarr adapter picks them up (Sonarr/Lidarr skip them).
 */
export function arrActivityQueueFixture(): Record<string, unknown>[] {
  const size = 1_000_000_000;
  return [
    {
      id: 90001,
      movieId: STUB_MOVIE_ID,
      status: 'downloading',
      trackedDownloadStatus: 'ok',
      trackedDownloadState: 'downloading',
      size,
      sizeleft: Math.round(size * 0.55), // ~45%
      estimatedCompletionTime: '2026-07-14T13:00:00Z',
      title: 'The.Fixture.2022.1080p.WEB-DL',
    },
    {
      id: 90002,
      movieId: STUB_VANISHED_ID,
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importBlocked',
      size,
      sizeleft: 0,
      title: 'Vanished.Heist.2018.1080p.WEB-DL',
      statusMessages: [
        {
          title: 'Manual import required',
          messages: ['One or more files were not imported — the release did not match a monitored movie'],
        },
      ],
    },
  ];
}

/**
 * ADR-083 / DESIGN-046 D-09 (PLAN-065 — *arr queue janitor) — a canned ERRORED download queue spanning every
 * Action Class (have_better / bad_release / retry_import / unknown) with realistic statusMessages, so
 * `--mode=queue-cleanup` runs end-to-end locally in census (writes arr_queue_cleanup_actions rows without
 * touching any *arr — enforcement stays off under the all-census default). `added` is deliberately old so the
 * items clear the janitor's minItemAgeHours rail. Staged via `POST /_stub/queue` (dev:local pre-stages it).
 * One stub stands in for all three *arrs, so a run observes each item once per instance — fine for a census
 * smoke; the fields the classifier reads (status / trackedDownloadState / statusMessages) are what matter.
 */
export function erroredArrQueueFixture(): Record<string, unknown>[] {
  const size = 2_000_000_000;
  const added = '2026-07-01T00:00:00Z';
  return [
    // have_better — the *arr already holds equal/better quality (remove + blocklist, no re-search).
    {
      id: 91001,
      movieId: STUB_MOVIE_ID,
      downloadId: 'dl-have-better-1',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importBlocked',
      size,
      sizeleft: 0,
      added,
      title: 'The.Fixture.2022.2160p.WEB-DL',
      statusMessages: [
        {
          title: 'Not an upgrade',
          messages: [
            'Not an upgrade for existing movie file(s). Existing quality: WEBDL-2160p. New quality WEBDL-1080p',
          ],
        },
      ],
    },
    // bad_release — an unparseable/defective grab (blocklist + re-search where still monitored).
    {
      id: 91002,
      seriesId: STUB_SERIES_ID,
      episodeId: 5001,
      downloadId: 'dl-bad-release-1',
      status: 'warning',
      trackedDownloadStatus: 'error',
      trackedDownloadState: 'importFailed',
      size,
      sizeleft: 0,
      added,
      title: 'Some.Show.S01E01.GARBLED',
      errorMessage: 'Unable to parse release title',
      statusMessages: [{ title: 'Import failed', messages: ['Unable to parse the release title'] }],
    },
    // retry_import — a stuck/transient import (bounded ProcessMonitoredDownloads).
    {
      id: 91003,
      movieId: STUB_VANISHED_ID,
      downloadId: 'dl-retry-1',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importPending',
      size,
      sizeleft: 0,
      added,
      title: 'Vanished.Heist.2018.1080p.WEB-DL',
      statusMessages: [{ title: 'Waiting', messages: ['Waiting to import...'] }],
    },
    // unknown — Lidarr match-ambiguity (deliberately unclassified initially, Q-01; reported, never acted on).
    {
      id: 91004,
      artistId: STUB_ARTIST_ID,
      albumId: STUB_ALBUM_ID,
      downloadId: 'dl-unknown-1',
      status: 'completed',
      trackedDownloadStatus: 'warning',
      trackedDownloadState: 'importPending',
      size,
      sizeleft: 0,
      added,
      title: 'Some Artist - Some Album (2019)',
      statusMessages: [
        {
          title: 'Manual import',
          messages: ['Found matching artist but no album could be found that was close enough'],
        },
      ],
    },
  ];
}

/** The metadata fields DESIGN-008 D-02 harvests off a Radarr movie / Sonarr series. */
const RADARR_META = {
  runtime: 106,
  genres: ['Comedy', 'Drama'],
  ratings: {
    imdb: { value: 7.7, votes: 12345, type: 'user' },
    tmdb: { value: 7.9, votes: 678, type: 'user' },
    rottenTomatoes: { value: 88, type: 'user' },
  },
  images: [
    {
      coverType: 'poster',
      url: '/MediaCover/601/poster.jpg?lastWrite=1',
      remoteUrl: 'https://image.tmdb.org/t/p/original/fixture.jpg',
    },
  ],
};
const SONARR_META = {
  runtime: 44,
  genres: ['Drama', 'Crime'],
  ratings: { value: 8.2, votes: 4321 },
  images: [
    {
      coverType: 'poster',
      url: '/MediaCover/501/poster.jpg?lastWrite=1',
      remoteUrl: 'https://artworks.thetvdb.com/x/poster.jpg',
    },
  ],
};

function movieResource(id: number) {
  return {
    id,
    title: 'The Fixture',
    sortTitle: 'fixture',
    year: 2022,
    tmdbId: STUB_MOVIE_TMDB_ID,
    imdbId: 'tt8800010',
    monitored: true,
    qualityProfileId: 1,
    rootFolderPath: '/data/haynestower/Media/Movies',
    path: '/data/haynestower/Media/Movies/The Fixture',
    tags: [] as number[],
    hasFile: true,
    movieFileId: 9601,
    // The on-disk file is embedded inline (DESIGN-008 D-02 resolution fix): the harvest reads
    // quality.quality.resolution (int) for the REAL per-item tier — here 1080 → '1080p'.
    movieFile: { quality: { quality: { id: 4, name: 'WEBDL-1080p', resolution: 1080 } } },
    sizeOnDisk: 4_294_967_296,
    statistics: { movieFileCount: 1 },
    minimumAvailability: 'released',
    status: 'released',
    isAvailable: true,
    added: '2025-02-02T00:00:00Z',
    ...RADARR_META,
  };
}

/** The present-but-unmonitored, fileless live movie (see STUB_VANISHED_ID above). */
function vanishedMovieResource() {
  return {
    id: STUB_VANISHED_ID,
    title: 'Vanished Heist',
    sortTitle: 'vanished heist',
    year: 2018,
    tmdbId: STUB_VANISHED_TMDB_ID,
    monitored: false,
    qualityProfileId: 1,
    rootFolderPath: '/data/haynestower/Media/Movies',
    path: '/data/haynestower/Media/Movies/Vanished Heist',
    tags: [] as number[],
    hasFile: false,
    movieFileId: 0, // Radarr sends 0 (not absent) for fileless movies
    sizeOnDisk: 0,
    statistics: { movieFileCount: 0 },
    minimumAvailability: 'released',
    status: 'released',
    isAvailable: true,
    added: '2025-03-03T00:00:00Z',
  };
}

/** ADR-022 D-02 — a minimal Lidarr artist resource for `POST /artist` (Ledger add path). */
function artistResource(id: number) {
  return {
    id,
    artistName: 'Ledger Band',
    sortName: 'ledger band',
    foreignArtistId: `11111111-2222-3333-4444-${String(id).padStart(12, '0')}`,
    monitored: true,
    monitorNewItems: 'all',
    qualityProfileId: 1,
    metadataProfileId: 1,
    rootFolderPath: '/data/media/music',
    path: `/data/media/music/Ledger Band ${id}`,
    tags: [] as number[],
    status: 'continuing',
    added: '2025-01-01T00:00:00Z',
  };
}

/**
 * The `grabbed` value for the paged `GET /history?eventType=` filter. That real *arr
 * endpoint binds `eventType` to the INTEGER `*HistoryEventType` enum (grabbed === 1;
 * see @hnet/arr SONARR_GRABBED_EVENT_TYPE) — the lowercase string it RETURNS in bodies
 * is rejected there with HTTP 400. The stub enforces the same so the prod bug
 * (fix/history-eventtype-enum) can never pass CI again.
 */
const GRABBED_EVENT_TYPE = 1;

/**
 * The real ASP.NET ValidationProblemDetails body the paged /history endpoint returns for
 * a non-integer `eventType` (captured live 2026-07-03). Mirrored so ArrHttpError sees the
 * exact shape production does.
 */
function invalidEventTypeBody(value: string) {
  return {
    type: 'https://tools.ietf.org/html/rfc7231#section-6.5.1',
    title: 'One or more validation errors occurred.',
    status: 400,
    traceId: '00-stubarr0000000000000000000000-0000000000000000-00',
    errors: { eventType: [`The value '${value}' is not valid.`] },
  };
}

function episodes() {
  // Season 1: 10 episodes, E10 missing (the seeded ledger row mirrors this as 9/10).
  const season1 = Array.from({ length: EPISODE_COUNT }, (_, i) => {
    const n = i + 1;
    const hasFile = n !== 10; // E10 missing
    return {
      id: STUB_SERIES_ID * 100 + n, // 50101..50110
      seriesId: STUB_SERIES_ID,
      seasonNumber: 1,
      episodeNumber: n,
      title: `Chapter ${n}`,
      airDateUtc: `2021-03-${String(n).padStart(2, '0')}T01:00:00Z`,
      hasFile,
      monitored: true,
      ...(hasFile ? { episodeFileId: 3000 + n } : {}),
    };
  });
  // Season 2: gives the detail view a second collapsible season (roll-up actions). One
  // episode on disk (so the season shows a Fix button), one missing.
  const season2 = [
    {
      id: STUB_SERIES_ID * 100 + 201, // 50301
      seriesId: STUB_SERIES_ID,
      seasonNumber: 2,
      episodeNumber: 1,
      title: 'Return',
      airDateUtc: '2022-03-01T01:00:00Z',
      hasFile: true,
      monitored: true,
      episodeFileId: 3201,
    },
    {
      id: STUB_SERIES_ID * 100 + 202, // 50302
      seriesId: STUB_SERIES_ID,
      seasonNumber: 2,
      episodeNumber: 2,
      title: 'Reckoning',
      airDateUtc: '2022-03-08T01:00:00Z',
      hasFile: false,
      monitored: true,
    },
  ];
  return [...season1, ...season2];
}

function seriesResource(id: number) {
  return {
    id,
    title: 'Breaking Prod',
    sortTitle: 'breaking prod',
    year: 2019,
    tvdbId: STUB_SERIES_TVDB_ID,
    monitored: true,
    monitorNewItems: 'all',
    qualityProfileId: 7,
    rootFolderPath: '/data/haynestower/Media/TV Shows',
    path: '/data/haynestower/Media/TV Shows/Breaking Prod',
    tags: [1],
    statistics: {
      episodeFileCount: 9,
      episodeCount: 10,
      totalEpisodeCount: 10,
      sizeOnDisk: 21_474_836_480,
    },
    seriesType: 'standard',
    seasonFolder: true,
    status: 'ended',
    ended: true,
    added: '2025-01-01T00:00:00Z',
    ...SONARR_META,
  };
}

function grabRecord(episodeId: number) {
  return {
    id: grabHistoryIdFor(episodeId),
    eventType: 'grabbed',
    date: '2026-07-01T10:00:00Z',
    sourceTitle: `Breaking.Prod.S01E${String(episodeId % 100).padStart(2, '0')}.MULTi.1080p.WEB-DL`,
    downloadId: `dl-${episodeId}`,
    quality: { quality: { id: 4, name: 'WEBDL-1080p' } },
    data: { indexer: 'StubIndexer', releaseGroup: 'STUB' },
    episodeId,
    seriesId: STUB_SERIES_ID,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

export async function startStubArr(): Promise<StubArrServer> {
  const calls: RecordedArrWrite[] = [];
  // PLAN-015 / D-20 — the scriptable download queue (staged via POST /_stub/queue). Empty by
  // default so a target with no download derives `searching`/`nothing_found`.
  let queueRecords: Record<string, unknown>[] = [];
  // PLAN-048 (fix/activity-robustness) — a scriptable FAULT toggle: when on, the Activity read
  // endpoints (`GET /queue`, `GET /history`) answer 500 so the *arr activity adapter's `list()`
  // throws. Exercises per-source failure isolation (one source down → the OTHERS still flow + a
  // per-source `unavailable` marker). Toggled via `POST /_stub/fault {on}`; cleared by reset.
  let faultReads = false;
  // ADR-093 / DESIGN-052 D-20 — Seerr's watchlist error switch: when on, every `/user/{id}/watchlist` page answers
  // Seerr 3.4.1's failed-read body (HTTP 200, `totalPages: 0`, `totalResults: 0`, no results). Cleared by reset.
  let seerrWatchlistError = false;
  // ADR-093 / DESIGN-052 D-10 — a spec-set Seerr watchlist per user id (`POST /_stub/seerr-watchlist`), in place of the
  // default (the member's Stub Dune). Cleared by reset, or per user by posting no `results`.
  const seerrWatchlistOverride = new Map<string, Array<Record<string, unknown>>>();
  // ADR-093 / DESIGN-052 D-13 / D-20 — the app-owned "must not contain" release profile. One list: this one stub
  // serves Radarr AND Sonarr, so each reconcile rewrites it with its own *arr's terms (each read-back still holds).
  let releaseProfiles: Array<Record<string, unknown> & { id: number }> = [];
  let nextReleaseProfileId = 1;
  // DESIGN-052 D-17 / D-20 — each Seerr user's watchlist sync flags (settings/main), and the Sonarr server's tags.
  let seerrSyncFlags = new Map<number, { movies: boolean; tv: boolean }>([[1, { movies: true, tv: true }]]);
  let seerrAnimeTags: number[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      // Normalize the API base away: /api/v3/... and /api/v1/... share handlers.
      const path = url.pathname.replace(/^\/api\/v[13]/, '');
      const query = Object.fromEntries(url.searchParams.entries());

      // ---- control surface ----
      if (url.pathname === '/_stub/calls') {
        return json(res, 200, { calls });
      }
      if (url.pathname === '/_stub/reset' && method === 'POST') {
        calls.length = 0;
        queueRecords = [];
        faultReads = false;
        seerrWatchlistError = false;
        seerrWatchlistOverride.clear();
        releaseProfiles = [];
        nextReleaseProfileId = 1;
        seerrSyncFlags = new Map([[1, { movies: true, tv: true }]]);
        seerrAnimeTags = [];
        clearStubArrDeleted();
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/_stub/seerr-watchlist-error' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = raw === '' ? {} : (JSON.parse(raw) as { on?: boolean });
        seerrWatchlistError = parsed.on !== false;
        res.writeHead(204);
        return res.end();
      }
      if (url.pathname === '/_stub/seerr-watchlist' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = raw === '' ? {} : (JSON.parse(raw) as { userId?: number; results?: Array<Record<string, unknown>> | null });
        const key = String(parsed.userId ?? 2);
        if (Array.isArray(parsed.results)) seerrWatchlistOverride.set(key, parsed.results);
        else seerrWatchlistOverride.delete(key);
        res.writeHead(204);
        return res.end();
      }
      // ADR-093 / DESIGN-052 D-02 / D-20 — Seerr's users and each user's watchlist (SEERR_URL points here; the path is
      // normalized, so `/api/v1/user` is `/user`). Seerr user 1 is the owner, user 2 the member (a friend); the
      // member's list holds Stub Dune, a title that is NOT in the Trash pool.
      if (method === 'GET' && path === '/user') {
        return json(res, 200, {
          pageInfo: { pages: 1, pageSize: 100, results: 2, page: 1 },
          results: [
            { id: 1, plexId: 12874060, userType: 1 },
            { id: 2, plexId: 77, userType: 1 },
          ],
        });
      }
      const seerrWatchlist = /^\/user\/(\d+)\/watchlist$/.exec(path);
      if (method === 'GET' && seerrWatchlist) {
        const page = Number(query.page ?? 1);
        if (seerrWatchlistError) return json(res, 200, { page, totalPages: 0, totalResults: 0, results: [] });
        const override = seerrWatchlistOverride.get(seerrWatchlist[1]!);
        const results = override
          ? override
          : seerrWatchlist[1] === '2'
            ? [{ id: 11, ratingKey: '5d776d1b0000000000000002', title: 'Stub Dune', mediaType: 'movie', tmdbId: 880020 }]
            : [];
        return json(res, 200, { page, totalPages: results.length > 0 ? 1 : 0, totalResults: results.length, results });
      }
      // ADR-093 / DESIGN-052 D-13 / D-20 — the release profile surface (kept out of the recorded `calls`, which other
      // specs assert on), plus a read of it for specs.
      if (url.pathname === '/_stub/release-profiles') return json(res, 200, { profiles: releaseProfiles });
      if (path === '/releaseprofile' && method === 'GET') return json(res, 200, releaseProfiles);
      if (path === '/releaseprofile' && method === 'POST') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const created = { ...body, id: nextReleaseProfileId++ };
        releaseProfiles.push(created);
        return json(res, 201, created);
      }
      const profilePut = /^\/releaseprofile\/(\d+)$/.exec(path);
      if (profilePut && method === 'PUT') {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        const id = Number(profilePut[1]);
        releaseProfiles = releaseProfiles.map((p) => (p.id === id ? { ...body, id } : p));
        return json(res, 202, { ...body, id });
      }
      // DESIGN-052 D-17 / D-20 — Seerr settings/main (the watchlist sync flags; POST echoes) and the Sonarr server list
      // the anime-tags preflight reads and PUTs.
      const seerrSettings = /^\/user\/(\d+)\/settings\/main$/.exec(path);
      if (seerrSettings) {
        const id = Number(seerrSettings[1]);
        if (method === 'POST') {
          const body = JSON.parse(await readBody(req)) as { watchlistSyncMovies?: boolean; watchlistSyncTv?: boolean };
          seerrSyncFlags.set(id, { movies: body.watchlistSyncMovies === true, tv: body.watchlistSyncTv === true });
        }
        const flags = seerrSyncFlags.get(id) ?? { movies: false, tv: false };
        return json(res, 200, {
          username: `Stub User ${id}`,
          locale: 'en',
          discoverRegion: 'US',
          streamingRegion: 'US',
          watchlistSyncMovies: flags.movies,
          watchlistSyncTv: flags.tv,
        });
      }
      const seerrSonarr = { id: 0, name: 'Stub Sonarr', is4k: false, isDefault: true, tags: [1], animeTags: seerrAnimeTags };
      if (path === '/settings/sonarr' && method === 'GET') return json(res, 200, [seerrSonarr]);
      if (path === '/settings/sonarr/0' && method === 'PUT') {
        const body = JSON.parse(await readBody(req)) as { animeTags?: number[] };
        seerrAnimeTags = Array.isArray(body.animeTags) ? body.animeTags : [];
        return json(res, 200, { ...seerrSonarr, animeTags: seerrAnimeTags });
      }
      if ((path === '/exclusions/paged' || path === '/importlistexclusion/paged') && method === 'GET') {
        return json(res, 200, { page: 1, pageSize: 1, totalRecords: 0, records: [] });
      }
      // PLAN-015 / D-20 — stage the download queue for the Action Feedback progress derivation.
      if (url.pathname === '/_stub/queue' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = raw === '' ? {} : (JSON.parse(raw) as { records?: Record<string, unknown>[] });
        queueRecords = Array.isArray(parsed.records) ? parsed.records : [];
        res.writeHead(204);
        return res.end();
      }
      // PLAN-048 (fix/activity-robustness) — toggle the Activity-read fault (500 on /queue + /history).
      if (url.pathname === '/_stub/fault' && method === 'POST') {
        const raw = await readBody(req);
        const parsed = raw === '' ? {} : (JSON.parse(raw) as { on?: boolean });
        faultReads = parsed.on !== false;
        res.writeHead(204);
        return res.end();
      }
      // When faulted, the *arr Activity reads answer 500 so the adapter degrades (per-source isolation).
      if (faultReads && method === 'GET' && (path === '/queue' || path.startsWith('/history'))) {
        return json(res, 500, { error: 'stub fault: *arr Activity read unavailable' });
      }

      if (method === 'POST' || method === 'DELETE' || method === 'PUT') {
        const raw = await readBody(req);
        const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
        calls.push({ method, path, query, body });

        // POST /history/failed/{id} — the AC-07 blocklist write. No response body.
        if (method === 'POST' && /^\/history\/failed\/\d+$/.test(path)) {
          return json(res, 200, {});
        }
        // POST /command — search trigger; echo the command name back with an id.
        if (method === 'POST' && path === '/command') {
          const name =
            typeof body === 'object' && body !== null && 'name' in body
              ? String((body as { name: unknown }).name)
              : 'UnknownCommand';
          return json(res, 201, { id: 4242, name });
        }
        // File deletes (AC-08 fallback) — accepted, recorded.
        if (method === 'DELETE' && /^\/(episodefile|moviefile|trackfile)\/\d+$/.test(path)) {
          return json(res, 200, {});
        }
        // ADR-022 D-02 — the bulk-editor monitor flip (Ledger Add-&-search, present-but-
        // unmonitored path). Echo the updated resource list (the write client drains it).
        if (method === 'PUT' && /^\/(series|movie|artist)\/editor$/.test(path)) {
          return json(res, 200, []);
        }
        // POST /series|/movie|/artist|/tag (restore + Ledger add surface) — echo resources.
        if (method === 'POST' && path === '/tag') {
          return json(res, 201, {
            id: 99,
            label: String((body as { label?: unknown })?.label ?? ''),
          });
        }
        if (method === 'POST' && path === '/series') {
          return json(res, 201, seriesResource(9001));
        }
        if (method === 'POST' && path === '/movie') {
          return json(res, 201, movieResource(9701));
        }
        if (method === 'POST' && path === '/artist') {
          return json(res, 201, artistResource(9801));
        }
        return json(res, 404, { message: `stub-arr: no write handler for ${method} ${path}` });
      }

      // ---- MediaCover poster proxy (ADR-019 / D-14): serve the fixture PNG for any variant.
      // Matches radarr/sonarr `/mediacover/{id}/poster-250.jpg` + lidarr `/mediacover/artist/{id}/…`.
      if (method === 'GET' && /^\/mediacover\//.test(path)) {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(POSTER_PNG);
      }

      // ---- GET /movie/{id} — the radarr fix flow's pre-read before its delete fallback
      // (getMovieById → movieFileId). PLAN-015's movie-fix journey is the first spec to
      // exercise a non-subtitle movie Fix, so this by-id read joined late.
      if (method === 'GET') {
        const movieById = /^\/movie\/(\d+)$/.exec(path);
        if (movieById) {
          const id = Number(movieById[1]);
          // ADR-093 / DESIGN-052 D-14 — after a stub Maintainerr delete the movie is gone (404).
          if (id === STUB_MOVIE_ID && stubArrDeleted.tmdb.has(STUB_MOVIE_TMDB_ID)) {
            return json(res, 404, { message: `stub-arr: movie ${id} was deleted` });
          }
          if (id === STUB_MOVIE_ID) return json(res, 200, movieResource(STUB_MOVIE_ID));
          if (id === STUB_VANISHED_ID && stubArrDeleted.tmdb.has(STUB_VANISHED_TMDB_ID)) {
            return json(res, 404, { message: `stub-arr: movie ${id} was deleted` });
          }
          if (id === STUB_VANISHED_ID) return json(res, 200, vanishedMovieResource());
          return json(res, 404, { message: `stub-arr: no movie ${id}` });
        }
        const seriesById = /^\/series\/(\d+)$/.exec(path);
        if (seriesById) {
          const id = Number(seriesById[1]);
          if (id === STUB_SERIES_ID && !stubArrDeleted.tvdb.has(STUB_SERIES_TVDB_ID)) {
            return json(res, 200, seriesResource(STUB_SERIES_ID));
          }
          return json(res, 404, { message: `stub-arr: no series ${id}` });
        }
      }

      // ---- reads ----
      switch (path) {
        case '/system/status':
          return json(res, 200, { appName: 'StubArr', version: '0.0.0-e2e' });
        case '/series':
          return json(res, 200, [seriesResource(STUB_SERIES_ID)]);
        case '/movie':
          // The Fixture (monitored, on disk) + Vanished Heist (unmonitored, fileless) — the
          // skip and monitor-flip halves of the Ledger bulk action's outcome matrix.
          return json(res, 200, [movieResource(STUB_MOVIE_ID), vanishedMovieResource()]);
        case '/collection':
          // DESIGN-044 D-05 (owner poster + caught-em-all redesign) — one TMDb franchise (id 990001) with two
          // films: The Fixture (tmdbId 880001, HELD in the seeded ledger → its tile renders the /api/posters
          // proxy) and a Sequel the estate does NOT hold (MISSING → the collection member's provider image).
          return json(res, 200, [
            {
              id: 5001,
              title: 'The Fixture Collection',
              tmdbId: 990001,
              movies: [
                {
                  tmdbId: STUB_MOVIE_TMDB_ID,
                  title: 'The Fixture',
                  images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/t/p/original/fixture.jpg' }],
                },
                {
                  tmdbId: 880002,
                  title: 'The Fixture II: Reticketed',
                  images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/t/p/original/fixture2.jpg' }],
                },
              ],
            },
          ]);
        case '/artist':
          return json(res, 200, []);
        // DESIGN-008 D-05 — the /lookup endpoints (tombstoned-row metadata, no add).
        case '/movie/lookup':
          return json(res, 200, [
            {
              title: 'The Fixture',
              year: 2022,
              tmdbId: STUB_MOVIE_TMDB_ID,
              imdbId: 'tt8800010',
              remotePoster: 'https://image.tmdb.org/t/p/original/lookup.jpg',
              // DESIGN-044 D-04/D-05 — the movie's TMDb franchise, so the "movie franchise" ref search yields a
              // pickable franchise (id 990001, previewed via the /collection handler above).
              collection: { title: 'The Fixture Collection', tmdbId: 990001 },
              ...RADARR_META,
            },
          ]);
        case '/series/lookup':
          return json(res, 200, [
            {
              title: 'Breaking Prod',
              year: 2019,
              tvdbId: STUB_SERIES_TVDB_ID,
              remotePoster: 'https://artworks.thetvdb.com/x/lookup.jpg',
              ...SONARR_META,
            },
          ]);
        case '/artist/lookup':
          return json(res, 200, [
            {
              artistName: 'The Stub Band',
              foreignArtistId: '11111111-2222-3333-4444-555555550701',
              genres: ['Rock'],
              ratings: { value: 7.0, votes: 3 },
            },
          ]);
        case '/episode': {
          if (Number(query.seriesId) !== STUB_SERIES_ID) return json(res, 200, []);
          return json(res, 200, episodes());
        }
        case '/episodefile': {
          // DESIGN-008 D-02 resolution fix — one file per on-disk episode, each carrying the
          // normalized `quality.quality.resolution` int the harvest derives the dominant tier
          // from (all 1080 → '1080p' for the stub series).
          if (Number(query.seriesId) !== STUB_SERIES_ID) return json(res, 200, []);
          const files = episodes()
            .filter((e) => e.hasFile)
            .map((e) => ({
              id: e.episodeFileId,
              seriesId: STUB_SERIES_ID,
              quality: { quality: { id: 4, name: 'WEBDL-1080p', resolution: 1080 } },
              // ADR-093 / DESIGN-052 D-11 — the identity fields the Release Block records before a delete.
              seasonNumber: e.seasonNumber,
              relativePath: `Season ${e.seasonNumber}/Breaking Prod - S0${e.seasonNumber}E${String(e.episodeNumber).padStart(2, '0')} [WEBDL-1080p]-STUB.mkv`,
              sceneName: `Breaking.Prod.S0${e.seasonNumber}E${String(e.episodeNumber).padStart(2, '0')}.1080p.WEB-DL.DDP5.1.H.264-STUB`,
              releaseGroup: 'STUB',
              size: 1_073_741_824,
            }));
          return json(res, 200, files);
        }
        case '/moviefile': {
          // ADR-093 / DESIGN-052 D-11 — The Fixture's file, with the identity the Release Block records.
          if (Number(query.movieId) !== STUB_MOVIE_ID) return json(res, 200, []);
          return json(res, 200, [
            {
              id: 9601,
              movieId: STUB_MOVIE_ID,
              relativePath: 'The Fixture (2022) {imdb-tt8800010} [WEBDL-1080p][EAC3 5.1][h264]-STUB.mkv',
              sceneName: 'The.Fixture.2022.1080p.WEB-DL.DDP5.1.H.264-STUB',
              releaseGroup: 'STUB',
              quality: { quality: { id: 4, name: 'WEBDL-1080p', resolution: 1080, source: 'web', modifier: 'none' } },
              size: 4_294_967_296,
            },
          ]);
        }
        case '/history/series':
          return json(res, 200, []);
        case '/album': {
          // Lidarr album picker (D-06): the seeded artist 701 has one on-disk album so its
          // detail offers Fix — used to assert Music offers no 'Missing subtitles' radio
          // (ADR-016 / D-19). Mirrors seed-ledger.ts's lidarr row.
          if (Number(query.artistId) !== STUB_ARTIST_ID) return json(res, 200, []);
          return json(res, 200, [
            {
              id: STUB_ALBUM_ID,
              artistId: STUB_ARTIST_ID,
              foreignAlbumId: '11111111-2222-3333-4444-666666660701',
              title: 'Stub Sessions',
              albumType: 'Album',
              monitored: true,
              anyReleaseOk: true,
              releaseDate: '2020-01-01T00:00:00Z',
              statistics: {
                trackFileCount: 10,
                trackCount: 10,
                totalTrackCount: 10,
                sizeOnDisk: 1_073_741_824,
              },
            },
          ]);
        }
        case '/history': {
          // STRICT: the real paged /history binds eventType to the INTEGER enum — a
          // lowercase string 400s (the fix/history-eventtype-enum prod bug). Reject any
          // non-integer eventType with the real error shape so a regression fails CI.
          if (query.eventType !== undefined && !/^\d+$/.test(query.eventType)) {
            return json(res, 400, invalidEventTypeBody(query.eventType));
          }
          // Latest-grab lookup: ?episodeId=&eventType=1 (paged envelope; 1 === grabbed).
          const episodeId = Number(query.episodeId ?? Number.NaN);
          const records =
            Number(query.eventType) === GRABBED_EVENT_TYPE && Number.isFinite(episodeId)
              ? [grabRecord(episodeId)]
              : [];
          return json(res, 200, {
            page: 1,
            pageSize: 20,
            sortKey: 'date',
            sortDirection: 'descending',
            totalRecords: records.length,
            records,
          });
        }
        case '/queue': {
          // PLAN-015 / D-20 — serve the staged queue, server-side filtered by the parent id
          // (seriesIds/movieIds/artistIds), exactly like the real *arrs (verified live 2026-07-07).
          const parentParam =
            query.seriesIds ?? query.movieIds ?? query.artistIds ?? undefined;
          const parentId = parentParam !== undefined ? Number(parentParam) : undefined;
          const records =
            parentId === undefined
              ? queueRecords
              : queueRecords.filter(
                  (r) =>
                    r.seriesId === parentId || r.movieId === parentId || r.artistId === parentId,
                );
          return json(res, 200, {
            page: 1,
            pageSize: 200,
            sortKey: 'timeleft',
            sortDirection: 'ascending',
            totalRecords: records.length,
            records,
          });
        }
        case '/history/movie':
          return json(res, 200, []);
        case '/qualityprofile':
          return json(res, 200, [
            { id: 7, name: 'HD-1080p' },
            { id: 1, name: 'Any' },
          ]);
        case '/metadataprofile':
          return json(res, 200, [{ id: 1, name: 'Standard' }]);
        case '/rootfolder':
          // One stub stands in for all three *arrs, so it advertises every seeded root —
          // the Ledger add path validates the recorded root against this list.
          return json(res, 200, [
            { id: 1, path: '/data/haynestower/Media/TV Shows' },
            { id: 2, path: '/data/haynestower/Media/Movies' },
            { id: 3, path: '/data/media/music' },
          ]);
        case '/diskspace':
          // ADR-030 / DESIGN-013 (PLAN-013) — the utilization source of record. One stub serves all
          // three *arrs, so it advertises BOTH physical media arrays (the domain's getUtilization picks
          // each array's disk by path): the HaynesTower NFS array at ~78.8% used (the owner's
          // cross-check number) and the CephFS music pool at ~25.4%, live-shaped 2026-07-07.
          return json(res, 200, [
            {
              path: '/data/haynestower',
              label: 'haynestower',
              freeSpace: 112_430_400_000_000,
              totalSpace: 529_960_000_000_000,
            },
            {
              path: '/data/cephfs-hdd',
              label: 'cephfs',
              freeSpace: 130_450_000_000_000,
              totalSpace: 174_840_000_000_000,
            },
          ]);
        case '/tag':
          return json(res, 200, [{ id: 1, label: 'mediarequests' }]);
        case '/trackfile':
          return json(res, 200, []);
        default:
          return json(res, 404, { message: `stub-arr: no read handler for GET ${path}` });
      }
    })().catch((err: unknown) => {
      json(res, 500, { message: `stub-arr error: ${String(err)}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-arr failed to bind a port');
  }
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
