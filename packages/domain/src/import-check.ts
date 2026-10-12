// ADR-109 C-05 / DESIGN-055 D-07 (PLAN-077 P2, issue #597 Part 1) — the Import Check (T-306), pure. It decides whether a
// finished download whose import is blocked can be imported onto its target, from the *arr's own manual-import view of
// the download (`GET /manualimport?downloadId=`), the queue records' mapping, and Title Evidence (T-304). Shared by a
// person's Force Search (one target) and the queue janitor's `importable` class (every record of the download,
// DESIGN-046 D-27). It never calls an *arr: the reads and the ManualImport write live with their callers.
//
// What counts (D-07 rule 2, with the P2 decisions in DESIGN-055 D-07):
// - every file to import maps to the target, by the *arr's manual-import mapping, else the queue record's own mapping,
//   and, when those disagree, the one Title Evidence agrees with;
// - no rejection beyond the identity rejections this check exists to overrule ("matched to series|movie by ID",
//   "unexpected considering the ... folder name", "not found in the grabbed release");
// - Title Evidence `agrees` or `silent` (an ambiguous title is not enough to import on), and the release does not name
//   another year's show (a Rugrats 2021 release on the 1991 series, a Franklin 2025 release on the 1997 one, read live);
// - the file's series or movie is the target's.
import type {
  ManualImportRejection,
  RadarrManualImportCandidate,
  RadarrManualImportFile,
  SonarrManualImportCandidate,
  SonarrManualImportFile,
} from '@hnet/arr';
import {
  episodeTitleEvidence,
  movieTitleEvidence,
  seriesYearConflict,
  type TitleEvidenceEpisode,
  type TitleVerdict,
} from './title-evidence';

/** Bump when a rule or a pattern below changes (the census rows carry the reason text, not this number). */
export const IMPORT_CHECK_VERSION = 1;

/** D-07 rule 2: the identity rejections the Import Check overrules (Sonarr 4.0.20 / Radarr 6.4.4 wording). */
const IDENTITY_REJECTIONS = [
  /matched to (?:series|movie) by id/i,
  /unexpected considering the\b.*\bfolder name/i,
  /not found in the grabbed release/i,
];
/** D-07 rule 5: a release defect (the upstream NotSampleSpecification "Sample", and the unpack and parse failures). */
const DEFECT_REJECTIONS = [/^sample\.?$/i, /unable to parse/i, /password/i, /executable/i];
/** D-07 rule 6 / DESIGN-046 D-26: an archive the download client left packed. Report only. */
const ARCHIVE = /found archive file/i;
/** The *arr already holds this at the same or better quality. */
const NOT_AN_UPGRADE = [/not an upgrade/i, /not a custom format upgrade/i, /cutoff.*already.*met/i];
/** The *arr's verbatim sample rejection. */
const SAMPLE = /^sample\.?$/i;

/**
 * The Import Check's verdict on one download.
 * - `importable`: import it (the `files` are the exact ManualImport files);
 * - `title_mismatch`: the names disagree with the target (Title Evidence `disagrees` or `ambiguous`, the release names
 *   another year's show, or the file and the download disagree about the episode); never imported automatically;
 * - `release_defect`: a sample, password, unparseable or executable rejection: remove with blocklist, search once;
 * - `archive`: the download is still packed (report only, DESIGN-046 D-26);
 * - `not_importable`: anything else, for staff.
 */
export type ImportCheckVerdict = 'importable' | 'title_mismatch' | 'release_defect' | 'archive' | 'not_importable';

/** Why, as a stable code the guide words for people and the janitor's census reason spells out. */
export type ImportCheckReason =
  | 'ok'
  | 'archive'
  | 'no_files'
  | 'only_sample'
  | 'defect'
  | 'have_better'
  | 'temporary'
  | 'rejected'
  | 'no_mapping'
  | 'other_series'
  | 'no_file_for_target'
  | 'several_files'
  | 'missing_quality'
  | 'mapping_conflict'
  | 'uncovered_targets'
  | 'title_disagrees'
  | 'title_ambiguous'
  | 'year_conflict';

/** The file the check judged (the one to import, or the one that failed), as the guide's preview shows it. */
export interface ImportCheckFileSummary {
  fileName: string;
  sizeBytes: number | null;
  qualityName: string | null;
  languages: string[];
  releaseGroup: string | null;
  /** The episodes (Sonarr) the file lands on, or the movie id (Radarr). */
  targetIds: number[];
}

