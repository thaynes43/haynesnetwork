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
