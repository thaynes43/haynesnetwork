// DESIGN-005 D-02 — shared zod shapes. All object schemas are default (strip) mode:
// they tolerate any extra upstream fields but never let unknown fields past the
// BC-03 ACL boundary (unknown *arr fields never enter the app).
import { z } from 'zod';

/** `GET /system/status` — only the identity fields the app consumes (D-01 probe). */
export const systemStatusSchema = z.object({
  appName: z.string().optional(),
  instanceName: z.string().optional(),
  version: z.string(),
});
export type ArrSystemStatus = z.infer<typeof systemStatusSchema>;

/** `GET /qualityprofile` element — id→name map source (D-14 step 1, D-16 remap-by-name). */
export const qualityProfileSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});
export type ArrQualityProfile = z.infer<typeof qualityProfileSchema>;

/** `GET /rootfolder` element. */
export const rootFolderSchema = z.object({
  id: z.number().int(),
  path: z.string(),
  accessible: z.boolean().optional(),
  freeSpace: z.number().optional(),
});
export type ArrRootFolder = z.infer<typeof rootFolderSchema>;

/** `GET /tag` element — int ids → labels (D-02); Restore recreates tags by label (D-03). */
export const tagSchema = z.object({
  id: z.number().int(),
  label: z.string(),
});
export type ArrTag = z.infer<typeof tagSchema>;

/** Paged *arr envelope (`/history`, `/wanted/missing`, …). */
export const pagedSchema = <T extends z.ZodType>(record: T) =>
  z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    sortKey: z.string().optional(),
    sortDirection: z.string().optional(),
    totalRecords: z.number().int(),
    records: z.array(record),
  });
export interface ArrPage<T> {
  page: number;
  pageSize: number;
  sortKey?: string;
  sortDirection?: string;
  totalRecords: number;
  records: T[];
}

/** Release quality on history records — nested name/id only (D-02). */
export const historyQualitySchema = z.object({
  quality: z.object({ id: z.number().int(), name: z.string() }),
});

/**
 * History record fields common to all three *arrs (D-02): per-kind target ids are added
 * in sonarr.ts/radarr.ts/lidarr.ts. `eventType` stays a plain string here — the full
 * per-kind enums live in each kind's schema; normalization is the domain's job (D-07).
 */
export const historyRecordBaseSchema = z.object({
  id: z.number().int(),
  eventType: z.string(),
  date: z.string(),
  sourceTitle: z.string().nullish(),
  downloadId: z.string().nullish(),
  quality: historyQualitySchema.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// DESIGN-008 D-02 — metadata-harvest shapes (ADR-018). The *arrs already carry
// ratings/images/genres/runtime on their item resources; strip-mode dropped them until now.
// Verified live 2026-07-06 against Radarr 6.x / Sonarr 4.x / Lidarr 3.x.
// ---------------------------------------------------------------------------

/** One rating source: {value, votes?, type?}. Radarr splits imdb/tmdb/rottenTomatoes/…;
 *  Sonarr/Lidarr expose a single community rating (see per-kind schemas). */
export const ratingValueSchema = z.object({
  value: z.number(),
  votes: z.number().int().optional(),
  type: z.string().optional(),
});
export type ArrRatingValue = z.infer<typeof ratingValueSchema>;

/** Radarr's multi-source `ratings` map (all optional — verified sources: imdb, tmdb,
 *  rottenTomatoes (critics tomatometer), metacritic, trakt). RT audience/popcorn is NOT
 *  exposed by any *arr, so rt_popcorn stays null from this tier. */
export const radarrRatingsSchema = z.object({
  imdb: ratingValueSchema.optional(),
  tmdb: ratingValueSchema.optional(),
  rottenTomatoes: ratingValueSchema.optional(),
  metacritic: ratingValueSchema.optional(),
  trakt: ratingValueSchema.optional(),
});
export type RadarrRatings = z.infer<typeof radarrRatingsSchema>;

/** Sonarr/Lidarr expose a single `{value, votes}` community rating (no per-source split). */
export const singleRatingSchema = z.object({
  value: z.number(),
  votes: z.number().int().optional(),
});

/**
 * DESIGN-008 D-02 (resolution fix, live-validated 2026-07-06) — a *arr FILE resource's nested
 * `quality` wrapper. `quality.quality.resolution` is the *arr's NORMALIZED integer resolution
 * tier (observed live: 2160/1080/720/576/480; 0 or absent = unknown) — the release's declared
 * resolution, far cleaner than the raw `mediaInfo.resolution` pixel dims which letterboxing
 * skews into hundreds of odd values (e.g. "1920x800", "3840x1600"). Shared by Radarr's inline
 * `movieFile` and Sonarr's `GET /episodefile` element (identical shape). Strip-mode: the rest of
 * the file resource (path, size, mediaInfo, …) is tolerated and dropped. */
export const arrFileSchema = z.object({
  quality: z
    .object({ quality: z.object({ resolution: z.number().int().optional() }).optional() })
    .optional(),
});
export type ArrFile = z.infer<typeof arrFileSchema>;

/** An *arr image: coverType ('poster'|'fanart'|'banner'), the relative in-app `url`
 *  (carries ?lastWrite — the poster ETag input) and the upstream `remoteUrl` (a TMDB CDN
 *  URL for the tombstone/lookup TMDB tier). */
export const arrImageSchema = z.object({
  coverType: z.string(),
  url: z.string().optional(),
  remoteUrl: z.string().optional(),
  extension: z.string().optional(), // lidarr adds this
});
export type ArrImage = z.infer<typeof arrImageSchema>;

/** `POST /command` acknowledgement (write surface — search triggers, D-15). */
export const commandResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});
export type ArrCommandResponse = z.infer<typeof commandResponseSchema>;

/**
 * PLAN-015 / DESIGN-005 D-20 — the *arr download-queue record subset the Action Feedback
 * projection consumes (`GET /api/v3|v1/queue`, read-only; verified live 2026-07-07 against
 * Sonarr 4.x / Radarr 6.x / Lidarr 3.x). Per-kind target ids (`episodeId`/`movieId`/`albumId`
 * + parents) are added in sonarr.ts/radarr.ts/lidarr.ts. BC-03 ACL — only these fields enter
 * the app; the rest of the (large) queue resource is tolerated and dropped (strip mode).
 *
 * `size`/`sizeleft` drive the download percent (`(size - sizeleft) / size`);
 * `status` is the download-client status (`queued|delay|paused|downloading|completed|warning|
 * failed|downloadClientUnavailable`); `trackedDownloadStatus` is `ok|warning|error`;
 * `trackedDownloadState` is the lifecycle (`downloading|importPending|importing|imported|
 * importBlocked|importFailed|failedPending|failed|ignored`). `errorMessage`/`statusMessages`
 * carry the stall reason surfaced on the `stalled` phase.
 */
export const queueRecordBaseSchema = z.object({
  id: z.number().int(),
  status: z.string(),
  trackedDownloadStatus: z.string().nullish(),
  trackedDownloadState: z.string().nullish(),
  size: z.number().nullish(),
  sizeleft: z.number().nullish(),
  estimatedCompletionTime: z.string().nullish(),
  timeleft: z.string().nullish(),
  downloadId: z.string().nullish(),
  title: z.string().nullish(),
  errorMessage: z.string().nullish(),
  statusMessages: z
    .array(z.object({ title: z.string().nullish(), messages: z.array(z.string()).nullish() }))
    .nullish(),
});
export type ArrQueueRecordBase = z.infer<typeof queueRecordBaseSchema>;
