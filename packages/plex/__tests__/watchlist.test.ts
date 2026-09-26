// ADR-092 / DESIGN-051 D-06 (PLAN-071 S2) — the plex.tv discover provider's watchlist surface, offline against
// the shapes verified live 2026-09-25 (__fixtures__/watch.ts): the external-id match (type param, empty result,
// `Video` vs `Metadata`), the per-title userState (object and one-element-array forms, absent watchlistedAt),
// and the two watchlist writes on the confined write client (2xx, 404, timeout, the idempotent retries, and the id check
// that refuses a non-hex id before any request). Headers stay exactly today's (ADR-092 C-08).
import { describe, expect, it } from 'vitest';
import { PLEX_DISCOVER_BASE_URL } from '../src/config';
import { discoverExternalIds, discoverIdFromGuid, isDiscoverId, requireDiscoverId } from '../src/discover';
import { PlexHttpError, PlexParseError, PlexTimeoutError } from '../src/errors';
import { PlexReadClient } from '../src/read';
import { PlexWriteClient } from '../src/write';
import { plexStub, TEST_CLIENT_OPTIONS } from './helpers';
import {
  DISCOVER_ACTION_OK_JSON,
  DISCOVER_MATCH_TERMINATOR_JSON,
  DISCOVER_MATCH_VIDEO_JSON,
  DISCOVER_NO_MATCH_JSON,
  DISCOVER_NOT_FOUND_JSON,
  DISCOVER_USER_STATE_ARRAY_JSON,
  DISCOVER_USER_STATE_OBJECT_JSON,
} from '../__fixtures__/watch';

const TERMINATOR = '5d776824151a60001f24a29e';
const SHOW_ID = '608ae6cf5077dd002d3bb8be';

const reader = (stub: ReturnType<typeof plexStub>, extra: Record<string, unknown> = {}) =>
  new PlexReadClient({ ...TEST_CLIENT_OPTIONS, ...extra, fetchImpl: stub.fetchImpl });
const writer = (stub: ReturnType<typeof plexStub>, extra: Record<string, unknown> = {}) =>
  new PlexWriteClient({ ...TEST_CLIENT_OPTIONS, ...extra, fetchImpl: stub.fetchImpl });

/** Only today's headers: the token, the client identifier, the product, Accept (never X-Plex-Version). */
function expectTodaysHeaders(headers: Record<string, string>) {
  expect(headers['X-Plex-Token']).toBe('owner-secret-token');
  expect(headers['X-Plex-Client-Identifier']).toBe('haynesnetwork');
  expect(headers['X-Plex-Product']).toBe('haynesnetwork');
  expect(Object.keys(headers).some((h) => h.toLowerCase() === 'x-plex-version')).toBe(false);
}

describe('discover ids (D-03: validated before any URL)', () => {
  it('accepts exactly 24 lower-case hex digits', () => {
    expect(isDiscoverId(TERMINATOR)).toBe(true);
    for (const bad of ['', '5D776824151A60001F24A29E', `${TERMINATOR}0`, TERMINATOR.slice(1), '../../x', 'abc']) {
      expect(isDiscoverId(bad), bad).toBe(false);
      expect(() => requireDiscoverId(bad)).toThrow(TypeError);
    }
  });

  it('reads the id from a plex:// guid of the same kind only', () => {
    expect(discoverIdFromGuid(`plex://movie/${TERMINATOR}`, 'movie')).toBe(TERMINATOR);
    expect(discoverIdFromGuid(`plex://movie/${TERMINATOR}`, 'show')).toBeNull();
    expect(discoverIdFromGuid('plex://show/sev', 'show')).toBeNull(); // not 24 hex
    expect(discoverIdFromGuid(`local://${TERMINATOR}`, 'movie')).toBeNull();
    expect(discoverIdFromGuid(null, 'movie')).toBeNull();
  });

  it('parses the external ids of a Guid[]', () => {
    expect(discoverExternalIds(DISCOVER_MATCH_TERMINATOR_JSON.MediaContainer.Metadata[0]?.Guid)).toEqual({
      tmdbId: 218,
      tvdbId: 470,
      imdbId: 'tt0088247',
    });
    expect(discoverExternalIds(undefined)).toEqual({ tmdbId: null, tvdbId: null, imdbId: null });
  });
});