export interface ImportCheckTitle {
  verdict: TitleVerdict;
  /** `disagrees`: the episode the title names. */
  bestEpisodeId: number | null;
  bestScore: number | null;
  againstScore: number | null;
  /** The release's own year when it names another year's show. */
  conflictingYear: number | null;
}

export interface ImportCheckResult {
  verdict: ImportCheckVerdict;
  reason: ImportCheckReason;
  /** The *arr's own rejection text behind `defect`, `have_better`, `temporary` or `rejected`, else null. */
  detail: string | null;
  downloadId: string;
  /** The judged file, when there is one. */
  file: ImportCheckFileSummary | null;
  title: ImportCheckTitle | null;
}

export interface SonarrImportCheck extends ImportCheckResult {
  kind: 'sonarr';
  /** `importable` only: exactly the ManualImport files to send. */
  files: SonarrManualImportFile[];
}

export interface RadarrImportCheck extends ImportCheckResult {
  kind: 'radarr';
  files: RadarrManualImportFile[];
}

/** The live queue texts of one download (its `errorMessage` and every statusMessage title and message). */
export function queueTexts(
  records: ReadonlyArray<{
    errorMessage?: string | null;
    statusMessages?: Array<{ title?: string | null; messages?: (string | null)[] | null }> | null;
  }>,
): string[] {
  const out: string[] = [];
  for (const r of records) {
    if (r.errorMessage) out.push(r.errorMessage);
    for (const sm of r.statusMessages ?? []) {
      if (sm.title) out.push(sm.title);
      for (const m of sm.messages ?? []) if (m) out.push(m);
    }
  }
  return out;
}

/** True when a queue text says the *arr doubts the grab's identity (the class of item the check exists for). */
export function hasIdentityRejection(texts: readonly string[]): boolean {
  return texts.some((t) => IDENTITY_REJECTIONS.some((p) => p.test(t)));
}

const baseName = (path: string): string => {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
};

interface RejectionJudgement {
  verdict: Exclude<ImportCheckVerdict, 'importable' | 'title_mismatch'>;
  reason: ImportCheckReason;
  detail: string;
}

/** The first rejection the check cannot overrule, judged; null when every rejection is an identity one. */
function judgeRejections(rejections: readonly ManualImportRejection[]): RejectionJudgement | null {
  for (const r of rejections) {
    const reason = r.reason.trim();
    if (reason === '' || IDENTITY_REJECTIONS.some((p) => p.test(reason))) continue;
    if (ARCHIVE.test(reason)) return { verdict: 'archive', reason: 'archive', detail: reason };
    if (DEFECT_REJECTIONS.some((p) => p.test(reason))) return { verdict: 'release_defect', reason: 'defect', detail: reason };
    if (NOT_AN_UPGRADE.some((p) => p.test(reason))) return { verdict: 'not_importable', reason: 'have_better', detail: reason };
    if ((r.type ?? '').toLowerCase() === 'temporary') {
      return { verdict: 'not_importable', reason: 'temporary', detail: reason };
    }
    return { verdict: 'not_importable', reason: 'rejected', detail: reason };
  }
  return null;
}

const isSample = (c: { rejections?: ManualImportRejection[] | null }): boolean =>
  (c.rejections ?? []).some((r) => SAMPLE.test(r.reason.trim()));

function summary(
  c: SonarrManualImportCandidate | RadarrManualImportCandidate,
  targetIds: number[],
): ImportCheckFileSummary {
  return {
    fileName: baseName(c.path),
    sizeBytes: c.size ?? null,
    qualityName: c.quality?.quality?.name ?? null,
    languages: (c.languages ?? []).map((l) => l.name ?? '').filter((n) => n !== ''),
    releaseGroup: c.releaseGroup && c.releaseGroup.trim() !== '' ? c.releaseGroup : null,
    targetIds,
  };
}

/** The verdict order when several files of one download fail: the most actionable first. */
const SEVERITY: Record<ImportCheckVerdict, number> = {
  archive: 4,
  release_defect: 3,
  not_importable: 2,
  title_mismatch: 1,
  importable: 0,
};

// ---------------------------------------------------------------------------
// Sonarr
// ---------------------------------------------------------------------------

