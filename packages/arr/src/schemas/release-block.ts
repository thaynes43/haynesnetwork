// ADR-093 / DESIGN-052 D-11 / D-13 / D-17 / D-23 (PLAN-072) — the field subsets the Release Block, the Deleted-Release
// Record and the Seerr enrollment read and write (strip mode; nothing past these shapes enters the app).
//
// Verified against the deployed upstream sources (Radarr 6.4.4, Sonarr 4.0.20, Seerr 3.4.1):
// - `GET/POST/PUT /api/v3/releaseprofile` (ReleaseProfileController + ReleaseProfileResource, identical on both *arrs):
//   `{id, name, enabled, required, ignored, indexerId, tags}`; `required` / `ignored` are string arrays on the way
//   out (the POST/PUT also accept one comma-separated string, which this app never sends).
// - `GET /api/v3/moviefile?movieId=` (MovieFileResource) and `GET /api/v3/episodefile?seriesId=`
//   (EpisodeFileResource): `relativePath`, `sceneName`, `originalFilePath`, `releaseGroup`, `quality.quality`
//   (`name`, `resolution`, `source`, `modifier`), `size`.
// - History records carry `data` as a camel-cased string dictionary: an import's `fileId` / `importedPath`, a grab's
//   `indexer` / `releaseGroup`. A grab's `data` ALSO carries `downloadUrl` / `nzbInfoUrl` (indexer API keys): only the
//   named keys are ever read, and no URL is stored or logged (D-05).
// - Seerr `GET /api/v1/user/{id}/settings/main` (UserSettingsGeneralResponse) — read here for the two watchlist sync
//   flags only; the write client echoes the whole body (D-17).
import { z } from 'zod';

/** A Radarr/Sonarr release profile (`/api/v3/releaseprofile`). */
export const arrReleaseProfileSchema = z.object({
  id: z.number().int(),
  name: z.string().nullish(),
  enabled: z.boolean().nullish(),
  required: z
    .union([z.array(z.string()), z.string()])
    .nullish()
    .transform(splitTerms),
  ignored: z
    .union([z.array(z.string()), z.string()])
    .nullish()
    .transform(splitTerms),
  indexerId: z.number().int().nullish(),
  tags: z.array(z.number().int()).nullish(),
});
export type ArrReleaseProfile = z.infer<typeof arrReleaseProfileSchema>;

/** The body this app POSTs / PUTs (`id` only on a PUT). Terms always travel as an array (never a joined string). */
export interface ArrReleaseProfileInput {
  id?: number;
  name: string;
  enabled: boolean;
  required: string[];
  ignored: string[];
  indexerId: number;
  tags: number[];
}

function splitTerms(value: string[] | string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value;
  return value
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** A file resource's full quality (`quality.quality`): the name (`Remux-2160p`), resolution, source and modifier. */
export const arrReleaseQualitySchema = z
  .object({
    quality: z
      .object({
        id: z.number().int().nullish(),
        name: z.string().nullish(),
        resolution: z.number().int().nullish(),
        source: z.string().nullish(),
        modifier: z.string().nullish(),
      })
      .nullish(),
  })
  .nullish();
export type ArrReleaseQuality = z.infer<typeof arrReleaseQualitySchema>;

/** The identity fields of a Radarr movie file or a Sonarr episode file (D-11). */
const releaseFileShape = {
  id: z.number().int(),
  relativePath: z.string().nullish(),
  sceneName: z.string().nullish(),
  originalFilePath: z.string().nullish(),
  releaseGroup: z.string().nullish(),
  quality: arrReleaseQualitySchema,
  size: z.number().nullish(),
};

/** `GET /api/v3/moviefile?movieId=` element. */
export const radarrMovieFileSchema = z.object({
  ...releaseFileShape,
  movieId: z.number().int().nullish(),
});
export type RadarrMovieFile = z.infer<typeof radarrMovieFileSchema>;

/** `GET /api/v3/episodefile?seriesId=` element, with the identity fields (the metadata subset lives in sonarr.ts). */
export const sonarrEpisodeFileReleaseSchema = z.object({
  ...releaseFileShape,
  seriesId: z.number().int().nullish(),
  seasonNumber: z.number().int().nullish(),
});
export type SonarrEpisodeFileRelease = z.infer<typeof sonarrEpisodeFileReleaseSchema>;

/**
 * One history record, as the identity join reads it (`GET /history/movie?movieId=`, `GET /history/series?seriesId=`):
 * the event type, the release name (`sourceTitle`), the `downloadId` that links an import to its grab, and ONLY the
 * named `data` keys (never `downloadUrl` / `nzbInfoUrl`, which carry indexer keys).
 */
export const arrReleaseHistoryRecordSchema = z
  .object({
    id: z.number().int(),
    eventType: z.string(),
    date: z.string().nullish(),
    sourceTitle: z.string().nullish(),
    downloadId: z.string().nullish(),
    episodeId: z.number().int().nullish(),
    quality: z
      .object({
        quality: z
          .object({ name: z.string().nullish(), resolution: z.number().int().nullish() })
          .nullish(),
      })
      .nullish(),
    data: z.record(z.string(), z.unknown()).nullish(),
  })
  .transform((r) => {
    const str = (key: string): string | null => {
      const v = r.data?.[key];
      return typeof v === 'string' && v.trim().length > 0 ? v : null;
    };
    return {
      id: r.id,
      eventType: r.eventType,
      date: r.date ?? null,
      sourceTitle: r.sourceTitle ?? null,
      downloadId: r.downloadId ?? null,
      episodeId: r.episodeId ?? null,
      qualityName: r.quality?.quality?.name ?? null,
      /** An import's file id (`data.fileId`, a numeric string upstream). */
      fileId: (() => {
        const v = str('fileId');
        return v !== null && /^\d+$/.test(v) ? Number(v) : null;
      })(),
      importedPath: str('importedPath'),
      releaseGroup: str('releaseGroup'),
      indexer: str('indexer'),
    };
  });
export type ArrReleaseHistoryRecord = z.infer<typeof arrReleaseHistoryRecordSchema>;

/** A paged list envelope's record count (`/exclusions/paged`, `/importlistexclusion/paged`). */
export const arrPagedCountSchema = z.object({ totalRecords: z.number().int() });

/** DESIGN-052 D-17 — a Seerr user's two watchlist sync flags (`GET /api/v1/user/{id}/settings/main`). */
export const seerrUserWatchlistSyncSchema = z
  .object({
    watchlistSyncMovies: z.boolean().nullish(),
    watchlistSyncTv: z.boolean().nullish(),
  })
  .transform((s) => ({ movies: s.watchlistSyncMovies === true, tv: s.watchlistSyncTv === true }));
export type SeerrUserWatchlistSync = z.infer<typeof seerrUserWatchlistSyncSchema>;

/**
 * DESIGN-052 D-17 — one Seerr Sonarr server (`GET /api/v1/settings/sonarr`), as the anime-tags preflight reads it: its
 * id and name and the two tag lists. The whole object (it carries the Sonarr API key) never leaves the write client.
 */
export const seerrSonarrServerSummarySchema = z.object({
  id: z.number().int(),
  name: z.string().nullish(),
  is4k: z.boolean().nullish(),
  isDefault: z.boolean().nullish(),
  tags: z.array(z.number().int()).nullish(),
  animeTags: z.array(z.number().int()).nullish(),
});
export type SeerrSonarrServerSummary = z.infer<typeof seerrSonarrServerSummarySchema>;
