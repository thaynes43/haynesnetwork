// DESIGN-005 D-02 — Sonarr v3 field subsets (strip mode: extra fields tolerated, dropped).
import { z } from 'zod';
import {
  arrFileSchema,
  arrImageSchema,
  historyRecordBaseSchema,
  queueRecordBaseSchema,
  singleRatingSchema,
} from './common';

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

/**
 * The `grabbed` filter value for the paged `GET /history?eventType=` endpoint
 * (D-03/D-15). That endpoint binds `eventType` to the INTEGER `EpisodeHistoryEventType`
 * enum — the lowercase string it RETURNS in responses is rejected there with HTTP 400
 * ("The value 'grabbed' is not valid."). The enum array above is in upstream order, so
 * grabbed's integer is its index (verified live 2026-07-03: `?eventType=1` →
 * records[0].eventType === 'grabbed'). Response-side schemas keep the string form.
 */
export const SONARR_GRABBED_EVENT_TYPE: number = SONARR_HISTORY_EVENT_TYPES.indexOf('grabbed');

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
  // Metadata-harvest fields (DESIGN-008 D-02). Sonarr exposes a single community rating
  // ({value, votes}) mapped to the tmdb_* slots (no imdb/tmdb split like Radarr).
  ratings: singleRatingSchema.optional(),
  images: z.array(arrImageSchema).optional(),
  genres: z.array(z.string()).optional(),
  runtime: z.number().int().optional(),
  // ADR-051 C-05 / DESIGN-026 D-05 (PLAN-029 — Date Released) — the series' first-aired date Sonarr
  // exposes on `GET /series` (ISO string; absent for an unaired show). The metadata harvest maps it
  // to media_metadata.released_at (a show's canonical release instant). Nullish-tolerant (strip mode).
  firstAired: z.string().optional(),
  // ADR-113 (DESIGN-055 Q-10 ruling) — the series' alternate titles (scene and translated titles; `seasonNumber` -1 for
  // every season). The Mislabel Block writes an `alias` term only for one of these.
  alternateTitles: z
    .array(z.object({ title: z.string(), seasonNumber: z.number().int().nullish() }))
    .nullish(),
});
export type SonarrSeries = z.infer<typeof sonarrSeriesSchema>;

/** `GET /series/lookup?term=tvdb:{id}` element (DESIGN-008 D-05) — tombstoned metadata path. */
export const sonarrLookupSchema = z.object({
  title: z.string(),
  year: z.number().int().optional(),
  tvdbId: z.number().int().optional(),
  tmdbId: z.number().int().optional(),
  imdbId: z.string().optional(),
  runtime: z.number().int().optional(),
  genres: z.array(z.string()).optional(),
  ratings: singleRatingSchema.optional(),
  images: z.array(arrImageSchema).optional(),
  remotePoster: z.string().optional(),
});
export type SonarrLookup = z.infer<typeof sonarrLookupSchema>;

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

/**
 * `GET /episodefile?seriesId=` element (DESIGN-008 D-02 resolution fix). The Sonarr series list
 * carries NO per-file data, so the metadata harvest fetches the episode files per target series
 * and derives the DOMINANT `quality.quality.resolution` tier (verified live 2026-07-06). A
 * metadata-only subset — the fix/delete paths use `episodeFileId` off the episode resource, not
 * this shape. */
export const sonarrEpisodeFileSchema = arrFileSchema.extend({
  id: z.number().int(),
  seriesId: z.number().int().optional(),
});
export type SonarrEpisodeFile = z.infer<typeof sonarrEpisodeFileSchema>;

/** History record with Sonarr's per-kind target ids (`episodeId` + `seriesId`). */
export const sonarrHistoryRecordSchema = historyRecordBaseSchema.extend({
  eventType: z.enum(SONARR_HISTORY_EVENT_TYPES).catch('unknown'),
  episodeId: z.number().int(),
  seriesId: z.number().int(),
});
export type SonarrHistoryRecord = z.infer<typeof sonarrHistoryRecordSchema>;

/**
 * ADR-110 C-03 / DESIGN-055 D-05 (PLAN-077 P4) — the `downloadFolderImported` filter value for the paged
 * `GET /history?eventType=` (the integer enum, like SONARR_GRABBED_EVENT_TYPE): 3.
 */
export const SONARR_DOWNLOAD_FOLDER_IMPORTED_EVENT_TYPE: number =
  SONARR_HISTORY_EVENT_TYPES.indexOf('downloadFolderImported');

/**
 * ADR-110 C-03 / DESIGN-055 D-05 (PLAN-077 P4) — one `downloadFolderImported` history record as the Title Check reads it
 * (Sonarr 4.0.20.3012, `GET /history?eventType=3` and `GET /history/since?eventType=downloadFolderImported`). Sonarr
 * writes one record per episode, so a multi-episode file has several records with the same `data.fileId`. Only the
 * named `data` keys are kept: the imported file's id, the path the download was dropped at (its base name is the
 * release's own file name), the library path and the release group. Nothing else from `data` (an indexer URL can ride
 * there on other event types) enters the app.
 */
export const sonarrImportHistoryRecordSchema = z
  .object({
    id: z.number().int(),
    eventType: z.string().nullish(),
    date: z.string(),
    seriesId: z.number().int(),
    episodeId: z.number().int(),
    sourceTitle: z.string().nullish(),
    downloadId: z.string().nullish(),
    data: z.record(z.string(), z.unknown()).nullish(),
  })
  .transform((r) => {
    const str = (key: string): string | null => {
      const v = r.data?.[key];
      return typeof v === 'string' && v.trim().length > 0 ? v : null;
    };
    const fileId = str('fileId');
    return {
      id: r.id,
      eventType: r.eventType ?? null,
      date: r.date,
      seriesId: r.seriesId,
      episodeId: r.episodeId,
      sourceTitle: r.sourceTitle?.trim() ? r.sourceTitle : null,
      downloadId: r.downloadId ?? null,
      /** The imported episode file's id (`data.fileId`, a numeric string upstream); null when absent or malformed. */
      fileId: fileId !== null && /^\d+$/.test(fileId) ? Number(fileId) : null,
      droppedPath: str('droppedPath'),
      importedPath: str('importedPath'),
      releaseGroup: str('releaseGroup'),
    };
  });
export type SonarrImportHistoryRecord = z.infer<typeof sonarrImportHistoryRecordSchema>;

/**
 * `GET /queue?seriesIds=` record with Sonarr's join keys (PLAN-015 / D-20). `seriesId` is the
 * parent (= media_items.arr_item_id) the queue is filtered by; `episodeId`/`seasonNumber` map a
 * record back to a fix/search target child (verified live 2026-07-07). Nullish because a queue
 * item for an unknown/removed series can omit them.
 */
export const sonarrQueueRecordSchema = queueRecordBaseSchema.extend({
  seriesId: z.number().int().nullish(),
  episodeId: z.number().int().nullish(),
  seasonNumber: z.number().int().nullish(),
});
export type SonarrQueueRecord = z.infer<typeof sonarrQueueRecordSchema>;
