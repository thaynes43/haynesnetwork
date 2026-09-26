// ADR-093 / DESIGN-052 D-01 / D-02 / D-03 (PLAN-072 S2) — the Watchlist Registry's owner-token plex.tv reads, fully
// offline (ADR-010): the roster (uuid from `thumb`, Home flags), the community GraphQL answer classes (data, empty,
// `User not found:`, a partial answer with data AND errors, other errors, non-JSON, the upper-case MOVIE/SHOW enum,
// an unknown type, a non-hex id, paging and the page cap), the discover-id map (404 ⇒ null), and the D-02 retry
// policy (429 and every 5xx retried, 3 attempts, backoff 2 s × attempt — injected here as zero).
import { describe, expect, it } from 'vitest';
import {
  COMMUNITY_WATCHLIST_QUERY,
  MAX_COMMUNITY_PAGES,
  PlexRegistryClient,
  isAccountUuid,
  registryBackoffMs,
  uuidFromThumb,
} from '../src/registry';
import { registryRetryStatus } from '../src/http';
import { PlexHttpError } from '../src/errors';
import { plexStub } from './helpers';

const UUID = 'abcdef0123456789';
const A = '5d776824151a60001f24a29e';
const B = '608ae6cf5077dd002d3bb8be';

const client = (stub: ReturnType<typeof plexStub>, extra: Record<string, unknown> = {}) =>
  new PlexRegistryClient({
    token: 'owner-secret-token',
    plexTvBaseUrl: 'https://plex.test',
    plexDiscoverBaseUrl: 'https://discover.test',
    plexCommunityBaseUrl: 'https://community.test',
    retryBackoffMs: () => 0,
    communityPauseMs: 0,
    fetchImpl: stub.fetchImpl,
    ...extra,
  });

const page = (nodes: unknown[], next: string | null = null) => ({
  data: {
    user: { watchlist: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } },
  },
});

describe('roster (D-01)', () => {
  it('reads the owner id and uuid from /api/v2/user', async () => {
    const stub = plexStub([
      { path: '/api/v2/user', body: { id: 12874060, uuid: 'F00DBEEF00112233', username: 'x' } },
    ]);
    await expect(client(stub).getOwner()).resolves.toEqual({
      id: '12874060',
      uuid: 'f00dbeef00112233',
    });
    const headers = stub.calls[0]!.headers;
    expect(headers['X-Plex-Token']).toBe('owner-secret-token');
    expect(Object.keys(headers).some((h) => h.toLowerCase() === 'x-plex-version')).toBe(false);
    expect(stub.calls[0]!.url.toString()).not.toContain('owner-secret-token');
  });

  it('parses /api/users: uuid from thumb, home/restricted flags, no name crosses the boundary', async () => {
    const xml = `<?xml version="1.0"?><MediaContainer size="3">
      <User id="101" title="Friend" username="friend1" email="f@example.test" thumb="https://plex.tv/users/${UUID}/avatar?c=1" home="0" restricted="0"><Server id="1"/></User>
      <User id="102" title="Kid" thumb="https://plex.tv/users/0123456789abcdef/avatar?c=2" home="1" restricted="1"/>
      <User id="103" title="NoThumb" home="1" restricted="0"/>
    </MediaContainer>`;
    const stub = plexStub([{ path: '/api/users', body: xml }]);
    const users = await client(stub).listUsers();
    expect(users).toEqual([
      { id: '101', uuid: UUID, home: false, restricted: false },
      { id: '102', uuid: '0123456789abcdef', home: true, restricted: true },
      { id: '103', uuid: null, home: true, restricted: false },
    ]);
    expect(JSON.stringify(users)).not.toContain('friend1');
    expect(JSON.stringify(users)).not.toContain('example.test');
  });

  it('parses /api/home/users (admin, restricted, uuid attribute first)', async () => {
    const xml = `<MediaContainer><User id="1" uuid="AAAABBBBCCCCDDDD" admin="1" restricted="0"/>
      <User id="7" admin="0" restricted="1" thumb="https://plex.tv/users/1111222233334444/avatar?c=9"/></MediaContainer>`;
    const stub = plexStub([{ path: '/api/home/users', body: xml }]);
    await expect(client(stub).listHomeUsers()).resolves.toEqual([
      { id: '1', uuid: 'aaaabbbbccccdddd', admin: true, restricted: false },
      { id: '7', uuid: '1111222233334444', admin: false, restricted: true },
    ]);
  });

  it('a <User> without a numeric id fails the whole roster read (never a partial roster)', async () => {
    const stub = plexStub([
      { path: '/api/users', body: '<MediaContainer><User title="x"/></MediaContainer>' },
    ]);
    await expect(client(stub).listUsers()).rejects.toThrow(/no numeric id/);
  });

  it('uuidFromThumb / isAccountUuid', () => {
    expect(uuidFromThumb(`https://plex.tv/users/${UUID}/avatar?c=123`)).toBe(UUID);
    expect(uuidFromThumb('https://plex.tv/users/not-hex/avatar')).toBeNull();
    expect(uuidFromThumb(undefined)).toBeNull();
    expect(isAccountUuid(UUID)).toBe(true);
    expect(isAccountUuid('abc')).toBe(false);
  });
});

