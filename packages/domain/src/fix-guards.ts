// ADR-109 C-03 / DESIGN-055 D-08, D-09 (PLAN-077 P1) — the Fix safety guards, pure. No I/O: fix-plan.ts reads the *arr
// and hands the facts in, so every rule here is unit-tested on fixtures taken from the live cases.
//
// 1. The Replacement Preview (T-308): which release the *arr would take once the file is gone. With the file on disk,
//    the *arr rejects every release that is not an upgrade ("Existing file on disk has a equal or higher Custom Format
//    score: 5950" on all 635 GoodFellas releases, read 2026-10-12). Those rejections vanish with the file, so the
//    replacement is the first release, in the *arr's own decision order, that is approved or rejected ONLY for the
//    existing file (an Existing-File Rejection, T-315). Anything else (blocklisted, a must-not-contain term, a
//    quality the profile does not want, a size limit, a delay) still stands after the delete.
// 2. The Same Release (T-308): the replacement is the file's own release again.
// 3. The season guard (D-09): which downloads back which episodes, so a pack that also holds episodes the person did
//    not choose is never marked failed.
// 4. The language check (D-08 rules 1-2): which audio languages the file carries.
import type { ArrDownloadClientConfig, ArrRelease, ArrReleaseHistoryRecord } from '@hnet/arr';

// ---------------------------------------------------------------------------------------------------------------
// Replacement Preview
// ---------------------------------------------------------------------------------------------------------------

/**
 * DESIGN-055 D-09 — an Existing-File Rejection (T-315): a rejection the *arr gives a release only because a file is on
 * disk. Every one of Radarr 6.4.4's and Sonarr 4.0.20's names it ("Existing file on disk is of equal or higher
 * preference", "Existing file on disk has a equal or higher Custom Format score", "Existing file on disk has Custom
 * Format score within Custom Format score increment", "Existing file meets cutoff", "... upgrades for existing file on
 * disk is not allowed").
 */
export function isExistingFileRejection(reason: string): boolean {
  return /\bexisting file\b/i.test(reason);
}

/** A release the *arr would take with the file gone: approved, or rejected only for the existing file. */
export function wouldTakeWithoutFile(release: ArrRelease): boolean {
  if (release.approved) return true;
  return release.rejections.length > 0 && release.rejections.every(isExistingFileRejection);
}

/**
 * The replacement: the first release in the *arr's decision order it would take once the file is gone (DESIGN-055
 * Q-07: `GET /release` returns that order). `covers` narrows a season list to the releases that hold one episode.
 */
export function replacementCandidate(
  releases: readonly ArrRelease[],
  covers?: (release: ArrRelease) => boolean,
): ArrRelease | null {
  for (const release of releases) {
    if (covers && !covers(release)) continue;
    if (wouldTakeWithoutFile(release)) return release;
  }
  return null;
}

/** Whether a Sonarr release holds this episode: a season pack of its season, or a release naming its number. */
export function releaseCoversEpisode(
  release: ArrRelease,
  episode: { seasonNumber: number; episodeNumber: number },
): boolean {
  if (release.seasonNumber !== null && release.seasonNumber !== episode.seasonNumber) return false;
  if (release.fullSeason) return true;
  return release.episodeNumbers.includes(episode.episodeNumber);
}

/** The current file, as the Same Release test sees it. */
export interface CurrentFileIdentity {
  /** The file's name in the library (the *arr's `relativePath`, renamed by the *arr). */
  fileName: string | null;
  /** The release name the *arr recorded for the file (`sceneName`), when it kept one. */
  sceneName: string | null;
  /** The release name from the file's import or grab history, when known. */
  releaseName: string | null;
  releaseGroup: string | null;
  qualityName: string | null;
  resolution: number | null;
  revision: number | null;
  edition: string | null;
  size: number | null;
  customFormatScore: number | null;
}

/**
 * A release name in comparable form: lowercase, no file extension, every run of non-alphanumerics one space.
 * `Goodfellas.1990.UHD.BluRay.2160p...-FraMeSToR` and `Goodfellas 1990 UHD BluRay 2160p ... FraMeSToR` are equal.
 */
