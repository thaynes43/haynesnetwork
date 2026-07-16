// ADR-051 / DESIGN-026 D-02/D-03 (PLAN-029 step 2) — the LibraryViewRegistry: the per-(wall,
// view-level) DECLARATION of exactly which sort keys and filter facets each view can answer, bound
// to its backing engine (ledger / plex-live / books). This module is the ONE enforcement point of
// the Plex-style asymmetry the owner ruled on (R5 — "Episodes ≠ Shows"): the UI renders exactly
// what the active level's entry lists, nothing more, so no dead "Resolution on a Season" control
// can ship. It is also AUTHORITATIVE on valid `sort_field` keys per (wall, view-level) — the
// per-user preference store carries free text (ADR-052) and every stored/URL sort is validated
// against the active entry before use.
//
// Engine key sets are pinned at COMPILE time: ledger sorts must be `LibrarySortField`s
// (SORT_SPECS), books sorts must be `BooksSort`s (BOOKS_SORTS) — both TYPE-ONLY imports from
// @hnet/api (erased; the client bundle never pulls server code). Adding a dimension to a wall is a
// registry-row edit (+ an engine expression when it needs new data) — never a new component
// (ADR-051 C-01).
import type { BooksSort, CollectionType, LibrarySortField, WatchState, BookReadState } from '@hnet/api';
import type { LibraryWallId, WallSortDir, WallViewShape } from './library-views';

export type RegistryEngine = 'ledger' | 'plex-live' | 'books';

/**
 * The view LEVELS capability is declared for. `wall` = the tab's top level (the flat grid, or the
 * grouped walls' natural card grid); `grouped` = the aggregate-card view of a wall that also offers
 * flat; `season`/`episode` = the drill-in levels of the hierarchy/live walls. TV's Shows → Seasons →
 * Episodes PRESENTATION is deliberately unchanged (owner R2: "keep that shape") — its season/episode
 * entries document the levels' honest capability for the drill-in and pin the asymmetry tests.
 */
export type ViewLevelKey =
  | 'movies:wall'
  | 'movies:grouped-collection'
  | 'tv:wall'
  | 'tv:grouped-collection'
  | 'tv:season'
  | 'tv:episode'
  | 'music:wall'
  | 'peloton:wall'
  | 'peloton:episode'
  | 'youtube:wall'
  | 'youtube:episode'
  | 'books:wall'
  | 'books:grouped'
  | 'books:grouped-collection'
  | 'books:collection-items'
  | 'audiobooks:wall'
  | 'audiobooks:grouped'
  | 'audiobooks:grouped-genre'
  | 'audiobooks:grouped-collection'
  | 'audiobooks:collection-items'
  | 'comics:wall'
  | 'comics:grouped-collection'
  | 'comics:collection-items';

export interface RegistrySortOf<K extends string> {
  key: K;
  label: string;
  /** The direction the FIRST click gives ('desc' = best/newest-first columns). */
  firstDir: WallSortDir;
}
export type RegistrySort = RegistrySortOf<string>;

/** How a facet renders: enum checklist chip · narrowing-typeahead chip · single-select chip ·
 *  date-range chip · the bounded rating chip · length-bucket checklist chip. */
export type RegistryFacetKind = 'enum' | 'suggest' | 'select' | 'range-date' | 'range-rating' | 'buckets';

export interface RegistryFacet {
  /** Stable facet id (drives which chip implementation renders + the search-input field). */
  key: string;
  label: string;
  kind: RegistryFacetKind;
  /** The URL param the facet syncs to (ranges use `param`+`param2` for the two bounds). */
  param: string;
  param2?: string;
  /** Per-user populated-value gate (library.facetGates) — chip offered only when true (ADR-051 C-06). */
  gate?: 'watch' | 'bookProgress';
  /** Value-gated: the chip is hidden entirely when its facet VALUES come back empty (ADR-051 C-06 —
   *  e.g. ABS narrator 16% / series 3-of-823, Kavita formats on ABS walls). */
  dataGated?: boolean;
}

