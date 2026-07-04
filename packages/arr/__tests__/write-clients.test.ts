// Write-surface tests — hand-rolled fetch stubs asserting method/path/payload shapes
// (DESIGN-005 D-03 write table). NO live write endpoint is ever called: the write
// clients are exercised here exclusively against stubs (ADR-008).
import { describe, expect, it } from 'vitest';
import { LidarrWriteClient, RadarrWriteClient, SonarrWriteClient } from '../src/write';
import { fixture, stubFetch, TEST_OPTS } from './helpers';

const COMMAND_OK = { id: 1234, name: 'stub' };

describe('SonarrWriteClient', () => {
  function client(routes: Parameters<typeof stubFetch>[0]) {
    const stub = stubFetch(routes);
    return {
      client: new SonarrWriteClient({
        baseUrl: 'http://sonarr.test:8989',
        fetchImpl: stub.fetchImpl,
        ...TEST_OPTS,
      }),
      ...stub,
    };
  }

  it('markHistoryFailed POSTs /history/failed/{historyId} with no body (AC-07)', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v3/history/failed/666' },
    ]);
    await c.markHistoryFailed(666);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', body: undefined });
    expect(calls[0]?.url.pathname).toBe('/api/v3/history/failed/666');
    expect(calls[0]?.headers.get('x-api-key')).toBe('test-api-key');
  });

  it('deleteEpisodeFile DELETEs /episodefile/{id} (AC-08 fallback)', async () => {
    const { client: c, calls } = client([{ method: 'DELETE', path: '/api/v3/episodefile/42' }]);
    await c.deleteEpisodeFile(42);
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url.pathname).toBe('/api/v3/episodefile/42');
  });

  it('searchEpisodes uses the EpisodeSearch command with episodeIds', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v3/command', body: { id: 77, name: 'EpisodeSearch' } },
    ]);
    const command = await c.searchEpisodes([61993, 61994]);
    expect(command).toEqual({ id: 77, name: 'EpisodeSearch' });
    expect(calls[0]?.body).toEqual({ name: 'EpisodeSearch', episodeIds: [61993, 61994] });
  });

  it('searchSeries uses the SeriesSearch command with seriesId', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v3/command', body: COMMAND_OK },
    ]);
    await c.searchSeries(645);
    expect(calls[0]?.body).toEqual({ name: 'SeriesSearch', seriesId: 645 });
  });

  it('searchSeason uses the SeasonSearch command with seriesId + seasonNumber', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v3/command', body: COMMAND_OK },
    ]);
    await c.searchSeason(645, 2);
    expect(calls[0]?.body).toEqual({ name: 'SeasonSearch', seriesId: 645, seasonNumber: 2 });
  });

  it('addSeries POSTs /series with the D-16 payload and parses the created resource', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v3/series', body: fixture('sonarr.series-byid') },
    ]);
    const created = await c.addSeries({
      tvdbId: 440218,
      title: 'Gray',
      qualityProfileId: 9,
      rootFolderPath: '/data/haynestower/Media/TV Shows',
      monitored: true,
      seasonFolder: true,
      seriesType: 'standard',
      tags: [1],
      addOptions: { monitor: 'all', searchForMissingEpisodes: false }, // searches OFF (D-16/Q-04)
    });
    expect(created.id).toBe(1);
    expect(calls[0]?.body).toMatchObject({
      tvdbId: 440218,
      rootFolderPath: '/data/haynestower/Media/TV Shows',
      addOptions: { monitor: 'all', searchForMissingEpisodes: false },
    });
  });

  it('createTag POSTs /tag {label}', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v3/tag', body: { id: 2, label: 'restored' } },
    ]);
    const tag = await c.createTag('restored');
    expect(tag).toEqual({ id: 2, label: 'restored' });
    expect(calls[0]?.body).toEqual({ label: 'restored' });
  });
});

