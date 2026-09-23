// ADR-088 / ADR-089 / DESIGN-049 (PLAN-068 S3) — sanitized JSON recordings of the Watch Companion's Plex
// reads, shaped EXACTLY like the live responses captured 2026-09-23 (field names, which fields are absent
// when unwatched, numeric vs string forms) against HaynesOps and the plex.tv discover provider, with fake
// titles/guids/keys so no viewing history lands in the repo. Trimmed to the consumed fields plus a few
// unconsumed ones (Media, Image, …) to prove the schema strips them.

/** One movie of `GET /library/sections/1/all?includeGuids=1&unwatched=0` (a WATCHED movie). */
export const WATCHED_MOVIE_ITEM = {
  ratingKey: '46761',
  key: '/library/metadata/46761',
  guid: 'plex://movie/5d770000000000000000a001',
  slug: 'stub-movie',
  type: 'movie',
  title: 'Stub Movie',
  contentRating: 'PG-13',
  year: 1989,
  viewCount: 1,
  lastViewedAt: 1787710449,
  duration: 7674250,
  addedAt: 1751600000,
  Genre: [{ tag: 'Action' }, { tag: 'Crime' }],
  Guid: [{ id: 'imdb://tt0000001' }, { id: 'tmdb://1001' }, { id: 'tvdb://2001' }],
  Media: [{ id: 1, duration: 7674250 }],
  Image: [{ alt: 'Stub Movie', type: 'coverPoster', url: '/library/metadata/46761/thumb/1' }],
};

/** One movie of an `inProgress=1` page — a resume point (viewOffset ms), never finished (no viewCount). */
export const IN_PROGRESS_MOVIE_ITEM = {
  ratingKey: '46762',
  guid: 'plex://movie/5d770000000000000000a002',
  type: 'movie',
  title: 'Stub Movie Two',
  year: 2012,
  viewOffset: 1153869,
  lastViewedAt: 1787700000,
  duration: 7674250,
  Guid: [{ id: 'tmdb://1002' }],
};

/** A section page carrying both — `totalSize` is the FILTERED total. */
export const WATCHED_MOVIES_PAGE_JSON = {
  MediaContainer: { size: 1, totalSize: 310, offset: 0, Metadata: [WATCHED_MOVIE_ITEM] },
};

/** One show of `GET /library/sections/2/all?type=2&includeGuids=1` — 28 of 106 leaves watched (specials count). */
export const SHOW_ITEM = {
  ratingKey: '45668',
  guid: 'plex://show/5d9c0000000000000000b001',
  type: 'show',
  title: 'Stub Show',
  contentRating: 'TV-14',
  year: 2013,
  index: 1,
  childCount: 10,
  leafCount: 106,
  viewedLeafCount: 28,
  viewCount: 40,
  lastViewedAt: 1790137600,
  Genre: [{ tag: 'Animation' }, { tag: 'Comedy' }],
  Guid: [{ id: 'imdb://tt0000002' }, { id: 'tmdb://1003' }, { id: 'tvdb://2003' }],
};

function episode(
  ratingKey: string,
  season: number,
  index: number,
  watched?: { viewCount: number; lastViewedAt: number },
  viewOffset?: number,
) {
  return {
    ratingKey,
    key: `/library/metadata/${ratingKey}`,
    parentRatingKey: season === 0 ? '45669' : `4567${season}`,
    grandparentRatingKey: '45668',
    guid: `plex://episode/5d9c0000000000000000e${String(season).padStart(2, '0')}${String(index).padStart(2, '0')}`,
    parentGuid: `plex://season/5d9c0000000000000000c0${season}`,
    grandparentGuid: 'plex://show/5d9c0000000000000000b001',
    type: 'episode',
    title: `Stub Episode S${season}E${index}`,
    grandparentTitle: 'Stub Show',
    parentTitle: season === 0 ? 'Specials' : `Season ${season}`,
    contentRating: 'TV-14',
    index,
    parentIndex: season,
    duration: 1320000,
    ...(watched ?? {}),
    ...(viewOffset !== undefined ? { viewOffset } : {}),
  };
}

/**
 * `GET /library/metadata/45668/allLeaves` — specials first (season 0), then seasons in order. Unwatched
 * episodes carry NO viewCount/lastViewedAt (as live); one has a resume point.
 */
export const ALL_LEAVES_EPISODES = [
  episode('45700', 0, 7),
  episode('45701', 1, 1, { viewCount: 1, lastViewedAt: 1790000000 }),
  episode('45702', 1, 2, { viewCount: 2, lastViewedAt: 1790100000 }),
  episode('45703', 1, 3, undefined, 612000),
  episode('45704', 2, 1),
];

/**
 * `GET https://discover.provider.plex.tv/library/sections/watchlist/all?includeGuids=1` — the discover
 * provider's item shape: a hex DISCOVER `ratingKey`, the Plex `guid`, external `Guid[]`, a catalog `addedAt`
 * (NOT the watchlist time) and `userState: false`. No watchlist timestamp on the list.
 */
export function watchlistItem(n: number, type: 'movie' | 'show' = n % 2 === 0 ? 'movie' : 'show') {
  const hex = n.toString(16).padStart(24, '0');
  return {
    ratingKey: hex,
    key: `/library/metadata/${hex}`,
    guid: `plex://${type}/${hex}`,
    slug: `stub-watchlist-title-${n}`,
    type,
    title: `Watchlist Title ${n}`,
    year: 2000 + (n % 26),
    addedAt: 1648771200 + n,
    contentRating: type === 'show' ? 'TV-MA' : 'R',
    userState: false,
    publicPagesURL: `https://watch.plex.tv/${type}/stub-watchlist-title-${n}`,
    Guid: [{ id: `imdb://tt${String(n).padStart(7, '0')}` }, { id: `tmdb://${9000 + n}` }, { id: `tvdb://${7000 + n}` }],
  };
}