export interface SonarrImportCheckInput {
  downloadId: string;
  /** The target's series and its year (a `null` year skips the year rule). */
  seriesId: number;
  seriesYear: number | null;
  /**
   * The episodes to import. `target` mode (a person's Force Search): the one target episode; only the file that holds
   * it is judged and imported. `download` mode (the janitor): every episode the download's queue records track; every
   * file must pass and every episode must be covered.
   */
  targetEpisodeIds: readonly number[];
  mode: 'target' | 'download';
  /** Every episode the download's queue records track (the queue's own mapping). */
  recordEpisodeIds: readonly number[];
  /** The download's release title (the queue record's `title`), Title Evidence's second source. */
  releaseTitle: string | null;
  /** The download's queue texts (queueTexts): an archive message there is report only. */
  queueMessages: readonly string[];
  /** `GET /manualimport?downloadId=`. */
  candidates: readonly SonarrManualImportCandidate[];
  /** The series' episodes (the *arr's list), for Title Evidence. */
  episodes: readonly TitleEvidenceEpisode[];
}

interface SonarrFileJudgement {
  candidate: SonarrManualImportCandidate;
  mapping: number[];
  verdict: ImportCheckVerdict;
  reason: ImportCheckReason;
  detail: string | null;
  title: ImportCheckTitle | null;
}

const sameSet = (a: readonly number[], b: readonly number[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));
const subsetOf = (a: readonly number[], b: readonly number[]): boolean => a.every((x) => b.includes(x));

/** Title Evidence for one file against a mapping: the file name first, the release title when the file is silent. */
function sonarrTitle(
  input: SonarrImportCheckInput,
  candidate: SonarrManualImportCandidate,
  against: readonly number[],
): ImportCheckTitle {
  const names = [candidate.name ?? baseName(candidate.path), baseName(candidate.path), input.releaseTitle].filter(
    (n): n is string => typeof n === 'string' && n.trim() !== '',
  );
  let evidence = episodeTitleEvidence({ name: names[0] ?? '', episodes: input.episodes, againstEpisodeIds: against });
  for (const name of names.slice(1)) {
    if (evidence.verdict !== 'silent') break;
    evidence = episodeTitleEvidence({ name, episodes: input.episodes, againstEpisodeIds: against });
  }
  let conflictingYear: number | null = null;
  for (const name of names) {
    conflictingYear = seriesYearConflict({ name, seriesYear: input.seriesYear });
    if (conflictingYear !== null) break;
  }
  return {
    verdict: evidence.verdict,
    bestEpisodeId: evidence.bestEpisodeId,
    bestScore: evidence.bestScore,
    againstScore: evidence.againstScore,
    conflictingYear,
  };
}

const titleOk = (t: ImportCheckTitle): boolean =>
  (t.verdict === 'agrees' || t.verdict === 'silent') && t.conflictingYear === null;

function titleFailure(t: ImportCheckTitle): { reason: ImportCheckReason } {
  if (t.conflictingYear !== null) return { reason: 'year_conflict' };
  return { reason: t.verdict === 'disagrees' ? 'title_disagrees' : 'title_ambiguous' };
}

function judgeSonarrFile(
  input: SonarrImportCheckInput,
  candidate: SonarrManualImportCandidate,
  soleFile: boolean,
): SonarrFileJudgement {
  const fail = (
    verdict: ImportCheckVerdict,
    reason: ImportCheckReason,
    mapping: number[],
    detail: string | null = null,
    title: ImportCheckTitle | null = null,
  ): SonarrFileJudgement => ({ candidate, mapping, verdict, reason, detail, title });

  // 1. The mapping (D-07 rule 2): the manual-import view's, else the queue's; when they disagree, the one Title
  //    Evidence agrees with.
  const own = (candidate.episodes ?? []).map((e) => e.id);
  const records = [...input.recordEpisodeIds];
  let mapping: number[];
  let title: ImportCheckTitle;
  if (own.length > 0 && (records.length === 0 || subsetOf(own, records))) {
    mapping = own;
    title = sonarrTitle(input, candidate, mapping);
  } else if (own.length === 0) {
    if (!soleFile || records.length === 0) return fail('not_importable', 'no_mapping', []);
    mapping = records;
    title = sonarrTitle(input, candidate, mapping);
  } else {
    const byOwn = sonarrTitle(input, candidate, own);
    const byRecords = sonarrTitle(input, candidate, records);
    const ownAgrees = byOwn.verdict === 'agrees' && byOwn.conflictingYear === null;
    const recordsAgree = byRecords.verdict === 'agrees' && byRecords.conflictingYear === null;
    if (ownAgrees === recordsAgree) return fail('title_mismatch', 'mapping_conflict', own, null, byOwn);
    mapping = ownAgrees ? own : records;
    title = ownAgrees ? byOwn : byRecords;
  }

  // 2. The series: the file's own series must be the target's.
  if (candidate.series && candidate.series.id !== input.seriesId) {
    return fail('not_importable', 'other_series', mapping, null, title);
  }

  // 3. Rejections beyond the identity ones.
  const rejection = judgeRejections(candidate.rejections ?? []);
  if (rejection) return fail(rejection.verdict, rejection.reason, mapping, rejection.detail, title);

  // 4. The names (Title Evidence and the series year).
  if (!titleOk(title)) return fail('title_mismatch', titleFailure(title).reason, mapping, null, title);

  // 5. The UI refuses an import without a quality or languages; so does the check.
  if (!candidate.quality || !candidate.languages) return fail('not_importable', 'missing_quality', mapping, null, title);

  return { candidate, mapping, verdict: 'importable', reason: 'ok', detail: null, title };
}