describe('matchDiscover — GET {discover}/library/metadata/matches?type=&guid=', () => {
  it('sends the kind as type (movie 1, show 2) and the guid; returns the discover id, title, year and ids', async () => {
    const stub = plexStub([{ path: '/library/metadata/matches', body: DISCOVER_MATCH_TERMINATOR_JSON }]);
    const match = await reader(stub).matchDiscover({ kind: 'movie', guid: 'tmdb://218' });
    expect(match).toEqual({
      ratingKey: TERMINATOR,
      guid: `plex://movie/${TERMINATOR}`,
      kind: 'movie',
      title: 'The Terminator',
      year: 1984,
      ids: { tmdbId: 218, tvdbId: 470, imdbId: 'tt0088247' },
    });
    const call = stub.calls[0]!;
    expect(call.url.origin).toBe(PLEX_DISCOVER_BASE_URL);
    expect(Object.fromEntries(call.url.searchParams)).toEqual({ type: '1', guid: 'tmdb://218' });
    expect(call.url.toString()).not.toContain('owner-secret-token');
    expectTodaysHeaders(call.headers);

    await reader(stub).matchDiscover({ kind: 'show', guid: 'tvdb://371980' });
    expect(stub.calls[1]!.url.searchParams.get('type')).toBe('2');
  });

  it('reads an item reported under Video as well as under Metadata', async () => {
    const stub = plexStub([{ path: '/library/metadata/matches', body: DISCOVER_MATCH_VIDEO_JSON }]);
    expect((await reader(stub).matchDiscover({ kind: 'movie', guid: 'imdb://tt0088247' }))?.ratingKey).toBe(TERMINATOR);
  });

  it('no match (an absent list, an empty body, a 404) is null', async () => {
    for (const route of [
      { path: '/library/metadata/matches', body: DISCOVER_NO_MATCH_JSON },
      { path: '/library/metadata/matches', body: {} },
      { path: '/library/metadata/matches', status: 404, body: DISCOVER_NOT_FOUND_JSON },
    ]) {
      expect(await reader(plexStub([route])).matchDiscover({ kind: 'movie', guid: 'tmdb://1' })).toBeNull();
    }
  });

  it('prefers an item of the asked kind; an item of another kind is reported with its own kind', async () => {
    const show = { ...DISCOVER_MATCH_TERMINATOR_JSON.MediaContainer.Metadata[0], type: 'show', ratingKey: SHOW_ID };
    const movie = DISCOVER_MATCH_TERMINATOR_JSON.MediaContainer.Metadata[0];
    const both = plexStub([{ path: '/library/metadata/matches', body: { MediaContainer: { Metadata: [show, movie] } } }]);
    expect((await reader(both).matchDiscover({ kind: 'movie', guid: 'tvdb://470' }))?.ratingKey).toBe(TERMINATOR);
    const onlyShow = plexStub([{ path: '/library/metadata/matches', body: { MediaContainer: { Metadata: [show] } } }]);
    expect((await reader(onlyShow).matchDiscover({ kind: 'movie', guid: 'tvdb://470' }))?.kind).toBe('show');
  });

  it('an item without a valid discover id is no match; a foreign guid scheme is refused before a request', async () => {
    const bogus = { ...DISCOVER_MATCH_TERMINATOR_JSON.MediaContainer.Metadata[0], ratingKey: '../../x' };
    const stub = plexStub([{ path: '/library/metadata/matches', body: { MediaContainer: { Metadata: [bogus] } } }]);
    expect(await reader(stub).matchDiscover({ kind: 'movie', guid: 'tmdb://218' })).toBeNull();
    const none = plexStub([]);
    await expect(reader(none).matchDiscover({ kind: 'movie', guid: 'plex://movie/x' })).rejects.toBeInstanceOf(TypeError);
    expect(none.calls).toHaveLength(0);
  });

  it('honors a configured discover base URL (the e2e stub)', async () => {
    const stub = plexStub([{ path: '/library/metadata/matches', body: DISCOVER_NO_MATCH_JSON }]);
    await reader(stub, { plexDiscoverBaseUrl: 'http://stub-discover.test:9/' }).matchDiscover({ kind: 'show', guid: 'tmdb://1' });
    expect(stub.calls[0]!.url.origin).toBe('http://stub-discover.test:9');
  });
});

