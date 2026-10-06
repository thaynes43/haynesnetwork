// DESIGN-051 D-15g — the production wiring of the two TMDB searches: `set_watchlist`'s fallback
// (`tmdbOnce`) makes a SINGLE attempt, every other tool's (`tmdb`) keeps the client's GET retries. The watchlist e2e
// proves which one each tool uses; this proves `defaultDeps` builds them that way (a stalled TMDB with three
// attempts would push an add past the 9 s MCP deadline), and that each attempt's timer covers the body (D-15p).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDeps, tmdbSearchFromEnv } from '../src/deps';

/** A TMDB that answers every request 503, counting the requests. */
function busyTmdb() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ status_message: 'busy' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the TMDB searches of the MCP deps (DESIGN-051 D-15g)', () => {
  it('tmdbSearchFromEnv: `once` is one attempt on a 503, the default three; no TMDB config is null', async () => {
    const env = { TMDB_API_KEY: 'test-tmdb-key' };
    const one = busyTmdb();
    await expect(tmdbSearchFromEnv(env, { once: true, fetchImpl: one.fetchImpl })?.searchMulti('dune')).rejects.toThrow();
    expect(one.calls).toHaveLength(1);
    const three = busyTmdb();
    await expect(
      tmdbSearchFromEnv(env, { once: false, fetchImpl: three.fetchImpl })?.searchMulti('dune'),
    ).rejects.toThrow();
    expect(three.calls).toHaveLength(3);
    expect(tmdbSearchFromEnv({}, { once: true })).toBeNull();
  });

  it('each attempt\'s timer covers the body (D-15p): a TMDB body that stalls after its headers ends at the bound', async () => {
    const stalling = ((_input: unknown, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"page":1,'));
              init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )) as typeof fetch;
    const start = Date.now();
    const search = tmdbSearchFromEnv({ TMDB_API_KEY: 'test-tmdb-key' }, { once: true, fetchImpl: stalling });
    await expect(search?.searchMulti('dune')).rejects.toThrow(/timed out/);
    // One 1.5 s attempt, not undici's 300 s body timeout.
    expect(Date.now() - start).toBeLessThan(4_000);
  });

  it('defaultDeps: `tmdbOnce` (set_watchlist) is the single-attempt client, `tmdb` keeps the retries', async () => {
    vi.stubEnv('TMDB_API_READ_ACCESS_TOKEN', '');
    vi.stubEnv('TMDB_API_KEY', 'test-tmdb-key');
    const busy = busyTmdb();
    vi.stubGlobal('fetch', busy.fetchImpl);
    const deps = defaultDeps();
    const once = deps.tmdbOnce?.();
    expect(once).toBeTruthy();
    await expect(once?.searchMulti('dune')).rejects.toThrow();
    expect(busy.calls).toHaveLength(1);
    busy.calls.length = 0;
    await expect(deps.tmdb()?.searchMulti('dune')).rejects.toThrow();
    expect(busy.calls).toHaveLength(3);
    // Both went to TMDB's search.
    expect(busy.calls.every((u) => u.includes('/3/search/multi'))).toBe(true);
  });
});
