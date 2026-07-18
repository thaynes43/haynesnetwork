// DESIGN-005 D-02 — Radarr v3 field subsets (strip mode: extra fields tolerated, dropped).
import { z } from 'zod';
import {
  arrFileSchema,
  arrImageSchema,
  historyRecordBaseSchema,
  queueRecordBaseSchema,
  radarrRatingsSchema,
} from './common';

/** Full eventType enum per Radarr's `MovieHistoryEventType` (D-02). */
export const RADARR_HISTORY_EVENT_TYPES = [
  'unknown',
  'grabbed',
  'downloadFolderImported',
  'downloadFailed',
  'movieFileDeleted',
  'movieFolderImported',
  'movieFileRenamed',
  'downloadIgnored',
] as const;

/**
 * `GET /movie` element — exactly the D-02 sync contract. `rootFolderPath` is optional
 * because `wanted/missing` movie records omit it (verified live 2026-07-03); the full
 * `GET /movie` list always carries it.
 */
export const radarrMovieSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  sortTitle: z.string(),
  year: z.number().int(),
  tmdbId: z.number().int(), // always set (D-02 external-id identity)
  imdbId: z.string().optional(),
  monitored: z.boolean(),
  qualityProfileId: z.number().int(),
  rootFolderPath: z.string().optional(),
  path: z.string(),
  tags: z.array(z.number().int()),
  hasFile: z.boolean(),
  movieFileId: z.number().int(),
  sizeOnDisk: z.number(),
  statistics: z.object({
    movieFileCount: z.number().int(),
  }),
  // Restore-fidelity extras (D-02 / D-05 arr_attrs)
  minimumAvailability: z.string(),
  status: z.string(),
  isAvailable: z.boolean(),
  added: z.string(),
  // Metadata-harvest fields (DESIGN-008 D-02) — present on the live resource; optional so
  // the strip-mode sync/restore paths that don't need them keep parsing (nullish-tolerant).
  ratings: radarrRatingsSchema.optional(),
  images: z.array(arrImageSchema).optional(),
  genres: z.array(z.string()).optional(),
  runtime: z.number().int().optional(),
  // ADR-051 C-05 / DESIGN-026 D-05 (PLAN-029 — Date Released) — the precise release dates Radarr
  // exposes on `GET /movie` (ISO strings; any may be absent for an unreleased title). The metadata
  // harvest derives media_metadata.released_at = digitalRelease ?? inCinemas ?? physicalRelease
  // (the earliest generally-available date, preferred over the January-1 `year`). Nullish-tolerant.
  digitalRelease: z.string().optional(),
  inCinemas: z.string().optional(),
  physicalRelease: z.string().optional(),
  // The on-disk file is embedded INLINE in the `GET /movie` list when hasFile is true (verified
  // live 2026-07-06: 5473/9558 carry it) — no extra request. Its `quality.quality.resolution` is
  // the REAL per-item resolution tier the harvest derives from (resolution fix, D-02).
  movieFile: arrFileSchema.optional(),
});
export type RadarrMovie = z.infer<typeof radarrMovieSchema>;

// DESIGN-035 D-16 (Wanted-tile membership) — Radarr natively models TMDb Collections. `GET
// /api/v3/collection` returns each collection with its FULL TMDb member set (`movies[]`), held or
// not. We consume only the collection `title` (the title-match join to the mirrored plex_collections
// row) and each member's `tmdbId` (matched against the app's own media_items ledger to split
// held/wanted). Strip-mode tolerant — Radarr carries many more fields we ignore.
export const radarrCollectionMovieSchema = z
  .object({
    tmdbId: z.number().int(),
    title: z.string().nullish(),
  })
  .passthrough();
export type RadarrCollectionMovie = z.infer<typeof radarrCollectionMovieSchema>;

export const radarrCollectionSchema = z
  .object({
    id: z.number().int().nullish(),
    title: z.string(),
    /** The TMDb collection id (the future exact-join key — the M-c hardening follow-up, D-16). */
    tmdbId: z.number().int().nullish(),
    movies: z.array(radarrCollectionMovieSchema).nullish(),
  })
  .passthrough();
export type RadarrCollection = z.infer<typeof radarrCollectionSchema>;

/**
 * DESIGN-044 D-04 / Q-04 — the TMDb franchise a looked-up movie belongs to, surfaced by
 * `GET /movie/lookup` on Radarr's MovieResource `collection` field. The collection-builder page's
 * "movie franchise" ref search reads this: the user searches a MOVIE by name, and the app takes its
 * `collection` (name + TMDb collection id) as the `tmdb_collection_details` ref. Radarr's serialized
 * key for the franchise NAME has drifted across versions (`title` on 6.x, `name` on older builds), so
 * the ACL tolerates BOTH and the domain derives one honest name (never a fabricated label). A movie
 * with no franchise omits `collection` entirely (the page shows it disabled with the honest note).
 */
export const radarrLookupCollectionSchema = z
  .object({
    name: z.string().nullish(),
    title: z.string().nullish(),
    /** The TMDb collection id — the exact `tmdb_collection_details` ref (the franchise builder value). */
    tmdbId: z.number().int().nullish(),
  })
  .passthrough();
export type RadarrLookupCollection = z.infer<typeof radarrLookupCollectionSchema>;

/**
 * `GET /movie/lookup?term=tmdb:{id}` element (DESIGN-008 D-05) — the tombstoned/never-listed
 * metadata path. Returns FULL metadata + `remotePoster` WITHOUT adding the movie. A metadata
 * subset only (lookup omits path/rootFolder/statistics). DESIGN-044 D-04 adds the optional
 * `collection` (the movie's TMDb franchise) for the franchise ref search.
 */
export const radarrLookupSchema = z.object({
  title: z.string(),
  year: z.number().int().optional(),
  tmdbId: z.number().int().optional(),
  imdbId: z.string().optional(),
  runtime: z.number().int().optional(),
  genres: z.array(z.string()).optional(),
  ratings: radarrRatingsSchema.optional(),
  images: z.array(arrImageSchema).optional(),
  remotePoster: z.string().optional(),
  // The movie's TMDb franchise, when it belongs to one (the DESIGN-044 franchise ref). Nullish-tolerant:
  // most movies carry no collection, and the name key varies by Radarr version (see the schema above).
  collection: radarrLookupCollectionSchema.nullish(),
});
export type RadarrLookup = z.infer<typeof radarrLookupSchema>;

/** History record with Radarr's per-kind target id (`movieId`). */
export const radarrHistoryRecordSchema = historyRecordBaseSchema.extend({
  eventType: z.enum(RADARR_HISTORY_EVENT_TYPES).catch('unknown'),
  movieId: z.number().int(),
});
export type RadarrHistoryRecord = z.infer<typeof radarrHistoryRecordSchema>;

/**
 * `GET /queue?movieIds=` record with Radarr's join key (PLAN-015 / D-20). `movieId` is the
 * target (= media_items.arr_item_id) the queue is filtered by — the movie IS the fix target
 * (radarr has no children). Verified live 2026-07-07.
 */
export const radarrQueueRecordSchema = queueRecordBaseSchema.extend({
  movieId: z.number().int().nullish(),
});
export type RadarrQueueRecord = z.infer<typeof radarrQueueRecordSchema>;
