// Read-surface tests: every D-03 read endpoint parses its recorded fixture through the
// D-02 zod subset, offline, via the injected fetch stub (DESIGN-005 test strategy).
import { describe, expect, it } from 'vitest';
import { LidarrClient, RadarrClient, SeerrClient, SonarrClient } from '../src/read';
import { fixture, stubFetch, TEST_OPTS } from './helpers';

function sonarr(routes: Parameters<typeof stubFetch>[0]) {
  const stub = stubFetch(routes);
  return {
    client: new SonarrClient({
      baseUrl: 'http://sonarr.test:8989',
      fetchImpl: stub.fetchImpl,
      ...TEST_OPTS,
    }),
    ...stub,
  };
}

describe('SonarrClient (v3)', () => {
  it('sends the API key as X-Api-Key and hits /api/v3', async () => {
    const { client, calls } = sonarr([
      { path: '/api/v3/system/status', body: fixture('sonarr.system-status') },
    ]);
    const status = await client.getSystemStatus();
    expect(status.version).toBe('4.0.18.2978');
    expect(status.appName).toBe('Sonarr');
    expect(calls[0]?.headers.get('x-api-key')).toBe('test-api-key');
    expect(calls[0]?.url.pathname).toBe('/api/v3/system/status');
  });

  it('parses the series list to exactly the D-02 subset (unknown fields stripped)', async () => {
    const { client } = sonarr([{ path: '/api/v3/series', body: fixture('sonarr.series-list') }]);
    const series = await client.listSeries();
    expect(series.length).toBeGreaterThan(0);
    const first = series[0]!;
    expect(first.tvdbId).toBeTypeOf('number');
    expect(first.statistics.totalEpisodeCount).toBeTypeOf('number');
    expect(first.seasonFolder).toBeTypeOf('boolean');
    // BC-03 ACL: fields outside the D-02 contract never enter the app.
    expect(first).not.toHaveProperty('seasons');
    expect(first).not.toHaveProperty('overview');
    expect(first).not.toHaveProperty('images');
  });

  it('fetches a single series by id', async () => {
    const { client, calls } = sonarr([
      { path: '/api/v3/series/1', body: fixture('sonarr.series-byid') },
    ]);
    const series = await client.getSeriesById(1);
    expect(series.id).toBe(1);
    expect(series.rootFolderPath).toBe('/data/haynestower/Media/TV Shows');
    expect(calls[0]?.url.pathname).toBe('/api/v3/series/1');
  });

  it('parses quality profiles, root folders, and tags', async () => {
    const { client } = sonarr([
      { path: '/api/v3/qualityprofile', body: fixture('sonarr.qualityprofile') },
      { path: '/api/v3/rootfolder', body: fixture('sonarr.rootfolder') },
      { path: '/api/v3/tag', body: fixture('sonarr.tag') },
    ]);
    const [profiles, folders, tags] = await Promise.all([
      client.listQualityProfiles(),
      client.listRootFolders(),
      client.listTags(),
    ]);
    expect(profiles[0]).toMatchObject({ id: 1, name: 'Any' });
    expect(folders[0]?.path).toBe('/data/haynestower/Media/TV Shows');
    expect(tags[0]).toEqual({ id: 1, label: 'mediarequests' });
  });

  it('pages history with the D-03 sort params and per-kind target ids', async () => {
    const { client, calls } = sonarr([
      { path: '/api/v3/history', body: fixture('sonarr.history-page') },
    ]);
    const page = await client.getHistory({ page: 1, pageSize: 5 });
    expect(page.totalRecords).toBeTypeOf('number');
    expect(page.records[0]?.episodeId).toBeTypeOf('number');
    expect(page.records[0]?.seriesId).toBeTypeOf('number');
    expect(page.records[0]?.eventType).toBe('grabbed');
    expect(page.records[0]?.quality?.quality.name).toBeTypeOf('string');
    const params = calls[0]!.url.searchParams;
    expect(params.get('page')).toBe('1');
    expect(params.get('pageSize')).toBe('5');
    expect(params.get('sortKey')).toBe('date');
    expect(params.get('sortDirection')).toBe('descending');
  });

  it('fetches incremental history via /history/since?date=', async () => {
    const { client, calls } = sonarr([
      { path: '/api/v3/history/since', body: fixture('sonarr.history-since') },
    ]);
    const since = new Date('2026-07-02T00:00:00.000Z');
    const records = await client.getHistorySince(since);
    expect(records.length).toBeGreaterThan(0);
    expect(calls[0]?.url.searchParams.get('date')).toBe(since.toISOString());
  });

  it('parses wanted/missing pages as episodes', async () => {
    const { client } = sonarr([
      { path: '/api/v3/wanted/missing', body: fixture('sonarr.wanted-missing') },
    ]);
    const page = await client.getWantedMissing({ page: 1, pageSize: 5 });
    expect(page.records[0]?.seasonNumber).toBeTypeOf('number');
    expect(page.records[0]?.episodeNumber).toBeTypeOf('number');
    expect(page.records[0]?.hasFile).toBe(false);
  });
});