describe('RadarrWriteClient', () => {
  function client(routes: Parameters<typeof stubFetch>[0]) {
    const stub = stubFetch(routes);
    return {
      client: new RadarrWriteClient({
        baseUrl: 'http://radarr.test:7878',
        fetchImpl: stub.fetchImpl,
        ...TEST_OPTS,
      }),
      ...stub,
    };
  }

  it('markHistoryFailed / deleteMovieFile hit the v3 paths', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v3/history/failed/530' },
      { method: 'DELETE', path: '/api/v3/moviefile/7' },
    ]);
    await c.markHistoryFailed(530);
    await c.deleteMovieFile(7);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'POST /api/v3/history/failed/530',
      'DELETE /api/v3/moviefile/7',
    ]);
  });

  it('searchMovies uses the MoviesSearch command with movieIds', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v3/command', body: COMMAND_OK },
    ]);
    await c.searchMovies([2327]);
    expect(calls[0]?.body).toEqual({ name: 'MoviesSearch', movieIds: [2327] });
  });

  it('addMovie POSTs /movie with the D-16 payload (searchForMovie off)', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v3/movie', body: fixture('radarr.movie-byid') },
    ]);
    const created = await c.addMovie({
      tmdbId: 1233620,
      title: 'Winner Takes the Cake',
      qualityProfileId: 9,
      rootFolderPath: '/data/haynestower/Media/Movies',
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { monitor: 'movieOnly', searchForMovie: false },
    });
    expect(created.tmdbId).toBe(1233620);
    expect(calls[0]?.body).toMatchObject({
      tmdbId: 1233620,
      minimumAvailability: 'released',
      addOptions: { searchForMovie: false },
    });
  });
});

describe('LidarrWriteClient', () => {
  function client(routes: Parameters<typeof stubFetch>[0]) {
    const stub = stubFetch(routes);
    return {
      client: new LidarrWriteClient({
        baseUrl: 'http://lidarr.test:8686',
        fetchImpl: stub.fetchImpl,
        ...TEST_OPTS,
      }),
      ...stub,
    };
  }

  it('markHistoryFailed / deleteTrackFile hit the v1 paths', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v1/history/failed/2943' },
      { method: 'DELETE', path: '/api/v1/trackfile/3' },
    ]);
    await c.markHistoryFailed(2943);
    await c.deleteTrackFile(3);
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'POST /api/v1/history/failed/2943',
      'DELETE /api/v1/trackfile/3',
    ]);
  });

  it('searchAlbums uses the AlbumSearch command with albumIds', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v1/command', body: COMMAND_OK },
    ]);
    await c.searchAlbums([2713]);
    expect(calls[0]?.body).toEqual({ name: 'AlbumSearch', albumIds: [2713] });
  });

  it('searchArtist uses the ArtistSearch command with artistId', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v1/command', body: COMMAND_OK },
    ]);
    await c.searchArtist(88);
    expect(calls[0]?.body).toEqual({ name: 'ArtistSearch', artistId: 88 });
  });

  it('addArtist POSTs /artist with the D-16 payload (searchForMissingAlbums off)', async () => {
    const { client: c, calls } = client([
      { method: 'POST', path: '/api/v1/artist', body: fixture('lidarr.artist-byid') },
      { method: 'POST', path: '/api/v1/tag', body: { id: 4, label: 'restored' } },
    ]);
    const created = await c.addArtist({
      foreignArtistId: 'd993169f-2033-4810-bae8-564d4aab89cd',
      artistName: '$NOT',
      qualityProfileId: 1,
      metadataProfileId: 1,
      rootFolderPath: '/data/media/music',
      monitored: true,
      addOptions: { monitor: 'all', searchForMissingAlbums: false },
    });
    expect(created.foreignArtistId).toBe('d993169f-2033-4810-bae8-564d4aab89cd');
    expect(calls[0]?.body).toMatchObject({
      foreignArtistId: 'd993169f-2033-4810-bae8-564d4aab89cd',
      metadataProfileId: 1,
      addOptions: { searchForMissingAlbums: false },
    });
    expect(await c.createTag('restored')).toEqual({ id: 4, label: 'restored' });
  });
});
