// DESIGN-005 D-02 — Lidarr v1 field subsets (strip mode: extra fields tolerated, dropped).
import { z } from 'zod';
import { historyRecordBaseSchema } from './common';

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
  statistics: z.object({
    trackFileCount: z.number().int(),
    trackCount: z.number().int(),
    totalTrackCount: z.number().int(),
    sizeOnDisk: z.number(),
  }),
  // Restore-fidelity extras (D-02 / D-05 arr_attrs)
  artistType: z.string().nullish(),
  status: z.string(),
  added: z.string(),
});
export type LidarrArtist = z.infer<typeof lidarrArtistSchema>;

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