describe('RadarrClient (v3)', () => {
  function radarr(routes: Parameters<typeof stubFetch>[0]) {
    const stub = stubFetch(routes);
    return {
      client: new RadarrClient({
        baseUrl: 'http://radarr.test:7878',
        fetchImpl: stub.fetchImpl,
        ...TEST_OPTS,
      }),
      ...stub,
    };
  }

  it('parses system status, movie list + byId with unknown fields stripped', async () => {
    const { client } = radarr([
      { path: '/api/v3/system/status', body: fixture('radarr.system-status') },
      { path: '/api/v3/movie', body: fixture('radarr.movie-list') },
      { path: '/api/v3/movie/1', body: fixture('radarr.movie-byid') },
    ]);
    expect((await client.getSystemStatus()).appName).toBe('Radarr');
    const movies = await client.listMovies();
    expect(movies[0]?.tmdbId).toBeTypeOf('number');
    expect(movies[0]?.statistics.movieFileCount).toBeTypeOf('number');
    expect(movies[0]).not.toHaveProperty('overview');
    expect(movies[0]).not.toHaveProperty('images');
    const movie = await client.getMovieById(1);
    expect(movie.minimumAvailability).toBe('released');
    expect(movie.isAvailable).toBe(true);
  });

  it('parses profiles/rootfolders/tags and paged history (movieId target)', async () => {
    const { client } = radarr([
      { path: '/api/v3/qualityprofile', body: fixture('radarr.qualityprofile') },
      { path: '/api/v3/rootfolder', body: fixture('radarr.rootfolder') },
      { path: '/api/v3/tag', body: fixture('radarr.tag') },
      { path: '/api/v3/history', body: fixture('radarr.history-page') },
      { path: '/api/v3/history/since', body: fixture('radarr.history-since') },
    ]);
    expect((await client.listQualityProfiles()).length).toBeGreaterThan(0);
    expect((await client.listRootFolders())[0]?.path).toContain('/data/');
    expect(await client.listTags()).toEqual([{ id: 1, label: 'mediarequests' }]);
    const page = await client.getHistory({ pageSize: 5 });
    expect(page.records[0]?.movieId).toBeTypeOf('number');
    expect((await client.getHistorySince('2026-07-02T00:00:00Z')).length).toBeGreaterThan(0);
  });

  it('parses wanted/missing pages as movies (rootFolderPath optional there)', async () => {
    const { client } = radarr([
      { path: '/api/v3/wanted/missing', body: fixture('radarr.wanted-missing') },
    ]);
    const page = await client.getWantedMissing();
    expect(page.records[0]?.hasFile).toBe(false);
    expect(page.records[0]?.tmdbId).toBeTypeOf('number');
  });
});

