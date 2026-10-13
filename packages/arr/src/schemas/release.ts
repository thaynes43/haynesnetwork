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
//
// ADR-109 C-02, C-06 / DESIGN-055 D-06 (PLAN-077 P5) — the Release Pick reads the same rows and grabs one of them. An
// override grab echoes the row's own `quality` and `languages` objects VERBATIM (Sonarr 4.0.20.3012's and Radarr
// 6.4.4.10685's OverrideMatchModalContent send the row's QualityModel and Language list back unchanged), so both are also
// kept raw (`qualityModel`, `languageModels`, loose objects: every field the *arr sent survives). `downloadAllowed` is
// the *arr's own "this row maps onto the series" flag, which decides the UI's plain grab.
import { z } from 'zod';

/** The release's QualityModel as the *arr sent it: read for its names, echoed back unchanged in an override grab. */
export const arrReleaseQualityModelSchema = z.looseObject({
  quality: z
    .looseObject({
      id: z.number().int().nullish(),
      name: z.string().nullish(),
      resolution: z.number().int().nullish(),
      source: z.string().nullish(),
      modifier: z.string().nullish(),
    })
    .nullish(),
  /** DESIGN-055 D-09 — the release's revision (`version` 2+ is a PROPER or REPACK). */
  revision: z.looseObject({ version: z.number().int().nullish() }).nullish(),
});
export type ArrReleaseQualityModel = z.infer<typeof arrReleaseQualityModelSchema>;

/** One of the release's languages as the *arr sent it (`{id, name}`), echoed back unchanged in an override grab. */
export const arrReleaseLanguageModelSchema = z.looseObject({ id: z.number().int().nullish(), name: z.string().nullish() });
export type ArrReleaseLanguageModel = z.infer<typeof arrReleaseLanguageModelSchema>;

const rejectionSchema = z.union([
  z.string(),
  z.object({ reason: z.string().nullish() }).transform((r) => r.reason ?? ''),
]);

/** One release row of `GET /api/v3/release?movieId=` (Radarr) or `?episodeId=` / `?seriesId=&seasonNumber=` (Sonarr). */
export const arrReleaseSchema = z
  .object({
    guid: z.string(),
    indexerId: z.number().int().nullish(),
    indexer: z.string().nullish(),
    title: z.string().nullish(),
    size: z.number().nullish(),
    quality: arrReleaseQualityModelSchema.nullish(),
    releaseGroup: z.string().nullish(),
    approved: z.boolean().nullish(),
    temporarilyRejected: z.boolean().nullish(),
    rejected: z.boolean().nullish(),
    rejections: z.array(rejectionSchema).nullish(),
    customFormatScore: z.number().nullish(),
    languages: z.array(arrReleaseLanguageModelSchema).nullish(),
    protocol: z.string().nullish(),
    ageHours: z.number().nullish(),
    edition: z.string().nullish(),
    seasonNumber: z.number().int().nullish(),
    mappedSeasonNumber: z.number().int().nullish(),
    episodeNumbers: z.array(z.number().int()).nullish(),
    mappedEpisodeNumbers: z.array(z.number().int()).nullish(),
    fullSeason: z.boolean().nullish(),
    downloadAllowed: z.boolean().nullish(),
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
    /** DESIGN-055 D-06 — the *arr mapped the row onto the series and its episodes (the UI's plain grab needs it). */
    downloadAllowed: r.downloadAllowed === true,
    /** DESIGN-055 D-06 — the row's QualityModel, unchanged, for an override grab (null when the *arr sent none). */
    qualityModel: r.quality ?? null,
    /** DESIGN-055 D-06 — the row's languages, unchanged, for an override grab. */
    languageModels: r.languages ?? [],
  }));
export type ArrRelease = z.infer<typeof arrReleaseSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// ADR-109 C-02, C-06 / DESIGN-055 D-03, D-06 (PLAN-077 P5) — the interactive-search grab, `POST /api/v3/release`. The
// bodies are pinned to what each running UI sends (write-clients.test.ts), read from the source at the running tags:
// - the plain grab (InteractiveSearchRow.tsx, `downloadAllowed` true): `{guid, indexerId}`, on both *arrs;
// - the override grab (OverrideMatchModalContent.tsx): Sonarr 4.0.20.3012 sends `{guid, indexerId, seriesId, episodeIds,
//   quality, languages, downloadClientId, shouldOverride: true}`; Radarr 6.4.4.10685 sends `{indexerId, guid, movieId,
//   quality, languages, downloadClientId, shouldOverride: true}`. `downloadClientId` is null unless the person picks a
//   client there (the app never does), and `quality` / `languages` are the row's own objects, echoed unchanged.
// The *arr finds the row in its own release cache by `indexerId` and `guid` (30 minutes after the search that listed
// it, ReleaseController `_remoteEpisodeCache`), so a grab never searches again: an expired row answers 404 ("Couldn't
// find requested release in cache, try searching again"), and an indexer that will not hand over the file 409.
// ---------------------------------------------------------------------------------------------------------------------

/** The plain grab: a row the *arr approved and mapped (`downloadAllowed`). Same body on Sonarr and Radarr. */
export interface ArrReleaseGrab {
  guid: string;
  indexerId: number;
}

/** Sonarr's override grab: the row grabbed for exactly these episodes of this series, at the row's own quality. */
export interface SonarrReleaseOverrideGrab {
  guid: string;
  indexerId: number;
  seriesId: number;
  episodeIds: number[];
  quality: ArrReleaseQualityModel;
  languages: ArrReleaseLanguageModel[];
  downloadClientId: null;
  shouldOverride: true;
}

/** Radarr's override grab: the row grabbed for exactly this movie, at the row's own quality. */
export interface RadarrReleaseOverrideGrab {
  indexerId: number;
  guid: string;
  movieId: number;
  quality: ArrReleaseQualityModel;
  languages: ArrReleaseLanguageModel[];
  downloadClientId: null;
  shouldOverride: true;
}
