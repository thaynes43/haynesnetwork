// ADR-109 / DESIGN-055 D-09 (PLAN-077 P1) — the interactive-search release list (`GET /api/v3/release`), as the
// Replacement Preview reads it. Strip mode: only the fields below enter the app.
//
// Verified live 2026-10-12 against the running versions (Radarr 6.4.4.10685 `?movieId=2934`, 635 rows; Sonarr
// 4.0.20.3012 `?seriesId=1061&seasonNumber=1`, 542 rows):
// - `rejections` is an array of plain strings on both *arrs ("Existing file on disk has a equal or higher Custom Format
//   score: 5950", "WEBDL-1080p is not wanted in profile", "Release is blocklisted", ...). Older builds sent
//   `{reason, type}` objects; both forms are accepted and reduced to the reason text.
// - The list comes back in the *arr's own decision order: both ReleaseControllers run the decisions through
//   `PrioritizeDecisions` before mapping (DESIGN-055 Q-07, order half). Sonarr's season search groups by episode.
// - Every row carries `downloadUrl`, `infoUrl` and `commentUrl`, which can hold indexer API keys: none of them is read.
// - Sonarr rows carry `mappedSeasonNumber` / `mappedEpisodeNumbers` (the *arr's own mapping of the release onto the
//   series) beside the parsed `seasonNumber` / `episodeNumbers`; the mapped values win when present.
import { z } from 'zod';
import { arrReleaseQualitySchema } from './release-block';

const rejectionSchema = z.union([
  z.string(),
  z.object({ reason: z.string().nullish() }).transform((r) => r.reason ?? ''),
]);

const languageSchema = z.object({ id: z.number().int().nullish(), name: z.string().nullish() });

/** One release row of `GET /api/v3/release?movieId=` (Radarr) or `?episodeId=` / `?seriesId=&seasonNumber=` (Sonarr). */
export const arrReleaseSchema = z
  .object({
    guid: z.string(),
    indexerId: z.number().int().nullish(),
    indexer: z.string().nullish(),
    title: z.string().nullish(),
    size: z.number().nullish(),
    quality: arrReleaseQualitySchema,
    releaseGroup: z.string().nullish(),
    approved: z.boolean().nullish(),
    temporarilyRejected: z.boolean().nullish(),
    rejected: z.boolean().nullish(),
    rejections: z.array(rejectionSchema).nullish(),
    customFormatScore: z.number().nullish(),
    languages: z.array(languageSchema).nullish(),
    protocol: z.string().nullish(),
    ageHours: z.number().nullish(),
    edition: z.string().nullish(),
    seasonNumber: z.number().int().nullish(),
    mappedSeasonNumber: z.number().int().nullish(),
    episodeNumbers: z.array(z.number().int()).nullish(),
    mappedEpisodeNumbers: z.array(z.number().int()).nullish(),
    fullSeason: z.boolean().nullish(),
  })
  .transform((r) => ({
    guid: r.guid,
    indexerId: r.indexerId ?? null,
    indexer: r.indexer ?? null,
    title: r.title ?? '',
    size: r.size ?? null,
    qualityName: r.quality?.quality?.name ?? null,
    resolution: r.quality?.quality?.resolution ?? null,
    source: r.quality?.quality?.source ?? null,
    revision: r.quality?.revision?.version ?? null,
    releaseGroup: r.releaseGroup && r.releaseGroup.trim() !== '' ? r.releaseGroup : null,
    approved: r.approved === true,
    temporarilyRejected: r.temporarilyRejected === true,
    rejections: (r.rejections ?? []).filter((x) => x.trim() !== ''),
    customFormatScore: r.customFormatScore ?? null,
    languages: (r.languages ?? []).map((l) => l.name ?? '').filter((n) => n !== ''),
    protocol: r.protocol ?? null,
    ageHours: r.ageHours ?? null,
    edition: r.edition ?? null,
    seasonNumber: r.mappedSeasonNumber ?? r.seasonNumber ?? null,
    episodeNumbers:
      r.mappedEpisodeNumbers && r.mappedEpisodeNumbers.length > 0
        ? r.mappedEpisodeNumbers
        : (r.episodeNumbers ?? []),
    fullSeason: r.fullSeason === true,
  }));
export type ArrRelease = z.infer<typeof arrReleaseSchema>;
