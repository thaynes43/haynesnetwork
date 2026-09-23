// ADR-088 / ADR-089 / DESIGN-049 (PLAN-068 S3) — the Tautulli and TMDB reads the Watch Companion adds,
// offline against recorded fixtures (sanitized recordings of the 2026-09-23 live reads; no network).
import { describe, expect, it } from 'vitest';
import { ArrHttpError, ArrParseError } from '../src/errors';
import { TautulliClient } from '../src/tautulli';
import { TmdbClient } from '../src/tmdb';
import { fixture, stubFetch, stubFetchSequence } from './helpers';

const TAUT = { baseUrl: 'http://tautulli.test:8181', apiKey: 'taut-key', retryDelayMs: 0 } as const;

describe('TautulliClient.getHistory — the Watch Event window (DESIGN-049 D-09)', () => {
  it('sends user_id / after / grouping / order_column / order_dir / length / start / media_type', async () => {
    const stub = stubFetch([{ path: '/api/v2', body: fixture('tautulli.history-owner') }]);
    await new TautulliClient({ ...TAUT, fetchImpl: stub.fetchImpl }).getHistory({
      userId: 12874060,
      after: '2026-09-20',
      grouping: 0,
      orderColumn: 'date',
      orderDir: 'desc',
      length: 500,
      start: 1000,
      mediaType: 'episode',
    });
    const q = stub.calls[0]!.url.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      apikey: 'taut-key',
      cmd: 'get_history',
      user_id: '12874060',
      after: '2026-09-20',
      grouping: '0',
      order_column: 'date',
      order_dir: 'desc',
      length: '500',
      start: '1000',
      media_type: 'episode',
    });
  });

  it('omits every unset filter (the household harvest call is unchanged)', async () => {
    const stub = stubFetch([{ path: '/api/v2', body: fixture('tautulli.history-owner') }]);
    await new TautulliClient({ ...TAUT, fetchImpl: stub.fetchImpl }).getHistory({ length: 5 });
    expect([...stub.calls[0]!.url.searchParams.keys()].sort()).toEqual(['apikey', 'cmd', 'length', 'start']);
  });

  it('a malformed `after` throws before any request', async () => {
    const stub = stubFetch([]);
    const client = new TautulliClient({ ...TAUT, fetchImpl: stub.fetchImpl });
    await expect(client.getHistory({ after: '2026-9-1' })).rejects.toBeInstanceOf(TypeError);
    await expect(client.getHistory({ after: '1790133400' })).rejects.toBeInstanceOf(TypeError);
    expect(stub.calls).toHaveLength(0);
  });

  it('parses the watch fields: row_id (not reference_id), guid, indices ("" → null), percent, year, started', async () => {
    const stub = stubFetch([{ path: '/api/v2', body: fixture('tautulli.history-owner') }]);
    const [episode, movie, grouped] = await new TautulliClient({ ...TAUT, fetchImpl: stub.fetchImpl }).getHistory(
      { userId: 12874060, grouping: 0 },
    );
    expect(episode).toMatchObject({
      row_id: 138,
      media_type: 'episode',
      guid: 'plex://episode/5d9c0000000000000000e010',
      media_index: 10,
      parent_media_index: 5,
      parent_rating_key: 45714,
      grandparent_rating_key: 45668,
      percent_complete: 100,
      watched_status: 1,
      year: 2026,
      full_title: 'Stub Show - Stub Episode Ten',
      started: 1790133400,
      user_id: 12874060,
    });
    // Movies serialize the episode indices as "" — normalized to null, never compared to ''.
    expect(movie).toMatchObject({ row_id: 42447, media_index: null, parent_media_index: null, percent_complete: 13 });
    // The grouped row: its GROUP began at 41839, but the row itself is 42195 — row_id is the identity.
    expect(grouped!.row_id).toBe(42195);
    expect(grouped).not.toHaveProperty('reference_id'); // BC-03 ACL: the non-identity id is not consumed
    expect(grouped!.guid).toMatch(/^com\.plexapp\.agents\.none:\/\//);
    // Unconsumed fields (IP, player, …) never cross the boundary.
    expect(episode).not.toHaveProperty('ip_address');
    expect(episode).not.toHaveProperty('player');
  });

  it('string numerics are tolerated (Tautulli is loose with numbers)', async () => {
    const stub = stubFetch([
      {
        path: '/api/v2',
        body: {
          response: {
            result: 'success',
            data: { data: [{ row_id: '77', media_index: '3', parent_media_index: '1', percent_complete: '85', year: 'n/a' }] },
          },
        },
      },
    ]);
    const [row] = await new TautulliClient({ ...TAUT, fetchImpl: stub.fetchImpl }).getHistory();
    expect(row).toMatchObject({ row_id: 77, media_index: 3, parent_media_index: 1, percent_complete: 85, year: null });
  });
});