describe('community GraphQL (D-02 answer classes)', () => {
  it('sends the D-02 query as a GET with first=100 and the uuid, and maps MOVIE/SHOW', async () => {
    const stub = plexStub([
      {
        path: '/api',
        body: page([
          { id: A, type: 'MOVIE', title: 'x' },
          { id: B, type: 'SHOW' },
        ]),
      },
    ]);
    await expect(client(stub).communityWatchlist(UUID)).resolves.toEqual({
      kind: 'answered',
      nodes: [
        { discoverId: A, kind: 'movie' },
        { discoverId: B, kind: 'show' },
      ],
    });
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.url.searchParams.get('query')).toBe(COMMUNITY_WATCHLIST_QUERY);
    expect(JSON.parse(call.url.searchParams.get('variables')!)).toEqual({
      uuid: UUID,
      first: 100,
      after: null,
    });
    expect(call.headers['X-Plex-Token']).toBe('owner-secret-token');
  });

  it('an empty list with no errors is answered (possibly hidden: the registry decides, D-04)', async () => {
    const stub = plexStub([{ path: '/api', body: page([]) }]);
    await expect(client(stub).communityWatchlist(UUID)).resolves.toEqual({
      kind: 'answered',
      nodes: [],
    });
  });

  it('pages with endCursor until hasNextPage is false', async () => {
    const stub = plexStub([
      {
        path: '/api',
        body: (url: URL) => {
          const after = JSON.parse(url.searchParams.get('variables')!).after as string | null;
          return after === null
            ? page([{ id: A, type: 'MOVIE' }], 'c1')
            : page([{ id: B, type: 'SHOW' }]);
        },
      },
    ]);
    const answer = await client(stub).communityWatchlist(UUID);
    expect(answer).toEqual({
      kind: 'answered',
      nodes: [
        { discoverId: A, kind: 'movie' },
        { discoverId: B, kind: 'show' },
      ],
    });
    expect(stub.calls).toHaveLength(2);
  });

  it('`User not found:` with no data is not_found (managed users, private lists)', async () => {
    const stub = plexStub([
      {
        path: '/api',
        body: {
          data: { user: null },
          errors: [{ message: 'User not found: Data loader item not found' }],
        },
      },
    ]);
    await expect(client(stub).communityWatchlist(UUID)).resolves.toEqual({ kind: 'not_found' });
  });

  it('a partial answer carrying data AND an errors entry is failed', async () => {
    const stub = plexStub([
      {
        path: '/api',
        body: { ...page([{ id: A, type: 'MOVIE' }]), errors: [{ message: 'User not found: x' }] },
      },
    ]);
    await expect(client(stub).communityWatchlist(UUID)).resolves.toEqual({
      kind: 'failed',
      errorClass: 'graphql_error',
    });
  });

  it('any other error entry is failed; a later page answering not found is failed', async () => {
    const other = plexStub([
      { path: '/api', body: { data: null, errors: [{ message: 'Rate limited' }] } },
    ]);
    await expect(client(other).communityWatchlist(UUID)).resolves.toMatchObject({ kind: 'failed' });
    const later = plexStub([
      {
        path: '/api',
        body: (url: URL) =>
          JSON.parse(url.searchParams.get('variables')!).after === null
            ? page([{ id: A, type: 'MOVIE' }], 'c1')
            : { data: { user: null }, errors: [{ message: 'User not found: gone' }] },
      },
    ]);
    await expect(client(later).communityWatchlist(UUID)).resolves.toEqual({
      kind: 'failed',
      errorClass: 'graphql_error_later_page',
    });
  });

  it('an unknown node type, a lower-case type or a non-hex id fails the account read (never a silent skip)', async () => {
    for (const [node, errorClass] of [
      [{ id: A, type: 'EPISODE' }, 'bad_type'],
      [{ id: A, type: 'movie' }, 'bad_type'],
      [{ id: 'not-hex', type: 'MOVIE' }, 'bad_id'],
    ] as const) {
      const stub = plexStub([{ path: '/api', body: page([node]) }]);
      await expect(client(stub).communityWatchlist(UUID)).resolves.toEqual({
        kind: 'failed',
        errorClass,
      });
    }
  });

  it('non-200, non-JSON and a missing watchlist are failed', async () => {
    const http = plexStub([{ path: '/api', status: 400, body: { message: 'bad' } }]);
    await expect(client(http).communityWatchlist(UUID)).resolves.toEqual({
      kind: 'failed',
      errorClass: 'http_400',
    });
    const text = plexStub([{ path: '/api', body: 'not json', contentType: 'text/plain' }]);
    await expect(client(text).communityWatchlist(UUID)).resolves.toEqual({
      kind: 'failed',
      errorClass: 'parse',
    });
    const empty = plexStub([{ path: '/api', body: { data: { user: { watchlist: null } } } }]);
    await expect(client(empty).communityWatchlist(UUID)).resolves.toEqual({
      kind: 'failed',
      errorClass: 'no_data',
    });
  });

  it('more than MAX_COMMUNITY_PAGES pages is failed', async () => {
    let n = 0;
    const stub = plexStub([
      { path: '/api', body: () => page([{ id: A, type: 'MOVIE' }], `c${++n}`) },
    ]);
    await expect(client(stub).communityWatchlist(UUID)).resolves.toEqual({
      kind: 'failed',
      errorClass: 'too_many_pages',
    });
    expect(stub.calls).toHaveLength(MAX_COMMUNITY_PAGES);
  });

  it('refuses a malformed uuid before any request', async () => {
    const stub = plexStub([]);
    await expect(client(stub).communityWatchlist('../x')).resolves.toEqual({
      kind: 'failed',
      errorClass: 'bad_uuid',
    });
    expect(stub.calls).toHaveLength(0);
  });
});