/** The ManualImport file for one judged candidate, exactly the UI's fields; a field the candidate lacks is left out. */
function sonarrFile(
  input: SonarrImportCheckInput,
  judged: SonarrFileJudgement,
): SonarrManualImportFile {
  const c = judged.candidate;
  const file: SonarrManualImportFile = {
    path: c.path,
    seriesId: input.seriesId,
    episodeIds: judged.mapping,
    quality: c.quality!,
    languages: c.languages!,
    indexerFlags: c.indexerFlags ?? 0,
    downloadId: input.downloadId,
  };
  if (c.folderName) file.folderName = c.folderName;
  if (c.releaseGroup) file.releaseGroup = c.releaseGroup;
  if (c.releaseType) file.releaseType = c.releaseType;
  if (c.episodeFileId) file.episodeFileId = c.episodeFileId;
  return file;
}

/** The Import Check for one Sonarr download (D-07). Pure. */
export function checkSonarrImport(input: SonarrImportCheckInput): SonarrImportCheck {
  const result = (
    verdict: ImportCheckVerdict,
    reason: ImportCheckReason,
    extra: Partial<Pick<SonarrImportCheck, 'detail' | 'file' | 'title' | 'files'>> = {},
  ): SonarrImportCheck => ({
    kind: 'sonarr',
    verdict,
    reason,
    detail: extra.detail ?? null,
    downloadId: input.downloadId,
    file: extra.file ?? null,
    title: extra.title ?? null,
    files: extra.files ?? [],
  });

  // Rule 6: a packed download is report only, whatever else it says.
  const archiveText = input.queueMessages.find((t) => ARCHIVE.test(t));
  if (archiveText) return result('archive', 'archive', { detail: archiveText });
  const archiveCandidate = input.candidates.find((c) => (c.rejections ?? []).some((r) => ARCHIVE.test(r.reason)));
  if (archiveCandidate) return result('archive', 'archive', { file: summary(archiveCandidate, []) });

  if (input.candidates.length === 0) return result('not_importable', 'no_files');
  const real = input.candidates.filter((c) => !isSample(c));
  if (real.length === 0) {
    return result('release_defect', 'only_sample', { file: summary(input.candidates[0]!, []), detail: 'Sample' });
  }

  const judged = real.map((c) => judgeSonarrFile(input, c, real.length === 1));
  const targets = [...input.targetEpisodeIds];

  if (input.mode === 'target') {
    const holding = judged.filter((j) => j.mapping.some((id) => targets.includes(id)));
    if (holding.length === 0) {
      // The one file of a single-file download that could not be mapped, or a pack without the target.
      const worst = judged.find((j) => j.verdict !== 'importable');
      if (worst && real.length === 1) {
        return result(worst.verdict, worst.reason, {
          detail: worst.detail,
          title: worst.title,
          file: summary(worst.candidate, worst.mapping),
        });
      }
      return result('not_importable', 'no_file_for_target');
    }
    if (holding.length > 1) return result('not_importable', 'several_files');
    const one = holding[0]!;
    if (one.verdict !== 'importable') {
      return result(one.verdict, one.reason, {
        detail: one.detail,
        title: one.title,
        file: summary(one.candidate, one.mapping),
      });
    }
    return result('importable', 'ok', {
      title: one.title,
      file: summary(one.candidate, one.mapping),
      files: [sonarrFile(input, one)],
    });
  }

  // download mode: every file passes and every tracked episode is covered, exactly once.
  const failed = judged
    .filter((j) => j.verdict !== 'importable')
    .sort((a, b) => SEVERITY[b.verdict] - SEVERITY[a.verdict]);
  if (failed.length > 0) {
    const w = failed[0]!;
    return result(w.verdict, w.reason, { detail: w.detail, title: w.title, file: summary(w.candidate, w.mapping) });
  }
  const covered = judged.flatMap((j) => j.mapping);
  if (new Set(covered).size !== covered.length) return result('not_importable', 'several_files');
  if (!subsetOf(targets, covered)) return result('not_importable', 'uncovered_targets');
  const first = judged[0]!;
  return result('importable', 'ok', {
    title: first.title,
    file: summary(first.candidate, covered),
    files: judged.map((j) => sonarrFile(input, j)),
  });
}