describe('TautulliClient.getMetadata — gone is null (DESIGN-049 D-09)', () => {
  it('HTTP 400 (current Tautulli, verified live) → null', async () => {
    const stub = stubFetch([{ path: '/api/v2', status: 400, body: fixture('tautulli.metadata-gone') }]);
    expect(await new TautulliClient({ ...TAUT, fetchImpl: stub.fetchImpl }).getMetadata(999999999)).toBeNull();
    expect(stub.calls).toHaveLength(1); // a 400 is not retried
  });

  it('an empty `{}` data object (older Tautulli) → null', async () => {
    const stub = stubFetch([{ path: '/api/v2', body: { response: { result: 'success', message: null, data: {} } } }]);
    expect(await new TautulliClient({ ...TAUT, fetchImpl: stub.fetchImpl }).getMetadata(1)).toBeNull();
  });

  it('a live item parses (guid + guids + grandparent key)', async () => {
    const stub = stubFetch([
      {
        path: '/api/v2',
        body: {
          response: {
            result: 'success',
            data: {
              guid: 'plex://show/5d9c086c46115600200aa2fe',
              guids: ['imdb://tt2861424', 'tmdb://60625', 'tvdb://275274'],
              media_type: 'show',
              last_viewed_at: '1790133400',
              title: 'stripped by the ACL',
            },
          },
        },
      },
    ]);
    const meta = await new TautulliClient({ ...TAUT, fetchImpl: stub.fetchImpl }).getMetadata('45668');
    expect(meta).toEqual({
      guid: 'plex://show/5d9c086c46115600200aa2fe',
      guids: ['imdb://tt2861424', 'tmdb://60625', 'tvdb://275274'],
      media_type: 'show',
      last_viewed_at: '1790133400',
    });
  });

  it('any other failure still throws the typed error (5xx after retries; schema drift)', async () => {
    const down = stubFetchSequence([{ status: 503, body: { message: 'busy' } }]);
    await expect(
      new TautulliClient({ ...TAUT, fetchImpl: down.fetchImpl }).getMetadata(5),
    ).rejects.toBeInstanceOf(ArrHttpError);
    expect(down.calls).toHaveLength(3);

    const drift = stubFetch([
      { path: '/api/v2', body: { response: { result: 'success', data: { guids: 'not-an-array' } } } },
    ]);
    const error = await new TautulliClient({ ...TAUT, fetchImpl: drift.fetchImpl })
      .getMetadata(6)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArrParseError);
    expect((error as ArrParseError).issues[0]).toContain('response.data.guids');
    expect((error as ArrParseError).message).not.toContain('taut-key');
  });
});

