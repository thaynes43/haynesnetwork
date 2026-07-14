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
import type { BooksSort, LibrarySortField, WatchState, BookReadState } from '@hnet/api';
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
  | 'tv:wall'
  | 'tv:season'
  | 'tv:episode'
  | 'music:wall'
  | 'peloton:wall'
  | 'peloton:episode'
  | 'youtube:wall'
  | 'youtube:episode'
  | 'books:wall'
  | 'books:grouped'
  | 'audiobooks:wall'
  | 'audiobooks:grouped'
  | 'comics:wall';

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
/** Grouped levels sort the aggregate CARDS (dimension label / member count) — client-side keys. */
const groupLevel = (e: ViewRegistryEntryOf<'author' | 'count'>) => e;
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
const releasedFacet = (label: string): RegistryFacet => ({
  key: 'released',
  label,
  kind: 'range-date',
  param: 'rfrom',
  param2: 'rto',
});

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
    ],
    azSorts: ['title'],
  }),
};

/** Look up a view level's declaration. */
export function registryFor(key: ViewLevelKey): ViewRegistryEntry {
  return LIBRARY_VIEW_REGISTRY[key];
}

// ---------------------------------------------------------------------------
// D-01 — which view SHAPES each wall offers (a build-phase D-11 call: only Books/Audiobooks offer
// an alternative shape in v1 — the design's own flat-A–Z example; every other wall's R2 shape is
// its only honest shape today, so no selector renders there).
// ---------------------------------------------------------------------------

export interface WallViewsSpec {
  /** The shapes the wall offers, in selector order (a single shape ⇒ no selector renders). */
  offers: readonly WallViewShape[];
  /** The grouped view's dimension (v1: exactly one per grouped-capable wall) + its UI copy. */
  grouped?: {
    dimension: string;
    /** Selector label for the grouped shape (e.g. "Authors"). */
    selectorLabel: string;
    /** Selector label for the flat shape (e.g. "All books"). */
    flatLabel: string;
    /** The drill-in header's back-to-groups label (e.g. "All authors"). */
    allLabel: string;
  };
}

export const WALL_VIEWS: Record<LibraryWallId, WallViewsSpec> = {
  movies: { offers: ['flat'] },
  tv: { offers: ['hierarchy'] },
  music: { offers: ['flat'] },
  peloton: { offers: ['grouped'], grouped: { dimension: 'exercise', selectorLabel: 'Exercises', flatLabel: '', allLabel: '' } },
  youtube: { offers: ['grouped'], grouped: { dimension: 'channel', selectorLabel: 'Channels', flatLabel: '', allLabel: '' } },
  books: {
    offers: ['grouped', 'flat'],
    grouped: { dimension: 'author', selectorLabel: 'Authors', flatLabel: 'All books', allLabel: 'All authors' },
  },
  audiobooks: {
    offers: ['grouped', 'flat'],
    grouped: { dimension: 'author', selectorLabel: 'Authors', flatLabel: 'All audiobooks', allLabel: 'All authors' },
  },
  comics: { offers: ['grouped'], grouped: { dimension: 'series', selectorLabel: 'Series', flatLabel: '', allLabel: '' } },
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