export function normalizeReleaseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(mkv|mp4|avi|m4v|ts|wmv|mov)$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const sameText = (a: string | null, b: string | null): boolean =>
  (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/**
 * The size test. A torrent's listed size is the files' size, so it must be within 2 percent. A Usenet post's listed
 * size includes its yEnc and par2 overhead, so it may run from 2 percent under to 20 percent over the file: GoodFellas'
 * own FraMeSToR remux (an 87.61 GB file) was listed at 89.38 to 99.48 GB across four indexers (+2 to +14 percent).
 */
export function sizeMatches(fileSize: number, releaseSize: number, protocol: string | null): boolean {
  if (!(fileSize > 0) || !(releaseSize > 0)) return false;
  const ratio = releaseSize / fileSize;
  if ((protocol ?? '').toLowerCase() === 'torrent') return Math.abs(ratio - 1) <= 0.02;
  return ratio >= 0.98 && ratio <= 1.2;
}

export type SameReleaseBasis = 'name' | 'identity';

/**
 * DESIGN-055 D-09 / T-308 — is the replacement the Same Release as the file? Either:
 * - **name**: its normalized title equals the file's recorded release name (`sceneName`, or the name its import or grab
 *   history carries); or
 * - **identity**: the same release group (case-insensitive), quality, resolution and edition, not a newer revision (a
 *   PROPER or REPACK is a different release), the same custom-format score when the *arr scored both, and a size that
 *   fits ({@link sizeMatches}; a season pack offered for one episode skips the size test).
 * Returns the basis, or null when it is a different release. Without a release group, only the name can tell.
 */
export function sameReleaseBasis(
  current: CurrentFileIdentity,
  candidate: ArrRelease,
  options: { packForEpisode?: boolean } = {},
): SameReleaseBasis | null {
  const title = normalizeReleaseName(candidate.title);
  if (title !== '') {
    for (const name of [current.sceneName, current.releaseName]) {
      if (name && normalizeReleaseName(name) === title) return 'name';
    }
  }
  if (!current.releaseGroup || !candidate.releaseGroup) return null;
  if (!sameText(current.releaseGroup, candidate.releaseGroup)) return null;
  if (!current.qualityName || !candidate.qualityName || !sameText(current.qualityName, candidate.qualityName)) {
    return null;
  }
  if (current.resolution !== null && candidate.resolution !== null && current.resolution !== candidate.resolution) {
    return null;
  }
  if (!sameText(current.edition, candidate.edition)) return null;
  if (candidate.revision !== null && current.revision !== null && candidate.revision > current.revision) return null;
  if (
    current.customFormatScore !== null &&
    candidate.customFormatScore !== null &&
    current.customFormatScore !== candidate.customFormatScore
  ) {
    return null;
  }
  if (!options.packForEpisode) {
    if (current.size === null || candidate.size === null) return null;
    if (!sizeMatches(current.size, candidate.size, candidate.protocol)) return null;
  }
  return 'identity';
}

export type ReplacementVerdict = 'ok' | 'same_release' | 'no_replacement';

export interface ReplacementCheck {
  verdict: ReplacementVerdict;
  candidate: ArrRelease | null;
  basis: SameReleaseBasis | null;
}

/** The whole Replacement Preview for one file: the candidate and whether the Fix may delete. */
export function checkReplacement(
  current: CurrentFileIdentity,
  releases: readonly ArrRelease[],
  options: { covers?: (release: ArrRelease) => boolean; episodeOfPack?: boolean } = {},
): ReplacementCheck {
  const candidate = replacementCandidate(releases, options.covers);
  if (!candidate) return { verdict: 'no_replacement', candidate: null, basis: null };
  const basis = sameReleaseBasis(current, candidate, { packForEpisode: options.episodeOfPack && candidate.fullSeason });
  return { verdict: basis ? 'same_release' : 'ok', candidate, basis };
}

// ---------------------------------------------------------------------------------------------------------------
// Season guard: which downloads back which episodes
// ---------------------------------------------------------------------------------------------------------------

/** The latest grab of one episode, from the series history. */
export interface EpisodeGrab {
  grabId: number;
  episodeId: number;
  /** `dl:<downloadId>`, or `id:<grabId>` for a grab with no download id (it stands alone). */
  downloadKey: string;
  downloadId: string | null;
  sourceTitle: string | null;
  releaseSource: string | null;
  date: string | null;
}

/** The download key that groups a pack's grab records (Sonarr writes one grabbed record per episode, one downloadId). */
export function downloadKeyOf(record: { id: number; downloadId: string | null }): string {
  return record.downloadId && record.downloadId.trim() !== '' ? `dl:${record.downloadId}` : `id:${record.id}`;
}

/**
 * The latest `grabbed` record per episode, from `GET /history/series` (newest date wins, then the higher id). This is
 * the grab the Fix marks failed for that episode, as `GET /history?episodeId=&eventType=1` returns it first.
 */
export function latestGrabsByEpisode(history: readonly ArrReleaseHistoryRecord[]): Map<number, EpisodeGrab> {
  const out = new Map<number, EpisodeGrab>();
  for (const record of history) {
    if (record.eventType !== 'grabbed' || record.episodeId === null) continue;
    const known = out.get(record.episodeId);
    const newer =
      !known ||
      (record.date ?? '') > (known.date ?? '') ||
      ((record.date ?? '') === (known.date ?? '') && record.id > known.grabId);
    if (!newer) continue;
    out.set(record.episodeId, {
      grabId: record.id,
      episodeId: record.episodeId,
      downloadKey: downloadKeyOf(record),
      downloadId: record.downloadId,
      sourceTitle: record.sourceTitle,
      releaseSource: record.releaseSource,
      date: record.date,
    });
  }
  return out;
}

/** One download behind on-disk episodes: its first grab record (the one marked), and every on-disk episode it backs. */
export interface BackingDownload {
  downloadKey: string;
  downloadId: string | null;
  grabId: number;
  sourceTitle: string | null;
  releaseSource: string | null;
  /** On-disk episodes whose latest grab is this download, ascending. */
  episodeIds: number[];
}

/** Group on-disk episodes by the download of their latest grab. Episodes with no grab are left out. */
export function backingDownloads(
  latest: ReadonlyMap<number, EpisodeGrab>,
  onDiskEpisodeIds: readonly number[],
): BackingDownload[] {
  const byKey = new Map<string, BackingDownload>();
  for (const episodeId of [...onDiskEpisodeIds].sort((a, b) => a - b)) {
    const grab = latest.get(episodeId);
    if (!grab) continue;
    const known = byKey.get(grab.downloadKey);
    if (known) {
      known.episodeIds.push(episodeId);
      if (grab.grabId < known.grabId) {
        known.grabId = grab.grabId;
      }
    } else {
      byKey.set(grab.downloadKey, {
        downloadKey: grab.downloadKey,
        downloadId: grab.downloadId,
        grabId: grab.grabId,
        sourceTitle: grab.sourceTitle,
        releaseSource: grab.releaseSource,
        episodeIds: [episodeId],
      });
    }
  }
  return [...byKey.values()];
}

export interface SeasonGuardSplit {
  /** Downloads every on-disk episode of which the person chose: safe to mark failed. */
  markable: BackingDownload[];
  /** Downloads that also back on-disk episodes the person did not choose: never marked. */
  heldBack: Array<BackingDownload & { chosen: number[]; others: number[] }>;
  /** Chosen episodes with no grab record (nothing to mark). */
  noRecord: number[];
}

/**
 * DESIGN-055 D-09 — split a season Fix's chosen episodes by what marking their downloads would cost. Marking any record
 * of a download fails the whole download (DESIGN-005 D-25), so a pack that also holds an on-disk episode the person
 * marked fine is held back.
 */
export function splitSeasonByDownload(
  latest: ReadonlyMap<number, EpisodeGrab>,
  onDiskEpisodeIds: readonly number[],
  chosenEpisodeIds: readonly number[],
): SeasonGuardSplit {
  const chosen = new Set(chosenEpisodeIds);
  const downloads = backingDownloads(latest, onDiskEpisodeIds);
  const markable: BackingDownload[] = [];
  const heldBack: SeasonGuardSplit['heldBack'] = [];
  for (const download of downloads) {
    const mine = download.episodeIds.filter((id) => chosen.has(id));
    if (mine.length === 0) continue;
    const others = download.episodeIds.filter((id) => !chosen.has(id));
    if (others.length === 0) markable.push(download);
    else heldBack.push({ ...download, chosen: mine, others });
  }
  const noRecord = [...chosen].filter((id) => onDiskEpisodeIds.includes(id) && !latest.has(id)).sort((a, b) => a - b);
  return { markable, heldBack, noRecord };
}

/**
 * DESIGN-055 D-09 — the other on-disk episodes an episode Fix's blocklist would cost: those whose latest grab is the
 * same download as the target's.
 */
export function packCost(
  latest: ReadonlyMap<number, EpisodeGrab>,
  onDiskEpisodeIds: readonly number[],
  targetEpisodeId: number,
): number[] {
  const target = latest.get(targetEpisodeId);
  if (!target) return [];
  return onDiskEpisodeIds
    .filter((id) => id !== targetEpisodeId && latest.get(id)?.downloadKey === target.downloadKey)
    .sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------------------------------------------
// Language check
// ---------------------------------------------------------------------------------------------------------------

/**
 * ISO 639-2 codes as Sonarr and Radarr report a file's audio (`mediaInfo.audioLanguages`), to names people know. Both
 * the bibliographic and the terminology codes are listed where they differ (fre/fra, ger/deu, chi/zho, ...).
 */
export const AUDIO_LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  eng: 'English',
  spa: 'Spanish',
  por: 'Portuguese',
  fre: 'French',
  fra: 'French',
  ger: 'German',
  deu: 'German',
  ita: 'Italian',
  jpn: 'Japanese',
  kor: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  rus: 'Russian',
  hin: 'Hindi',
  ara: 'Arabic',
  dut: 'Dutch',
  nld: 'Dutch',
  swe: 'Swedish',
  nor: 'Norwegian',
  dan: 'Danish',
  fin: 'Finnish',
  pol: 'Polish',
  cze: 'Czech',
  ces: 'Czech',
  hun: 'Hungarian',
  tur: 'Turkish',
  gre: 'Greek',
  ell: 'Greek',
  heb: 'Hebrew',
  tha: 'Thai',
  vie: 'Vietnamese',
  ukr: 'Ukrainian',
  rum: 'Romanian',
  ron: 'Romanian',
  bul: 'Bulgarian',
  hrv: 'Croatian',
  srp: 'Serbian',
  slv: 'Slovenian',
  ind: 'Indonesian',
  may: 'Malay',
  msa: 'Malay',
  tam: 'Tamil',
  tel: 'Telugu',
  tgl: 'Tagalog',
  fil: 'Filipino',
  cat: 'Catalan',
  ice: 'Icelandic',
  isl: 'Icelandic',
  per: 'Persian',
  fas: 'Persian',
  slo: 'Slovak',
  slk: 'Slovak',
  lav: 'Latvian',
  lit: 'Lithuanian',
  est: 'Estonian',
  ben: 'Bengali',
  urd: 'Urdu',
};

/** One code per language: the terminology code folds into the bibliographic one the *arrs mostly send. */
const CODE_ALIASES: Readonly<Record<string, string>> = {
  fra: 'fre',
  deu: 'ger',
  zho: 'chi',
  nld: 'dut',
  ces: 'cze',
  ell: 'gre',
  ron: 'rum',
  msa: 'may',
  isl: 'ice',
  fas: 'per',
  slk: 'slo',
  nob: 'nor',
  nno: 'nor',
};

/** The canonical lowercase code for a language code (`FRA` → `fre`). */
export function canonicalLanguageCode(code: string): string {
  const c = code.trim().toLowerCase();
  return CODE_ALIASES[c] ?? c;
}

/** A language's display name; an unknown code is shown in capitals. */
export function audioLanguageName(code: string): string {
  const c = canonicalLanguageCode(code);
  return AUDIO_LANGUAGE_NAMES[c] ?? c.toUpperCase();
}

/**
 * The distinct audio languages of a file from its `mediaInfo.audioLanguages` (`"por/eng"`, `"eng/eng/eng"`), in track
 * order. Empty, `und` (undetermined) and `zxx` (no speech) carry no language.
 */
export function parseAudioLanguages(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const part of value.split(/[/,]/)) {
    const code = canonicalLanguageCode(part);
    if (code === '' || code === 'und' || code === 'zxx' || out.includes(code)) continue;
    out.push(code);
  }
  return out;
}