/**
 * D-07 rule 4 — "Import this download onto...": the import of a `disagrees` download onto the episode a person chose,
 * allowed only for the episode Title Evidence names or the grab's own target (anything else is for staff). Every other
 * rule still holds: the file's series, no rejection beyond the identity ones, a release that does not name another
 * year's show. Returns the importable check with `files` mapped onto `ontoEpisodeId`, or the reason it is refused.
 */
export function checkSonarrImportOnto(input: SonarrImportCheckInput, ontoEpisodeId: number): SonarrImportCheck {
  const base = checkSonarrImport({ ...input, mode: 'target' });
  const refuse = (reason: ImportCheckReason): SonarrImportCheck => ({ ...base, verdict: 'not_importable', reason, files: [] });
  if (base.verdict !== 'title_mismatch' || base.reason !== 'title_disagrees' || !base.title || !base.file) {
    return base.verdict === 'importable' ? refuse('rejected') : base;
  }
  const allowed = new Set<number>([...input.targetEpisodeIds, ...(base.title.bestEpisodeId ? [base.title.bestEpisodeId] : [])]);
  if (!allowed.has(ontoEpisodeId)) return refuse('rejected');
  const candidate = input.candidates.find((c) => baseName(c.path) === base.file!.fileName && !isSample(c));
  if (!candidate || !candidate.quality || !candidate.languages) return refuse('missing_quality');
  const judged: SonarrFileJudgement = {
    candidate,
    mapping: [ontoEpisodeId],
    verdict: 'importable',
    reason: 'ok',
    detail: null,
    title: base.title,
  };
  return {
    ...base,
    verdict: 'importable',
    reason: 'ok',
    file: summary(candidate, [ontoEpisodeId]),
    files: [sonarrFile(input, judged)],
  };
}

// ---------------------------------------------------------------------------
// Radarr
// ---------------------------------------------------------------------------

export interface RadarrImportCheckInput {
  downloadId: string;
  movie: {
    id: number;
    title: string;
    originalTitle?: string | null;
    alternateTitles?: ReadonlyArray<{ title: string }> | null;
    year: number | null;
  };
  releaseTitle: string | null;
  queueMessages: readonly string[];
  candidates: readonly RadarrManualImportCandidate[];
}

