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

  it('fetchItemCover requests the sized upstream variant via ?width=&format= (F-06 / ADR-041 idiom)', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        method: 'POST',
        match: (u) => u.pathname === '/login',
        body: { user: { token: 'abs-tok', username: 'root' } },
      },
      {
        match: (u) => u.pathname === '/api/items/item-1/cover',
        headers: { 'content-type': 'image/webp' },
        body: null,
      },
    ]);
    const client = new AudiobookshelfClient({ ...ABS_OPTS, fetchImpl });
    const sized = await client.fetchItemCover('item-1', { width: 300, format: 'webp' });
    expect(sized.status).toBe(200);
    const sizedCall = calls.find((c) => c.url.pathname === '/api/items/item-1/cover');
    expect(sizedCall?.url.search).toBe('?width=300&format=webp');
    expect(sizedCall?.headers.get('authorization')).toBe('Bearer abs-tok');
    // The token rides in a header, never the URL.
    expect(calls.every((c) => !c.url.search.includes('abs-tok'))).toBe(true);
  });

  it('fetchItemCover without a variant requests the ORIGINAL cover (the fallback tier)', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        method: 'POST',
        match: (u) => u.pathname === '/login',
        body: { user: { token: 'abs-tok', username: 'root' } },
      },
      {
        match: (u) => u.pathname === '/api/items/item-1/cover',
        headers: { 'content-type': 'image/jpeg' },
        body: null,
      },
    ]);
    const client = new AudiobookshelfClient({ ...ABS_OPTS, fetchImpl });
    await client.fetchItemCover('item-1');
    const call = calls.find((c) => c.url.pathname === '/api/items/item-1/cover');
    expect(call?.url.search).toBe('');
  });

  it('listAuthors reads a library’s authors incl. imagePath/updatedAt (group-card art directory)', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        method: 'POST',
        match: (u) => u.pathname === '/login',
        body: { user: { token: 'abs-tok', username: 'root' } },
      },
      {
        match: (u) => u.pathname === '/api/libraries/lib-1/authors',
        body: {
          authors: [
            { id: 'auth-1', name: 'John Grisham', imagePath: '/metadata/authors/a.jpg', updatedAt: 100, numBooks: 44 },
            { id: 'auth-2', name: 'Douglas Adams', imagePath: null, updatedAt: 101 },
          ],
        },
      },
    ]);
    const client = new AudiobookshelfClient({ ...ABS_OPTS, fetchImpl });
    const authors = await client.listAuthors('lib-1');
    expect(authors.map((a) => `${a.name}:${a.imagePath !== null}`)).toEqual([
      'John Grisham:true',
      'Douglas Adams:false',
    ]);
    const authorsCall = calls.find((c) => c.url.pathname === '/api/libraries/lib-1/authors');
    expect(authorsCall?.headers.get('authorization')).toBe('Bearer abs-tok');
  });

  it('fetchAuthorImage requests the sized variant like fetchItemCover (token header-only)', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        method: 'POST',
        match: (u) => u.pathname === '/login',
        body: { user: { token: 'abs-tok', username: 'root' } },
      },
      {
        match: (u) => u.pathname === '/api/authors/auth-1/image',
        headers: { 'content-type': 'image/webp' },
        body: null,
      },
    ]);
    const client = new AudiobookshelfClient({ ...ABS_OPTS, fetchImpl });
    const sized = await client.fetchAuthorImage('auth-1', { width: 300, format: 'webp' });
    expect(sized.status).toBe(200);
    const imageCall = calls.find((c) => c.url.pathname === '/api/authors/auth-1/image');
    expect(imageCall?.url.search).toBe('?width=300&format=webp');
    expect(imageCall?.headers.get('authorization')).toBe('Bearer abs-tok');
    expect(calls.every((c) => !c.url.search.includes('abs-tok'))).toBe(true);
  });
});

