// ADR-107 / DESIGN-054: read-only canonical identity lookup paths and harvested facts.
import { describe, expect, it } from 'vitest';
import { TmdbClient } from '../src/tmdb';

describe('TMDB canonical identity reads', () => {
  it('requests authoritative movie/show external IDs and parses IMDb/TVDB bridges', async () => {
    const requests: Array<{ url: URL; method: string }> = [];
    const client = new TmdbClient({
      apiKey: 'test-key',
      getRetries: 0,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        requests.push({ url, method: init?.method ?? 'GET' });
        const body = url.pathname.endsWith('/movie/1')
          ? {
              id: 1,
              title: 'A Film',
              release_date: '2020-01-01',
              external_ids: { imdb_id: 'tt123' },
            }
          : url.pathname.endsWith('/tv/2')
            ? {
                id: 2,
                name: 'A Show',
                first_air_date: '2021-01-01',
                external_ids: { imdb_id: 'tt456', tvdb_id: 22 },
              }
            : {
                movie_results: [{ id: 1, title: 'A Film', release_date: '2020-01-01' }],
                tv_results: [],
              };
        return Response.json(body);
      },
    });
    expect(await client.getMovieIdentity(1)).toMatchObject({
      id: 1,
      external_ids: { imdb_id: 'tt123' },
    });
    expect(await client.getTvIdentity(2)).toMatchObject({ id: 2, external_ids: { tvdb_id: 22 } });
    expect(await client.findByExternalId('tt123', 'imdb_id')).toMatchObject({
      movie_results: [{ id: 1 }],
    });
    expect(requests.map((r) => r.method)).toEqual(['GET', 'GET', 'GET']);
    expect(
      requests
        .slice(0, 2)
        .every((r) => r.url.searchParams.get('append_to_response') === 'external_ids'),
    ).toBe(true);
    expect(requests[2]?.url.searchParams.get('external_source')).toBe('imdb_id');
  });
});
