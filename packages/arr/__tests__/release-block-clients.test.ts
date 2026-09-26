// ADR-093 / DESIGN-052 D-11 / D-13 / D-16 / D-17 / D-23 (PLAN-072 S2 part 2) — the client surface the Release Block,
// the Deleted-Release Record and the Seerr enrollment use, fully offline against fetch stubs (ADR-010):
// - Radarr / Sonarr `releaseprofile` list / create / update (the exact bodies, terms always an array);
// - the identity reads: `moviefile` / `episodefile` with their identity fields, `history/movie` / `history/series`
//   with `data.fileId` parsed and NO URL-bearing data key carried over, `movie/{id}` / `series/{id}` 404 ⇒ null;
// - the import-list exclusion counts (Radarr `exclusions/paged`, Sonarr `importlistexclusion/paged`);
// - Seerr: the watchlist sync flags, the settings write echoing the WHOLE GET body, the Sonarr `animeTags` write
//   echoing the whole server object and reading it back;
// - the Maintainerr collection schema carries `listExclusions` / `forceSeerr`; Radarr's `secondaryYear`.
import { describe, expect, it } from 'vitest';
import { RadarrClient, SeerrClient, SonarrClient } from '../src/read';
import { RadarrWriteClient, SeerrWriteClient, SonarrWriteClient } from '../src/write';
import { maintainerrCollectionSchema, radarrMovieSchema } from '../src/schemas';
import { stubFetch, TEST_OPTS } from './helpers';

const RADARR = { ...TEST_OPTS, baseUrl: 'http://radarr.test:7878' };
const SONARR = { ...TEST_OPTS, baseUrl: 'http://sonarr.test:8989' };
const SEERR = { ...TEST_OPTS, baseUrl: 'http://seerr.test:5055' };

const profile = {
  id: 4,
  name: 'haynesnetwork: deleted releases (managed, do not edit)',
  enabled: true,
  required: [],
  ignored: ['hnet-release-block-sentinel', '/^a(?:[^a-z0-9]|$)/i'],
  indexerId: 0,
  tags: [],
};

describe('release profiles (D-13)', () => {
  it('lists, creates (no id in the body) and updates (PUT /releaseprofile/{id}) on Radarr and Sonarr', async () => {
    for (const [Client, base] of [
      [RadarrWriteClient, RADARR],
      [SonarrWriteClient, SONARR],
    ] as const) {
      const { fetchImpl, calls } = stubFetch([
        { path: '/api/v3/releaseprofile', body: [profile] },
        { method: 'POST', path: '/api/v3/releaseprofile', status: 201, body: profile },
        { method: 'PUT', path: '/api/v3/releaseprofile/4', status: 202, body: profile },
      ]);
      const client = new Client({ ...base, fetchImpl });
      expect(await client.listReleaseProfiles()).toEqual([profile]);
      const input = {
        name: profile.name,
        enabled: true,
        required: [],
        ignored: profile.ignored,
        indexerId: 0,
        tags: [],
      };
      await client.createReleaseProfile({ ...input, id: 99 });
      await client.updateReleaseProfile({ ...input, id: 4 });
      expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
        'GET /api/v3/releaseprofile',
        'POST /api/v3/releaseprofile',
        'PUT /api/v3/releaseprofile/4',
      ]);
      expect(calls[1]!.body).toEqual(input); // never an id on create
      expect(calls[2]!.body).toEqual({ ...input, id: 4 });
      expect(Array.isArray((calls[2]!.body as { ignored: unknown }).ignored)).toBe(true);
      expect(calls[0]!.headers.get('X-Api-Key')).toBe('test-api-key');
    }
  });

  it('reads a profile whose terms come back as one comma-separated string', async () => {
    const { fetchImpl } = stubFetch([
      { path: '/api/v3/releaseprofile', body: [{ ...profile, ignored: 'a, b' }] },
    ]);
    const [p] = await new RadarrWriteClient({ ...RADARR, fetchImpl }).listReleaseProfiles();
    expect(p!.ignored).toEqual(['a', 'b']);
  });
});

