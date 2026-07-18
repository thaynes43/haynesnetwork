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

/** The Libretto builder types (mirrors @hnet/db COLLECTION_BUILDER_TYPES). */
export const COLLECTION_BUILDER_TYPE_NAMES = [
  'static_ids',
  'hardcover_series',
  'nyt_list',
  'wikidata_award',
] as const;
export type CollectionBuilderTypeName = (typeof COLLECTION_BUILDER_TYPE_NAMES)[number];

/** Short badge/label copy per builder type (the composer picker + the row badge share these). */
export const COLLECTION_BUILDER_LABELS: Record<CollectionBuilderTypeName, string> = {
  static_ids: 'ID list',
  hardcover_series: 'Hardcover series',
  nyt_list: 'NYT list',
  wikidata_award: 'Award',
};

/** The composer's builder picker options (order chosen for the common case first). */
export const COLLECTION_BUILDER_OPTIONS: ReadonlyArray<{
  value: CollectionBuilderTypeName;
  label: string;
}> = [
  { value: 'hardcover_series', label: 'Hardcover series' },
  { value: 'nyt_list', label: 'NYT list' },
  { value: 'wikidata_award', label: 'Award (Wikidata)' },
  { value: 'static_ids', label: 'ID list' },
];

/** The recipe sync modes (mirrors @hnet/db COLLECTION_SYNC_MODES). */
export type CollectionSyncModeName = 'append' | 'sync';
