// ADR-072 / DESIGN-043 (PLAN-052 PR4a) — pure, client-safe helpers for the first-class /collections
// page: the ratified nav label, the media-type sub-nav, and the Libretto builder labels. Client
// components never import the server packages, so the enum literals MIRROR @hnet/db (the lib/bulletin.ts
// convention — keep in lockstep with COLLECTION_MEDIA_TYPES / COLLECTION_BUILDER_TYPES / COLLECTION_SYNC_MODES).

/**
 * The ratified top-nav label for the collection manager (route `/collections`) — the PORTAL_NAME /
 * HELPDESK_NAME idiom (DESIGN-004 D-22): the nav entry, page heading, and back-link copy read from
 * this ONE constant so they can never drift.
 */
export const COLLECTIONS_NAME = 'Collections';

/** The collection media types (mirrors @hnet/db COLLECTION_MEDIA_TYPES). */
export const COLLECTION_MEDIA_TYPE_NAMES = ['movies', 'tv', 'books', 'audiobooks'] as const;
export type CollectionMediaTypeName = (typeof COLLECTION_MEDIA_TYPE_NAMES)[number];

/** Human labels for the media-type sub-sections. */
export const COLLECTION_MEDIA_TYPE_LABELS: Record<CollectionMediaTypeName, string> = {
  movies: 'Movies',
  tv: 'TV',
  books: 'Books',
  audiobooks: 'Audiobooks',
};

/** The Libretto (Books/Audiobooks) builder types (mirrors @hnet/db LIBRETTO_BUILDER_TYPES). */
export const LIBRETTO_BUILDER_TYPE_NAMES = [
  'static_ids',
  'hardcover_series',
  'nyt_list',
  'wikidata_award',
] as const;

/**
 * The Kometa (Movies/TV) member-suggestible builder types (mirrors @hnet/db KOMETA_BUILDER_TYPES —
 * ADR-072 / DESIGN-042 D-04, PLAN-052 PR4b). Exactly the six single-validated-ref builders.
 */
export const KOMETA_BUILDER_TYPE_NAMES = [
  'imdb_list',
  'tmdb_collection_details',
  'tvdb_list_details',
  'tmdb_movie',
  'tmdb_show',
  'tvdb_show',
] as const;

/** The full builder vocabulary the composer picker + row badge span (both providers). */
export const COLLECTION_BUILDER_TYPE_NAMES = [
  ...LIBRETTO_BUILDER_TYPE_NAMES,
  ...KOMETA_BUILDER_TYPE_NAMES,
] as const;
export type CollectionBuilderTypeName = (typeof COLLECTION_BUILDER_TYPE_NAMES)[number];

/** Short badge/label copy per builder type (the composer picker + the row badge share these). */
export const COLLECTION_BUILDER_LABELS: Record<CollectionBuilderTypeName, string> = {
  static_ids: 'ID list',
  hardcover_series: 'Hardcover series',
  nyt_list: 'NYT list',
  wikidata_award: 'Award',
  imdb_list: 'IMDb list',
  tmdb_collection_details: 'TMDb collection',
  tvdb_list_details: 'TVDb list',
  tmdb_movie: 'TMDb movie ids',
  tmdb_show: 'TMDb show ids',
  tvdb_show: 'TVDb show ids',
};

/** The Libretto composer builder options (order chosen for the common case first). */
export const LIBRETTO_BUILDER_OPTIONS: ReadonlyArray<{
  value: CollectionBuilderTypeName;
  label: string;
}> = [
  { value: 'hardcover_series', label: 'Hardcover series' },
  { value: 'nyt_list', label: 'NYT list' },
  { value: 'wikidata_award', label: 'Award (Wikidata)' },
  { value: 'static_ids', label: 'ID list' },
];

/** The Kometa (Movies/TV) composer builder options. */
export const KOMETA_BUILDER_OPTIONS: ReadonlyArray<{
  value: CollectionBuilderTypeName;
  label: string;
}> = [
  { value: 'imdb_list', label: 'IMDb list (URL)' },
  { value: 'tmdb_collection_details', label: 'TMDb collection (id)' },
  { value: 'tvdb_list_details', label: 'TVDb list (URL)' },
  { value: 'tmdb_movie', label: 'TMDb movie ids' },
  { value: 'tmdb_show', label: 'TMDb show ids' },
  { value: 'tvdb_show', label: 'TVDb show ids' },
];

/** Kept for back-compat (the Libretto default set). */
export const COLLECTION_BUILDER_OPTIONS = LIBRETTO_BUILDER_OPTIONS;

