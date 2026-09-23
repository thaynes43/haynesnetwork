// ADR-088 / ADR-089 / DESIGN-049 (PLAN-068 S3) — the Watch Companion's Plex READS, offline against the
// sanitized 2026-09-23 recordings in __fixtures__/watch.ts: the optional watch fields on section items,
// the filtered section page, allLeaves paging, the guid lookup, and the plex.tv discover watchlist.
import { describe, expect, it } from 'vitest';
import {
  ALL_LEAVES_PAGE_SIZE,
  MAX_ALL_LEAVES_PAGES,
  PlexReadClient,
  WATCHLIST_PAGE_SIZE,
} from '../src/read';
import { PLEX_DISCOVER_BASE_URL } from '../src/config';
import { sectionItemSchema } from '../src/schemas';
import { plexStub, TEST_CLIENT_OPTIONS } from './helpers';
import {
  ALL_LEAVES_EPISODES,
  IN_PROGRESS_MOVIE_ITEM,
  SHOW_ITEM,
  WATCHED_MOVIE_ITEM,
  WATCHED_MOVIES_PAGE_JSON,
  watchlistItem,
} from '../__fixtures__/watch';

function client(stub: ReturnType<typeof plexStub>, extra: Record<string, unknown> = {}): PlexReadClient {
  return new PlexReadClient({ ...TEST_CLIENT_OPTIONS, ...extra, fetchImpl: stub.fetchImpl });
}

/** Serve `items` as X-Plex-Container pages, honoring Start/Size and reporting `totalSize` (or not). */
function pagedBody(items: unknown[], opts: { totalSize?: boolean } = {}) {
  return (url: URL) => {
    const start = Number(url.searchParams.get('X-Plex-Container-Start') ?? 0);
    const size = Number(url.searchParams.get('X-Plex-Container-Size') ?? items.length);
    const Metadata = items.slice(start, start + size);
    return {
      MediaContainer: {
        size: Metadata.length,
        offset: start,
        ...(opts.totalSize === false ? {} : { totalSize: items.length }),
        Metadata,
      },
    };
  };
}

describe('sectionItemSchema — the optional watch fields', () => {
  it('parses a watched movie: viewCount, lastViewedAt, Genre, contentRating (numbers coerced)', () => {
    const item = sectionItemSchema.parse({ ...WATCHED_MOVIE_ITEM, viewCount: '1', lastViewedAt: '1787710449' });
    expect(item).toMatchObject({
      ratingKey: '46761',
      type: 'movie',
      viewCount: 1,
      lastViewedAt: 1787710449,
      contentRating: 'PG-13',
      Genre: [{ tag: 'Action' }, { tag: 'Crime' }],
    });
    expect(item).not.toHaveProperty('Media'); // the ACL strips unconsumed structure
    expect(item).not.toHaveProperty('slug');
  });

  it('parses a show (viewedLeafCount) and an episode (parentIndex, parent/grandparent keys + guid + title)', () => {
    expect(sectionItemSchema.parse(SHOW_ITEM)).toMatchObject({ leafCount: 106, viewedLeafCount: 28, childCount: 10 });
    const ep = sectionItemSchema.parse({ ...ALL_LEAVES_EPISODES[1], parentRatingKey: 45671, grandparentRatingKey: 45668 });
    expect(ep).toMatchObject({
      index: 1,
      parentIndex: 1,
      parentRatingKey: '45671', // numbers coerced to string keys, like ratingKey
      grandparentRatingKey: '45668',
      grandparentTitle: 'Stub Show',
      grandparentGuid: 'plex://show/5d9c0000000000000000b001',
      viewCount: 1,
    });
    expect(sectionItemSchema.parse(IN_PROGRESS_MOVIE_ITEM).viewOffset).toBe(1153869);
  });

  it('an item WITHOUT them parses exactly as before: the new keys stay absent (no defaults)', () => {
    const item = sectionItemSchema.parse({ ratingKey: 9001, type: 'show', title: 'Bike Bootcamp' });
    for (const k of [
      'viewCount',
      'viewedLeafCount',
      'lastViewedAt',
      'viewOffset',
      'Genre',
      'contentRating',
      'parentIndex',
      'parentRatingKey',
      'grandparentRatingKey',
      'grandparentTitle',
      'grandparentGuid',
    ]) {
      expect(item, k).not.toHaveProperty(k);
    }
    expect(item).toEqual({ ratingKey: '9001', type: 'show', title: 'Bike Bootcamp', Guid: [], Label: [] });
  });
});