/** D-08 rule 3's test: the wanted language is among the file's audio tracks. */
export function fileHasLanguage(fileLanguages: readonly string[], wanted: string): boolean {
  return fileLanguages.includes(canonicalLanguageCode(wanted));
}

// ---------------------------------------------------------------------------------------------------------------
// ADR-109 C-07 / DESIGN-055 D-08 (PLAN-077 P6) — the languages the *arrs name and the locales Plex stores
// ---------------------------------------------------------------------------------------------------------------

/**
 * The names Sonarr 4.0.20 and Radarr 6.4.4 give languages (a series' or movie's `originalLanguage.name`, a release's
 * `languages[].name`) that are not plain AUDIO_LANGUAGE_NAMES entries, to their ISO 639-2 code. "Unknown", "Any" and
 * "Original" name no language.
 */
const ARR_LANGUAGE_NAME_CODES: Readonly<Record<string, string>> = {
  'portuguese (brazil)': 'por',
  'spanish (latino)': 'spa',
  flemish: 'dut',
  'norwegian bokmal': 'nor',
  'norwegian bokmål': 'nor',
  'chinese (simplified)': 'chi',
  'chinese (traditional)': 'chi',
  'mandarin': 'chi',
  'cantonese': 'chi',
};

/** The canonical ISO 639-2 code for a language the *arr names (`"English"` → `eng`), or null when it names none. */
export function languageCodeFromArrName(name: string | null | undefined): string | null {
  const n = (name ?? '').trim().toLowerCase();
  if (n === '' || n === 'unknown' || n === 'any' || n === 'original') return null;
  const special = ARR_LANGUAGE_NAME_CODES[n];
  if (special) return special;
  for (const [code, label] of Object.entries(AUDIO_LANGUAGE_NAMES)) {
    if (label.toLowerCase() === n) return canonicalLanguageCode(code);
  }
  return null;
}