describe('LidarrClient (v1)', () => {
  function lidarr(routes: Parameters<typeof stubFetch>[0]) {
    const stub = stubFetch(routes);
    return {
      client: new LidarrClient({
        baseUrl: 'http://lidarr.test:8686',
        fetchImpl: stub.fetchImpl,
        ...TEST_OPTS,
      }),
      ...stub,
    };
  }

  it('uses /api/v1 and parses artists (foreignArtistId, not mbId)', async () => {
    const { client, calls } = lidarr([
      { path: '/api/v1/system/status', body: fixture('lidarr.system-status') },
      { path: '/api/v1/artist', body: fixture('lidarr.artist-list') },
      { path: /^\/api\/v1\/artist\/\d+$/, body: fixture('lidarr.artist-byid') },
    ]);
    expect((await client.getSystemStatus()).appName).toBe('Lidarr');
    expect(calls[0]?.url.pathname).toBe('/api/v1/system/status');
    const artists = await client.listArtists();
    expect(artists[0]?.foreignArtistId).toMatch(/^[0-9a-f-]{36}$/);
    expect(artists[0]?.metadataProfileId).toBeTypeOf('number');
    expect(artists[0]?.statistics.trackFileCount).toBeTypeOf('number');
    expect(artists[0]).not.toHaveProperty('images');
    const artist = await client.getArtistById(2);
    expect(artist.artistName).toBe('$NOT');
  });

  it('parses history (albumId+artistId, null downloadId tolerated) and wanted albums', async () => {
    const { client } = lidarr([
      { path: '/api/v1/history', body: fixture('lidarr.history-page') },
      { path: '/api/v1/history/since', body: fixture('lidarr.history-since') },
      { path: '/api/v1/wanted/missing', body: fixture('lidarr.wanted-missing') },
      { path: '/api/v1/qualityprofile', body: fixture('lidarr.qualityprofile') },
      { path: '/api/v1/rootfolder', body: fixture('lidarr.rootfolder') },
      { path: '/api/v1/tag', body: fixture('lidarr.tag') },
    ]);
    const page = await client.getHistory({ pageSize: 5 });
    expect(page.records[0]?.albumId).toBeTypeOf('number');
    expect(page.records[0]?.artistId).toBeTypeOf('number');
    expect(page.records[0]?.eventType).toBe('trackFileImported');
    expect((await client.getHistorySince('2026-07-02T00:00:00Z')).length).toBeGreaterThan(0);
    const wanted = await client.getWantedMissing({ pageSize: 5 });
    expect(wanted.records[0]?.foreignAlbumId).toBeTypeOf('string');
    expect(wanted.records[0]?.albumType).toBeTypeOf('string');
    expect((await client.listTags()).map((t) => t.label)).toContain('spotifyalbums');
    expect((await client.listQualityProfiles())[0]?.name).toBe('Any');
    expect((await client.listRootFolders())[0]?.path).toBe('/data/media/music');
  });
});

describe('SeerrClient (Jellyseerr 3.3 v1)', () => {
  function seerr(routes: Parameters<typeof stubFetch>[0]) {
    const stub = stubFetch(routes);
    return {
      client: new SeerrClient({
        baseUrl: 'http://seerr.test:5055',
        fetchImpl: stub.fetchImpl,
        ...TEST_OPTS,
      }),
      ...stub,
    };
  }

  it('parses status and settings/main (apiKey never passes the schema)', async () => {
    const { client } = seerr([
      { path: '/api/v1/status', body: fixture('seerr.status') },
      { path: '/api/v1/settings/main', body: fixture('seerr.settings-main') },
    ]);
    expect((await client.getStatus()).version).toBe('3.3.0');
    const settings = await client.getMainSettings();
    expect(settings.applicationTitle).toBe('Jellyseerr');
    expect(settings).not.toHaveProperty('apiKey');
  });

  it('pages requests with take/skip/sort and parses the attribution subset', async () => {
    const { client, calls } = seerr([
      { path: '/api/v1/request', body: fixture('seerr.requests') },
    ]);
    const page = await client.getRequests({ take: 5, skip: 0 });
    expect(page.pageInfo.pageSize).toBe(5);
    const request = page.results[0]!;
    expect(request.type).toMatch(/^(movie|tv)$/);
    expect(request.media.tmdbId).toBeTypeOf('number');
    expect(request.requestedBy.email).toContain('@example.test'); // fixtures are sanitized
    expect(request.requestedBy).not.toHaveProperty('permissions');
    const params = calls[0]!.url.searchParams;
    expect(params.get('take')).toBe('5');
    expect(params.get('skip')).toBe('0');
    expect(params.get('sort')).toBe('added');
  });
});
