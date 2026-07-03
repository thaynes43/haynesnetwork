// Test harness: fixture loader + injectable fetch stubs. Fixtures are SANITIZED
// recordings of the 2026-07-03 live GET probes (DESIGN-005 test strategy) — tests run
// fully offline; no code path here can reach a network.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__');

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8')) as T;
}

export interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  /** JSON-parsed request body, or undefined when none was sent. */
  body: unknown;
}

export interface StubRoute {
  method?: string; // default GET
  /** Exact pathname (e.g. '/api/v3/series') or RegExp. */
  path: string | RegExp;
  status?: number; // default 200
  body?: unknown; // JSON-serialized; omit for an empty body
}

/** Route-table fetch stub; records every call for method/path/payload assertions. */
export function stubFetch(routes: StubRoute[]) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const route = routes.find(
      (r) =>
        (r.method ?? 'GET') === method &&
        (typeof r.path === 'string' ? url.pathname === r.path : r.path.test(url.pathname)),
    );
    if (!route) {
      return new Response(JSON.stringify({ message: `no stub for ${method} ${url.pathname}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Sequenced fetch stub: returns responses[0], responses[1], … regardless of URL. */
export function stubFetchSequence(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({
      method: init.method ?? 'GET',
      url,
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)] ?? {};
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Fetch stub that never resolves but honors AbortSignal — for timeout tests. */
export function stubFetchHanging() {
  const fetchImpl = ((_input: unknown, init: RequestInit = {}) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      );
    })) as typeof fetch;
  return { fetchImpl };
}

export const TEST_OPTS = {
  apiKey: 'test-api-key',
  retryDelayMs: 0,
} as const;