/** Whether one of a release's languages, as the *arr parsed them from its name, is the wanted one. */
export function releaseHasLanguage(release: Pick<ArrRelease, 'languages'>, wanted: string): boolean {
  const code = canonicalLanguageCode(wanted);
  return release.languages.some((name) => languageCodeFromArrName(name) === code);
}

/** ISO 639-2 (canonical) to the two-letter ISO 639-1 code a Plex locale starts with (`eng` → `en`). */
const ISO_639_1: Readonly<Record<string, string>> = {
  eng: 'en',
  spa: 'es',
  por: 'pt',
  fre: 'fr',
  ger: 'de',
  ita: 'it',
  jpn: 'ja',
  kor: 'ko',
  chi: 'zh',
  rus: 'ru',
  hin: 'hi',
  ara: 'ar',
  dut: 'nl',
  swe: 'sv',
  nor: 'nb',
  dan: 'da',
  fin: 'fi',
  pol: 'pl',
  cze: 'cs',
  hun: 'hu',
  tur: 'tr',
  gre: 'el',
  heb: 'he',
  tha: 'th',
  vie: 'vi',
  ukr: 'uk',
  rum: 'ro',
  bul: 'bg',
  hrv: 'hr',
  srp: 'sr',
  slv: 'sl',
  ind: 'id',
  may: 'ms',
  tam: 'ta',
  tel: 'te',
  tgl: 'tl',
  cat: 'ca',
  ice: 'is',
  per: 'fa',
  slo: 'sk',
  lav: 'lv',
  lit: 'lt',
  est: 'et',
  ben: 'bn',
  urd: 'ur',
};