describe('listSectionContentsPage — the D-09 filters', () => {
  it('unwatched:false ⇒ unwatched=0 (the watched listing) and type; totalSize is the filtered total', async () => {
    const stub = plexStub([{ path: '/library/sections/1/all', body: WATCHED_MOVIES_PAGE_JSON }]);
    const page = await client(stub).listSectionContentsPage('1', { start: 0, size: 200, type: 1, unwatched: false });
    const q = stub.calls[0]!.url.searchParams;
    expect(q.get('unwatched')).toBe('0');
    expect(q.get('type')).toBe('1');
    expect(q.get('includeGuids')).toBe('1');
    expect(q.has('inProgress')).toBe(false);
    expect(page.totalSize).toBe(310);
    expect(page.items[0]).toMatchObject({ viewCount: 1, Genre: [{ tag: 'Action' }, { tag: 'Crime' }] });
  });

  it('inProgress:true ⇒ inProgress=1; unwatched:true ⇒ unwatched=1', async () => {
    const stub = plexStub([{ path: '/library/sections/1/all', body: { MediaContainer: { totalSize: 1, Metadata: [IN_PROGRESS_MOVIE_ITEM] } } }]);
    await client(stub).listSectionContentsPage('1', { start: 0, size: 50, inProgress: true });
    await client(stub).listSectionContentsPage('1', { start: 0, size: 50, unwatched: true, inProgress: false });
    expect(stub.calls[0]!.url.searchParams.get('inProgress')).toBe('1');
    expect(stub.calls[1]!.url.searchParams.get('unwatched')).toBe('1');
    expect(stub.calls[1]!.url.searchParams.has('inProgress')).toBe(false); // false is "no filter"
  });

  it('no filters ⇒ the pre-existing plex-match query, byte for byte', async () => {
    const stub = plexStub([{ path: '/library/sections/1/all', body: WATCHED_MOVIES_PAGE_JSON }]);
    await client(stub).listSectionContentsPage('1', { start: 400, size: 200 });
    expect(stub.calls[0]!.url.search).toBe('?X-Plex-Container-Start=400&X-Plex-Container-Size=200&includeGuids=1');
  });
});

describe('listAllLeaves — every episode, paged to completion', () => {
  it('pages Start/Size until totalSize and keeps specials + the per-episode watch state', async () => {
    const stub = plexStub([{ path: '/library/metadata/45668/allLeaves', body: pagedBody(ALL_LEAVES_EPISODES) }]);
    const listing = await client(stub).listAllLeaves('45668', { pageSize: 2 });
    expect(stub.calls.map((c) => c.url.searchParams.get('X-Plex-Container-Start'))).toEqual(['0', '2', '4']);
    expect(listing.truncated).toBe(false);
    expect(listing.totalSize).toBe(5);
    expect(listing.items.map((e) => `S${e.parentIndex}E${e.index}:${e.viewCount ?? 0}`)).toEqual([
      'S0E7:0',
      'S1E1:1',
      'S1E2:2',
      'S1E3:0',
      'S2E1:0',
    ]);
    expect(listing.items[3]!.viewOffset).toBe(612000); // the resume point survives
    expect(stub.calls[0]!.headers['X-Plex-Token']).toBe('owner-secret-token');
    expect(stub.calls[0]!.url.toString()).not.toContain('owner-secret-token');
  });

  it('defaults to ALL_LEAVES_PAGE_SIZE; without totalSize a short page ends it', async () => {
    const stub = plexStub([
      { path: '/library/metadata/1/allLeaves', body: pagedBody(ALL_LEAVES_EPISODES, { totalSize: false }) },
    ]);
    const listing = await client(stub).listAllLeaves('1');
    expect(stub.calls[0]!.url.searchParams.get('X-Plex-Container-Size')).toBe(String(ALL_LEAVES_PAGE_SIZE));
    expect(listing).toMatchObject({ totalSize: null, truncated: false });
    expect(listing.items).toHaveLength(5);
  });

  it('is TRUNCATED at the page cap or when a page contradicts totalSize', async () => {
    const capped = plexStub([
      { path: '/library/metadata/2/allLeaves', body: pagedBody(ALL_LEAVES_EPISODES) },
    ]);
    const partial = await client(capped).listAllLeaves('2', { pageSize: 1, maxPages: 2 });
    expect(partial).toMatchObject({ truncated: true, totalSize: 5 });
    expect(partial.items).toHaveLength(2);

    const liar = plexStub([
      { path: '/library/metadata/3/allLeaves', body: { MediaContainer: { size: 0, totalSize: 40, Metadata: [] } } },
    ]);
    expect(await client(liar).listAllLeaves('3')).toMatchObject({ items: [], totalSize: 40, truncated: true });
    expect(MAX_ALL_LEAVES_PAGES).toBeGreaterThan(1);
  });
});