describe('identity reads (D-11)', () => {
  const file = {
    id: 70,
    movieId: 7,
    relativePath: 'Babygirl (2024) [Remux-2160p]-FraMeSToR.mkv',
    path: '/movies/Babygirl (2024)/x.mkv',
    size: 53_310_000_000,
    sceneName: 'Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR',
    originalFilePath:
      'Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR/x.mkv',
    releaseGroup: 'FraMeSToR',
    quality: {
      quality: {
        id: 31,
        name: 'Remux-2160p',
        source: 'bluray',
        resolution: 2160,
        modifier: 'remux',
      },
    },
    mediaInfo: { videoCodec: 'x265' },
  };
  const grab = {
    id: 1,
    movieId: 7,
    eventType: 'grabbed',
    date: '2026-01-01T00:00:00Z',
    sourceTitle: file.sceneName,
    downloadId: 'SABnzbd_nzo_1',
    quality: { quality: { id: 31, name: 'Remux-2160p', resolution: 2160 } },
    data: {
      indexer: 'NZBgeek (Prowlarr)',
      releaseGroup: 'FraMeSToR',
      downloadUrl: 'https://indexer.test/getnzb?apikey=SECRET',
      nzbInfoUrl: 'https://indexer.test/details?apikey=SECRET',
    },
  };
  const imported = {
    id: 2,
    movieId: 7,
    eventType: 'downloadFolderImported',
    date: '2026-01-01T01:00:00Z',
    sourceTitle: file.sceneName,
    downloadId: 'SABnzbd_nzo_1',
    data: {
      fileId: '70',
      importedPath: '/movies/Babygirl (2024)/x.mkv',
      droppedPath: '/downloads/x.mkv',
    },
  };

  it('Radarr: moviefile identity fields; history with fileId parsed and no URL carried over; 404 ⇒ null', async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: '/api/v3/moviefile', body: [file] },
      { path: '/api/v3/history/movie', body: [grab, imported] },
      { path: '/api/v3/movie/7', status: 404, body: { message: 'NotFound' } },
      {
        path: '/api/v3/exclusions/paged',
        body: { page: 1, pageSize: 1, totalRecords: 812, records: [] },
      },
    ]);
    const radarr = new RadarrClient({ ...RADARR, fetchImpl });
    const [f] = await radarr.listMovieFiles(7);
    expect(f).toEqual({
      id: 70,
      movieId: 7,
      relativePath: file.relativePath,
      sceneName: file.sceneName,
      originalFilePath: file.originalFilePath,
      releaseGroup: 'FraMeSToR',
      quality: file.quality,
      size: file.size,
    });
    const history = await radarr.getMovieReleaseHistory(7);
    expect(history[0]).toMatchObject({
      eventType: 'grabbed',
      downloadId: 'SABnzbd_nzo_1',
      indexer: 'NZBgeek (Prowlarr)',
      fileId: null,
    });
    expect(history[1]).toMatchObject({
      eventType: 'downloadFolderImported',
      fileId: 70,
      importedPath: '/movies/Babygirl (2024)/x.mkv',
    });
    expect(JSON.stringify(history)).not.toMatch(/SECRET|apikey|getnzb/);
    expect(await radarr.findMovie(7)).toBeNull();
    expect(await radarr.countImportListExclusions()).toBe(812);
    expect(calls.map((c) => `${c.url.pathname}${c.url.search}`)).toEqual([
      '/api/v3/moviefile?movieId=7',
      '/api/v3/history/movie?movieId=7',
      '/api/v3/movie/7',
      '/api/v3/exclusions/paged?page=1&pageSize=1',
    ]);
  });

  it('Sonarr: episodefile season and identity fields; history/series; series 404 ⇒ null; other errors throw', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        path: '/api/v3/episodefile',
        body: [
          {
            id: 5,
            seriesId: 3,
            seasonNumber: 2,
            sceneName: 'Show.S02E01.1080p-GRP',
            releaseGroup: 'GRP',
            quality: { quality: { name: 'WEBDL-1080p', resolution: 1080 } },
            size: 10,
          },
        ],
      },
      {
        path: '/api/v3/history/series',
        body: [{ ...imported, movieId: undefined, seriesId: 3, episodeId: 9 }],
      },
      { path: '/api/v3/series/3', status: 404, body: {} },
      { path: '/api/v3/series/4', status: 500, body: {} },
      {
        path: '/api/v3/importlistexclusion/paged',
        body: { page: 1, pageSize: 1, totalRecords: 40, records: [] },
      },
    ]);
    const sonarr = new SonarrClient({ ...SONARR, fetchImpl, getRetries: 0 });
    expect((await sonarr.listEpisodeFileReleases(3))[0]).toMatchObject({
      id: 5,
      seasonNumber: 2,
      releaseGroup: 'GRP',
    });
    expect((await sonarr.getSeriesReleaseHistory(3))[0]).toMatchObject({
      episodeId: 9,
      fileId: 70,
    });
    expect(await sonarr.findSeries(3)).toBeNull();
    await expect(sonarr.findSeries(4)).rejects.toThrow(/500/);
    expect(await sonarr.countImportListExclusions()).toBe(40);
    expect(calls.map((c) => c.url.pathname + c.url.search)).toContain(
      '/api/v3/history/series?seriesId=3',
    );
  });

  it('schemas: Radarr secondaryYear; Maintainerr collections listExclusions / forceSeerr', () => {
    expect(radarrMovieSchema.shape.secondaryYear.parse(2016)).toBe(2016);
    expect(radarrMovieSchema.shape.secondaryYear.parse(null)).toBeNull();
    expect(
      maintainerrCollectionSchema.parse({ id: 1, listExclusions: true, forceSeerr: false }),
    ).toMatchObject({
      listExclusions: true,
      forceSeerr: false,
    });
  });
});

