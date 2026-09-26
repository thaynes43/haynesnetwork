// DESIGN-051 D-15n / D-15p (PR #580 review) — the shared Plex fetch wrapper's per-attempt timer bounds the WHOLE
// attempt, the body included, and the error a retried request finally throws says whether an earlier attempt may
// still be applied by the server. The body tests run the production path — Node's own fetch (undici) against a real
// local HTTP server that sends its headers and then stalls the body — because a stubbed Response never stalls:
// before the fix, a 200 whose body never finished kept the watchlist PUT (and so a pending Watch Mark, and an
// undo's advisory lock) waiting for undici's 300 s body timeout.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlexHttpError, PlexNetworkError, PlexTimeoutError } from '../src/errors';
import { PlexReadClient } from '../src/read';
import { PlexWriteClient } from '../src/write';
import { TEST_CLIENT_OPTIONS } from './helpers';

const ID = '5d776824151a60001f24a29e';
const TIMEOUT_MS = 150;

let server: Server;
let base = '';
const hits: string[] = [];
/** How each path answers: 'stall' = headers, a first chunk, then never the rest; 'stall-error' = a 503 that stalls. */
const mode = new Map<string, 'stall' | 'stall-error'>();

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    hits.push(`${req.method} ${path}`);
    const how = mode.get(path) ?? 'stall';
    res.writeHead(how === 'stall-error' ? 503 : 200, { 'content-type': 'application/json' });
    res.write('{"MediaContainer":'); // …and the body never finishes
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const options = {
  ...TEST_CLIENT_OPTIONS,
  plexDiscoverBaseUrl: base,
  timeoutMs: TIMEOUT_MS,
  retryDelayMs: 0,
};

async function timed<T>(
  p: Promise<T>,
): Promise<{ ms: number; value: T | undefined; error: unknown }> {
  const start = Date.now();
  try {
    const value = await p;
    return { ms: Date.now() - start, value, error: undefined };
  } catch (error) {
    return { ms: Date.now() - start, value: undefined, error };
  }
}

describe('the per-attempt timer covers the body (D-15p)', () => {
  it('a watchlist PUT whose 200 body stalls ends at the attempt bound, and the 2xx stands (one attempt)', async () => {
    hits.length = 0;
    const client = new PlexWriteClient({ ...options, plexDiscoverBaseUrl: base });
    const out = await timed(client.addToWatchlist(ID));
    expect(out.error).toBeUndefined();
    expect(out.ms).toBeLessThan(TIMEOUT_MS * 4);
    expect(hits).toEqual(['PUT /actions/addToWatchlist']);
  });

  it('a JSON read whose body stalls is a PlexTimeoutError after the three attempts, not a 300 s wait', async () => {
    hits.length = 0;
    const client = new PlexReadClient({ ...options, plexDiscoverBaseUrl: base });
    const out = await timed(client.getDiscoverUserState(ID));
    expect(out.error).toBeInstanceOf(PlexTimeoutError);
    expect((out.error as PlexTimeoutError).mayStillLand).toBe(true);
    expect(out.ms).toBeLessThan(TIMEOUT_MS * 3 + 1_000);
    expect(hits).toHaveLength(3);
  });

  it('an error status whose body stalls is still a typed PlexHttpError (only the snippet is lost)', async () => {
    hits.length = 0;
    mode.set('/actions/removeFromWatchlist', 'stall-error');
    const client = new PlexWriteClient({ ...options, plexDiscoverBaseUrl: base });
    const out = await timed(client.removeFromWatchlist(ID));
    expect(out.error).toBeInstanceOf(PlexHttpError);
    expect((out.error as PlexHttpError).status).toBe(503);
    expect(out.ms).toBeLessThan(TIMEOUT_MS * 3 + 1_000);
    expect(hits).toHaveLength(3); // a 503 is retried
  });
});

describe('mayStillLand: whether a failed request may still be applied (D-15n)', () => {
  /** A fetch that answers each attempt from `script` in turn: a status, or 'hang' (until our timer aborts it). */
  function scripted(script: Array<number | 'hang' | 'refused'>): {
    fetchImpl: typeof fetch;
    count: () => number;
  } {
    let n = 0;
    const fetchImpl = ((_input: unknown, init?: RequestInit) => {
      const step = script[Math.min(n, script.length - 1)];
      n += 1;
      if (step === 'hang') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        });
      }
      if (step === 'refused') return Promise.reject(new TypeError('fetch failed'));
      return Promise.resolve(new Response('{}', { status: step }));
    }) as typeof fetch;
    return { fetchImpl, count: () => n };
  }
  const put = (script: Array<number | 'hang' | 'refused'>) => {
    const s = scripted(script);
    const client = new PlexWriteClient({
      ...TEST_CLIENT_OPTIONS,
      fetchImpl: s.fetchImpl,
      timeoutMs: 20,
    });
    return {
      error: client.addToWatchlist(ID).then(
        () => null,
        (e: unknown) => e,
      ),
      count: s.count,
    };
  };

  it('a timeout or a dropped connection may still land; so may a gateway timeout (504)', async () => {
    expect(await put(['hang']).error).toMatchObject({
      name: 'PlexTimeoutError',
      mayStillLand: true,
    });
    expect(await put(['refused']).error).toBeInstanceOf(PlexNetworkError);
    expect(await put(['refused']).error).toMatchObject({ mayStillLand: true });
    expect(await put([504]).error).toMatchObject({ status: 504, mayStillLand: true });
  });

  it('plex.tv refusing every attempt (503, 500, 429) does not, when no earlier attempt could still land', async () => {
    const busy = put([503]);
    expect(await busy.error).toMatchObject({ status: 503, mayStillLand: false });
    expect(busy.count()).toBe(3);
    expect(await put([500]).error).toMatchObject({ status: 500, mayStillLand: false });
    expect(await put([429]).error).toMatchObject({ status: 429, mayStillLand: false });
  });

  it('an earlier attempt that timed out marks the error finally thrown, even a clean 503 or 429 after it', async () => {
    const late = put(['hang', 503, 503]);
    expect(await late.error).toMatchObject({ status: 503, mayStillLand: true });
    expect(late.count()).toBe(3);
    const limited = put(['hang', 429]);
    expect(await limited.error).toMatchObject({ status: 429, mayStillLand: true });
    expect(limited.count()).toBe(2); // a 429 is not retried
  });
});