/** The Import Check for one Radarr download (D-07). Pure. */
export function checkRadarrImport(input: RadarrImportCheckInput): RadarrImportCheck {
  const result = (
    verdict: ImportCheckVerdict,
    reason: ImportCheckReason,
    extra: Partial<Pick<RadarrImportCheck, 'detail' | 'file' | 'title' | 'files'>> = {},
  ): RadarrImportCheck => ({
    kind: 'radarr',
    verdict,
    reason,
    detail: extra.detail ?? null,
    downloadId: input.downloadId,
    file: extra.file ?? null,
    title: extra.title ?? null,
    files: extra.files ?? [],
  });

  const archiveText = input.queueMessages.find((t) => ARCHIVE.test(t));
  if (archiveText) return result('archive', 'archive', { detail: archiveText });
  const archiveCandidate = input.candidates.find((c) => (c.rejections ?? []).some((r) => ARCHIVE.test(r.reason)));
  if (archiveCandidate) return result('archive', 'archive', { file: summary(archiveCandidate, []) });

  if (input.candidates.length === 0) return result('not_importable', 'no_files');
  const real = input.candidates.filter((c) => !isSample(c));
  if (real.length === 0) {
    return result('release_defect', 'only_sample', { file: summary(input.candidates[0]!, []), detail: 'Sample' });
  }
  if (real.length > 1) return result('not_importable', 'several_files', { file: summary(real[0]!, [input.movie.id]) });
  const c = real[0]!;
  const file = summary(c, [input.movie.id]);
  if (c.movie && c.movie.id !== input.movie.id) return result('not_importable', 'other_series', { file });

  const rejection = judgeRejections(c.rejections ?? []);
  const titles = [
    input.movie.title,
    input.movie.originalTitle ?? '',
    ...(input.movie.alternateTitles ?? []).map((a) => a.title),
  ].filter((t) => t.trim() !== '');
  const names = [c.name ?? baseName(c.path), baseName(c.path), input.releaseTitle].filter(
    (n): n is string => typeof n === 'string' && n.trim() !== '',
  );
  let evidence = movieTitleEvidence({ name: names[0] ?? '', titles, year: input.movie.year });
  for (const name of names.slice(1)) {
    if (evidence.verdict !== 'silent') break;
    evidence = movieTitleEvidence({ name, titles, year: input.movie.year });
  }
  const title: ImportCheckTitle = {
    verdict: evidence.verdict,
    bestEpisodeId: null,
    bestScore: evidence.score,
    againstScore: evidence.score,
    conflictingYear: null,
  };
  if (rejection) return result(rejection.verdict, rejection.reason, { detail: rejection.detail, file, title });
  if (evidence.verdict === 'ambiguous') return result('title_mismatch', 'title_ambiguous', { file, title });
  if (!c.quality || !c.languages) return result('not_importable', 'missing_quality', { file, title });

  const out: RadarrManualImportFile = {
    path: c.path,
    movieId: input.movie.id,
    quality: c.quality,
    languages: c.languages,
    indexerFlags: c.indexerFlags ?? 0,
    downloadId: input.downloadId,
  };
  if (c.folderName) out.folderName = c.folderName;
  if (c.releaseGroup) out.releaseGroup = c.releaseGroup;
  if (c.movieFileId) out.movieFileId = c.movieFileId;
  return result('importable', 'ok', { file, title, files: [out] });
}

/** The census reason the janitor stores for a verdict (≤500 chars): plain, stable, the *arr's text when it has one. */
export function importCheckReasonText(check: ImportCheckResult): string {
  const why: Record<ImportCheckReason, string> = {
    ok: 'passed',
    archive: 'Archive left unpacked',
    no_files: 'No importable file in the download',
    only_sample: 'Only a sample was downloaded',
    defect: 'Release defect',
    have_better: 'Not an upgrade',
    temporary: 'Cannot import yet',
    rejected: 'Rejected',
    no_mapping: 'No episode mapping',
    other_series: 'Mapped to another series or movie',
    no_file_for_target: 'No file for the target',
    several_files: 'More than one file for one target',
    missing_quality: 'No quality or language parsed',
    mapping_conflict: 'The file and the download name different episodes',
    uncovered_targets: 'Some tracked episodes have no file',
    title_disagrees: 'Title names another episode',
    title_ambiguous: 'Title does not match',
    year_conflict: 'Release names another year',
  };
  const parts = [`Import Check: ${why[check.reason]}`];
  if (check.reason === 'year_conflict' && check.title?.conflictingYear) parts.push(String(check.title.conflictingYear));
  if (check.reason === 'title_disagrees' && check.title?.bestEpisodeId) parts.push(`episode ${check.title.bestEpisodeId}`);
  if (check.detail) parts.push(check.detail);
  if (check.file) parts.push(check.file.fileName);
  const text = parts.join(': ');
  return text.length > 500 ? text.slice(0, 500) : text;
}

/** Whether two checks would do the same thing (the plan digest's import half). */
export function sameImport(a: ImportCheckResult & { files: unknown[] }, b: ImportCheckResult & { files: unknown[] }): boolean {
  return (
    a.verdict === b.verdict &&
    a.downloadId === b.downloadId &&
    JSON.stringify(a.files) === JSON.stringify(b.files) &&
    sameSet(a.file?.targetIds ?? [], b.file?.targetIds ?? [])
  );
}