export interface ViewRegistryEntryOf<K extends string> {
  engine: RegistryEngine;
  /** ONLY the sort keys this view level can answer (the asymmetry enforcement point). */
  sorts: RegistrySortOf<K>[];
  /** The R6 default for this level (the resolver's wall default must be one of `sorts`). */
  defaultSort: { field: K; dir: WallSortDir };
  facets: RegistryFacet[];
  /** Sort keys eligible for the A–Z jump bar (asc, title-like — DESIGN-026 D-09). */
  azSorts: readonly K[];
}
export type ViewRegistryEntry = ViewRegistryEntryOf<string>;

// Per-engine constructors — pin each entry's keys to its engine's key union at compile time.
const ledgerLevel = (e: ViewRegistryEntryOf<LibrarySortField>) => e;
const booksLevel = (e: ViewRegistryEntryOf<BooksSort>) => e;
/** Grouped levels sort the aggregate CARDS (dimension label / member count) — client-side keys
 *  ('author' = the author-grouped label sort; 'label' = an abstract dimension's label sort). */
const groupLevel = (e: ViewRegistryEntryOf<'author' | 'label' | 'count'>) => e;
/** Plex-live keys map onto the parsed section/children fields (addedAt / title / originallyAvailableAt /
 *  index / duration — ADR-051: available "for free", no wider Plex read). */
const plexLevel = (e: ViewRegistryEntryOf<'added_at' | 'title' | 'air_date' | 'index' | 'duration'>) => e;

// The shared ledger facet rows (single definitions so param names never fork across walls).
const GENRE_FACET: RegistryFacet = { key: 'genres', label: 'Genre', kind: 'enum', param: 'genre' };
const DECADE_FACET: RegistryFacet = { key: 'decade', label: 'Decade', kind: 'enum', param: 'decade' };
const RATING_FACET: RegistryFacet = {
  key: 'rating',
  label: 'Rating',
  kind: 'range-rating',
  param: 'rmin',
  param2: 'rmax',
};
const COLLECTION_FACET: RegistryFacet = {
  key: 'sourceCollections',
  label: 'Collection',
  kind: 'enum',
  param: 'col',
};
const WATCH_FACET: RegistryFacet = {
  key: 'watch',
  label: 'Watched',
  kind: 'select',
  param: 'watch',
  gate: 'watch',
};
const READ_FACET: RegistryFacet = {
  key: 'read',
  label: 'Read',
  kind: 'select',
  param: 'read',
  gate: 'bookProgress',
};
/** ADR-057 / DESIGN-029 (PLAN-045; three-state per amendment 3, PLAN-056) — the composed-Wanted
 *  state filter on the book walls: All · Wanted only · Hide wanted (`?wanted=only|hide`, absent =
 *  All; legacy `?wanted=1` reads as only). Single-select, server-authoritative (the state rides the
 *  books.search input). Value-gated: the control renders only while the wall's `books.wanted`
 *  overlay actually holds tiles (no dead chip). */
const WANTED_FACET: RegistryFacet = {
  key: 'wanted',
  label: 'Wanted',
  kind: 'select',
  param: 'wanted',
  dataGated: true,
};
const releasedFacet = (label: string): RegistryFacet => ({
  key: 'released',
  label,
  kind: 'range-date',
  param: 'rfrom',
  param2: 'rto',
});
/** DESIGN-035 D-11 / R-214 (PLAN-053) — the Collections grouped levels' ONE facet: the Type chip
 *  row (single-select, All default, `?ctype=` replace refinement — D-19). Owner ruling: the chip
 *  FILTERS, never hides — so it is neither gated nor dataGated (a 0-count chip still renders);
 *  the server (`ledger.collectionGroups` ctype) does the card filtering. */
const COLLECTION_TYPE_FACET: RegistryFacet = {
  key: 'collectionType',
  label: 'Type',
  kind: 'select',
  param: 'ctype',
};

/**
 * DESIGN-026 D-03 — the per-wall registry CONTENTS (the live-verified strawman, ruled normative).
 * Notes on honest gaps (data the engines do not carry — a level never offers what it can't answer):
 *  • Music: no Runtime/Year/Release-Date (lidarr artists have none — live-verified year 0%).
 *  • Kavita Books/Comics: no genre/year facets (0% in the list read — Q-02 defers a per-series fetch).
 *  • TV Shows: the D-03 "Last Episode Added" rollup sort is NOT offered — the ledger carries no
 *    per-episode added dates (a Sonarr-episode sync add; deferred residual, not a registry row).
 *  • Peloton/YouTube episode Instructor/Duration-bucket facets need a wider Plex read (D-11 deferral).
 */
