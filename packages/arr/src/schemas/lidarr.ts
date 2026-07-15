// DESIGN-005 D-02 — Lidarr v1 field subsets (strip mode: extra fields tolerated, dropped).
import { z } from 'zod';
import {
  arrImageSchema,
  historyRecordBaseSchema,
  queueRecordBaseSchema,
  singleRatingSchema,
} from './common';

/** Full eventType enum per Lidarr's `EntityHistoryEventType` (D-02). */
export const LIDARR_HISTORY_EVENT_TYPES = [
  'unknown',
  'grabbed',
  'artistFolderImported',
  'trackFileImported',
  'downloadFailed',
  'trackFileDeleted',
  'trackFileRenamed',
  'albumImportIncomplete',
  'downloadImported',
  'trackFileRetagged',
  'downloadIgnored',
] as const;

/**
 * The `grabbed` filter value for the paged `GET /history?eventType=` endpoint
 * (D-03/D-15). That endpoint binds `eventType` to the INTEGER `EntityHistoryEventType`
 * enum — the lowercase string it RETURNS in responses is rejected there with HTTP 400
 * ("The value 'grabbed' is not valid."). The enum array above is in upstream order, so
 * grabbed's integer is its index (verified live 2026-07-03: `?eventType=1` →
 * records[0].eventType === 'grabbed'). Response-side schemas keep the string form.
 */
export const LIDARR_GRABBED_EVENT_TYPE: number = LIDARR_HISTORY_EVENT_TYPES.indexOf('grabbed');

/** `GET /artist` element — exactly the D-02 sync contract (no year for artists). */
export const lidarrArtistSchema = z.object({
  id: z.number().int(),
  artistName: z.string(),
  sortName: z.string(),
  foreignArtistId: z.string(), // MusicBrainz artist id — NOT `mbId` (D-02)
  monitored: z.boolean(),
  monitorNewItems: z.string(),
  qualityProfileId: z.number().int(),
  metadataProfileId: z.number().int(),
  rootFolderPath: z.string(),
  path: z.string(),
  tags: z.array(z.number().int()),
  // Optional: Lidarr omits statistics entirely for artists it has never
  // refreshed (seen live 2026-07-04 on 5 freshly-migrated artists — the field
  // is absent, not empty). Adapt treats absence as nothing-on-disk.
  statistics: z
    .object({
      trackFileCount: z.number().int(),
      trackCount: z.number().int(),
      totalTrackCount: z.number().int(),
      sizeOnDisk: z.number(),
    })
    .optional(),
  // Restore-fidelity extras (D-02 / D-05 arr_attrs)
  artistType: z.string().nullish(),
  status: z.string(),
  added: z.string(),
  // Metadata-harvest fields (DESIGN-008 D-02). Lidarr exposes a single community rating +
  // genres + images (artist poster); no runtime for artists.
  ratings: singleRatingSchema.optional(),
  images: z.array(arrImageSchema).optional(),
  genres: z.array(z.string()).optional(),
});
export type LidarrArtist = z.infer<typeof lidarrArtistSchema>;

/** `GET /artist/lookup?term=lidarr:{mbid}` element (DESIGN-008 D-05) — tombstoned metadata path. */
export const lidarrLookupSchema = z.object({
  artistName: z.string(),
  foreignArtistId: z.string().optional(),
  genres: z.array(z.string()).optional(),
  ratings: singleRatingSchema.optional(),
  images: z.array(arrImageSchema).optional(),
  remotePoster: z.string().optional(),
});
export type LidarrLookup = z.infer<typeof lidarrLookupSchema>;

/** `GET /album?artistId=` / `wanted/missing` record — fix-target granularity (D-02). */
export const lidarrAlbumSchema = z.object({
  id: z.number().int(),
  artistId: z.number().int(),
  foreignAlbumId: z.string(), // MusicBrainz release-group id
  title: z.string(),
  albumType: z.string(),
  monitored: z.boolean(),
  anyReleaseOk: z.boolean(),
  releaseDate: z.string().nullish(),
  statistics: z
    .object({
      trackFileCount: z.number().int(),
      trackCount: z.number().int(),
      totalTrackCount: z.number().int(),
      sizeOnDisk: z.number(),
    })
    .optional(),
});
export type LidarrAlbum = z.infer<typeof lidarrAlbumSchema>;

// ADR-061 / DESIGN-032 D-02 (PLAN-038) — one track row from `GET /track?albumId=` (the compose
// drill's music leaf). Tolerant: only the picker-facing fields are parsed.
export const lidarrTrackSchema = z.object({
  id: z.number().int(),
  albumId: z.number().int().optional(),
  trackNumber: z.union([z.string(), z.number()]).nullish(),
  absoluteTrackNumber: z.number().int().nullish(),
  title: z.string().nullish(),
  hasFile: z.boolean().optional(),
});
export type LidarrTrack = z.infer<typeof lidarrTrackSchema>;

/**
 * `GET /trackfile?albumId=` element — the Fix fallback's delete targets (D-03: an
 * album fix deletes every track file of that album; Lidarr deletes at track-file
 * granularity).
 */
export const lidarrTrackFileSchema = z.object({
  id: z.number().int(),
  albumId: z.number().int().optional(),
  path: z.string().optional(),
});
export type LidarrTrackFile = z.infer<typeof lidarrTrackFileSchema>;

/** `GET /metadataprofile` element — Restore maps metadata profiles BY NAME (D-16). */
export const lidarrMetadataProfileSchema = z.object({
  id: z.number().int(),
  name: z.string(),
});
export type LidarrMetadataProfile = z.infer<typeof lidarrMetadataProfileSchema>;

/** History record with Lidarr's per-kind target ids (`albumId` + `artistId`). */
export const lidarrHistoryRecordSchema = historyRecordBaseSchema.extend({
  eventType: z.enum(LIDARR_HISTORY_EVENT_TYPES).catch('unknown'),
  albumId: z.number().int(),
  artistId: z.number().int(),
});
export type LidarrHistoryRecord = z.infer<typeof lidarrHistoryRecordSchema>;

/**
 * `GET /queue?artistIds=` record with Lidarr's join keys (PLAN-015 / D-20). `artistId` is the
 * parent (= media_items.arr_item_id) the queue is filtered by; `albumId` maps a record back to
 * a fix/search album target (verified live 2026-07-07). Nullish for unknown-artist items.
 */
export const lidarrQueueRecordSchema = queueRecordBaseSchema.extend({
  artistId: z.number().int().nullish(),
  albumId: z.number().int().nullish(),
});
export type LidarrQueueRecord = z.infer<typeof lidarrQueueRecordSchema>;