/** Movies/TV bind Kometa; Books/Audiobooks bind Libretto. */
export function isKometaMedia(mediaType: CollectionMediaTypeName): boolean {
  return mediaType === 'movies' || mediaType === 'tv';
}

/** The builder options a media sub-section's composer offers. */
export function builderOptionsFor(
  mediaType: CollectionMediaTypeName,
): ReadonlyArray<{ value: CollectionBuilderTypeName; label: string }> {
  return isKometaMedia(mediaType) ? KOMETA_BUILDER_OPTIONS : LIBRETTO_BUILDER_OPTIONS;
}

/** The default builder a fresh composer starts on for a media sub-section. */
export function defaultBuilderFor(mediaType: CollectionMediaTypeName): CollectionBuilderTypeName {
  return isKometaMedia(mediaType) ? 'imdb_list' : 'hardcover_series';
}

/** The recipe sync modes (mirrors @hnet/db COLLECTION_SYNC_MODES). */
export type CollectionSyncModeName = 'append' | 'sync';

// ── DESIGN-044 — the collection BUILDER PAGE ──────────────────────────────────────────────────
// The full-page, search-first builder that replaces the DESIGN-043 D-03 Modal composer (superseded).
// The copy below is DESIGN-044 D-03, used VERBATIM by the page AND the gallery capture (one source of
// truth so they can never drift). Owner tone: no em-dashes, no jargon, no names. A lint test asserts the
// no-em-dash rule against these strings.

/** How a builder's ref field behaves (DESIGN-044 D-04). */
export type BuilderRefShape =
  | 'search' // Shape A — typeahead search for ONE ref (series/list/franchise)
  | 'url' // Shape B — a validated list URL (no name search, honest "preview unavailable")
  | 'multi'; // Shape C — a search box that ADDS each pick to an ordered id list

/** One builder-type card: the plain-language explanation a user picks from (DESIGN-044 D-03, verbatim). */
export interface BuilderCard {
  builder: CollectionBuilderTypeName;
  /** Short human title (the card heading). */
  title: string;
  /** The one-line explanation, VERBATIM from DESIGN-044 D-03 (no em-dashes). */
  explanation: string;
  /** The tiny "what you'll enter" hint. */
  hint: string;
  /** How the ref field behaves for this builder. */
  shape: BuilderRefShape;
  /** For a search/multi builder, the search backend (books ⇒ Libretto type; movies/TV ⇒ arr kind). */
  searchType?: string;
}

/** Books and Audiobooks builder cards (Libretto), easiest-first (DESIGN-044 D-03). */
export const BOOKS_BUILDER_CARDS: readonly BuilderCard[] = [
  {
    builder: 'hardcover_series',
    title: 'A book series',
    explanation:
      'Every book in a series, in reading order. Type the series name and pick it, and the whole series comes along, even the ones the library does not have yet.',
    hint: 'Search a series by name',
    shape: 'search',
    searchType: 'hardcover_series',
  },
  {
    builder: 'nyt_list',
    title: 'A New York Times list',
    explanation:
      'A New York Times bestseller list, kept in list order. Great for a shelf that follows what is popular right now.',
    hint: 'Pick a list by name',
    shape: 'search',
    searchType: 'nyt_list',
  },
  {
    builder: 'static_ids',
    title: 'A hand-picked set',
    explanation:
      'A set you choose book by book. Search for each title and add it, and they stay in the order you add them.',
    hint: 'Search and add each book',
    shape: 'multi',
    searchType: 'hardcover_series',
  },
];

/** Movies builder cards (Kometa), easiest-first (DESIGN-044 D-03). */
export const MOVIES_BUILDER_CARDS: readonly BuilderCard[] = [
  {
    builder: 'tmdb_collection_details',
    title: 'A movie franchise',
    explanation:
      'A movie franchise or series, all of its films together. Type a movie from it and pick the franchise, and every film in that franchise comes along.',
    hint: 'Search a movie, pick its franchise',
    shape: 'search',
    searchType: 'tmdb_collection_details',
  },
  {
    builder: 'imdb_list',
    title: 'An IMDb list',
    explanation:
      "Any public IMDb list, kept in the list's order. Paste the list's web address and the app pulls in everything on it.",
    hint: 'Paste an IMDb list link',
    shape: 'url',
  },
  {
    builder: 'tmdb_movie',
    title: 'A hand-picked set of movies',
    explanation:
      'A set you choose film by film. Search for each movie and add it, and they stay in the order you add them.',
    hint: 'Search and add each movie',
    shape: 'multi',
    searchType: 'tmdb_movie',
  },
];