export const LIBRARY_VIEW_REGISTRY: Record<ViewLevelKey, ViewRegistryEntry> = {
  'movies:wall': ledgerLevel({
    engine: 'ledger',
    sorts: [
      { key: 'added_at', label: 'Added', firstDir: 'desc' },
      { key: 'released_at', label: 'Released', firstDir: 'desc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
      { key: 'year', label: 'Year', firstDir: 'desc' },
      { key: 'imdb_rating', label: 'Rating', firstDir: 'desc' },
      { key: 'runtime', label: 'Runtime', firstDir: 'desc' },
      { key: 'play_count', label: 'Plays', firstDir: 'desc' },
      { key: 'last_viewed', label: 'Watched', firstDir: 'desc' },
    ],
    defaultSort: { field: 'added_at', dir: 'desc' },
    facets: [
      GENRE_FACET,
      DECADE_FACET,
      releasedFacet('Released'),
      { key: 'resolutions', label: 'Resolution', kind: 'enum', param: 'res' },
      RATING_FACET,
      COLLECTION_FACET,
      { key: 'requesters', label: 'Requester', kind: 'enum', param: 'req' },
      WATCH_FACET,
    ],
    azSorts: ['title'],
  }),
  // ADR-064 / DESIGN-035 D-05 (PLAN-037) — the Movies Collections grouped level: sorts the aggregate
  // CARDS (collection label / accessible-member count) like every grouped level. ONE facet (PLAN-053
  // D-11): the Type chip row — the only question a collection-card grid can answer; item facets stay
  // absent (the D-09 asymmetry).
  'movies:grouped-collection': groupLevel({
    engine: 'ledger',
    sorts: [
      { key: 'label', label: 'Collection A–Z', firstDir: 'asc' },
      { key: 'count', label: 'Most items', firstDir: 'desc' },
    ],
    defaultSort: { field: 'label', dir: 'asc' },
    facets: [COLLECTION_TYPE_FACET],
    azSorts: [],
  }),
  // TV Shows — no Runtime (a show has no single runtime), no Resolution facet (nor a single tier);
  // released_at = Sonarr firstAired (D-05).
  'tv:wall': ledgerLevel({
    engine: 'ledger',
    sorts: [
      { key: 'added_at', label: 'Added', firstDir: 'desc' },
      { key: 'released_at', label: 'First aired', firstDir: 'desc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
      { key: 'year', label: 'Year', firstDir: 'desc' },
      { key: 'tmdb_rating', label: 'Rating', firstDir: 'desc' },
      { key: 'play_count', label: 'Plays', firstDir: 'desc' },
      { key: 'last_viewed', label: 'Watched', firstDir: 'desc' },
    ],
    defaultSort: { field: 'added_at', dir: 'desc' },
    facets: [GENRE_FACET, DECADE_FACET, releasedFacet('First aired'), RATING_FACET, COLLECTION_FACET, WATCH_FACET],
    azSorts: ['title'],
  }),
  // ADR-064 / DESIGN-035 D-05 (PLAN-037) — the TV Collections grouped level (same shape as the
  // Movies one, incl. the PLAN-053 Type facet; the hierarchy drill below is untouched — owner R2).
  'tv:grouped-collection': groupLevel({
    engine: 'ledger',
    sorts: [
      { key: 'label', label: 'Collection A–Z', firstDir: 'asc' },
      { key: 'count', label: 'Most items', firstDir: 'desc' },
    ],
    defaultSort: { field: 'label', dir: 'asc' },
    facets: [COLLECTION_TYPE_FACET],
    azSorts: [],
  }),
  // TV drill-in levels (capability declarations — the Shows → Seasons → Episodes presentation is
  // unchanged, owner R2). A season answers its number/added/title ONLY; an episode adds air date +
  // duration. Neither offers Resolution/Genre/Release-Date (unanswerable without a wider Plex read).
  'tv:season': plexLevel({
    engine: 'plex-live',
    sorts: [
      { key: 'index', label: 'Season #', firstDir: 'asc' },
      { key: 'added_at', label: 'Added', firstDir: 'desc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
    ],
    defaultSort: { field: 'index', dir: 'asc' },
    facets: [],
    azSorts: [],
  }),
  'tv:episode': plexLevel({
    engine: 'plex-live',
    sorts: [
      { key: 'index', label: 'Episode #', firstDir: 'asc' },
      { key: 'air_date', label: 'Air date', firstDir: 'desc' },
      { key: 'added_at', label: 'Added', firstDir: 'desc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
      { key: 'duration', label: 'Duration', firstDir: 'desc' },
    ],
    defaultSort: { field: 'index', dir: 'asc' },
    facets: [],
    azSorts: [],
  }),
  // Music Artists — no Runtime/Year/Release-Date (artists have none; live-verified lidarr year 0%),
  // no Resolution/Requester. Genre + Collection only (D-03).
  'music:wall': ledgerLevel({
    engine: 'ledger',
    sorts: [
      { key: 'added_at', label: 'Added', firstDir: 'desc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
      { key: 'play_count', label: 'Plays', firstDir: 'desc' },
      { key: 'last_viewed', label: 'Played', firstDir: 'desc' },
    ],
    defaultSort: { field: 'added_at', dir: 'desc' },
    facets: [GENRE_FACET, COLLECTION_FACET],
    azSorts: ['title'],
  }),
  // Peloton — the wall IS the grouped-by-Exercise view (each Plex show is a discipline; R2 default).
  // A discipline card answers title/added only; the classes' dates/durations live at episode level.
  'peloton:wall': plexLevel({
    engine: 'plex-live',
    sorts: [
      { key: 'added_at', label: 'Recently added', firstDir: 'desc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
    ],
    defaultSort: { field: 'added_at', dir: 'desc' },
    facets: [],
    azSorts: [],
  }),
  'peloton:episode': plexLevel({
    engine: 'plex-live',
    sorts: [
      { key: 'index', label: 'Class #', firstDir: 'asc' },
      { key: 'air_date', label: 'Class date', firstDir: 'desc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
      { key: 'duration', label: 'Duration', firstDir: 'desc' },
    ],
    defaultSort: { field: 'index', dir: 'asc' },
    facets: [],
    azSorts: [],
  }),
  // YouTube — the wall IS the grouped-by-Channel view (each Plex show is a channel; R2 default).
  'youtube:wall': plexLevel({
    engine: 'plex-live',
    sorts: [
      { key: 'added_at', label: 'Recently added', firstDir: 'desc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
    ],
    defaultSort: { field: 'added_at', dir: 'desc' },
    facets: [],
    azSorts: [],
  }),
  'youtube:episode': plexLevel({
    engine: 'plex-live',
    sorts: [
      { key: 'index', label: 'Video #', firstDir: 'asc' },
      { key: 'air_date', label: 'Upload date', firstDir: 'desc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
      { key: 'duration', label: 'Duration', firstDir: 'desc' },
    ],
    defaultSort: { field: 'index', dir: 'asc' },
    facets: [],
    azSorts: [],
  }),
  // Books (Kavita EBooks) — flat level. No genre/year (Kavita's list read carries none — honest gap);
  // author/format/page-length facets, title/author A–Z jumps.
  'books:wall': booksLevel({
    engine: 'books',
    sorts: [
      { key: 'title', label: 'Title', firstDir: 'asc' },
      { key: 'author', label: 'Author', firstDir: 'asc' },
      { key: 'added', label: 'Added', firstDir: 'desc' },
      { key: 'pages', label: 'Pages', firstDir: 'desc' },
    ],
    defaultSort: { field: 'title', dir: 'asc' },
    facets: [
      { key: 'authors', label: 'Author', kind: 'suggest', param: 'author', dataGated: true },
      { key: 'formats', label: 'Format', kind: 'enum', param: 'fmt', dataGated: true },
      { key: 'lengths', label: 'Pages', kind: 'buckets', param: 'len' },
      WANTED_FACET,
    ],
    azSorts: ['title', 'author'],
  }),
  'books:grouped': groupLevel({
    engine: 'books',
    sorts: [
      { key: 'author', label: 'Author A–Z', firstDir: 'asc' },
      { key: 'count', label: 'Most books', firstDir: 'desc' },
    ],
    defaultSort: { field: 'author', dir: 'asc' },
    facets: [],
    azSorts: [],
  }),
  // ADR-066 / DESIGN-038 D-07 (PLAN-051) — the books Collections grouped level: sorts the aggregate
  // CARDS (label/count) like every grouped level. NO facets (the PLAN-053 Type classifier is
  // movie-estate-specific — an honest gap, not an omission); no A–Z rail.
  'books:grouped-collection': groupLevel({
    engine: 'books',
    sorts: [
      { key: 'label', label: 'Collection A–Z', firstDir: 'asc' },
      { key: 'count', label: 'Most items', firstDir: 'desc' },
    ],
    defaultSort: { field: 'label', dir: 'asc' },
    facets: [],
    azSorts: [],
  }),
  // DESIGN-038 D-06/D-07 — the DRILLED collection grid: the wall's own sorts + 'position' ("List
  // order" — the reading-order payoff, asc-first, the level DEFAULT). The client narrows honestly:
  // an UNORDERED collection's drill drops the position sort and falls back to the wall default
  // (the `ordered` flag is the data-honesty gate — the dataGated idiom applied to a sort). Facets =
  // the wall's minus `wanted` (a want is not a collection member).
  'books:collection-items': booksLevel({
    engine: 'books',
    sorts: [
      { key: 'position', label: 'List order', firstDir: 'asc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
      { key: 'author', label: 'Author', firstDir: 'asc' },
      { key: 'added', label: 'Added', firstDir: 'desc' },
      { key: 'pages', label: 'Pages', firstDir: 'desc' },
    ],
    defaultSort: { field: 'position', dir: 'asc' },
    facets: [
      { key: 'authors', label: 'Author', kind: 'suggest', param: 'author', dataGated: true },
      { key: 'formats', label: 'Format', kind: 'enum', param: 'fmt', dataGated: true },
      { key: 'lengths', label: 'Pages', kind: 'buckets', param: 'len' },
    ],
    azSorts: ['title', 'author'],
  }),
  // Audiobooks (ABS) — the richest book registry (R8 "all"): genre/author/narrator/series/language
  // facets (narrator + series + language populated-value-gated — live-verified sparse), duration
  // length buckets, Year sort (ABS publishedYear), per-user Read facet (ADR-053, gated).
  'audiobooks:wall': booksLevel({
    engine: 'books',
    sorts: [
      { key: 'title', label: 'Title', firstDir: 'asc' },
      { key: 'author', label: 'Author', firstDir: 'asc' },
      { key: 'year', label: 'Year', firstDir: 'desc' },
      { key: 'duration', label: 'Length', firstDir: 'desc' },
      { key: 'added', label: 'Added', firstDir: 'desc' },
    ],
    defaultSort: { field: 'title', dir: 'asc' },
    facets: [
      { key: 'genres', label: 'Genre', kind: 'enum', param: 'genre', dataGated: true },
      { key: 'authors', label: 'Author', kind: 'suggest', param: 'author', dataGated: true },
      { key: 'narrators', label: 'Narrator', kind: 'suggest', param: 'narr', dataGated: true },
      { key: 'series', label: 'Series', kind: 'suggest', param: 'ser', dataGated: true },
      { key: 'languages', label: 'Language', kind: 'enum', param: 'lang', dataGated: true },
      { key: 'lengths', label: 'Length', kind: 'buckets', param: 'len' },
      READ_FACET,
      WANTED_FACET,
    ],
    azSorts: ['title', 'author'],
  }),
  'audiobooks:grouped': groupLevel({
    engine: 'books',
    sorts: [
      { key: 'author', label: 'Author A–Z', firstDir: 'asc' },
      { key: 'count', label: 'Most audiobooks', firstDir: 'desc' },
    ],
    defaultSort: { field: 'author', dir: 'asc' },
    facets: [],
    azSorts: [],
  }),
  // Audiobooks grouped by GENRE (group-card-art pass — the first abstract grouping dimension;
  // ABS genres live-verified 91% populated). Cards are designed glyph tiles (never fake art);
  // the level sorts its cards (label/count) like every grouped level.
  'audiobooks:grouped-genre': groupLevel({
    engine: 'books',
    sorts: [
      { key: 'label', label: 'Genre A–Z', firstDir: 'asc' },
      { key: 'count', label: 'Most audiobooks', firstDir: 'desc' },
    ],
    defaultSort: { field: 'label', dir: 'asc' },
    facets: [],
    azSorts: [],
  }),
  // ADR-066 / DESIGN-038 D-07 (PLAN-051) — the Audiobooks Collections grouped + drilled levels
  // (same contract as the books ones; the drill keeps the ABS item facets minus `wanted`).
  'audiobooks:grouped-collection': groupLevel({
    engine: 'books',
    sorts: [
      { key: 'label', label: 'Collection A–Z', firstDir: 'asc' },
      { key: 'count', label: 'Most items', firstDir: 'desc' },
    ],
    defaultSort: { field: 'label', dir: 'asc' },
    facets: [],
    azSorts: [],
  }),
  'audiobooks:collection-items': booksLevel({
    engine: 'books',
    sorts: [
      { key: 'position', label: 'List order', firstDir: 'asc' },
      { key: 'title', label: 'Title', firstDir: 'asc' },
      { key: 'author', label: 'Author', firstDir: 'asc' },
      { key: 'year', label: 'Year', firstDir: 'desc' },
      { key: 'duration', label: 'Length', firstDir: 'desc' },
      { key: 'added', label: 'Added', firstDir: 'desc' },
    ],
    defaultSort: { field: 'position', dir: 'asc' },
    facets: [
      { key: 'genres', label: 'Genre', kind: 'enum', param: 'genre', dataGated: true },
      { key: 'authors', label: 'Author', kind: 'suggest', param: 'author', dataGated: true },
      { key: 'narrators', label: 'Narrator', kind: 'suggest', param: 'narr', dataGated: true },
      { key: 'series', label: 'Series', kind: 'suggest', param: 'ser', dataGated: true },
      { key: 'languages', label: 'Language', kind: 'enum', param: 'lang', dataGated: true },
      { key: 'lengths', label: 'Length', kind: 'buckets', param: 'len' },
      READ_FACET,
    ],
    azSorts: ['title', 'author'],
  }),
  // Comics (Kavita) — the wall IS the grouped-by-Series view (a Kavita row IS a series, so the item
  // grid is the series grid; R2 default). Series A–Z rides sort_title; format/page facets only.
  'comics:wall': booksLevel({
    engine: 'books',
    sorts: [
      { key: 'title', label: 'Series', firstDir: 'asc' },
      { key: 'added', label: 'Added', firstDir: 'desc' },
      { key: 'pages', label: 'Pages', firstDir: 'desc' },
    ],
    defaultSort: { field: 'title', dir: 'asc' },
    facets: [
      { key: 'formats', label: 'Format', kind: 'enum', param: 'fmt', dataGated: true },
      { key: 'lengths', label: 'Pages', kind: 'buckets', param: 'len' },
      WANTED_FACET,
    ],
    azSorts: ['title'],
  }),
  // ADR-066 / DESIGN-038 D-07 (PLAN-051) — the Comics Collections grouped + drilled levels. The
  // wall itself stays the grouped-by-Series item grid (no level); Collections is its first
  // aggregate-card SIBLING dimension.
  'comics:grouped-collection': groupLevel({
    engine: 'books',
    sorts: [
      { key: 'label', label: 'Collection A–Z', firstDir: 'asc' },
      { key: 'count', label: 'Most items', firstDir: 'desc' },
    ],
    defaultSort: { field: 'label', dir: 'asc' },
    facets: [],
    azSorts: [],
  }),
  'comics:collection-items': booksLevel({
    engine: 'books',
    sorts: [
      { key: 'position', label: 'List order', firstDir: 'asc' },
      { key: 'title', label: 'Series', firstDir: 'asc' },
      { key: 'added', label: 'Added', firstDir: 'desc' },
      { key: 'pages', label: 'Pages', firstDir: 'desc' },
    ],
    defaultSort: { field: 'position', dir: 'asc' },
    facets: [
      { key: 'formats', label: 'Format', kind: 'enum', param: 'fmt', dataGated: true },
      { key: 'lengths', label: 'Pages', kind: 'buckets', param: 'len' },
    ],
    azSorts: ['title'],
  }),
};

/** Look up a view level's declaration. */
export function registryFor(key: ViewLevelKey): ViewRegistryEntry {
  return LIBRARY_VIEW_REGISTRY[key];
}

// ---------------------------------------------------------------------------
// D-01 — which view SHAPES (and grouping DIMENSIONS) each wall offers. Books/Audiobooks offer a
// flat alternative; Audiobooks additionally offers the Genre grouping (the group-card-art pass —
// the first abstract dimension; Kavita walls can't: genres 0% in the list read). Every other
// wall's R2 shape is its only honest shape today, so no selector renders there.
// ---------------------------------------------------------------------------

/** D-04 (art-amended) — what an aggregate card's ART SLOT renders for a grouping dimension:
 *  'covers' = the real-imagery ladder (dimension portrait where the source holds one → member
 *  cover fan → KindIcon); 'glyph' = the designed token-themed glyph tile (abstract dimensions —
 *  NEVER fake art). */
export type WallGroupingArt = 'covers' | 'glyph';

export interface WallGrouping {
  /** The grouping dimension key (`?by=` / the stored ADR-052 groupBy). */
  dimension: string;
  /** Selector label for this grouping (e.g. "Authors", "Genres"). */
  selectorLabel: string;
  /** The drill-in header's back-to-groups label (e.g. "All authors"). */
  allLabel: string;
  /** What the aggregate card's art slot renders (D-04). */
  art: WallGroupingArt;
  /** The registry level whose sorts drive the grouped CARDS (aggregate-card walls only). */
  level?: ViewLevelKey;
}

export interface WallViewsSpec {
  /** The shapes the wall offers, in selector order (a single shape ⇒ no selector renders). */
  offers: readonly WallViewShape[];
  /** The grouped shape's dimensions, in selector order (first = the wall's default dimension). */
  groupings?: readonly WallGrouping[];
  /** Selector label for the flat shape (multi-shape walls only — e.g. "All books"). */
  flatLabel?: string;
}

export const WALL_VIEWS: Record<LibraryWallId, WallViewsSpec> = {
  // ADR-064 / DESIGN-035 D-05 (PLAN-037) — Movies/TV gain the opt-in Collections grouping (mirrored
  // Plex collections, cover-fan cards). The DEFAULT shapes are unchanged (flat / hierarchy —
  // WALL_VIEW_DEFAULTS untouched); the selector renders now that the walls offer two shapes.
  movies: {
    offers: ['flat', 'grouped'],
    groupings: [
      {
        dimension: 'collection',
        selectorLabel: 'Collections',
        allLabel: 'All collections',
        art: 'covers',
        level: 'movies:grouped-collection',
      },
    ],
    flatLabel: 'All movies',
  },
  tv: {
    offers: ['hierarchy', 'grouped'],
    groupings: [
      {
        dimension: 'collection',
        selectorLabel: 'Collections',
        allLabel: 'All collections',
        art: 'covers',
        level: 'tv:grouped-collection',
      },
    ],
    flatLabel: 'All shows',
  },
  music: { offers: ['flat'] },
  // Peloton/YouTube walls ARE their grouped views: each card is a Plex show (discipline/channel)
  // whose REAL poster streams through /api/ytdlsub/poster (ADR-041; Peloton art is the PLAN-024
  // durable poster guard) — the D-04 art answer for these dimensions needs no aggregate machinery.
  peloton: {
    offers: ['grouped'],
    groupings: [{ dimension: 'exercise', selectorLabel: 'Exercises', allLabel: '', art: 'covers' }],
  },
  youtube: {
    offers: ['grouped'],
    groupings: [{ dimension: 'channel', selectorLabel: 'Channels', allLabel: '', art: 'covers' }],
  },
  // ADR-066 / DESIGN-038 D-07 (PLAN-051) — the three book walls gain the `collection` grouping as a
  // SIBLING dimension (mirrored Kavita/ABS collections + reading lists; cover-fan cards). The
  // DEFAULT shapes/dimensions are unchanged (WALL_VIEW_DEFAULTS untouched) — Collections is opt-in
  // via the selector / `?view=grouped&by=collection`.
  books: {
    offers: ['grouped', 'flat'],
    groupings: [
      { dimension: 'author', selectorLabel: 'Authors', allLabel: 'All authors', art: 'covers', level: 'books:grouped' },
      { dimension: 'collection', selectorLabel: 'Collections', allLabel: 'All collections', art: 'covers', level: 'books:grouped-collection' },
    ],
    flatLabel: 'All books',
  },
  audiobooks: {
    offers: ['grouped', 'flat'],
    groupings: [
      { dimension: 'author', selectorLabel: 'Authors', allLabel: 'All authors', art: 'covers', level: 'audiobooks:grouped' },
      { dimension: 'genre', selectorLabel: 'Genres', allLabel: 'All genres', art: 'glyph', level: 'audiobooks:grouped-genre' },
      { dimension: 'collection', selectorLabel: 'Collections', allLabel: 'All collections', art: 'covers', level: 'audiobooks:grouped-collection' },
    ],
    flatLabel: 'All audiobooks',
  },
  // Comics' Series grouping IS the wall — each tile is a Kavita series wearing its REAL series
  // cover through /api/books/cover (the D-04 art answer for the Series dimension). PLAN-051 adds
  // Collections as its first aggregate-card sibling (the wall gains a selector WITHOUT gaining a
  // flat shape — the D-07 selector rule).
  comics: {
    offers: ['grouped'],
    groupings: [
      { dimension: 'series', selectorLabel: 'Series', allLabel: '', art: 'covers' },
      { dimension: 'collection', selectorLabel: 'Collections', allLabel: 'All collections', art: 'covers', level: 'comics:grouped-collection' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Facet option vocabularies (typed against the engine unions — TYPE-ONLY imports).
// ---------------------------------------------------------------------------

/** The per-user watch-state options (ADR-053; single-select — the wire takes ONE state). */
export const WATCH_STATE_OPTIONS: ReadonlyArray<{ value: WatchState; label: string }> = [
  { value: 'watched', label: 'Watched' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'unwatched', label: 'Unwatched' },
];

/** The per-user ABS read-state options (ADR-053; Audiobooks only — Kavita deferred). */
export const READ_STATE_OPTIONS: ReadonlyArray<{ value: BookReadState; label: string }> = [
  { value: 'read', label: 'Finished' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'unread', label: 'Unread' },
];

/** DESIGN-035 D-10/D-11 / R-214 (PLAN-053) — the six owner-ruled Collection Type chips, in chip-row
 *  order (the URL/wire values are the `@hnet/db` COLLECTION_TYPES buckets — TYPE-pinned here so a
 *  drifted value fails the build; the All chip is the absent-param default and lives in the row
 *  renderer, not this vocabulary). */
export const COLLECTION_TYPE_OPTIONS: ReadonlyArray<{ value: CollectionType; label: string }> = [
  { value: 'trilogy', label: 'Trilogies' },
  { value: 'franchise_universe', label: 'Franchise & Universe' },
  { value: 'director', label: 'Director' },
  { value: 'actor', label: 'Actor' },
  { value: 'list', label: 'Lists' },
  { value: 'other', label: 'Other' },
];

/** Length-bucket labels per medium (boundaries live server-side — BOOK_LENGTH_BOUNDS; D-11 call:
 *  <6 h · 6–12 h · >12 h for audiobook runtime, <200 · 200–400 · >400 for Kavita pages). */
export const LENGTH_BUCKET_OPTIONS: Record<
  'duration' | 'pages',
  ReadonlyArray<{ value: 'short' | 'medium' | 'long'; label: string }>
> = {
  duration: [
    { value: 'short', label: 'Under 6 h' },
    { value: 'medium', label: '6–12 h' },
    { value: 'long', label: 'Over 12 h' },
  ],
  pages: [
    { value: 'short', label: 'Under 200 pages' },
    { value: 'medium', label: '200–400 pages' },
    { value: 'long', label: 'Over 400 pages' },
  ],
};

/** '1990' → '1990s' (the Decade chip's display map). */
export function decadeLabel(value: string): string {
  return `${value}s`;
}
