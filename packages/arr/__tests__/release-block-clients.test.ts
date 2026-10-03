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
import { LidarrClient, RadarrClient, SeerrClient, SonarrClient } from '../src/read';
import { LidarrWriteClient, RadarrWriteClient, SeerrWriteClient, SonarrWriteClient } from '../src/write';
import { maintainerrCollectionSchema, radarrMovieSchema } from '../src/schemas';
import { stubFetch, TEST_OPTS } from './helpers';

const RADARR = { ...TEST_OPTS, baseUrl: 'http://radarr.test:7878' };
const SONARR = { ...TEST_OPTS, baseUrl: 'http://sonarr.test:8989' };
const SEERR = { ...TEST_OPTS, baseUrl: 'http://seerr.test:5055' };
const LIDARR = { ...TEST_OPTS, baseUrl: 'http://lidarr.test:8686' };

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

// ADR-094 / DESIGN-046 D-14 — the janitor release block on Lidarr (v1): no `name` on the resource, and the grab's own
// release title from the download's history.
describe('Lidarr release profiles + grab history (ADR-094 / DESIGN-046 D-14)', () => {
  const lidarrProfile = {
    id: 5,
    enabled: true,
    required: [],
    ignored: ['haynesnetwork-janitor-managed-do-not-edit', '/^[^a-z0-9]*a[^a-z0-9]*b[^a-z0-9]*$/i'],
    indexerId: 0,
    tags: [],
  };

  it('lists, creates (no id, no name) and updates (PUT /api/v1/releaseprofile/{id})', async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: '/api/v1/releaseprofile', body: [lidarrProfile, { ...lidarrProfile, id: 6, ignored: 'x, y' }] },
      { method: 'POST', path: '/api/v1/releaseprofile', status: 201, body: lidarrProfile },
      { method: 'PUT', path: '/api/v1/releaseprofile/5', status: 202, body: lidarrProfile },
    ]);
    const client = new LidarrWriteClient({ ...LIDARR, fetchImpl });
    const listed = await client.listReleaseProfiles();
    expect(listed[0]).toEqual(lidarrProfile);
    expect(listed[1]!.ignored).toEqual(['x', 'y']);
    const input = { enabled: true, required: [], ignored: lidarrProfile.ignored, indexerId: 0, tags: [] };
    await client.createReleaseProfile({ ...input, id: 99 });
    await client.updateReleaseProfile({ ...input, id: 5 });
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      'GET /api/v1/releaseprofile',
      'POST /api/v1/releaseprofile',
      'PUT /api/v1/releaseprofile/5',
    ]);
    expect(calls[1]!.body).toEqual(input); // never an id on create, never a name
    expect(calls[2]!.body).toEqual({ ...input, id: 5 });
  });

  it('getDownloadGrabs reads /api/v1/history filtered to the download and the grabbed event (integer 1)', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        path: '/api/v1/history',
        body: {
          page: 1,
          pageSize: 10,
          totalRecords: 1,
          records: [
            {
              id: 1,
              eventType: 'grabbed',
              date: '2026-09-29T00:00:00Z',
              sourceTitle: 'Artist - Album (2019) [FLAC]',
              downloadId: 'SABnzbd_nzo_1',
              albumId: 71,
              artistId: 7,
              data: { downloadUrl: 'https://indexer.test/?apikey=secret' },
            },
          ],
        },
      },
    ]);
    const page = await new LidarrClient({ ...LIDARR, fetchImpl }).getDownloadGrabs('SABnzbd_nzo_1');
    expect(page.records[0]!.sourceTitle).toBe('Artist - Album (2019) [FLAC]');
    const q = calls[0]!.url.searchParams;
    expect(q.get('downloadId')).toBe('SABnzbd_nzo_1');
    expect(q.get('eventType')).toBe('1');
    expect(q.get('pageSize')).toBe('10');
    expect(q.get('sortDirection')).toBe('descending');
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

  it('D-25cj: beforeWrite runs after the GET answered and before the POST; a failed GET never runs it', async () => {
    const order: string[] = [];
    const { fetchImpl, calls } = stubFetch([
      { path: '/api/v1/user/12/settings/main', body: settingsBody },
      {
        method: 'POST',
        path: '/api/v1/user/12/settings/main',
        body: { ...settingsBody, watchlistSyncMovies: true, watchlistSyncTv: true },
      },
    ]);
    await new SeerrWriteClient({ ...SEERR, fetchImpl }).setWatchlistSync(
      12,
      { movies: true, tv: true },
      {
        beforeWrite: async () => {
          order.push(`beforeWrite after ${calls.map((c) => c.method).join(',')}`);
        },
      },
    );
    expect(order).toEqual(['beforeWrite after GET']);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);

    const failing = stubFetch([{ path: '/api/v1/user/12/settings/main', status: 400, body: { message: 'no' } }]);
    let ran = false;
    await expect(
      new SeerrWriteClient({ ...SEERR, fetchImpl: failing.fetchImpl }).setWatchlistSync(
        12,
        { movies: true, tv: true },
        {
          beforeWrite: async () => {
            ran = true;
          },
        },
      ),
    ).rejects.toThrow();
    expect(ran).toBe(false);
    expect(failing.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('setSonarrAnimeTags PUTs the whole server object (minus the read-only id) with animeTags replaced, then reads it back', async () => {
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
      // Seerr 3.4.1 answers a body carrying the read-only `id` with 400 (seen live, PLAN-072 S9).
      if (method === 'PUT' && body && typeof body === 'object' && 'id' in body)
        return new Response(JSON.stringify({ message: 'request/body/id is read-only' }), { status: 400 });
      if (method === 'PUT') saved = { ...body, id: 0 };
      return new Response(JSON.stringify(method === 'PUT' ? saved : [saved]), { status: 200 });
    }) as typeof fetch;
    const res = await new SeerrWriteClient({ ...SEERR, fetchImpl }).setSonarrAnimeTags(0, [1]);
    expect(res).toMatchObject({ id: 0, tags: [1], animeTags: [1] });
    expect(res).not.toHaveProperty('apiKey');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'GET']);
    const { id: _id, ...withoutId } = server;
    expect(calls[1]!.body).toEqual({ ...withoutId, animeTags: [1] });
  });
});