// ADR-066 / DESIGN-038 D-02 (PLAN-051) — the collection READ extensions, fixture-shaped from the
// verified v0.9.0.2 / v2.35.1 DTOs (strip-mode zod: extra upstream fields drop, never break).
describe('collection reads (PLAN-051)', () => {
  const kavitaLogin: Route = {
    method: 'POST',
    match: (u) => u.pathname === '/api/Account/login',
    body: { token: 'jwt', apiKey: 'key' },
  };

  it('Kavita listCollections parses the AppUserCollectionDto subset and drops extras', async () => {
    const { fetchImpl, calls } = stubFetch([
      kavitaLogin,
      {
        match: (u) => u.pathname === '/api/Collection',
        body: [
          {
            id: 4,
            title: 'Harry Potter Collection',
            summary: null,
            promoted: false,
            itemCount: 7,
            coverImage: 'c4.png',
            ageRating: 0,
            source: 1,
            totalSourceCount: 0,
          },
        ],
      },
    ]);
    const client = new KavitaClient({ ...KAVITA_OPTS, fetchImpl });
    const collections = await client.listCollections();
    expect(collections).toEqual([{ id: 4, title: 'Harry Potter Collection', promoted: false, itemCount: 7 }]);
    const call = calls.find((c) => c.url.pathname === '/api/Collection');
    expect(call?.headers.get('authorization')).toBe('Bearer jwt');
  });

  it('Kavita listCollectionSeriesPage filters all-v2 by CollectionTags (field 7, Equal) + reads the Pagination total', async () => {
    const { fetchImpl, calls } = stubFetch([
      kavitaLogin,
      {
        method: 'POST',
        match: (u) => u.pathname === '/api/Series/all-v2',
        headers: { Pagination: JSON.stringify({ currentPage: 1, totalItems: 7 }) },
        body: [{ id: 501, name: 'HP Book 1', libraryId: 1 }],
      },
    ]);
    const client = new KavitaClient({ ...KAVITA_OPTS, fetchImpl });
    const page = await client.listCollectionSeriesPage(4, 1, 500);
    expect(page.total).toBe(7);
    expect(page.items[0]?.id).toBe(501);
    const call = calls.find((c) => c.url.pathname === '/api/Series/all-v2');
    // The shipped library-filter idiom, collection-flavored: field 7 = CollectionTags, Equal.
    expect(call?.body).toEqual({
      statements: [{ comparison: 0, field: 7, value: '4' }],
      combination: 1,
      limitTo: 0,
    });
  });

  it('Kavita listReadingListsPage POSTs with query pagination (the verified route shape)', async () => {
    const { fetchImpl, calls } = stubFetch([
      kavitaLogin,
      {
        method: 'POST',
        match: (u) => u.pathname === '/api/ReadingList/lists',
        headers: { Pagination: JSON.stringify({ currentPage: 1, totalItems: 2 }) },
        body: [
          { id: 11, title: 'HP Reading Order', promoted: false, itemCount: 7, startingYear: 0 },
          { id: 12, title: 'Cosmere Order', promoted: true, itemCount: 12 },
        ],
      },
    ]);
    const client = new KavitaClient({ ...KAVITA_OPTS, fetchImpl });
    const page = await client.listReadingListsPage(1, 100);
    expect(page.total).toBe(2);
    expect(page.items.map((l) => l.title)).toEqual(['HP Reading Order', 'Cosmere Order']);
    const call = calls.find((c) => c.url.pathname === '/api/ReadingList/lists');
    expect(call?.method).toBe('POST');
    expect(call?.url.searchParams.get('PageNumber')).toBe('1');
    expect(call?.url.searchParams.get('PageSize')).toBe('100');
    expect(call?.url.searchParams.get('includePromoted')).toBe('true');
  });

  it('Kavita listReadingListItems parses order + seriesId (chapter grain — the mirror dedupes)', async () => {
    const { fetchImpl } = stubFetch([
      kavitaLogin,
      {
        match: (u) => u.pathname === '/api/ReadingList/items',
        body: [
          { id: 900, order: 0, chapterId: 70, seriesId: 501, title: 'Ch 1', pagesRead: 0 },
          { id: 901, order: 1, chapterId: 71, seriesId: 501, title: 'Ch 2' },
          { id: 902, order: 2, chapterId: 80, seriesId: 502 },
        ],
      },
    ]);
    const client = new KavitaClient({ ...KAVITA_OPTS, fetchImpl });
    const items = await client.listReadingListItems(11);
    expect(items).toEqual([
      { id: 900, order: 0, seriesId: 501 },
      { id: 901, order: 1, seriesId: 501 },
      { id: 902, order: 2, seriesId: 502 },
    ]);
  });

  it('ABS listCollections parses the ordered books array (collectionBook.order ASC — verified)', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        method: 'POST',
        match: (u) => u.pathname === '/login',
        body: { user: { token: 'abs-tok', username: 'root' } },
      },
      {
        match: (u) => u.pathname === '/api/collections',
        body: {
          collections: [
            {
              id: 'col-abs-1',
              libraryId: 'lib-1',
              name: 'Discworld in Order',
              description: null,
              books: [
                { id: 'item-2', libraryId: 'lib-1', media: { metadata: { title: 'Book Two' } } },
                { id: 'item-1', libraryId: 'lib-1', media: { metadata: { title: 'Book One' } } },
              ],
              lastUpdate: 1783702399325,
              createdAt: 1783702399325,
            },
          ],
        },
      },
    ]);
    const client = new AudiobookshelfClient({ ...ABS_OPTS, fetchImpl });
    const collections = await client.listCollections();
    expect(collections).toEqual([
      {
        id: 'col-abs-1',
        libraryId: 'lib-1',
        name: 'Discworld in Order',
        // The array order is the curated order — position derives from the index.
        books: [{ id: 'item-2' }, { id: 'item-1' }],
      },
    ]);
    const call = calls.find((c) => c.url.pathname === '/api/collections');
    expect(call?.headers.get('authorization')).toBe('Bearer abs-tok');
  });
});

describe('booksReadClients factory', () => {
  it('constructs both clients from a config', () => {
    const clients = booksReadClients({ kavita: KAVITA_OPTS, audiobookshelf: ABS_OPTS });
    expect(clients.kavita).toBeInstanceOf(KavitaClient);
    expect(clients.audiobookshelf).toBeInstanceOf(AudiobookshelfClient);
  });
});