describe('getDiscoverUserState — GET {discover}/library/metadata/<id>/userState', () => {
  it('reads watchlistedAt from a one-element ARRAY', async () => {
    const stub = plexStub([{ path: `/library/metadata/${SHOW_ID}/userState`, body: DISCOVER_USER_STATE_ARRAY_JSON }]);
    expect(await reader(stub).getDiscoverUserState(SHOW_ID)).toEqual({ watchlistedAt: 1789061676 });
    expect(stub.calls[0]!.url.origin).toBe(PLEX_DISCOVER_BASE_URL);
    expectTodaysHeaders(stub.calls[0]!.headers);
  });

  it('an OBJECT without watchlistedAt (and an absent UserState) is "not on the watchlist"', async () => {
    const obj = plexStub([{ path: `/library/metadata/${TERMINATOR}/userState`, body: DISCOVER_USER_STATE_OBJECT_JSON }]);
    expect(await reader(obj).getDiscoverUserState(TERMINATOR)).toEqual({ watchlistedAt: null });
    const on = plexStub([
      {
        path: `/library/metadata/${TERMINATOR}/userState`,
        body: { MediaContainer: { UserState: { ratingKey: TERMINATOR, watchlistedAt: '1789061676' } } },
      },
    ]);
    expect(await reader(on).getDiscoverUserState(TERMINATOR)).toEqual({ watchlistedAt: 1789061676 });
    const absent = plexStub([{ path: `/library/metadata/${TERMINATOR}/userState`, body: { MediaContainer: { size: 0 } } }]);
    expect(await reader(absent).getDiscoverUserState(TERMINATOR)).toEqual({ watchlistedAt: null });
  });

  it('never reads another title\'s state (DESIGN-051 D-06, review A3): only the requested id, or an element naming none', async () => {
    const other = { ratingKey: SHOW_ID, type: 'show', watchlistedAt: 1789061676 };
    const foreign = plexStub([{ path: /userState$/, body: { MediaContainer: { UserState: [other] } } }]);
    await expect(reader(foreign).getDiscoverUserState(TERMINATOR)).rejects.toBeInstanceOf(PlexParseError);
    const foreignObject = plexStub([{ path: /userState$/, body: { MediaContainer: { UserState: other } } }]);
    await expect(reader(foreignObject).getDiscoverUserState(TERMINATOR)).rejects.toBeInstanceOf(PlexParseError);
    const mixed = plexStub([
      { path: /userState$/, body: { MediaContainer: { UserState: [other, { ratingKey: TERMINATOR, type: 'movie' }] } } },
    ]);
    expect(await reader(mixed).getDiscoverUserState(TERMINATOR)).toEqual({ watchlistedAt: null });
    const unnamed = plexStub([{ path: /userState$/, body: { MediaContainer: { UserState: [{ watchlistedAt: 1789061676 }] } } }]);
    expect(await reader(unnamed).getDiscoverUserState(TERMINATOR)).toEqual({ watchlistedAt: 1789061676 });
    const empty = plexStub([{ path: /userState$/, body: { MediaContainer: { UserState: [] } } }]);
    expect(await reader(empty).getDiscoverUserState(TERMINATOR)).toEqual({ watchlistedAt: null });
  });

  it('refuses a non-hex id before any request; a 404 is a typed error', async () => {
    const none = plexStub([]);
    await expect(reader(none).getDiscoverUserState('sev')).rejects.toBeInstanceOf(TypeError);
    expect(none.calls).toHaveLength(0);
    const missing = plexStub([{ path: /userState$/, status: 404, body: DISCOVER_NOT_FOUND_JSON }]);
    await expect(reader(missing).getDiscoverUserState(TERMINATOR)).rejects.toMatchObject({ status: 404 });
  });
});