describe('TmdbClient — recommendations + search/multi (DESIGN-049 D-13 / D-17)', () => {
  const V3 = { apiKey: 'tmdb-v3-key', retryDelayMs: 0 } as const;

  it('getMovieRecommendations: /3/movie/{id}/recommendations?page=, parsed with nullish fields', async () => {
    const stub = stubFetch([{ path: '/3/movie/603/recommendations', body: fixture('tmdb.movie-recommendations') }]);
    const page = await new TmdbClient({ ...V3, fetchImpl: stub.fetchImpl }).getMovieRecommendations(603);
    const q = stub.calls[0]!.url.searchParams;
    expect(q.get('page')).toBe('1');
    expect(q.get('api_key')).toBe('tmdb-v3-key');
    expect(page.total_results).toBe(541);
    expect(page.results).toHaveLength(3);
    expect(page.results[0]).toMatchObject({
      id: 604,
      media_type: 'movie',
      title: 'The Matrix Reloaded',
      release_date: '2003-05-15',
      genre_ids: [12, 28, 53, 878],
      vote_average: 7.085,
    });
    expect(page.results[0]).not.toHaveProperty('overview'); // BC-03 ACL
    // An unreleased stub with an empty date and a null poster still parses.
    expect(page.results[2]).toMatchObject({ id: 1200001, release_date: '', poster_path: null });
  });

  it('getTvRecommendations: /3/tv/{id}/recommendations, the v4 bearer when configured, page clamped', async () => {
    const stub = stubFetch([{ path: '/3/tv/1399/recommendations', body: fixture('tmdb.tv-recommendations') }]);
    const page = await new TmdbClient({
      readAccessToken: 'v4-bearer',
      retryDelayMs: 0,
      fetchImpl: stub.fetchImpl,
    }).getTvRecommendations(1399, 0);
    const call = stub.calls[0]!;
    expect(call.headers.get('authorization')).toBe('Bearer v4-bearer');
    expect(call.url.searchParams.get('api_key')).toBeNull();
    expect(call.url.searchParams.get('page')).toBe('1'); // 0 → 1
    expect(page.results.map((r) => r.name)).toEqual(['House of the Dragon', 'The Witcher']);
    expect(page.results[0]).toMatchObject({ media_type: 'tv', first_air_date: '2022-08-21', origin_country: ['US'] });
  });

  it('searchMulti: /3/search/multi with query + include_adult=false; people come back tagged', async () => {
    const stub = stubFetch([{ path: '/3/search/multi', body: fixture('tmdb.search-multi') }]);
    const page = await new TmdbClient({ ...V3, fetchImpl: stub.fetchImpl }).searchMulti('  dune ', 2);
    const q = stub.calls[0]!.url.searchParams;
    expect(q.get('query')).toBe('dune');
    expect(q.get('page')).toBe('2');
    expect(q.get('include_adult')).toBe('false');
    expect(page.results.map((r) => r.media_type)).toEqual(['movie', 'tv', 'person']);
    expect(page.results[1]).toMatchObject({ id: 90228, name: 'Dune: Prophecy' });
  });

  it('searchMulti with a blank query answers an empty page without a request; absent results → []', async () => {
    const stub = stubFetch([{ path: '/3/search/multi', body: { page: 1, total_results: 0 } }]);
    const client = new TmdbClient({ ...V3, fetchImpl: stub.fetchImpl });
    expect(await client.searchMulti('   ')).toEqual({ page: 1, results: [], total_pages: 0, total_results: 0 });
    expect(stub.calls).toHaveLength(0);
    expect((await client.searchMulti('x')).results).toEqual([]);
  });

  it('an unknown id is a typed 404 (TMDB status_code 34)', async () => {
    const stub = stubFetch([
      {
        path: '/3/movie/99999999/recommendations',
        status: 404,
        body: { success: false, status_code: 34, status_message: 'The resource you requested could not be found.' },
      },
    ]);
    const error = await new TmdbClient({ ...V3, fetchImpl: stub.fetchImpl })
      .getMovieRecommendations(99999999)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArrHttpError);
    expect((error as ArrHttpError).status).toBe(404);
    expect((error as ArrHttpError).message).not.toContain('tmdb-v3-key');
  });
});