describe('Seerr enrollment writes (D-17)', () => {
  const settingsBody = {
    username: 'Friend',
    email: 'friend@example.com',
    locale: 'en',
    discoverRegion: 'US',
    streamingRegion: 'US',
    originalLanguage: null,
    movieQuotaLimit: 5,
    movieQuotaDays: 7,
    tvQuotaLimit: null,
    tvQuotaDays: null,
    globalMovieQuotaDays: null,
    globalMovieQuotaLimit: null,
    globalTvQuotaDays: null,
    globalTvQuotaLimit: null,
    watchlistSyncMovies: false,
    watchlistSyncTv: false,
  };

  it('reads the two flags only (a missing flag reads false)', async () => {
    const { fetchImpl } = stubFetch([
      {
        path: '/api/v1/user/12/settings/main',
        body: { ...settingsBody, watchlistSyncTv: undefined },
      },
    ]);
    const flags = await new SeerrClient({ ...SEERR, fetchImpl }).getUserWatchlistSync(12);
    expect(flags).toEqual({ movies: false, tv: false });
  });

  it('setWatchlistSync echoes the WHOLE GET body with both flags on, and returns the response flags', async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: '/api/v1/user/12/settings/main', body: settingsBody },
      {
        method: 'POST',
        path: '/api/v1/user/12/settings/main',
        body: { ...settingsBody, watchlistSyncMovies: true, watchlistSyncTv: true },
      },
    ]);
    const res = await new SeerrWriteClient({ ...SEERR, fetchImpl }).setWatchlistSync(12, {
      movies: true,
      tv: true,
    });
    expect(res).toEqual({ movies: true, tv: true });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(calls[1]!.body).toEqual({
      ...settingsBody,
      watchlistSyncMovies: true,
      watchlistSyncTv: true,
    });
  });

  it('setSonarrAnimeTags PUTs the whole server object with animeTags replaced, then reads it back', async () => {
    const server = {
      id: 0,
      name: 'Sonarr',
      hostname: 'sonarr',
      port: 8989,
      apiKey: 'SONARR-KEY',
      tags: [1],
      animeTags: [],
      is4k: false,
      isDefault: true,
      activeProfileId: 4,
    };
    let saved = server;
    const calls: Array<{ method: string; body: unknown }> = [];
    const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, body });
      expect(new URL(String(input)).pathname).toMatch(/^\/api\/v1\/settings\/sonarr(\/0)?$/);
      if (method === 'PUT') saved = body;
      return new Response(JSON.stringify(method === 'PUT' ? saved : [saved]), { status: 200 });
    }) as typeof fetch;
    const res = await new SeerrWriteClient({ ...SEERR, fetchImpl }).setSonarrAnimeTags(0, [1]);
    expect(res).toMatchObject({ id: 0, tags: [1], animeTags: [1] });
    expect(res).not.toHaveProperty('apiKey');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET']);
    expect(calls[1]!.body).toEqual({ ...server, animeTags: [1] });
  });
});