describe('addToWatchlist / removeFromWatchlist — PUT {discover}/actions/…?ratingKey= (the confined write surface)', () => {
  it('PUTs the action with the id as ratingKey on the discover host; token header-only; no body', async () => {
    const stub = plexStub([
      { method: 'PUT', path: '/actions/addToWatchlist', body: DISCOVER_ACTION_OK_JSON },
      { method: 'PUT', path: '/actions/removeFromWatchlist', body: DISCOVER_ACTION_OK_JSON },
    ]);
    await writer(stub).addToWatchlist(TERMINATOR);
    await writer(stub).removeFromWatchlist(TERMINATOR);
    expect(stub.calls.map((c) => [c.method, c.url.origin, c.url.pathname, Object.fromEntries(c.url.searchParams)])).toEqual([
      ['PUT', PLEX_DISCOVER_BASE_URL, '/actions/addToWatchlist', { ratingKey: TERMINATOR }],
      ['PUT', PLEX_DISCOVER_BASE_URL, '/actions/removeFromWatchlist', { ratingKey: TERMINATOR }],
    ]);
    for (const c of stub.calls) {
      expectTodaysHeaders(c.headers);
      expect(c.url.toString()).not.toContain('owner-secret-token');
      expect(c.body).toBeUndefined();
      expect(c.headers['Content-Type']).toBeUndefined();
    }
  });

  it('honors the configured discover base URL (the constructor takes it like the read client)', async () => {
    const stub = plexStub([{ method: 'PUT', path: '/actions/addToWatchlist', body: DISCOVER_ACTION_OK_JSON }]);
    await writer(stub, { plexDiscoverBaseUrl: 'http://stub-discover.test:9/' }).addToWatchlist(TERMINATOR);
    expect(stub.calls[0]!.url.origin).toBe('http://stub-discover.test:9');
  });

  it('a 404 (an id plex.tv does not know) is a typed PlexHttpError', async () => {
    const stub = plexStub([{ method: 'PUT', path: '/actions/addToWatchlist', status: 404, body: DISCOVER_NOT_FOUND_JSON }]);
    const err = await writer(stub).addToWatchlist(TERMINATOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlexHttpError);
    expect((err as PlexHttpError).status).toBe(404);
  });

  it('is idempotent, so it keeps the GET retry policy (DESIGN-051 D-03 step 6, D-06): a transient 503 is retried, a lasting one fails typed', async () => {
    let n = 0;
    const flaky = plexStub([{ method: 'PUT', path: '/actions/removeFromWatchlist', status: 503, body: 'busy' }]);
    const once = (async (input: unknown, init?: RequestInit) => {
      n += 1;
      if (n === 1) return flaky.fetchImpl(input as string, init);
      return new Response(JSON.stringify(DISCOVER_ACTION_OK_JSON), { status: 200 });
    }) as typeof fetch;
    await new PlexWriteClient({ ...TEST_CLIENT_OPTIONS, fetchImpl: once }).removeFromWatchlist(TERMINATOR);
    expect(n).toBe(2);
    const stub = plexStub([{ method: 'PUT', path: '/actions/removeFromWatchlist', status: 503, body: 'busy' }]);
    await expect(writer(stub).removeFromWatchlist(TERMINATOR)).rejects.toBeInstanceOf(PlexHttpError);
    expect(stub.calls).toHaveLength(3);
    // A 404 is not retried (the id is unknown, not the server busy).
    const missing = plexStub([{ method: 'PUT', path: '/actions/addToWatchlist', status: 404, body: DISCOVER_NOT_FOUND_JSON }]);
    await expect(writer(missing).addToWatchlist(TERMINATOR)).rejects.toMatchObject({ status: 404 });
    expect(missing.calls).toHaveLength(1);
  });

  it('a timeout is a typed PlexTimeoutError, after the client\'s three attempts', async () => {
    let attempts = 0;
    const hang = ((_input: unknown, init?: RequestInit) => {
      attempts += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as typeof fetch;
    const client = new PlexWriteClient({ ...TEST_CLIENT_OPTIONS, fetchImpl: hang, timeoutMs: 20 });
    await expect(client.addToWatchlist(TERMINATOR)).rejects.toBeInstanceOf(PlexTimeoutError);
    expect(attempts).toBe(3);
  });

  it('refuses a non-hex id before any request (nothing built into a URL)', async () => {
    const stub = plexStub([]);
    for (const bad of ['', 'sev', '../actions/x', `${TERMINATOR}&x=1`]) {
      await expect(writer(stub).addToWatchlist(bad)).rejects.toBeInstanceOf(TypeError);
      await expect(writer(stub).removeFromWatchlist(bad)).rejects.toBeInstanceOf(TypeError);
    }
    expect(stub.calls).toHaveLength(0);
  });
});
