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