describe('retry policy (D-02: 429 and 5xx, 3 attempts, 2 s × attempt)', () => {
  it('retries a 429 and a 500 and then answers', async () => {
    let n = 0;
    const stub = plexStub([
      {
        path: '/api',
        status: undefined,
        body: () => page([]),
      },
    ]);
    const flaky = (async (input: unknown, init?: RequestInit) => {
      n += 1;
      if (n === 1) return new Response('{}', { status: 429 });
      if (n === 2) return new Response('{}', { status: 500 });
      return stub.fetchImpl(input as string, init);
    }) as typeof fetch;
    await expect(client(stub, { fetchImpl: flaky }).communityWatchlist(UUID)).resolves.toEqual({
      kind: 'answered',
      nodes: [],
    });
    expect(n).toBe(3);
  });

  it('gives up after 3 attempts', async () => {
    let n = 0;
    const always503 = (async () => {
      n += 1;
      return new Response('{}', { status: 503 });
    }) as typeof fetch;
    const stub = plexStub([]);
    await expect(client(stub, { fetchImpl: always503 }).communityWatchlist(UUID)).resolves.toEqual({
      kind: 'failed',
      errorClass: 'http_503',
    });
    expect(n).toBe(3);
  });

  it('the policy constants', () => {
    expect(registryRetryStatus(429)).toBe(true);
    expect(registryRetryStatus(500)).toBe(true);
    expect(registryRetryStatus(599)).toBe(true);
    expect(registryRetryStatus(404)).toBe(false);
    expect(registryBackoffMs(1)).toBe(2000);
    expect(registryBackoffMs(2)).toBe(4000);
  });
});

describe('owner discover watchlist + discover metadata (D-02, D-03)', () => {
  it('pages the owner list with includeGuids and reports truncation', async () => {
    const stub = plexStub([
      {
        path: '/library/sections/watchlist/all',
        body: {
          MediaContainer: {
            totalSize: 1,
            Metadata: [
              {
                ratingKey: A,
                type: 'movie',
                title: 'T',
                guid: `plex://movie/${A}`,
                Guid: [{ id: 'tmdb://218' }],
              },
            ],
          },
        },
      },
    ]);
    const listing = await client(stub).getOwnerWatchlist();
    expect(listing.truncated).toBe(false);
    expect(listing.items).toHaveLength(1);
    expect(stub.calls[0]!.url.searchParams.get('includeGuids')).toBe('1');
  });

  it('maps a discover id to its external ids; 404 ⇒ null; other failures throw', async () => {
    const stub = plexStub([
      {
        path: `/library/metadata/${A}`,
        body: {
          MediaContainer: {
            Metadata: [{ type: 'movie', Guid: [{ id: 'tmdb://218' }, { id: 'imdb://tt0088247' }] }],
          },
        },
      },
      { path: `/library/metadata/${B}`, status: 404, body: { message: 'nope' } },
    ]);
    await expect(client(stub).discoverMetadata(A)).resolves.toEqual({
      kind: 'movie',
      ids: { tmdbId: 218, tvdbId: null, imdbId: 'tt0088247' },
    });
    await expect(client(stub).discoverMetadata(B)).resolves.toBeNull();
    expect(stub.calls[0]!.url.searchParams.get('includeGuids')).toBe('1');
    const down = plexStub([{ path: /\/library\/metadata\//, status: 500, body: {} }]);
    await expect(client(down).discoverMetadata(A)).rejects.toBeInstanceOf(PlexHttpError);
    await expect(client(down).discoverMetadata('xyz')).rejects.toThrow(TypeError);
  });
});
