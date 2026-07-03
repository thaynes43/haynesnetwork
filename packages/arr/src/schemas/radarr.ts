// DESIGN-005 D-02 — Radarr v3 field subsets (strip mode: extra fields tolerated, dropped).
import { z } from 'zod';
import { historyRecordBaseSchema } from './common';

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
});
export type RadarrMovie = z.infer<typeof radarrMovieSchema>;

/** History record with Radarr's per-kind target id (`movieId`). */
export const radarrHistoryRecordSchema = historyRecordBaseSchema.extend({
  eventType: z.enum(RADARR_HISTORY_EVENT_TYPES).catch('unknown'),
  movieId: z.number().int(),
});
export type RadarrHistoryRecord = z.infer<typeof radarrHistoryRecordSchema>;
