// ADR-109 C-05 / DESIGN-055 D-07 (PLAN-077 P2) — the *arr's manual-import view of one finished download
// (`GET /api/v3/manualimport?downloadId=`), the ManualImport command body built from it, and the command status read.
//
// Verified live 2026-10-12 against the running versions (Sonarr 4.0.20.3012, Radarr 6.4.4.10685), and against their
// source at those tags:
// - The read sends `downloadId` (and `filterExistingFiles`) only. Sonarr 4.0.20's ManualImportController takes the
//   SERIES-FOLDER branch whenever `seriesId` is present (`if (seriesId.HasValue)`), so a `seriesId` beside the download
//   id lists the series' library files instead of the download (read live on A Woman of Substance). The queue's own
//   "Manual Import" button sends only `downloadId` too (QueueRow.tsx → InteractiveImportModal).
// - Each candidate carries the *arr's own mapping (`series` + `episodes`, or `movie`), the parsed `quality`,
//   `languages`, `releaseGroup`, `indexerFlags`, Sonarr's `releaseType`, and `rejections` as `{reason, type}` objects
//   (`type` is `permanent` or `temporary`).
// - `quality` and `languages` are echoed back VERBATIM in the command (the UI does the same), so both are kept loose
//   (every field the *arr sent survives the parse).
import { z } from 'zod';

/** One import rejection: `{reason, type}` on both *arrs (a bare string is accepted defensively). */
export const manualImportRejectionSchema = z.union([
  z.object({ reason: z.string().nullish(), type: z.string().nullish() }).transform((r) => ({
    reason: r.reason ?? '',
    type: r.type ?? null,
  })),
  z.string().transform((reason) => ({ reason, type: null as string | null })),
]);
export type ManualImportRejection = z.infer<typeof manualImportRejectionSchema>;

/** The quality object as the *arr sent it; echoed back unchanged in the command. */
export const manualImportQualitySchema = z.looseObject({
  quality: z.looseObject({
    id: z.number().int(),
    name: z.string().nullish(),
    source: z.string().nullish(),
    resolution: z.number().nullish(),
  }),
  revision: z.looseObject({ version: z.number().int().nullish(), real: z.number().int().nullish() }).nullish(),
});
export type ManualImportQuality = z.infer<typeof manualImportQualitySchema>;

export const manualImportLanguageSchema = z.looseObject({ id: z.number().int(), name: z.string().nullish() });
export type ManualImportLanguage = z.infer<typeof manualImportLanguageSchema>;

const manualImportEpisodeSchema = z.object({
  id: z.number().int(),
  seriesId: z.number().int().nullish(),
  seasonNumber: z.number().int(),
  episodeNumber: z.number().int(),
  title: z.string().nullish(),
  hasFile: z.boolean().nullish(),
  episodeFileId: z.number().int().nullish(),
});

const candidateBaseShape = {
  /** The *arr's id for this candidate row (not stable). */
  id: z.number().int().nullish(),
  path: z.string(),
  relativePath: z.string().nullish(),
  folderName: z.string().nullish(),
  /** The file name without extension, as the *arr parsed it. */
  name: z.string().nullish(),
  size: z.number().nullish(),
  quality: manualImportQualitySchema.nullish(),
  languages: z.array(manualImportLanguageSchema).nullish(),
  releaseGroup: z.string().nullish(),
  indexerFlags: z.number().int().nullish(),
  downloadId: z.string().nullish(),
  customFormatScore: z.number().nullish(),
  rejections: z.array(manualImportRejectionSchema).nullish(),
};

/** One Sonarr manual-import candidate (`GET /api/v3/manualimport?downloadId=`). */
export const sonarrManualImportCandidateSchema = z.object({
  ...candidateBaseShape,
  series: z.object({ id: z.number().int(), title: z.string().nullish(), year: z.number().int().nullish() }).nullish(),
  seasonNumber: z.number().int().nullish(),
  episodes: z.array(manualImportEpisodeSchema).nullish(),
  episodeFileId: z.number().int().nullish(),
  releaseType: z.string().nullish(),
});
export type SonarrManualImportCandidate = z.infer<typeof sonarrManualImportCandidateSchema>;

/** One Radarr manual-import candidate. */
export const radarrManualImportCandidateSchema = z.object({
  ...candidateBaseShape,
  movie: z.object({ id: z.number().int(), title: z.string().nullish(), year: z.number().int().nullish() }).nullish(),
  movieFileId: z.number().int().nullish(),
});
export type RadarrManualImportCandidate = z.infer<typeof radarrManualImportCandidateSchema>;

/**
 * One file of a Sonarr `ManualImport` command, exactly the fields Sonarr 4.0.20.3012's interactive-import UI sends
 * (InteractiveImportModalContent.tsx `onImportSelectedPress`): `{path, folderName, seriesId, episodeIds, releaseGroup,
 * quality, languages, indexerFlags, releaseType, downloadId, episodeFileId}`. A field the candidate did not carry is
 * left out, as the UI's JSON.stringify drops `undefined`.
 */
export interface SonarrManualImportFile {
  path: string;
  folderName?: string;
  seriesId: number;
  episodeIds: number[];
  releaseGroup?: string;
  quality: ManualImportQuality;
  languages: ManualImportLanguage[];
  indexerFlags: number;
  releaseType?: string;
  downloadId: string;
  episodeFileId?: number;
}

/** One file of a Radarr `ManualImport` command (Radarr 6.4.4.10685's UI): `{path, folderName, movieId, releaseGroup,
 *  quality, languages, indexerFlags, downloadId, movieFileId}`. */
export interface RadarrManualImportFile {
  path: string;
  folderName?: string;
  movieId: number;
  releaseGroup?: string;
  quality: ManualImportQuality;
  languages: ManualImportLanguage[];
  indexerFlags: number;
  downloadId: string;
  movieFileId?: number;
}

/** `importMode`: the UI sends `auto` for a download (InteractiveImportModalContent: `downloadId ? 'auto' : ...`). */
export type ManualImportMode = 'auto' | 'move' | 'copy';

/**
 * `GET /api/v3/command/{id}` — a command's state. `status` is one of queued, started, completed, failed, aborted,
 * cancelled, orphaned (Servarr `CommandStatus`); `message` is the *arr's last status text.
 */
export const arrCommandStatusSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.string(),
  message: z.string().nullish(),
  result: z.string().nullish(),
  started: z.string().nullish(),
  ended: z.string().nullish(),
});
export type ArrCommandStatus = z.infer<typeof arrCommandStatusSchema>;

/**
 * DESIGN-055 D-04 rule 8 (PLAN-077 P4) — one row of Sonarr's `GET /rename?seriesId=&seasonNumber=` (RenameEpisodeFile
 * Preview): a file whose name on disk is not the one the naming format gives it. Read live on Sonarr 4.0.20.3012.
 */
export const sonarrRenamePreviewSchema = z.object({
  seriesId: z.number().int().nullish(),
  seasonNumber: z.number().int().nullish(),
  episodeNumbers: z.array(z.number().int()).nullish(),
  episodeFileId: z.number().int(),
  existingPath: z.string().nullish(),
  newPath: z.string().nullish(),
});
export type SonarrRenamePreview = z.infer<typeof sonarrRenamePreviewSchema>;
