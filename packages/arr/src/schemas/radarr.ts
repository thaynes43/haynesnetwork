// DESIGN-005 D-02 — Radarr v3 field subsets (strip mode: extra fields tolerated, dropped).
import { z } from 'zod';
import { arrImageSchema, historyRecordBaseSchema, radarrRatingsSchema } from './common';

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
});
export type RadarrMovie = z.infer<typeof radarrMovieSchema>;

/**
 * `GET /movie/lookup?term=tmdb:{id}` element (DESIGN-008 D-05) — the tombstoned/never-listed
 * metadata path. Returns FULL metadata + `remotePoster` WITHOUT adding the movie. A metadata
 * subset only (lookup omits path/rootFolder/statistics).
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
});
export type RadarrLookup = z.infer<typeof radarrLookupSchema>;

/** History record with Radarr's per-kind target id (`movieId`). */
export const radarrHistoryRecordSchema = historyRecordBaseSchema.extend({
  eventType: z.enum(RADARR_HISTORY_EVENT_TYPES).catch('unknown'),
  movieId: z.number().int(),
});
export type RadarrHistoryRecord = z.infer<typeof radarrHistoryRecordSchema>;
