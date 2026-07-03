// DESIGN-005 D-02 — Sonarr v3 field subsets (strip mode: extra fields tolerated, dropped).
import { z } from 'zod';
import { historyRecordBaseSchema } from './common';

/** Full eventType enum per Sonarr's `EpisodeHistoryEventType` (D-02). */
export const SONARR_HISTORY_EVENT_TYPES = [
  'unknown',
  'grabbed',
  'seriesFolderImported',
  'downloadFolderImported',
  'downloadFailed',
  'episodeFileDeleted',
  'episodeFileRenamed',
  'downloadIgnored',
] as const;

/** `GET /series` element — exactly the D-02 sync contract for the ledger row. */
export const sonarrSeriesSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  sortTitle: z.string(),
  year: z.number().int(),
  tvdbId: z.number().int(), // always set (D-02 external-id identity)
  imdbId: z.string().optional(),
  tmdbId: z.number().int().optional(),
  monitored: z.boolean(),
  monitorNewItems: z.string(),
  qualityProfileId: z.number().int(),
  rootFolderPath: z.string(),
  path: z.string(),
  tags: z.array(z.number().int()),
  statistics: z.object({
    episodeFileCount: z.number().int(),
    episodeCount: z.number().int(),
    totalEpisodeCount: z.number().int(),
    sizeOnDisk: z.number(),
  }),
  // Restore-fidelity extras (D-02 / D-05 arr_attrs)
  seriesType: z.string(),
  seasonFolder: z.boolean(),
  status: z.string(),
  ended: z.boolean(),
  added: z.string(),
});
export type SonarrSeries = z.infer<typeof sonarrSeriesSchema>;

/** `GET /episode?seriesId=` / `wanted/missing` record — fix-target granularity (D-02). */
export const sonarrEpisodeSchema = z.object({
  id: z.number().int(),
  seriesId: z.number().int(),
  seasonNumber: z.number().int(),
  episodeNumber: z.number().int(),
  title: z.string(),
  airDateUtc: z.string().optional(),
  hasFile: z.boolean(),
  monitored: z.boolean(),
  episodeFileId: z.number().int().optional(),
});
export type SonarrEpisode = z.infer<typeof sonarrEpisodeSchema>;

/** History record with Sonarr's per-kind target ids (`episodeId` + `seriesId`). */
export const sonarrHistoryRecordSchema = historyRecordBaseSchema.extend({
  eventType: z.enum(SONARR_HISTORY_EVENT_TYPES).catch('unknown'),
  episodeId: z.number().int(),
  seriesId: z.number().int(),
});
export type SonarrHistoryRecord = z.infer<typeof sonarrHistoryRecordSchema>;
