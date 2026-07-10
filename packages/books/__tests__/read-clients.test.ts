import { describe, expect, it } from 'vitest';
import {
  AudiobookshelfClient,
  KavitaClient,
  booksReadClients,
  kavitaLibraryKind,
} from '../src/read';

interface RecordedCall {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

interface Route {
  method?: string;
  match: (url: URL) => boolean;
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/** A route-table fetch stub that records every call (mirrors @hnet/arr's stubFetch). */
function stubFetch(routes: Route[]): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, headers: new Headers(init.headers), body });
    const route = routes.find(
      (r) => (r.method ?? 'GET') === method && r.match(url),
    );
    if (!route) {
      return new Response(JSON.stringify({ message: `no route for ${method} ${url.pathname}` }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(route.body === null ? null : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const KAVITA_OPTS = {
  baseUrl: 'http://kavita.test:5000',
  username: 'hnetadmin',
  password: 'secret',
};
const ABS_OPTS = {
  baseUrl: 'http://abs.test:13378',
  username: 'root',
  password: 'secret',
};

describe('kavitaLibraryKind', () => {
  it('maps Kavita LibraryType 2→book, 1→comic, others→null', () => {
    expect(kavitaLibraryKind(2)).toBe('book');
    expect(kavitaLibraryKind(1)).toBe('comic');
    expect(kavitaLibraryKind(0)).toBeNull();
    expect(kavitaLibraryKind(4)).toBeNull();
  });
});

describe('KavitaClient', () => {
  it('logs in with username/password then lists libraries with a Bearer token', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        method: 'POST',
        match: (u) => u.pathname === '/api/Account/login',
        body: { token: 'jwt-123', apiKey: 'key-abc' },
      },
      {
        match: (u) => u.pathname === '/api/Library/libraries',
        body: [
          { id: 1, name: 'Books', type: 2 },
          { id: 2, name: 'Comics', type: 1 },
        ],
      },
    ]);
    const client = new KavitaClient({ ...KAVITA_OPTS, fetchImpl });
    const libs = await client.listLibraries();
    expect(libs).toHaveLength(2);
    expect(libs[0]).toEqual({ id: 1, name: 'Books', type: 2 });

    const loginCall = calls.find((c) => c.url.pathname === '/api/Account/login');
    expect(loginCall?.body).toEqual({ username: 'hnetadmin', password: 'secret' });
    const libCall = calls.find((c) => c.url.pathname === '/api/Library/libraries');
    expect(libCall?.headers.get('authorization')).toBe('Bearer jwt-123');
    // The password never rides in a URL.
    expect(calls.every((c) => !c.url.search.includes('secret'))).toBe(true);
  });

  it('reads the total from the Pagination response header', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'POST',
        match: (u) => u.pathname === '/api/Account/login',
        body: { token: 'jwt', apiKey: 'key' },
      },
      {
        method: 'POST',
        match: (u) => u.pathname === '/api/Series/all-v2',
        headers: { Pagination: JSON.stringify({ currentPage: 1, totalItems: 1283 }) },
        body: [{ id: 1169, name: "Shakespeare's Landlord", libraryId: 1, format: 3, pages: 27 }],
      },
    ]);
    const client = new KavitaClient({ ...KAVITA_OPTS, fetchImpl });
    const page = await client.listSeriesPage(1, 1, 100);
    expect(page.total).toBe(1283);
    expect(page.items[0]?.id).toBe(1169);
  });

  it('re-authenticates once on a 401 and retries the request', async () => {
    let libHits = 0;
    const { fetchImpl, calls } = stubFetch([
      {
        method: 'POST',
        match: (u) => u.pathname === '/api/Account/login',
        body: { token: 'jwt', apiKey: 'key' },
      },
      {
        match: (u) => u.pathname === '/api/Library/libraries',
        get status() {
          libHits += 1;
          return libHits === 1 ? 401 : 200;
        },
        body: [{ id: 1, name: 'Books', type: 2 }],
      },
    ]);
    const client = new KavitaClient({ ...KAVITA_OPTS, fetchImpl });
    const libs = await client.listLibraries();
    expect(libs).toHaveLength(1);
    // Two logins (initial + re-auth) and two library hits (401 then 200).
    expect(calls.filter((c) => c.url.pathname === '/api/Account/login')).toHaveLength(2);
    expect(calls.filter((c) => c.url.pathname === '/api/Library/libraries')).toHaveLength(2);
  });

  it('exposes the stable apiKey for the cover proxy', async () => {
    const { fetchImpl } = stubFetch([
      {
        method: 'POST',
        match: (u) => u.pathname === '/api/Account/login',
        body: { token: 'jwt', apiKey: 'key-abc' },
      },
    ]);
    const client = new KavitaClient({ ...KAVITA_OPTS, fetchImpl });
    expect(await client.apiKey()).toBe('key-abc');
  });
});

describe('AudiobookshelfClient', () => {
  it('logs in then lists libraries and items with a bearer token + total', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        method: 'POST',
        match: (u) => u.pathname === '/login',
        body: { user: { token: 'abs-tok', username: 'root' } },
      },
      {
        match: (u) => u.pathname === '/api/libraries',
        body: { libraries: [{ id: 'lib-1', name: 'Audio Books', mediaType: 'book' }] },
      },
      {
        match: (u) => u.pathname === '/api/libraries/lib-1/items',
        body: {
          total: 823,
          page: 0,
          results: [
            {
              id: 'item-1',
              libraryId: 'lib-1',
              addedAt: 1783702399325,
              updatedAt: 1783702399325,
              media: {
                metadata: { title: 'Restaurant at the End of the Universe', authorName: 'Douglas Adams' },
                numTracks: 5,
                duration: 19822,
                size: 369070,
              },
            },
          ],
        },
      },
    ]);
    const client = new AudiobookshelfClient({ ...ABS_OPTS, fetchImpl });
    const libs = await client.listLibraries();
    expect(libs[0]?.id).toBe('lib-1');
    const page = await client.listItemsPage('lib-1', 0, 50);
    expect(page.total).toBe(823);
    expect(page.items[0]?.media?.metadata?.authorName).toBe('Douglas Adams');

    const itemsCall = calls.find((c) => c.url.pathname === '/api/libraries/lib-1/items');
    expect(itemsCall?.headers.get('authorization')).toBe('Bearer abs-tok');
    expect(await client.bearerToken()).toBe('abs-tok');
  });
});

describe('booksReadClients factory', () => {
  it('constructs both clients from a config', () => {
    const clients = booksReadClients({ kavita: KAVITA_OPTS, audiobookshelf: ABS_OPTS });
    expect(clients.kavita).toBeInstanceOf(KavitaClient);
    expect(clients.audiobookshelf).toBeInstanceOf(AudiobookshelfClient);
  });
});
