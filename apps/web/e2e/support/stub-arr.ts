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
//   POST /_stub/reset  → 204 (clears recorded calls)
import { createServer, type IncomingMessage, type Server } from 'node:http';

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
    { coverType: 'poster', url: '/MediaCover/601/poster.jpg?lastWrite=1', remoteUrl: 'https://image.tmdb.org/t/p/original/fixture.jpg' },
  ],
};
const SONARR_META = {
  runtime: 44,
  genres: ['Drama', 'Crime'],
  ratings: { value: 8.2, votes: 4321 },
  images: [
    { coverType: 'poster', url: '/MediaCover/501/poster.jpg?lastWrite=1', remoteUrl: 'https://artworks.thetvdb.com/x/poster.jpg' },
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
        res.writeHead(204);
        return res.end();
      }

      if (method === 'POST' || method === 'DELETE') {
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
        // POST /series|/movie|/artist|/tag (restore surface) — echo minimal resources.
        if (method === 'POST' && path === '/tag') {
          return json(res, 201, {
            id: 99,
            label: String((body as { label?: unknown })?.label ?? ''),
          });
        }
        if (method === 'POST' && path === '/series') {
          return json(res, 201, seriesResource(9001));
        }
        return json(res, 404, { message: `stub-arr: no write handler for ${method} ${path}` });
      }

      // ---- MediaCover poster proxy (ADR-019 / D-14): serve the fixture PNG for any variant.
      // Matches radarr/sonarr `/mediacover/{id}/poster-250.jpg` + lidarr `/mediacover/artist/{id}/…`.
      if (method === 'GET' && /^\/mediacover\//.test(path)) {
        res.writeHead(200, { 'content-type': 'image/png' });
        return res.end(POSTER_PNG);
      }

      // ---- reads ----
      switch (path) {
        case '/system/status':
          return json(res, 200, { appName: 'StubArr', version: '0.0.0-e2e' });
        case '/series':
          return json(res, 200, [seriesResource(STUB_SERIES_ID)]);
        case '/movie':
          return json(res, 200, [movieResource(STUB_MOVIE_ID)]);
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
            { artistName: 'The Stub Band', foreignArtistId: '11111111-2222-3333-4444-555555550701', genres: ['Rock'], ratings: { value: 7.0, votes: 3 } },
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
            }));
          return json(res, 200, files);
        }
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
          return json(res, 200, [{ id: 1, path: '/data/haynestower/Media/TV Shows' }]);
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