/** The language a Plex locale value names (`en-US` → `eng`, `nb-NO` → `nor`); `''` (Account default) names none. */
export function languageOfPlexLocale(value: string | null | undefined): string | null {
  const prefix = (value ?? '').trim().toLowerCase().split('-')[0] ?? '';
  if (prefix === '') return null;
  if (prefix === 'no' || prefix === 'nn') return 'nor';
  for (const [code, two] of Object.entries(ISO_639_1)) if (two === prefix) return code;
  return null;
}

/**
 * The Plex value to store for a language: the first of the item's own options (Plex's order, so English is `en-US`, not
 * `en-AU`) whose locale names it. Null when Plex offers none for it (its list is the Plex UI languages, about 45).
 */
export function plexLocaleFor(code: string, options: ReadonlyArray<{ value: string }>): string | null {
  const wanted = canonicalLanguageCode(code);
  for (const option of options) {
    if (option.value !== '' && languageOfPlexLocale(option.value) === wanted) return option.value;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// DESIGN-005 D-25 — the *arr's own Redownload Failed (moved here from fix-flow.ts in PLAN-077 P6, so the Language
// Replace's plan can read it too)
// ---------------------------------------------------------------------------------------------------------------

/**
 * DESIGN-005 D-25 (issue #646, the ADR-098 principle) — whether the *arr searches again by itself
 * after the Fix marks this grab failed. `POST /history/failed/{id}` publishes the *arr's
 * DownloadFailedEvent with `skipRedownload = false` (the endpoint takes no such parameter), and
 * upstream RedownloadFailedDownloadService then searches unless Redownload Failed is off, or the
 * grab came from an interactive search while its interactive-search twin is off (the grab
 * record's `data.releaseSource`). Its search always covers the Fix's target: the grab's own
 * episodes / movie / albums, or the season / artist when the grab was all of it. Pure.
 */
export function arrSearchesAfterMarkFailed(
  config: ArrDownloadClientConfig,
  grab: { data?: Record<string, unknown> | null },
): boolean {
  if (!config.autoRedownloadFailed) return false;
  const interactive = grab.data?.releaseSource === 'InteractiveSearch';
  return !interactive || config.autoRedownloadFailedFromInteractiveSearch !== false;
}