describe('findByGuid — /library/all?guid=', () => {
  it('queries the guid (with includeGuids) and returns the server items carrying it', async () => {
    const stub = plexStub([{ path: '/library/all', body: { MediaContainer: { size: 1, Metadata: [WATCHED_MOVIE_ITEM] } } }]);
    const items = await client(stub).findByGuid(' plex://movie/5d770000000000000000a001 ');
    const q = stub.calls[0]!.url.searchParams;
    expect(q.get('guid')).toBe('plex://movie/5d770000000000000000a001');
    expect(q.get('includeGuids')).toBe('1');
    expect(items.map((i) => i.ratingKey)).toEqual(['46761']);
  });

  it('a blank guid answers [] without a request; no match is an empty list', async () => {
    const stub = plexStub([{ path: '/library/all', body: { MediaContainer: { size: 0 } } }]);
    expect(await client(stub).findByGuid('  ')).toEqual([]);
    expect(stub.calls).toHaveLength(0);
    expect(await client(stub).findByGuid('plex://show/none')).toEqual([]);
  });
});

describe('getWatchlist — the plex.tv discover provider', () => {
  const titles = Array.from({ length: 151 }, (_, i) => watchlistItem(i + 1));

  it('pages the discover watchlist at 100 (the provider cap) with the owner token in the header', async () => {
    const stub = plexStub([{ path: '/library/sections/watchlist/all', body: pagedBody(titles) }]);
    const listing = await client(stub).getWatchlist();
    expect(stub.calls).toHaveLength(2);
    const first = stub.calls[0]!;
    expect(first.url.origin).toBe(PLEX_DISCOVER_BASE_URL);
    expect(first.url.searchParams.get('X-Plex-Container-Size')).toBe(String(WATCHLIST_PAGE_SIZE));
    expect(first.url.searchParams.get('includeGuids')).toBe('1');
    expect(first.url.searchParams.get('sort')).toBe('watchlistedAt:desc');
    expect(stub.calls[1]!.url.searchParams.get('X-Plex-Container-Start')).toBe('100');
    expect(first.headers['X-Plex-Token']).toBe('owner-secret-token');
    expect(first.url.toString()).not.toContain('owner-secret-token');
    expect(listing).toMatchObject({ totalSize: 151, truncated: false });
    expect(listing.items).toHaveLength(151);
    expect(listing.items[0]).toMatchObject({
      type: 'show',
      guid: expect.stringMatching(/^plex:\/\/show\//),
      Guid: [{ id: 'imdb://tt0000001' }, { id: 'tmdb://9001' }, { id: 'tvdb://7001' }],
    });
    expect(listing.items[0]).not.toHaveProperty('userState');
  });

  it('never asks for more than 100 per page, and honors a configured discover base URL', async () => {
    const stub = plexStub([{ path: '/library/sections/watchlist/all', body: pagedBody(titles.slice(0, 3)) }]);
    await client(stub, { plexDiscoverBaseUrl: 'http://stub-discover.test:9/' }).getWatchlist({ pageSize: 500 });
    expect(stub.calls[0]!.url.origin).toBe('http://stub-discover.test:9');
    expect(stub.calls[0]!.url.searchParams.get('X-Plex-Container-Size')).toBe('100');
  });
});