// ADR-096 / DESIGN-052 D-26 — the title exclusion surface: Radarr `exclusions`, Sonarr `importlistexclusion`.
describe('import-list exclusions (ADR-096 / D-26)', () => {
  it('lists every page of Radarr exclusions, oldest id first, normalized', async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      tmdbId: 10_000 + i,
      movieTitle: `Movie ${i}`,
      movieYear: 2020,
    }));
    const page2 = [{ id: 1001, tmdbId: 1097549, movieTitle: 'Babygirl', movieYear: 2024 }];
    let n = 0;
    const fetchImpl = (async (input: unknown) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/v3/exclusions/paged');
      n += 1;
      const records = url.searchParams.get('page') === '1' ? page1 : page2;
      return new Response(JSON.stringify({ page: n, pageSize: 1000, totalRecords: 1001, records }), {
        status: 200,
      });
    }) as typeof fetch;
    const radarr = new RadarrClient({ ...RADARR, fetchImpl });
    const all = await radarr.listImportListExclusions();
    expect(all).toHaveLength(1001);
    expect(all[1000]).toEqual({ id: 1001, tmdbId: 1097549, tvdbId: null, title: 'Babygirl', year: 2024 });
    expect(n).toBe(2);
  });

  it('sends the paging and sort query, and stops on a short page (Sonarr)', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        path: '/api/v3/importlistexclusion/paged',
        body: { page: 1, pageSize: 1000, totalRecords: 1, records: [{ id: 7, tvdbId: 81189, title: 'Breaking Bad' }] },
      },
    ]);
    const sonarr = new SonarrClient({ ...SONARR, fetchImpl });
    expect(await sonarr.listImportListExclusions()).toEqual([
      { id: 7, tmdbId: null, tvdbId: 81189, title: 'Breaking Bad', year: null },
    ]);
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({
      page: '1',
      pageSize: '1000',
      sortKey: 'id',
      sortDirection: 'ascending',
    });
  });

  it('adds one exclusion: Radarr {tmdbId, movieTitle, movieYear} (an unknown year as 0), Sonarr {tvdbId, title}', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        method: 'POST',
        path: '/api/v3/exclusions',
        status: 201,
        body: { id: 89, tmdbId: 420634, movieTitle: 'Terrifier', movieYear: 2018 },
      },
      {
        method: 'POST',
        path: '/api/v3/importlistexclusion',
        status: 201,
        body: { id: 3, tvdbId: 81189, title: 'Breaking Bad' },
      },
    ]);
    const radarr = new RadarrWriteClient({ ...RADARR, fetchImpl });
    const sonarr = new SonarrWriteClient({ ...SONARR, fetchImpl });
    expect(await radarr.addImportListExclusion({ tmdbId: 420634, title: 'Terrifier', year: 2018 })).toEqual({
      id: 89,
      tmdbId: 420634,
      tvdbId: null,
      title: 'Terrifier',
      year: 2018,
    });
    await radarr.addImportListExclusion({ tmdbId: 420634, title: 'Terrifier', year: null });
    expect(await sonarr.addImportListExclusion({ tvdbId: 81189, title: 'Breaking Bad' })).toMatchObject({
      id: 3,
      tvdbId: 81189,
    });
    expect(calls.map((c) => [c.method, c.url.pathname, c.body])).toEqual([
      ['POST', '/api/v3/exclusions', { tmdbId: 420634, movieTitle: 'Terrifier', movieYear: 2018 }],
      ['POST', '/api/v3/exclusions', { tmdbId: 420634, movieTitle: 'Terrifier', movieYear: 0 }],
      ['POST', '/api/v3/importlistexclusion', { tvdbId: 81189, title: 'Breaking Bad' }],
    ]);
  });

  it('a refused POST (already excluded: 400) throws, never a phantom success', async () => {
    const { fetchImpl } = stubFetch([
      { method: 'POST', path: '/api/v3/exclusions', status: 400, body: [{ errorMessage: 'This exclusion has already been added.' }] },
    ]);
    const radarr = new RadarrWriteClient({ ...RADARR, fetchImpl });
    await expect(radarr.addImportListExclusion({ tmdbId: 1, title: 'X', year: 2020 })).rejects.toThrow();
  });
});
