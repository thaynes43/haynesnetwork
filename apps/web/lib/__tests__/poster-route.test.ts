// ADR-019 / DESIGN-008 — the authed poster PROXY route, tested at the handler level (the
// @hnet/api resolver + TMDB fallback and @hnet/auth session are mocked; the streaming/304/
// fallback WIRING is the real thing). Load-bearing: the deleted-item fallback — when the primary
// *arr MediaCover 404s (item removed from the *arr, poster_source still 'arr'), the route streams
// the TMDB poster instead; and the guards that keep the current behavior (both-absent → 404/
// placeholder, tmdb primary never falls back, session-gated, ETag/304).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getServerSession = vi.hoisted(() => vi.fn());
const resolvePosterUpstream = vi.hoisted(() => vi.fn());
const resolveTmdbPosterFallback = vi.hoisted(() => vi.fn());
// ADR-047 (PLAN-028) — the per-item Library access gate the route now applies (THE INVARIANT:
// the poster proxy is a parallel art-by-id leak vector). Defaults accessible; the gate test flips it.
const isMediaItemAccessibleToUser = vi.hoisted(() => vi.fn());

vi.mock('@hnet/auth', () => ({ getServerSession }));
vi.mock('@hnet/api', () => ({
  resolvePosterUpstream,
  resolveTmdbPosterFallback,
  isMediaItemAccessibleToUser,
}));

import { GET } from '../../app/api/posters/[mediaItemId]/route';

const ARR = {
  source: 'arr' as const,
  url: 'http://radarr.test/api/v3/mediacover/601/poster-250.jpg',
  headers: { 'X-Api-Key': 'r-key', Accept: 'image/*' },
  etag: '"arr-etag"',
};
const TMDB = {
  source: 'tmdb' as const,
  url: 'https://image.tmdb.org/t/p/w342/deleted.jpg',
  headers: { Accept: 'image/*' },
  etag: '"tmdb-etag"',
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const image = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
const notFound = () => new Response('nf', { status: 404 });

const ID = '00000000-0000-4000-8000-000000000000';
function call(headers: Record<string, string> = {}): Promise<Response> {
  const req = new Request(`http://app.local/api/posters/${ID}`, { headers });
  return GET(req, { params: Promise.resolve({ mediaItemId: ID }) });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  getServerSession.mockReset().mockResolvedValue({ user: { id: 'u1' } });
  resolvePosterUpstream.mockReset();
  resolveTmdbPosterFallback.mockReset().mockResolvedValue(null);
  isMediaItemAccessibleToUser.mockReset().mockResolvedValue(true);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('GET /api/posters/[id] — session gate', () => {
  it('unauthenticated → 401, and never touches the resolver', async () => {
    getServerSession.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(resolvePosterUpstream).not.toHaveBeenCalled();
  });
});

describe('GET /api/posters/[id] — library access gate (ADR-047 THE INVARIANT)', () => {
  it('an item in a Plex library the caller cannot access → 404, resolver never touched', async () => {
    isMediaItemAccessibleToUser.mockResolvedValue(false);
    const res = await call();
    expect(res.status).toBe(404);
    expect(isMediaItemAccessibleToUser).toHaveBeenCalledWith('u1', ID);
    expect(resolvePosterUpstream).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/posters/[id] — primary path (unchanged)', () => {
  it('streams the *arr MediaCover when it 200s; no TMDB fallback attempted', async () => {
    resolvePosterUpstream.mockResolvedValue(ARR);
    fetchMock.mockResolvedValue(image());
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/');
    expect(res.headers.get('etag')).toBe(ARR.etag);
    expect(res.headers.get('cache-control')).toContain('private');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(ARR.url);
    expect(resolveTmdbPosterFallback).not.toHaveBeenCalled();
  });

  it('no poster at all (resolver → null) → 404 without fetching', async () => {
    resolvePosterUpstream.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveTmdbPosterFallback).not.toHaveBeenCalled();
  });

  it('a conditional request matching the ETag → 304 (no upstream fetch)', async () => {
    resolvePosterUpstream.mockResolvedValue(ARR);
    const res = await call({ 'if-none-match': ARR.etag });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(ARR.etag);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/posters/[id] — deleted-item TMDB fallback', () => {
  it('*arr MediaCover 404 + a TMDB poster → streams the TMDB poster (Recently-Deleted art)', async () => {
    resolvePosterUpstream.mockResolvedValue(ARR);
    resolveTmdbPosterFallback.mockResolvedValue(TMDB);
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('image.tmdb.org') ? image() : notFound(),
    );
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(TMDB.etag);
    expect(resolveTmdbPosterFallback).toHaveBeenCalledWith(ID);
    // Fetched the *arr first (404), then the TMDB CDN.
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([ARR.url, TMDB.url]);
  });

  it('*arr MediaCover 404 + TMDB has nothing → 404 (KindIcon placeholder, current behavior)', async () => {
    resolvePosterUpstream.mockResolvedValue(ARR);
    resolveTmdbPosterFallback.mockResolvedValue(null);
    fetchMock.mockResolvedValue(notFound());
    const res = await call();
    expect(res.status).toBe(404);
    expect(resolveTmdbPosterFallback).toHaveBeenCalledWith(ID);
  });

  it('a TMDB *primary* that misses does NOT fall back (only arr primaries do)', async () => {
    resolvePosterUpstream.mockResolvedValue(TMDB); // primary already tmdb
    fetchMock.mockResolvedValue(notFound());
    const res = await call();
    expect(res.status).toBe(404);
    expect(resolveTmdbPosterFallback).not.toHaveBeenCalled();
  });

  it('revalidation after a heal: a cached TMDB ETag → 304 via the fallback (one wasted *arr probe)', async () => {
    resolvePosterUpstream.mockResolvedValue(ARR);
    resolveTmdbPosterFallback.mockResolvedValue(TMDB);
    fetchMock.mockResolvedValue(notFound()); // the *arr probe 404s; the fallback 304s before fetching
    const res = await call({ 'if-none-match': TMDB.etag });
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(TMDB.etag);
    // Only the *arr probe hit the network; the TMDB fallback short-circuited on the ETag.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(ARR.url);
  });

  it('a network THROW on the *arr upstream still falls back to TMDB', async () => {
    resolvePosterUpstream.mockResolvedValue(ARR);
    resolveTmdbPosterFallback.mockResolvedValue(TMDB);
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('image.tmdb.org')) return image();
      throw new Error('ECONNREFUSED');
    });
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(TMDB.etag);
  });
});
