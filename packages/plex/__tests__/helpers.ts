// Fetch-stub harness for the @hnet/plex client tests (ADR-010 — fully offline). Records every
// request (method, URL, headers, parsed body) and dispatches by a route table, returning XML
// text or JSON. Lets tests assert the token rides ONLY in the X-Plex-Token header, never the
// URL, and that the sharing write bodies match the plex.tv v1 contract.

export interface RecordedPlexCall {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export interface PlexStubRoute {
  method?: string; // default GET
  /** Exact pathname or RegExp against url.pathname. */
  path: string | RegExp;
  status?: number; // default 200
  /** Static or URL-derived body; strings are sent verbatim (XML), objects JSON-stringified. */
  body?: unknown | ((url: URL) => unknown);
  contentType?: string;
}

export interface PlexStub {
  fetchImpl: typeof fetch;
  calls: RecordedPlexCall[];
  callsFor: (method: string, pathIncludes: string) => RecordedPlexCall[];
}

export function plexStub(routes: PlexStubRoute[]): PlexStub {
  const calls: RecordedPlexCall[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    calls.push({
      method,
      url,
      headers,
      body: typeof init.body === 'string' ? safeJson(init.body) : undefined,
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
    const resolved = typeof route.body === 'function' ? route.body(url) : route.body;
    const isString = typeof resolved === 'string';
    const payload = resolved === undefined ? null : isString ? resolved : JSON.stringify(resolved);
    return new Response(payload, {
      status: route.status ?? 200,
      headers: { 'content-type': route.contentType ?? (isString ? 'application/xml' : 'application/json') },
    });
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    callsFor: (method, pathIncludes) =>
      calls.filter((c) => c.method === method && c.url.pathname.includes(pathIncludes)),
  };
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export const TEST_CLIENT_OPTIONS = {
  baseUrl: 'http://plexops.test:32400',
  token: 'owner-secret-token',
  machineIdentifier: 'mid-tower',
  plexTvBaseUrl: 'https://plex.tv',
  retryDelayMs: 0,
} as const;
