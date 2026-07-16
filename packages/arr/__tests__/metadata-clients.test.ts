// ADR-018 / DESIGN-008 — the metadata-harvest read surfaces: the *arr /lookup endpoints
// (tombstoned-row metadata, no re-add) + the Tautulli watch-stats client. Offline via the
// injected fetch stub (mirrors read-clients.test.ts).
import { describe, expect, it } from 'vitest';
import { RadarrClient, SonarrClient, LidarrClient, TautulliClient } from '../src/read';
import { stubFetch, TEST_OPTS } from './helpers';

const TAUT_OPTS = { apiKey: 'taut-key', retryDelayMs: 0 } as const;

describe('*arr /lookup (DESIGN-008 D-05 — tombstoned metadata, no add)', () => {
  it('Radarr lookupMovie hits /movie/lookup?term=tmdb: and parses ratings/images', async () => {
    const stub = stubFetch([
      {
        path: '/api/v3/movie/lookup',
        body: [
          {
            title: 'Gone',
            year: 2020,
            tmdbId: 1234,
            runtime: 100,
            genres: ['Drama'],
            ratings: { imdb: { value: 7.1, votes: 900 }, tmdb: { value: 7.4, votes: 40 } },
            images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/t/p/original/p.jpg' }],
            remotePoster: 'https://image.tmdb.org/t/p/original/p.jpg',
            extraUnknownField: 'stripped',
          },
        ],
      },
    ]);
    const client = new RadarrClient({ baseUrl: 'http://radarr.test:7878', fetchImpl: stub.fetchImpl, ...TEST_OPTS });
    const [m] = await client.lookupMovie('tmdb:1234');
    expect(stub.calls[0]!.url.pathname).toBe('/api/v3/movie/lookup');
    expect(stub.calls[0]!.url.searchParams.get('term')).toBe('tmdb:1234');
    expect(m!.ratings?.imdb?.value).toBe(7.1);
    expect(m!.remotePoster).toContain('image.tmdb.org');
    expect(m).not.toHaveProperty('extraUnknownField'); // BC-03 ACL
  });

  it('Sonarr lookupSeries uses tvdb: term; Lidarr lookupArtist uses lidarr: term', async () => {
    const s = stubFetch([{ path: '/api/v3/series/lookup', body: [{ title: 'X', tvdbId: 9, genres: [] }] }]);
    const sonarr = new SonarrClient({ baseUrl: 'http://s.test:8989', fetchImpl: s.fetchImpl, ...TEST_OPTS });
    await sonarr.lookupSeries('tvdb:9');
    expect(s.calls[0]!.url.searchParams.get('term')).toBe('tvdb:9');

    const l = stubFetch([{ path: '/api/v1/artist/lookup', body: [{ artistName: 'A', genres: [] }] }]);
    const lidarr = new LidarrClient({ baseUrl: 'http://l.test:8686', fetchImpl: l.fetchImpl, ...TEST_OPTS });
    await lidarr.lookupArtist('lidarr:mbid');
    expect(l.calls[0]!.url.pathname).toBe('/api/v1/artist/lookup');
    expect(l.calls[0]!.url.searchParams.get('term')).toBe('lidarr:mbid');
  });
});

describe('TautulliClient (DESIGN-008 D-04)', () => {
  it('get_history: apikey + cmd in the query; unwraps response.data.data', async () => {
    const stub = stubFetch([
      {
        path: '/api/v2',
        body: { response: { result: 'success', data: { data: [{ rating_key: 1, media_type: 'movie' }] } } },
      },
    ]);
    const client = new TautulliClient({ baseUrl: 'http://taut.test:8181', fetchImpl: stub.fetchImpl, ...TAUT_OPTS });
    const rows = await client.getHistory({ length: 5 });
    expect(stub.calls[0]!.url.pathname).toBe('/api/v2');
    expect(stub.calls[0]!.url.searchParams.get('apikey')).toBe('taut-key');
    expect(stub.calls[0]!.url.searchParams.get('cmd')).toBe('get_history');
    expect(rows[0]!.media_type).toBe('movie');
  });

  it('get_libraries_table (ADR-068 scoreboard): apikey + cmd in the query; unwraps the row subset', async () => {
    const stub = stubFetch([
      {
        path: '/api/v2',
        body: {
          response: {
            result: 'success',
            data: {
              recordsTotal: 2,
              data: [
                {
                  section_id: 1,
                  section_name: 'Movies',
                  section_type: 'movie',
                  plays: 3449,
                  duration: 100,
                  extra: 'stripped',
                },
                { section_name: 'TV Shows', section_type: 'show', plays: '25238', duration: '200' },
              ],
            },
          },
        },
      },
    ]);
    const client = new TautulliClient({ baseUrl: 'http://taut.test:8181', fetchImpl: stub.fetchImpl, ...TAUT_OPTS });
    const rows = await client.getLibrariesTable();
    expect(stub.calls[0]!.url.searchParams.get('cmd')).toBe('get_libraries_table');
    expect(stub.calls[0]!.url.searchParams.get('apikey')).toBe('taut-key');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.section_type).toBe('movie');
    expect(rows[0]!.plays).toBe(3449);
    expect(rows[1]!.plays).toBe('25238'); // string numerics tolerated (the aggregator coerces)
    expect(rows[0]).not.toHaveProperty('extra'); // BC-03 ACL
  });

  it('get_metadata: returns the external-id guids (the join key)', async () => {
    const stub = stubFetch([
      {
        path: '/api/v2',
        body: {
          response: {
            result: 'success',
            data: { guids: ['imdb://tt1', 'tmdb://2', 'tvdb://3'], last_viewed_at: 1700000000 },
          },
        },
      },
    ]);
    const client = new TautulliClient({ baseUrl: 'http://taut.test:8181', fetchImpl: stub.fetchImpl, ...TAUT_OPTS });
    const meta = await client.getMetadata(42);
    expect(stub.calls[0]!.url.searchParams.get('cmd')).toBe('get_metadata');
    expect(stub.calls[0]!.url.searchParams.get('rating_key')).toBe('42');
    expect(meta.guids).toEqual(['imdb://tt1', 'tmdb://2', 'tvdb://3']);
  });
});