/** TV builder cards (Kometa), easiest-first (DESIGN-044 D-03). */
export const TV_BUILDER_CARDS: readonly BuilderCard[] = [
  {
    builder: 'tvdb_list_details',
    title: 'A TVDb list',
    explanation:
      "Any public TheTVDB list, kept in the list's order. Paste the list's web address and the app pulls in every show on it.",
    hint: 'Paste a TVDb list link',
    shape: 'url',
  },
  {
    builder: 'tmdb_show',
    title: 'A hand-picked set of shows',
    explanation:
      'A set you choose show by show. Search for each show and add it, and they stay in the order you add them.',
    hint: 'Search and add each show',
    shape: 'multi',
    searchType: 'tmdb_show',
  },
  {
    builder: 'tvdb_show',
    title: 'A hand-picked set of shows (TVDb)',
    explanation:
      'A set you choose show by show, matched on TheTVDB. Search for each show and add it, and they stay in the order you add them.',
    hint: 'Search and add each show',
    shape: 'multi',
    searchType: 'tvdb_show',
  },
];

/** The builder cards a media tab shows (DESIGN-044 D-03). An empty set renders the honest no-types state. */
export function builderCardsFor(mediaType: CollectionMediaTypeName): readonly BuilderCard[] {
  switch (mediaType) {
    case 'books':
    case 'audiobooks':
      return BOOKS_BUILDER_CARDS;
    case 'movies':
      return MOVIES_BUILDER_CARDS;
    case 'tv':
      return TV_BUILDER_CARDS;
  }
}

/** Look up one card by builder within a media tab (the ref field + preview read its shape). */
export function builderCard(
  mediaType: CollectionMediaTypeName,
  builder: CollectionBuilderTypeName,
): BuilderCard | undefined {
  return builderCardsFor(mediaType).find((c) => c.builder === builder);
}

/** Every DESIGN-044 D-03 explanation string (the em-dash lint test iterates these). */
export const ALL_BUILDER_CARD_COPY: readonly string[] = [
  ...BOOKS_BUILDER_CARDS,
  ...MOVIES_BUILDER_CARDS,
  ...TV_BUILDER_CARDS,
].flatMap((c) => [c.title, c.explanation, c.hint]);

/** DESIGN-044 D-04 URL validation — the IMDb / TVDb list URL patterns (the honest inline check). */
export const LIST_URL_PATTERNS: Partial<Record<CollectionBuilderTypeName, RegExp>> = {
  imdb_list: /imdb\.com\/list\/ls\d+/i,
  tvdb_list_details: /thetvdb\.com\/lists\//i,
};

/** True when a URL-shape builder's ref looks like a valid list URL (DESIGN-044 D-04). */
export function isValidListUrl(builder: CollectionBuilderTypeName, ref: string): boolean {
  const pattern = LIST_URL_PATTERNS[builder];
  if (!pattern) return true;
  return pattern.test(ref.trim());
}

/**
 * DESIGN-044 D-05 (owner REDESIGN ruling 2026-07-18 — "gotta catch em all") — the gamified in-library vs
 * total read that REPLACES the retired cap meter. The number that matters is not "how close to the 25 limit"
 * (we never advertise the cap — over-cap surfaces only as the server error + the ticket flow when actually
 * tripped); it is how much of the collection the estate already HOLDS. A COMPLETE collection (held === total,
 * total > 0) earns the celebratory "caught em all" state; an incomplete one shows the held/total pair with
 * the missing side in the wall's existing "missing" chip typeface. The Trash surfaces' gamification idiom.
 */
export interface CollectionProgress {
  /** In-library member count (clamped to [0, total]). */
  held: number;
  /** Full resolved membership count. */
  total: number;
  /** total - held. */
  missing: number;
  /** held === total && total > 0 — the caught-em-all celebration. */
  complete: boolean;
  /** total === 0 — nothing resolved yet; no count, no celebration (the honest edge). */
  empty: boolean;
}

/** Resolve the gamified held/total read (DESIGN-044 D-05, owner ruling 2026-07-18). */
export function collectionProgress(held: number, total: number): CollectionProgress {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safeHeld = Math.max(0, Math.min(Math.trunc(held), safeTotal));
  const missing = safeTotal - safeHeld;
  return {
    held: safeHeld,
    total: safeTotal,
    missing,
    complete: safeTotal > 0 && missing === 0,
    empty: safeTotal === 0,
  };
}
