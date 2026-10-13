// ADR-110 C-04, C-05, C-08 / DESIGN-055 D-05 (PLAN-077 P4) — the MISLABEL BLOCK (T-310).
//
// A release group that numbers a series wrongly (Case A: BiOMA's Lost Tapes pack, one episode behind TVDB from E12 on)
// keeps filing that series wrong for as long as Sonarr may grab it. After a person confirms an Episode Re-map whose
// evidence pins two or more files of one group on the series (D-04 rule 10), the guide offers "Stop <group> from filing
// this show again": one "must not contain" term naming the series AND the group goes into ONE app-owned Sonarr release
// profile, "haynesnetwork: mislabelled releases (managed, do not edit)", and is read back before the person is answered.
// The term is series-scoped by its own text (release-terms.ts `renderMislabelTerm`), so the profile has no tags.
//
// Single writer: this module, under `pg_advisory_xact_lock('mislabel-block:sonarr')`. A `mislabel_block_terms` row is
// inserted only in the transaction of the profile write and its read-back, so an `active` row is a term Sonarr
// confirmed. A write that cannot be read back answers "not saved" and records the attempt as a `removed` row
// (`ended_reason` `write_failed` or `read_back_failed`); a term it may have left in the profile is drift, which the
// hourly upkeep removes. Terms live 365 days (`expired`, `ended_reason` `expired`) and at most 500 are active; staff
// remove one with an audit row (`removed`, `staff_removed`, ADR-110 C-08). The adoption of Case A's hand-made
// profile (ADR-110 C-05) is one more term, origin `adoption`, through the same write and read-back.
//
// Separate from the Release Block (ADR-093), whose terms come only from Deleted-Release Records: its own profile name,
// its own sentinel, its own grammar (`isMislabelTerm`), and no other profile is ever touched. A copy of this profile
// (two profiles of the name) is never merged or deleted here: every write refuses (`duplicate_profile`) until staff
// remove the copy by hand, the Release Block's rule.
//
// ADR-113 (the owner's ruling on DESIGN-055 Q-10, 2026-10-13) adds a second term kind, the MISLABELLED NAME: a release
// name that files a series wrong whoever posts it, so a group term cannot hold it. Three kinds (`renderMislabelNameTerm`):
// `pair`, an episode number with another episode's title and the series anchor (`S01E11 Secret Menu`); `double`, a
// double-episode token and the series anchor (`S01E13E14`); `alias`, an alternate title Sonarr lists for the series
// ("Regular Show Die verlorenen Videos"). Staff add them with the in-cluster tool (origin `staff`) and the adoption moves
// Case A's hand-made ones in (origin `adoption`), through the same `saveTerm`: lock, cap, 365 days, write and read-back.
// No person is offered a name term; the re-map's group offer is unchanged.
//
// Hard rule 4 (amended by ADR-110 C-04 and ADR-113): this profile is a write-back through `@hnet/arr/write` from this
// package; "must not contain" terms only, never library files, quality profiles or custom formats.
import {
  mediaItems,
  mislabelBlockTerms,
  permissionAudit,
  repairRequests,
  users,
  type DbClient,
  type MislabelTermKind,
  type MislabelTermOrigin,
  type MislabelTermState,
} from '@hnet/db';
import { ARR_CLUSTER_URL_DEFAULTS, ArrConfigError } from '@hnet/arr';
import { SonarrClient } from '@hnet/arr/read';
import { SonarrWriteClient } from '@hnet/arr/write';
import { and, asc, count, desc, eq, gt, isNull, lte, ne, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { consoleDomainLogger, type DomainLogger } from './domain-logger';
import { hasUnwritableWord } from './janitor-release-block';
import {
  isMislabelNameTerm,
  isMislabelTerm,
  mergeTermWords,
  mislabelNameKindOf,
  releaseTokens,
  renderMislabelNameTerm,
  renderMislabelTerm,
  termMatchesRaw,
  termWords,
  type MislabelNameKind,
} from './release-terms';

/** The app-owned Sonarr profile's exact name (D-05). */
export const MISLABEL_BLOCK_PROFILE_NAME = 'haynesnetwork: mislabelled releases (managed, do not edit)';
/** The plain term that keeps the profile valid when it holds no live term (Sonarr refuses an empty profile). A plain
 *  term is a case-insensitive "contains": no release title carries it. */
export const MISLABEL_BLOCK_SENTINEL = 'haynesnetwork-mislabel-managed-do-not-edit';
/** A term lives this long from its write (ADR-110 C-04). */
export const MISLABEL_TERM_LIFETIME_DAYS = 365;
/** At most this many active terms (ADR-110 C-04). */
export const MISLABEL_TERM_CAP = 500;
/** A group is offered only when the re-map moved at least this many of its files on the series (D-04 rule 10). */
export const MISLABEL_MIN_FILES = 2;
/** The longest staff note kept on a removal's audit row. */
export const MISLABEL_NOTE_MAX = 500;

const DAY_MS = 86_400_000;
const LOCK_KEY = sql`hashtext(${'mislabel-block:sonarr'})`;

// ---------------------------------------------------------------------------
// Clients (thin, so tests pass stubs)
// ---------------------------------------------------------------------------

/** One Sonarr release profile, as the Mislabel Block reads it. */
export interface MislabelReleaseProfile {
  id: number;
  name?: string | null;
  enabled?: boolean | null;
  required?: readonly string[] | null;
  ignored?: readonly string[] | null;
  indexerId?: number | null;
  tags?: readonly number[] | null;
}

/** The profile body the Mislabel Block writes: its name, enabled, no required terms, every indexer, every series. */
export interface MislabelReleaseProfileBody {
  name: string;
  enabled: boolean;
  required: string[];
  ignored: string[];
  indexerId: number;
  tags: number[];
}

/** Sonarr's release-profile surface (`SonarrWriteClient`). */
export interface MislabelReleaseProfileClient {
  listReleaseProfiles(): Promise<MislabelReleaseProfile[]>;
  createReleaseProfile(body: MislabelReleaseProfileBody): Promise<unknown>;
  updateReleaseProfile(body: MislabelReleaseProfileBody & { id: number }): Promise<unknown>;
}

/** Sonarr's series reads (`SonarrClient.findSeries`, `listEpisodes`): the adoption confirms the series; a mislabelled
 *  name reads its alternate titles (an `alias`) and its episode titles (a `pair`, ADR-113). */
export interface MislabelSeriesReader {
  findSeries(id: number): Promise<{ title: string; alternateTitles?: ReadonlyArray<{ title: string }> | null } | null>;
  listEpisodes(
    seriesId: number,
  ): Promise<ReadonlyArray<{ seasonNumber: number; episodeNumber: number; title: string | null }>>;
}

export interface MislabelBlockSonarr {
  read: MislabelSeriesReader;
  write: MislabelReleaseProfileClient;
}

/** What the profile writers need: the release-profile surface only. */
export type MislabelBlockWriter = Pick<MislabelBlockSonarr, 'write'>;

/** The Mislabel Block's Sonarr clients from env (SONARR_URL default in-cluster, SONARR_API_KEY required). Built here so
 *  `@hnet/arr/write` stays confined to packages/domain. */
export function mislabelBlockSonarrFromEnv(env: Record<string, string | undefined> = process.env): MislabelBlockSonarr {
  const apiKey = env.SONARR_API_KEY?.trim() ?? '';
  if (!apiKey) throw new ArrConfigError(['SONARR_API_KEY']);
  const options = { baseUrl: env.SONARR_URL?.trim() || ARR_CLUSTER_URL_DEFAULTS.sonarr, apiKey };
  return { read: new SonarrClient(options), write: new SonarrWriteClient(options) };
}

/** Where a profile write stopped: a term outside the grammar (`validate`), the first GET (`read`), the POST / PUT
 *  (`put`), the read-back (`read_back`), or a copy of the profile (`duplicate_profile`). */
export type MislabelBlockStep = 'validate' | 'read' | 'put' | 'read_back' | 'duplicate_profile';

export class MislabelBlockError extends Error {
  readonly code = 'MISLABEL_BLOCK_FAILED' as const;
  constructor(
    readonly step: MislabelBlockStep,
    options?: { cause?: unknown },
  ) {
    super(`mislabel block ${step} failed on sonarr`, options);
  }
}

// ---------------------------------------------------------------------------
// The term (pure)
// ---------------------------------------------------------------------------

/** Why no term blocks this group on this series: no group, a one-character group, a group outside `[A-Za-z0-9.-]` (or
 *  digits only), a group that ordinary release names of the series already carry (a source or codec tag, a title word),
 *  no title, a title with a word the term cannot write, a term that would also block another library series, or a
 *  term outside the grammar. ADR-113 adds a mislabelled name's: a name that is no pair, double or writable title
 *  (`name_unwritable`), an alias that is the series' own title or not one Sonarr lists for it, a name that ordinary
 *  release names of the series carry (`name_too_broad`), and a pair whose number really has that title
 *  (`name_is_correct`). */
export type MislabelTermRefusal =
  | 'no_group'
  | 'group_too_short'
  | 'group_unwritable'
  | 'group_too_broad'
  | 'no_title'
  | 'title_unwritable'
  | 'names_other_series'
  | 'grammar'
  | 'name_unwritable'
  | 'alias_is_title'
  | 'alias_not_listed'
  | 'name_too_broad'
  | 'name_is_correct';

export type MislabelTerm = { term: string } | { refused: MislabelTermRefusal; otherSeries?: string };

/** The tags an ordinary release name carries (sources, resolutions, codecs, audio, flags, episode markers). A group term
 *  that matches a name made of the title and these alone would block every release of the series. */
const ORDINARY_TAGS = [
  'S01E01', 'S01', 'E01', '2160p', '1080p', '720p', '576p', '480p', 'AMZN', 'NF', 'DSNP', 'HMAX', 'MAX', 'ATVP',
  'PCOK', 'PMTP', 'HULU', 'iT', 'STAN', 'CRAV', 'WEB-DL', 'WEBDL', 'WEBRip', 'WEB', 'HDTV', 'PDTV', 'DVDRip', 'BluRay',
  'BDRip', 'REMUX', 'DDP5.1', 'DDP2.0', 'DD5.1', 'DD2.0', 'DD+', 'EAC3', 'AC3', 'AAC2.0', 'AAC', 'DTS-HD.MA',
  'DTS', 'TrueHD', 'Atmos', 'FLAC', 'Opus', 'H.264', 'H.265', 'H264', 'H265', 'x264', 'x265', 'HEVC', 'AVC', 'AV1',
  '10bit', 'HDR', 'HDR10', 'DV', 'DoVi', 'SDR', 'DUAL', 'MULTI', 'SUBBED', 'DUBBED', 'PROPER', 'REPACK', 'REAL',
  'INTERNAL', 'COMPLETE',
];

/**
 * D-05 — the Mislabel Block term for one release group on one series, or why there is none. Built only from the D-12
 * grammar (`renderMislabelTerm`: the series title's words with their apostrophes, accented letters and `&`; the group
 * lower case), then checked before it may be written:
 *  - `isMislabelTerm` (the template, and it compiles);
 *  - it matches the series' own release names from the group, raw and dotted, as Sonarr tests them (the raw title);
 *  - it matches no ordinary release name of the series WITHOUT the group (`group_too_broad`: a group named `WEB-DL`,
 *    `x264` or a title word would block the whole series);
 *  - it matches no release of another series in `otherSeriesTitles` from that group (`names_other_series`: the term for
 *    "Lost" would also block "Lost Girl").
 * Pure.
 */
export function deriveMislabelTerm(input: {
  seriesTitle: string | null | undefined;
  releaseGroup: string | null | undefined;
  /** The library's other Sonarr series titles (the writer passes them; pure callers may leave it out). */
  otherSeriesTitles?: readonly string[];
}): MislabelTerm {
  const group = (input.releaseGroup ?? '').trim();
  if (group.length === 0) return { refused: 'no_group' };
  if (group.length < 2) return { refused: 'group_too_short' };
  if (!/^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$/.test(group) || /^[0-9.-]+$/.test(group)) {
    return { refused: 'group_unwritable' };
  }
  const title = (input.seriesTitle ?? '').normalize('NFC').trim();
  const tokens = releaseTokens(title);
  if (tokens.length === 0) return { refused: 'no_title' };
  if (hasUnwritableWord(title)) return { refused: 'title_unwritable' };
  let term: string;
  try {
    term = renderMislabelTerm(termWords(title), group.toLowerCase());
  } catch {
    return { refused: 'grammar' };
  }
  if (!isMislabelTerm(term)) return { refused: 'grammar' };
  const dotted = tokens.join('.');
  const named = [`${title} S01E01 1080p WEB-DL-${group}`, `${dotted}.S01E01.1080p.WEB-DL-${group}`];
  if (!named.every((n) => termMatchesRaw(term, n))) return { refused: 'grammar' };
  const ordinary = [title, `${title} ${ORDINARY_TAGS.join(' ')}`, `${dotted}.${ORDINARY_TAGS.join('.')}`];
  if (ordinary.some((n) => termMatchesRaw(term, n))) return { refused: 'group_too_broad' };
  for (const other of input.otherSeriesTitles ?? []) {
    const otherTokens = releaseTokens(other);
    if (otherTokens.length === 0) continue;
    const probes = [
      `${other.normalize('NFC')} S01E01 1080p WEB-DL-${group}`,
      `${otherTokens.join('.')}.S01E01.1080p.WEB-DL-${group}`,
    ];
    if (probes.some((n) => termMatchesRaw(term, n))) return { refused: 'names_other_series', otherSeries: other };
  }
  return { term };
}

// ---------------------------------------------------------------------------
// A mislabelled name (ADR-113, pure)
// ---------------------------------------------------------------------------

export type ParsedMislabelName =
  | { kind: 'pair'; nameToken: string; season: number; episode: number; title: string }
  | { kind: 'double'; nameToken: string; season: number; episode: number; lastEpisode: number }
  | { kind: 'alias'; nameToken: string; alias: string };

const pad2 = (n: number) => String(n).padStart(2, '0');
const episodeLabel = (season: number, episode: number) => `S${pad2(season)}E${pad2(episode)}`;

/**
 * ADR-113 — read a mislabelled name as staff give it, or null when it is none of the three: a `pair` is an `SxxEyy`
 * token then the title words (`S01E11 Secret Menu`), a `double` is `SxxEyyEzz` with z after y (`S01E13E14`,
 * `S01E13-E14`), an `alias` is a title. Season 0..999, episodes 1..9999; title words must be writable
 * (`hasUnwritableWord`). The display text (`nameToken`) is `S01E11 Secret Menu`, `S01E13E14`, or the title as given.
 */
export function parseMislabelName(kind: MislabelNameKind, raw: string): ParsedMislabelName | null {
  const value = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (value.length === 0 || value.length > 200) return null;
  if (kind === 'alias') {
    if (releaseTokens(value).length === 0 || hasUnwritableWord(value)) return null;
    return { kind, nameToken: value, alias: value };
  }
  if (kind === 'double') {
    const m = /^s(\d{1,3})e(\d{1,4})[^0-9a-z]*e(\d{1,4})$/i.exec(value);
    if (!m) return null;
    const [season, episode, lastEpisode] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (episode < 1 || lastEpisode <= episode) return null;
    return { kind, nameToken: `${episodeLabel(season, episode)}E${pad2(lastEpisode)}`, season, episode, lastEpisode };
  }
  const m = /^s(\d{1,3})e(\d{1,4})(?![0-9a-z])[^0-9a-z]*(.*)$/i.exec(value);
  if (!m) return null;
  const [season, episode, title] = [Number(m[1]), Number(m[2]), (m[3] ?? '').trim()];
  if (episode < 1 || releaseTokens(title).length === 0 || hasUnwritableWord(title)) return null;
  return { kind, nameToken: `${episodeLabel(season, episode)} ${title}`, season, episode, title };
}

export type MislabelNameTerm =
  | { term: string; nameToken: string }
  | { refused: MislabelTermRefusal; otherSeries?: string };

/**
 * ADR-113 / DESIGN-055 Q-10 ruling — the Mislabel Block term for one mislabelled name on one series, or why there is
 * none. Built only from the D-12 grammar (`renderMislabelNameTerm`: the series title's words and the name's, with their
 * apostrophes, accented letters and `&`), then checked before it may be written:
 *  - `mislabelNameKindOf` (exactly that kind's template, and it compiles);
 *  - it matches the mislabelled name in a release title of the series, raw and dotted, as Sonarr tests it;
 *  - it matches no ordinary release name of the series (`name_too_broad`): the title with every ordinary tag; a pair's
 *    words under the next or previous episode or season, or a tag in place of its words (`S01E11 1080p` would block the
 *    whole episode); a double's two episodes alone, or the doubles beside it; for an alias, any release of the series
 *    under its own title;
 *  - a pair matches no release that gives its number the title Sonarr has for it (`name_is_correct`: the right release);
 *  - it matches no release of another series in `otherSeriesTitles` (`names_other_series`).
 * An alias must be one of Sonarr's alternate titles for the series (`alias_not_listed`, compared folded) and not the
 * series' own title (`alias_is_title`); its words are Sonarr's spelling, merged with the one given. Pure.
 */
export function deriveMislabelNameTerm(input: {
  seriesTitle: string | null | undefined;
  kind: MislabelNameKind;
  name: string;
  /** Sonarr's alternate titles for the series (an `alias` must be one of them). */
  alternateTitles?: readonly string[];
  /** Sonarr's episodes of the series (a `pair` must not name its own episode's title). */
  episodes?: ReadonlyArray<{ seasonNumber: number; episodeNumber: number; title: string | null }>;
  /** The library's other Sonarr series titles (the writer passes them; pure callers may leave it out). */
  otherSeriesTitles?: readonly string[];
}): MislabelNameTerm {
  const title = (input.seriesTitle ?? '').normalize('NFC').trim();
  const tokens = releaseTokens(title);
  if (tokens.length === 0) return { refused: 'no_title' };
  if (hasUnwritableWord(title)) return { refused: 'title_unwritable' };
  const parsed = parseMislabelName(input.kind, input.name);
  if (parsed === null) return { refused: 'name_unwritable' };
  const dotted = (value: string) => releaseTokens(value).join('.');
  const series = dotted(title);
  const tail = '1080p WEB-DL-GRP';
  const dottedTail = '1080p.WEB-DL-GRP';
  const ordinary = [title, `${title} ${ORDINARY_TAGS.join(' ')}`, `${series}.${ORDINARY_TAGS.join('.')}`];

  let term: string;
  let nameToken = parsed.nameToken;
  let named: string[];
  let broad: string[];
  let correct: string[] = [];
  let otherProbes: (other: string) => string[];
  try {
    if (parsed.kind === 'pair') {
      const { season, episode, title: words } = parsed;
      term = renderMislabelNameTerm({ kind: 'pair', series: termWords(title), season, episode, title: termWords(words) });
      const at = (s: number, e: number, w: string, show = title) => [
        `${show} ${episodeLabel(s, e)} ${w} ${tail}`,
        `${dotted(show)}.${episodeLabel(s, e)}.${dotted(w)}.${dottedTail}`,
      ];
      named = at(season, episode, words);
      broad = [
        ...ordinary,
        ...(episode > 1 ? at(season, episode - 1, words) : []),
        ...at(season, episode + 1, words),
        ...at(season + 1, episode, words),
        ...ORDINARY_TAGS.map((tag) => `${series}.${episodeLabel(season, episode)}.${tag}.${dottedTail}`),
      ];
      correct = (input.episodes ?? [])
        .filter((e) => e.seasonNumber === season && e.episodeNumber === episode)
        .flatMap((e) => (e.title && releaseTokens(e.title).length > 0 ? at(season, episode, e.title) : []));
      otherProbes = (other) => at(season, episode, words, other);
    } else if (parsed.kind === 'double') {
      const { season, episode, lastEpisode } = parsed;
      term = renderMislabelNameTerm({ kind: 'double', series: termWords(title), season, episode, lastEpisode });
      const token = (s: number, e: number, f?: number) =>
        f === undefined ? episodeLabel(s, e) : `${episodeLabel(s, e)}E${pad2(f)}`;
      const at = (t: string, show = title) => [`${show} ${t} ${tail}`, `${dotted(show)}.${t}.${dottedTail}`];
      named = [
        ...at(token(season, episode, lastEpisode)),
        `${series}.${episodeLabel(season, episode)}-E${pad2(lastEpisode)}.${dottedTail}`,
      ];
      broad = [
        ...ordinary,
        ...at(token(season, episode)),
        ...at(token(season, lastEpisode)),
        ...(episode > 1 ? at(token(season, episode - 1, episode)) : []),
        ...at(token(season, lastEpisode, lastEpisode + 1)),
        ...at(token(season + 1, episode, lastEpisode)),
      ];
      otherProbes = (other) => at(token(season, episode, lastEpisode), other);
    } else {
      const wanted = releaseTokens(parsed.alias).join(' ');
      if (wanted === tokens.join(' ')) return { refused: 'alias_is_title' };
      const listed = (input.alternateTitles ?? [])
        .map((a) => a.normalize('NFC').trim())
        .find((a) => releaseTokens(a).join(' ') === wanted);
      if (listed === undefined) return { refused: 'alias_not_listed' };
      if (hasUnwritableWord(listed)) return { refused: 'name_unwritable' };
      term = renderMislabelNameTerm({
        kind: 'alias',
        alias: mergeTermWords(termWords(listed), termWords(parsed.alias)),
      });
      nameToken = listed;
      named = [...new Set([listed, parsed.alias])].flatMap((a) => [
        `${a} S01E01 ${tail}`,
        `${dotted(a)}.S01E01.${dottedTail}`,
      ]);
      broad = ordinary;
      otherProbes = (other) => [`${other} S01E01 ${tail}`, `${dotted(other)}.S01E01.${dottedTail}`];
    }
  } catch {
    return { refused: 'grammar' };
  }
  if (mislabelNameKindOf(term) !== parsed.kind) return { refused: 'grammar' };
  if (!named.every((n) => termMatchesRaw(term, n))) return { refused: 'grammar' };
  if (broad.some((n) => termMatchesRaw(term, n))) return { refused: 'name_too_broad' };
  if (correct.some((n) => termMatchesRaw(term, n))) return { refused: 'name_is_correct' };
  for (const other of input.otherSeriesTitles ?? []) {
    if (releaseTokens(other).length === 0) continue;
    if (otherProbes(other.normalize('NFC')).some((n) => termMatchesRaw(term, n))) {
      return { refused: 'names_other_series', otherSeries: other };
    }
  }
  return { term, nameToken };
}

/** A term the profile may hold: its sentinel, a group term (ADR-110 C-04), or a mislabelled-name term (ADR-113). */
export const isMislabelBlockTerm = (term: string): boolean =>
  term === MISLABEL_BLOCK_SENTINEL || isMislabelTerm(term) || isMislabelNameTerm(term);

// ---------------------------------------------------------------------------
// Drift (pure)
// ---------------------------------------------------------------------------

export type MislabelBlockDriftReason = 'missing' | 'duplicate' | 'disabled' | 'edited' | 'terms';

export interface MislabelBlockDrift {
  reason: MislabelBlockDriftReason;
  /** Desired terms the profile lacks (the sentinel included). */
  missingTerms: number;
  /** Terms the profile holds that no active row wants (an expired or removed term, a hand edit). */
  extraTerms: number;
}

const isOurs = (p: MislabelReleaseProfile) => p.name === MISLABEL_BLOCK_PROFILE_NAME;

/**
 * Compare the profiles named MISLABEL_BLOCK_PROFILE_NAME with the desired state (one profile, enabled, no required
 * terms, every indexer, no tags, `ignored` exactly `desired` as a set). A missing profile is drift only while a term is
 * active (nothing is created to hold the sentinel alone). null ⇒ nothing to write.
 */
export function mislabelBlockProfileDrift(
  profiles: readonly MislabelReleaseProfile[],
  desired: readonly string[],
): MislabelBlockDrift | null {
  const ours = profiles.filter(isOurs);
  const want = new Set(desired);
  if (ours.length === 0) {
    return desired.some((x) => x !== MISLABEL_BLOCK_SENTINEL)
      ? { reason: 'missing', missingTerms: want.size, extraTerms: 0 }
      : null;
  }
  if (ours.length > 1) return { reason: 'duplicate', missingTerms: 0, extraTerms: 0 };
  const p = ours[0]!;
  const have = new Set(p.ignored ?? []);
  const missingTerms = [...want].filter((x) => !have.has(x)).length;
  const extraTerms = [...have].filter((x) => !want.has(x)).length;
  if (p.enabled !== true) return { reason: 'disabled', missingTerms, extraTerms };
  if ((p.required ?? []).length > 0 || (p.indexerId ?? 0) !== 0 || (p.tags ?? []).length > 0) {
    return { reason: 'edited', missingTerms, extraTerms };
  }
  if (missingTerms > 0 || extraTerms > 0) return { reason: 'terms', missingTerms, extraTerms };
  return null;
}

/** The sentinel first, then each distinct term. */
const desiredOf = (terms: readonly string[]) => [MISLABEL_BLOCK_SENTINEL, ...new Set(terms)];

// ---------------------------------------------------------------------------
// The profile write (inside the caller's transaction, under the lock)
// ---------------------------------------------------------------------------

interface ProfileWrite {
  wrote: boolean;
  drift: MislabelBlockDrift | null;
  added: number;
  removed: number;
}

/**
 * Make the profile hold exactly `desired`: every term must pass the grammar before anything is sent (`validate`); the
 * profile is found by its exact name (none ⇒ POST, one ⇒ PUT only when it drifted, more ⇒ `duplicate_profile`); then a
 * read-back GET must show no drift at all (`read_back`). Throws MislabelBlockError; the caller's transaction then rolls
 * back, so no row records a term Sonarr did not confirm.
 */
async function writeProfile(client: MislabelReleaseProfileClient, desired: readonly string[]): Promise<ProfileWrite> {
  if (!desired.every(isMislabelBlockTerm)) throw new MislabelBlockError('validate');
  let profiles: MislabelReleaseProfile[];
  try {
    profiles = await client.listReleaseProfiles();
  } catch (cause) {
    throw new MislabelBlockError('read', { cause });
  }
  const ours = profiles.filter(isOurs);
  if (ours.length > 1) throw new MislabelBlockError('duplicate_profile');
  const mine = ours[0];
  const drift = mislabelBlockProfileDrift(ours, desired);
  const before = new Set(mine?.ignored ?? []);
  const want = new Set(desired);
  if (drift !== null) {
    const body: MislabelReleaseProfileBody = {
      name: MISLABEL_BLOCK_PROFILE_NAME,
      enabled: true,
      required: [],
      ignored: [...desired],
      indexerId: 0,
      tags: [],
    };
    try {
      if (mine === undefined) await client.createReleaseProfile(body);
      else await client.updateReleaseProfile({ ...body, id: mine.id });
    } catch (cause) {
      throw new MislabelBlockError('put', { cause });
    }
  }
  let after: MislabelReleaseProfile[];
  try {
    after = await client.listReleaseProfiles();
  } catch (cause) {
    throw new MislabelBlockError('read_back', { cause });
  }
  if (mislabelBlockProfileDrift(after, desired) !== null) throw new MislabelBlockError('read_back');
  return {
    wrote: drift !== null,
    drift,
    added: [...want].filter((x) => !before.has(x) && x !== MISLABEL_BLOCK_SENTINEL).length,
    removed: [...before].filter((x) => !want.has(x) && x !== MISLABEL_BLOCK_SENTINEL).length,
  };
}

/** The active terms whose life has not run out, oldest first. */
async function readActiveTerms(exec: DbClient, now: Date): Promise<Array<{ id: string; term: string }>> {
  const t = mislabelBlockTerms;
  return resolveDb(exec)
    .select({ id: t.id, term: t.term })
    .from(t)
    .where(and(eq(t.instance, 'sonarr'), eq(t.state, 'active'), gt(t.expiresAt, now)))
    .orderBy(asc(t.createdAt), asc(t.id));
}

/** Active terms past `expires_at` turn `expired` (inside the transaction of the profile write that drops them). */
async function expireDue(tx: DbClient, now: Date): Promise<number> {
  const t = mislabelBlockTerms;
  const rows = await resolveDb(tx)
    .update(t)
    .set({ state: 'expired', endedAt: now, endedReason: 'expired' })
    .where(and(eq(t.instance, 'sonarr'), eq(t.state, 'active'), lte(t.expiresAt, now)))
    .returning({ id: t.id });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Saving a term: the confirmed re-map offer (D-04 rule 10) and the adoption (ADR-110 C-05)
// ---------------------------------------------------------------------------

/** Why a profile write did not land (MislabelBlockStep in plain terms). */
export type MislabelWriteRefusal =
  | 'invalid_terms'
  | 'duplicate_profile'
  | 'sonarr_unavailable'
  | 'write_failed'
  | 'read_back_failed';

/** Why a term was not saved: the offer's checks, the term's refusals, the cap, and the profile write. */
export type MislabelSaveRefusal =
  | MislabelTermRefusal
  | MislabelWriteRefusal
  | 'not_found'
  | 'not_remap'
  | 'not_completed'
  | 'not_requester'
  | 'preview_invalid'
  | 'not_shift'
  | 'group_not_offered'
  | 'too_few_files'
  | 'not_a_series'
  | 'cap_reached';

/** The plain words a person sees for each refusal (the owner's copy rules: no names, no dashes, friendly). */
export const MISLABEL_REFUSAL_TEXT: Record<MislabelSaveRefusal, string> = {
  no_group: 'That release group has no name we can block.',
  group_too_short: 'That release group name is too short to block safely.',
  group_unwritable: 'That release group name cannot be blocked safely.',
  group_too_broad: 'That group name also appears in ordinary release names, so blocking it would stop every download of this show.',
  no_title: "This show's title cannot be written into a block.",
  title_unwritable: "This show's title has characters a block cannot match safely.",
  names_other_series: "Blocking it would also stop that group's releases of another show in the library.",
  grammar: 'The block could not be built safely, so nothing was saved.',
  name_unwritable:
    "That name cannot be blocked safely. Give an episode and its title (S01E11 Secret Menu), a double episode (S01E13E14), or one of the show's other titles.",
  alias_is_title: "That is the show's own title, so blocking it would stop every download of this show.",
  alias_not_listed: "That title is not one of the show's other titles in Sonarr, so nothing was saved.",
  name_too_broad: 'That name also appears in ordinary release names of this show, so blocking it would stop good downloads.',
  name_is_correct: 'That episode really has that title, so blocking it would stop the right release.',
  not_found: 'That repair could not be found.',
  not_remap: 'Only an episode re-map can block a release group.',
  not_completed: 'The re-map has not finished, so nothing was saved.',
  not_requester: 'Only the person who confirmed the re-map, or staff, can save this.',
  preview_invalid: 'The re-map record is incomplete, so nothing was saved.',
  not_shift: 'A block is offered only after a shift of several episodes.',
  group_not_offered: 'That release group was not part of this re-map.',
  too_few_files: 'A block needs at least two files from that group on this show.',
  not_a_series: 'That show could not be found in Sonarr.',
  cap_reached: 'The block list is full. Ask staff to clear old entries.',
  invalid_terms: 'The block list holds an entry that fails its safety check, so nothing was saved. Ask staff to check it.',
  duplicate_profile: 'Sonarr holds a copy of the block list, so nothing was saved. Ask staff to remove the copy.',
  sonarr_unavailable: 'Sonarr could not be reached, so nothing was saved. Try again later.',
  write_failed: 'Sonarr did not accept the change, so nothing was saved. Try again later.',
  read_back_failed: 'Sonarr did not confirm the change, so it was not saved. Try again later.',
};

export interface MislabelSaved {
  saved: true;
  term: string;
  termId: string;
  /** The (series, group) term, or the (series, kind, name) term, was already active: nothing was written (idempotent). */
  alreadyActive: boolean;
  /** ADR-113 — a mislabelled-name term's kind and display text (absent for a group term). */
  kind?: MislabelNameKind;
  nameToken?: string;
}

export interface MislabelRefused {
  saved: false;
  reason: MislabelSaveRefusal;
  message: string;
  /** `names_other_series`: the library series the term would also block. */
  otherSeries?: string;
}

export type MislabelSaveResult = MislabelSaved | MislabelRefused;

const refusal = (reason: MislabelSaveRefusal, otherSeries?: string): MislabelRefused => ({
  saved: false,
  reason,
  message: MISLABEL_REFUSAL_TEXT[reason],
  ...(otherSeries !== undefined ? { otherSeries } : {}),
});

const STEP_REASON: Record<MislabelBlockStep, MislabelWriteRefusal> = {
  validate: 'invalid_terms',
  read: 'sonarr_unavailable',
  put: 'write_failed',
  read_back: 'read_back_failed',
  duplicate_profile: 'duplicate_profile',
};

/** The library's other live Sonarr series titles (for `names_other_series`). */
async function otherSeriesTitles(exec: DbClient, seriesId: number): Promise<string[]> {
  const rows = await resolveDb(exec)
    .select({ title: mediaItems.title })
    .from(mediaItems)
    .where(
      and(eq(mediaItems.arrKind, 'sonarr'), ne(mediaItems.arrItemId, seriesId), isNull(mediaItems.deletedFromArrAt)),
    );
  return rows.map((r) => r.title);
}

/** What a term names: a release group (ADR-110 C-04) or a mislabelled name (ADR-113). */
export type MislabelTermKey =
  | { kind: 'group'; releaseGroup: string }
  | { kind: MislabelNameKind; nameToken: string };

/** The active row for (series, group), or (series, kind, name token), whose life has not run out; the group or the
 *  name compared case-insensitively. */
async function activeRowFor(
  exec: DbClient,
  seriesId: number,
  key: MislabelTermKey,
  now: Date,
): Promise<{ id: string; term: string } | undefined> {
  const t = mislabelBlockTerms;
  const [row] = await resolveDb(exec)
    .select({ id: t.id, term: t.term })
    .from(t)
    .where(
      and(
        eq(t.instance, 'sonarr'),
        eq(t.seriesId, seriesId),
        eq(t.kind, key.kind),
        eq(t.state, 'active'),
        gt(t.expiresAt, now),
        key.kind === 'group'
          ? sql`lower(${t.releaseGroup}) = lower(${key.releaseGroup})`
          : sql`lower(${t.nameToken}) = lower(${key.nameToken})`,
      ),
    )
    .limit(1);
  return row;
}

/** The active row on the series holding exactly this term (a name given in another spelling that renders the same). */
async function activeRowWithTerm(
  exec: DbClient,
  seriesId: number,
  term: string,
  now: Date,
): Promise<{ id: string; term: string } | undefined> {
  const t = mislabelBlockTerms;
  const [row] = await resolveDb(exec)
    .select({ id: t.id, term: t.term })
    .from(t)
    .where(
      and(
        eq(t.instance, 'sonarr'),
        eq(t.seriesId, seriesId),
        eq(t.state, 'active'),
        gt(t.expiresAt, now),
        eq(t.term, term),
      ),
    )
    .limit(1);
  return row;
}

interface SaveTermInput {
  db?: DbClient;
  sonarr: MislabelBlockWriter;
  seriesId: number;
  mediaItemId: string | null;
  seriesTitle: string;
  key: MislabelTermKey;
  /** The term: a group's is derived under the lock (`deriveMislabelTerm`); a name's before it, from Sonarr's reads
   *  (`deriveMislabelNameTerm`, ADR-113). */
  derive: () => MislabelTerm;
  origin: MislabelTermOrigin;
  repairRequestId: string | null;
  createdBy: string | null;
  now: Date;
  logger: DomainLogger;
}

/**
 * The one path that adds a term, group or name, under the lock in one transaction: an active term for the same key
 * (series and group, or series, kind and name) answers saved (idempotent, nothing written); else the term is derived,
 * an active row holding the same term text answers saved too, the cap is checked, terms past their life turn
 * `expired`, the profile is written with every active term plus this one and read back (`writeProfile`), and only
 * then the row inserted. A refusal changes nothing; a write or read-back failure rolls the transaction back (expiry
 * included) and records the attempt as one `removed` row.
 */
async function saveTerm(input: SaveTermInput): Promise<MislabelSaveResult> {
  const t = mislabelBlockTerms;
  const key: MislabelTermKey =
    input.key.kind === 'group'
      ? { kind: 'group', releaseGroup: input.key.releaseGroup.trim() }
      : { kind: input.key.kind, nameToken: input.key.nameToken.trim() };
  const fields =
    key.kind === 'group'
      ? { kind: key.kind, releaseGroup: key.releaseGroup, nameToken: null }
      : { kind: key.kind, releaseGroup: null, nameToken: key.nameToken };
  const named = key.kind === 'group' ? {} : { kind: key.kind, nameToken: key.nameToken };
  const meta =
    key.kind === 'group'
      ? { seriesId: input.seriesId, releaseGroup: key.releaseGroup, origin: input.origin }
      : { seriesId: input.seriesId, kind: key.kind, nameToken: key.nameToken, origin: input.origin };
  // The term sent to Sonarr, once one is (set inside the transaction's callback, read by the failure path).
  const attempt: { term: string | null } = { term: null };
  try {
    return await inTransaction(input.db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
      const existing = await activeRowFor(tx, input.seriesId, key, input.now);
      if (existing) return { saved: true, term: existing.term, termId: existing.id, alreadyActive: true, ...named };
      const derived = input.derive();
      if ('refused' in derived) {
        input.logger.info('[mislabel-block] refused', { ...meta, reason: derived.refused });
        return refusal(derived.refused, derived.otherSeries);
      }
      const same = await activeRowWithTerm(tx, input.seriesId, derived.term, input.now);
      if (same) return { saved: true, term: same.term, termId: same.id, alreadyActive: true, ...named };
      const active = await readActiveTerms(tx, input.now);
      if (active.length >= MISLABEL_TERM_CAP) {
        input.logger.warn('[mislabel-block] refused', { ...meta, reason: 'cap_reached' });
        return refusal('cap_reached');
      }
      // A term past its life leaves with this write (and frees its (series, group) for the new row).
      await expireDue(tx, input.now);
      attempt.term = derived.term;
      await writeProfile(input.sonarr.write, desiredOf([...active.map((a) => a.term), derived.term]));
      const [row] = await tx
        .insert(t)
        .values({
          instance: 'sonarr',
          seriesId: input.seriesId,
          mediaItemId: input.mediaItemId,
          seriesTitle: input.seriesTitle,
          ...fields,
          term: derived.term,
          state: 'active',
          origin: input.origin,
          repairRequestId: input.repairRequestId,
          createdBy: input.createdBy,
          createdAt: input.now,
          expiresAt: new Date(input.now.getTime() + MISLABEL_TERM_LIFETIME_DAYS * DAY_MS),
        })
        .returning({ id: t.id });
      input.logger.info('[mislabel-block] term_added', { ...meta, term: derived.term, total: active.length + 1 });
      return { saved: true, term: derived.term, termId: row!.id, alreadyActive: false, ...named };
    });
  } catch (error) {
    if (!(error instanceof MislabelBlockError)) throw error;
    input.logger.warn('[mislabel-block] write_failed', { ...meta, step: error.step });
    const reason = STEP_REASON[error.step];
    // D-05: a write that was sent but not confirmed leaves the term `removed` (a term it left in the profile is drift,
    // which the upkeep removes). Nothing sent (validate, read, duplicate) records nothing.
    if (attempt.term !== null && (error.step === 'put' || error.step === 'read_back')) {
      await resolveDb(input.db)
        .insert(t)
        .values({
          instance: 'sonarr',
          seriesId: input.seriesId,
          mediaItemId: input.mediaItemId,
          seriesTitle: input.seriesTitle,
          ...fields,
          term: attempt.term,
          state: 'removed',
          origin: input.origin,
          repairRequestId: input.repairRequestId,
          createdBy: input.createdBy,
          createdAt: input.now,
          expiresAt: new Date(input.now.getTime() + MISLABEL_TERM_LIFETIME_DAYS * DAY_MS),
          endedAt: input.now,
          endedReason: reason,
        });
    }
    return refusal(reason);
  }
}

/** The fields of a `remap` Repair Request's preview the offer reads (the coordinator's re-map flow writes the whole
 *  shape; see addMislabelTermFromRemap). null when the preview lacks them. */
function readRemapPreview(preview: unknown): {
  claimKind: string;
  seriesId: number | null;
  mislabelGroups: Array<{ releaseGroup: string; fileCount: number }>;
} | null {
  if (typeof preview !== 'object' || preview === null) return null;
  const p = preview as Record<string, unknown>;
  const claim = p.claim as Record<string, unknown> | null | undefined;
  if (typeof claim !== 'object' || claim === null || typeof claim.kind !== 'string') return null;
  if (!Array.isArray(p.mislabelGroups)) return null;
  const groups: Array<{ releaseGroup: string; fileCount: number }> = [];
  for (const g of p.mislabelGroups as unknown[]) {
    if (typeof g !== 'object' || g === null) return null;
    const { releaseGroup, fileCount } = g as Record<string, unknown>;
    if (typeof releaseGroup !== 'string' || typeof fileCount !== 'number') return null;
    groups.push({ releaseGroup, fileCount });
  }
  return {
    claimKind: claim.kind,
    seriesId: typeof p.seriesId === 'number' ? p.seriesId : null,
    mislabelGroups: groups,
  };
}

/**
 * D-04 rule 10 / D-05 — the confirmed "Stop <group> from filing this show again" offer after an Episode Re-map. The
 * Repair Request must be a `remap` that `completed`; the caller must be its requester or an admin; its `preview` must
 * hold a shift claim (`claim.kind === 'shift'`) and a `mislabelGroups` entry for the group (case-insensitive) with
 * `fileCount >= 2`. The series is the repair's media item (`media_items.title`, `arr_item_id` = the Sonarr series id).
 * Then `saveTerm`: idempotent for an active (series, group); the 500 cap; the write and read-back; the row (origin
 * `remap`, 365 days, `created_by` the caller) in the read-back's transaction. Never throws for a refusal or a failed
 * write: `{ saved: false, reason, message }`.
 *
 * The preview contract (kind `remap`): `{ claim: { kind: 'shift', fromEpisodeNumber, throughEpisodeNumber, by } |
 * { kind: 'single', fromEpisodeId, toEpisodeId }, digest, seriesId, seriesTitle, moves: [{ fileId, fileName, size,
 * releaseGroup, fromEpisodeIds, toEpisodeIds }], vacatedEpisodeIds, mislabelGroups: [{ releaseGroup, fileCount }] }`.
 */
export async function addMislabelTermFromRemap(input: {
  db?: DbClient;
  sonarr: MislabelBlockWriter;
  repairRequestId: string;
  releaseGroup: string;
  /** The person accepting the offer; null is staff from the in-cluster tool (with requesterIsAdmin, P4 decision 17). */
  requesterId: string | null;
  requesterIsAdmin: boolean;
  now?: Date;
  logger?: DomainLogger;
}): Promise<MislabelSaveResult> {
  const db = resolveDb(input.db);
  const [repair] = await db
    .select({
      id: repairRequests.id,
      kind: repairRequests.kind,
      status: repairRequests.status,
      requesterId: repairRequests.requesterId,
      mediaItemId: repairRequests.mediaItemId,
      preview: repairRequests.preview,
    })
    .from(repairRequests)
    .where(eq(repairRequests.id, input.repairRequestId))
    .limit(1);
  if (!repair) return refusal('not_found');
  if (repair.kind !== 'remap') return refusal('not_remap');
  if (repair.status !== 'completed') return refusal('not_completed');
  if (!input.requesterIsAdmin && repair.requesterId !== input.requesterId) return refusal('not_requester');
  const preview = readRemapPreview(repair.preview);
  if (preview === null) return refusal('preview_invalid');
  if (preview.claimKind !== 'shift') return refusal('not_shift');
  const wanted = input.releaseGroup.trim().toLowerCase();
  const offered = preview.mislabelGroups.find((g) => g.releaseGroup.trim().toLowerCase() === wanted);
  if (wanted.length === 0 || offered === undefined) return refusal('group_not_offered');
  if (offered.fileCount < MISLABEL_MIN_FILES) return refusal('too_few_files');
  const [item] = await db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      arrItemId: mediaItems.arrItemId,
      title: mediaItems.title,
      deletedFromArrAt: mediaItems.deletedFromArrAt,
    })
    .from(mediaItems)
    .where(eq(mediaItems.id, repair.mediaItemId))
    .limit(1);
  if (!item || item.arrKind !== 'sonarr' || item.deletedFromArrAt !== null) return refusal('not_a_series');
  if (preview.seriesId !== null && preview.seriesId !== item.arrItemId) return refusal('preview_invalid');
  const others = await otherSeriesTitles(db, item.arrItemId);
  return saveTerm({
    db: input.db,
    sonarr: input.sonarr,
    seriesId: item.arrItemId,
    mediaItemId: item.id,
    seriesTitle: item.title,
    key: { kind: 'group', releaseGroup: offered.releaseGroup },
    derive: () =>
      deriveMislabelTerm({ seriesTitle: item.title, releaseGroup: offered.releaseGroup.trim(), otherSeriesTitles: others }),
    origin: 'remap',
    repairRequestId: repair.id,
    createdBy: input.requesterId,
    now: input.now ?? new Date(),
    logger: input.logger ?? consoleDomainLogger,
  });
}

/** The adoption's dry run (or a mislabelled name's): the term it would write, and whether that (series, group) or
 *  (series, kind, name) is already active. */
export interface MislabelAdoptPreview {
  saved: false;
  dryRun: true;
  seriesTitle: string;
  term: string;
  alreadyActive: boolean;
  /** ADR-113 — a mislabelled-name term's kind and display text (absent for a group term). */
  kind?: MislabelNameKind;
  nameToken?: string;
}

export type MislabelAdoptResult = MislabelSaveResult | MislabelAdoptPreview;

/**
 * ADR-110 C-05 — adopt Case A's hand-made per-series profile (tag `lost-tapes-release-block`) as one Mislabel Block
 * term: origin `adoption`, no Repair Request, no creator, through the same write and read-back as an offer. The series
 * must exist in Sonarr (`findSeries`); its title is the ledger's (`media_items`), else Sonarr's. `dryRun` derives and
 * reports only (no lock, no write). The hand-made profile and its tag are removed by hand afterwards (PLAN-077 P4).
 */
export async function adoptMislabelTerm(input: {
  db?: DbClient;
  sonarr: MislabelBlockSonarr;
  seriesId: number;
  releaseGroup: string;
  dryRun?: boolean;
  now?: Date;
  logger?: DomainLogger;
}): Promise<MislabelAdoptResult> {
  const db = resolveDb(input.db);
  let live: { title: string } | null;
  try {
    live = await input.sonarr.read.findSeries(input.seriesId);
  } catch {
    return refusal('sonarr_unavailable');
  }
  if (live === null) return refusal('not_a_series');
  const [item] = await db
    .select({ id: mediaItems.id, title: mediaItems.title })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.arrKind, 'sonarr'),
        eq(mediaItems.arrItemId, input.seriesId),
        isNull(mediaItems.deletedFromArrAt),
      ),
    )
    .limit(1);
  const seriesTitle = item?.title ?? live.title;
  const others = await otherSeriesTitles(db, input.seriesId);
  const key = { kind: 'group', releaseGroup: input.releaseGroup.trim() } as const;
  const derive = () => deriveMislabelTerm({ seriesTitle, releaseGroup: key.releaseGroup, otherSeriesTitles: others });
  if (input.dryRun) {
    const existing = await activeRowFor(db, input.seriesId, key, input.now ?? new Date());
    if (existing) return { saved: false, dryRun: true, seriesTitle, term: existing.term, alreadyActive: true };
    const derived = derive();
    if ('refused' in derived) return refusal(derived.refused, derived.otherSeries);
    return { saved: false, dryRun: true, seriesTitle, term: derived.term, alreadyActive: false };
  }
  return saveTerm({
    db: input.db,
    sonarr: input.sonarr,
    seriesId: input.seriesId,
    mediaItemId: item?.id ?? null,
    seriesTitle,
    key,
    derive,
    origin: 'adoption',
    repairRequestId: null,
    createdBy: null,
    now: input.now ?? new Date(),
    logger: input.logger ?? consoleDomainLogger,
  });
}

/**
 * ADR-113 / DESIGN-055 Q-10 ruling — add one MISLABELLED-NAME term (`pair`, `double` or `alias`) for a series: staff
 * from the in-cluster tool (origin `staff`), or the adoption of a hand-made block (origin `adoption`, Case A's five).
 * No Repair Request, no creator, no person-facing offer. The series must exist in Sonarr (`findSeries`, which also gives
 * an alias's alternate titles; a pair reads the series' episodes for `name_is_correct`); its title is the ledger's
 * (`media_items`), else Sonarr's. The term is derived before the lock (`deriveMislabelNameTerm`, with the library's
 * other series), then `saveTerm` writes it as it does a group term: idempotent per (series, kind, name), the 500 cap,
 * the write and read-back, the row (365 days) in the read-back's transaction. `dryRun` derives and reports only (no
 * lock, no write). Never throws for a refusal or a failed write.
 */
export async function addMislabelNameTerm(input: {
  db?: DbClient;
  sonarr: MislabelBlockSonarr;
  seriesId: number;
  kind: MislabelNameKind;
  /** The name as staff give it: `S01E11 Secret Menu` (pair), `S01E13E14` (double), or an alternate title (alias). */
  name: string;
  origin: Extract<MislabelTermOrigin, 'staff' | 'adoption'>;
  dryRun?: boolean;
  now?: Date;
  logger?: DomainLogger;
}): Promise<MislabelAdoptResult> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const logger = input.logger ?? consoleDomainLogger;
  let live: Awaited<ReturnType<MislabelSeriesReader['findSeries']>>;
  let episodes: Awaited<ReturnType<MislabelSeriesReader['listEpisodes']>> = [];
  try {
    live = await input.sonarr.read.findSeries(input.seriesId);
    if (live !== null && input.kind === 'pair') episodes = await input.sonarr.read.listEpisodes(input.seriesId);
  } catch {
    return refusal('sonarr_unavailable');
  }
  if (live === null) return refusal('not_a_series');
  const [item] = await db
    .select({ id: mediaItems.id, title: mediaItems.title })
    .from(mediaItems)
    .where(
      and(
        eq(mediaItems.arrKind, 'sonarr'),
        eq(mediaItems.arrItemId, input.seriesId),
        isNull(mediaItems.deletedFromArrAt),
      ),
    )
    .limit(1);
  const seriesTitle = item?.title ?? live.title;
  const derived = deriveMislabelNameTerm({
    seriesTitle,
    kind: input.kind,
    name: input.name,
    alternateTitles: (live.alternateTitles ?? []).map((a) => a.title),
    episodes,
    otherSeriesTitles: await otherSeriesTitles(db, input.seriesId),
  });
  if ('refused' in derived) {
    logger.info('[mislabel-block] refused', { seriesId: input.seriesId, kind: input.kind, reason: derived.refused });
    return refusal(derived.refused, derived.otherSeries);
  }
  const key: MislabelTermKey = { kind: input.kind, nameToken: derived.nameToken };
  if (input.dryRun) {
    const existing =
      (await activeRowFor(db, input.seriesId, key, now)) ?? (await activeRowWithTerm(db, input.seriesId, derived.term, now));
    return {
      saved: false,
      dryRun: true,
      seriesTitle,
      term: existing?.term ?? derived.term,
      alreadyActive: existing !== undefined,
      kind: input.kind,
      nameToken: derived.nameToken,
    };
  }
  return saveTerm({
    db: input.db,
    sonarr: input.sonarr,
    seriesId: input.seriesId,
    mediaItemId: item?.id ?? null,
    seriesTitle,
    key,
    derive: () => ({ term: derived.term }),
    origin: input.origin,
    repairRequestId: null,
    createdBy: null,
    now,
    logger,
  });
}

// ---------------------------------------------------------------------------
// Reconcile (expiry and drift repair) and the hourly upkeep
// ---------------------------------------------------------------------------

export interface MislabelBlockReconcileReport {
  /** Active terms after the reconcile. */
  total: number;
  /** Terms that expired in this run (in a dry run: that would). */
  expired: number;
  /** How the profile differed before the write (null: it matched). */
  drift: MislabelBlockDriftReason | null;
  /** Terms the write added to, and removed from, the profile (the sentinel not counted). */
  added: number;
  removed: number;
  wrote: boolean;
  dryRun: boolean;
}

/**
 * D-05 — `reconcileMislabelBlock`, the drift repair, under the lock in one transaction: active terms past `expires_at`
 * turn `expired` (`ended_reason` `expired`); desired = the sentinel + the remaining active terms; every term must pass
 * the grammar; the profile is found by name and written only when it drifted (missing while a term is active,
 * disabled, hand-edited required terms, indexer or tags, terms that differ), then read back. A copy of the profile
 * throws `duplicate_profile` and writes nothing. Throws MislabelBlockError and rolls the expiry back on any failure, so
 * a row and the profile never disagree for longer than one run. `dryRun` reads and reports only.
 */
export async function reconcileMislabelBlock(input: {
  db?: DbClient;
  sonarr: MislabelBlockWriter;
  now?: Date;
  dryRun?: boolean;
  logger?: DomainLogger;
}): Promise<MislabelBlockReconcileReport> {
  const now = input.now ?? new Date();
  const logger = input.logger ?? consoleDomainLogger;
  const dryRun = input.dryRun === true;
  const t = mislabelBlockTerms;
  try {
    return await inTransaction(input.db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
      const due = and(eq(t.instance, 'sonarr'), eq(t.state, 'active'), lte(t.expiresAt, now));
      const expired = dryRun
        ? Number((await tx.select({ n: count() }).from(t).where(due))[0]?.n ?? 0)
        : await expireDue(tx, now);
      const active = await readActiveTerms(tx, now);
      const desired = desiredOf(active.map((a) => a.term));
      let report: MislabelBlockReconcileReport;
      if (dryRun) {
        if (!desired.every(isMislabelBlockTerm)) throw new MislabelBlockError('validate');
        let profiles: MislabelReleaseProfile[];
        try {
          profiles = await input.sonarr.write.listReleaseProfiles();
        } catch (cause) {
          throw new MislabelBlockError('read', { cause });
        }
        const drift = mislabelBlockProfileDrift(profiles, desired);
        const have = new Set(profiles.filter(isOurs)[0]?.ignored ?? []);
        const want = new Set(desired);
        report = {
          total: active.length,
          expired,
          drift: drift?.reason ?? null,
          added: [...want].filter((x) => !have.has(x) && x !== MISLABEL_BLOCK_SENTINEL).length,
          removed: [...have].filter((x) => !want.has(x) && x !== MISLABEL_BLOCK_SENTINEL).length,
          wrote: false,
          dryRun,
        };
      } else {
        const write = await writeProfile(input.sonarr.write, desired);
        report = {
          total: active.length,
          expired,
          drift: write.drift?.reason ?? null,
          added: write.added,
          removed: write.removed,
          wrote: write.wrote,
          dryRun,
        };
      }
      logger.info('[mislabel-block] reconciled', { ...report });
      return report;
    });
  } catch (error) {
    if (error instanceof MislabelBlockError) logger.warn('[mislabel-block] reconcile_failed', { step: error.step });
    throw error;
  }
}

export interface MislabelBlockUpkeep {
  /** Active terms past `expires_at` when the upkeep looked. */
  expiring: number;
  /** How the profile differed from the active terms (null: it matched, or the block has never held a term). */
  drift: MislabelBlockDriftReason | null;
  report: MislabelBlockReconcileReport | null;
  error: string | null;
}

/**
 * D-05 — the hourly upkeep the `title-check` sync mode runs: once the block has ever held a term, one
 * `GET /releaseprofile` compares the profile with the active terms, and an expiring term or a drift (logged
 * `[mislabel-block] drift`, warn) runs `reconcileMislabelBlock`. Nothing is read or created before the first term.
 * Best effort: a failure is `[mislabel-block] upkeep_failed` (warn) and `error`, never the run's failure.
 */
export async function mislabelBlockUpkeep(input: {
  db?: DbClient;
  sonarr: MislabelBlockWriter;
  now?: Date;
  logger?: DomainLogger;
}): Promise<MislabelBlockUpkeep> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const logger = input.logger ?? consoleDomainLogger;
  const t = mislabelBlockTerms;
  const out: MislabelBlockUpkeep = { expiring: 0, drift: null, report: null, error: null };
  try {
    const [any] = await db.select({ id: t.id }).from(t).where(eq(t.instance, 'sonarr')).limit(1);
    if (!any) return out;
    const [due] = await db
      .select({ n: count() })
      .from(t)
      .where(and(eq(t.instance, 'sonarr'), eq(t.state, 'active'), lte(t.expiresAt, now)));
    out.expiring = Number(due?.n ?? 0);
    const active = await readActiveTerms(db, now);
    const drift = mislabelBlockProfileDrift(
      await input.sonarr.write.listReleaseProfiles(),
      desiredOf(active.map((a) => a.term)),
    );
    if (drift !== null) {
      out.drift = drift.reason;
      logger.warn('[mislabel-block] drift', {
        reason: drift.reason,
        missingTerms: drift.missingTerms,
        extraTerms: drift.extraTerms,
      });
    }
    if (out.expiring > 0 || out.drift !== null) {
      out.report = await reconcileMislabelBlock({ db, sonarr: input.sonarr, now, logger });
    }
  } catch (error) {
    out.error = error instanceof Error ? error.message : String(error);
    logger.warn('[mislabel-block] upkeep_failed', { drift: out.drift, error: out.error });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Staff removal (ADR-110 C-08)
// ---------------------------------------------------------------------------

export type MislabelRemoveRefusal = 'not_found' | 'not_active' | MislabelWriteRefusal;

export type MislabelRemoveResult =
  | {
      removed: true;
      termId: string;
      seriesId: number;
      kind: MislabelTermKind;
      /** The group (a group term), or null. */
      releaseGroup: string | null;
      /** The name's display text (a mislabelled-name term, ADR-113), or null. */
      nameToken: string | null;
      term: string;
    }
  | { removed: false; reason: MislabelRemoveRefusal; message: string };

const removeRefusal = (reason: MislabelRemoveRefusal): MislabelRemoveResult => ({
  removed: false,
  reason,
  message:
    reason === 'not_found'
      ? 'That block entry could not be found.'
      : reason === 'not_active'
        ? 'That block entry is no longer active.'
        : MISLABEL_REFUSAL_TEXT[reason],
});

/**
 * ADR-110 C-08 — staff remove one active term, under the lock in one transaction: the profile is written without it
 * and read back (the term must be gone), then the row turns `removed` (`ended_reason` `staff_removed`) with one
 * `permission_audit` row (`remove_mislabel_term`, detail `{ termId, seriesId, seriesTitle, kind, releaseGroup,
 * nameToken, term, note }`). A group term and a mislabelled-name term (ADR-113) are removed alike. A failed write or
 * read-back rolls back: the term stays active and nothing is audited.
 */
export async function removeMislabelTerm(input: {
  db?: DbClient;
  sonarr: MislabelBlockWriter;
  termId: string;
  actorId: string;
  note?: string | null;
  now?: Date;
  logger?: DomainLogger;
}): Promise<MislabelRemoveResult> {
  const now = input.now ?? new Date();
  const logger = input.logger ?? consoleDomainLogger;
  const t = mislabelBlockTerms;
  const note = input.note?.trim().slice(0, MISLABEL_NOTE_MAX) || null;
  try {
    return await inTransaction(input.db, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
      const [row] = await tx.select().from(t).where(eq(t.id, input.termId)).for('update');
      if (!row) return removeRefusal('not_found');
      if (row.state !== 'active') return removeRefusal('not_active');
      const rest = (await readActiveTerms(tx, now)).filter((a) => a.id !== row.id).map((a) => a.term);
      // Another active row with the same term text keeps it in the profile (two namesake series, one group).
      await writeProfile(input.sonarr.write, desiredOf(rest));
      await tx
        .update(t)
        .set({ state: 'removed', endedAt: now, endedReason: 'staff_removed' })
        .where(eq(t.id, row.id));
      await tx.insert(permissionAudit).values({
        actorId: input.actorId,
        action: 'remove_mislabel_term',
        detail: {
          termId: row.id,
          seriesId: row.seriesId,
          seriesTitle: row.seriesTitle,
          kind: row.kind,
          releaseGroup: row.releaseGroup,
          nameToken: row.nameToken,
          term: row.term,
          note,
        },
      });
      logger.info('[mislabel-block] term_removed', {
        seriesId: row.seriesId,
        kind: row.kind,
        releaseGroup: row.releaseGroup,
        nameToken: row.nameToken,
      });
      return {
        removed: true,
        termId: row.id,
        seriesId: row.seriesId,
        kind: row.kind,
        releaseGroup: row.releaseGroup,
        nameToken: row.nameToken,
        term: row.term,
      };
    });
  } catch (error) {
    if (!(error instanceof MislabelBlockError)) throw error;
    logger.warn('[mislabel-block] remove_failed', { step: error.step });
    return removeRefusal(STEP_REASON[error.step]);
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface MislabelTermView {
  id: string;
  seriesId: number;
  mediaItemId: string | null;
  seriesTitle: string;
  /** What the term names (ADR-113): a release group, or a mislabelled name (`pair`, `double`, `alias`). */
  kind: MislabelTermKind;
  /** The group of a `group` term; null for a mislabelled name. */
  releaseGroup: string | null;
  /** A mislabelled name's display text (`S01E11 Secret Menu`, `S01E13E14`, an alternate title); null for a group. */
  nameToken: string | null;
  term: string;
  state: MislabelTermState;
  origin: MislabelTermOrigin;
  repairRequestId: string | null;
  createdBy: string | null;
  /** The creator's display name (null for the adoption, or a deleted user). */
  createdByName: string | null;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endedReason: string | null;
}

async function readTerms(
  exec: DbClient | undefined,
  filter: { state?: MislabelTermState | 'all'; seriesId?: number },
): Promise<MislabelTermView[]> {
  const t = mislabelBlockTerms;
  const where = and(
    eq(t.instance, 'sonarr'),
    filter.state === undefined || filter.state === 'all' ? undefined : eq(t.state, filter.state),
    filter.seriesId === undefined ? undefined : eq(t.seriesId, filter.seriesId),
  );
  return resolveDb(exec)
    .select({
      id: t.id,
      seriesId: t.seriesId,
      mediaItemId: t.mediaItemId,
      seriesTitle: t.seriesTitle,
      kind: t.kind,
      releaseGroup: t.releaseGroup,
      nameToken: t.nameToken,
      term: t.term,
      state: t.state,
      origin: t.origin,
      repairRequestId: t.repairRequestId,
      createdBy: t.createdBy,
      createdByName: users.displayName,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
      endedAt: t.endedAt,
      endedReason: t.endedReason,
    })
    .from(t)
    .leftJoin(users, eq(users.id, t.createdBy))
    .where(where)
    .orderBy(desc(t.createdAt), asc(t.id));
}

/** The admin list: every term (or those in one state), newest first. */
export async function listMislabelTerms(
  input: { db?: DbClient; state?: MislabelTermState | 'all' } = {},
): Promise<MislabelTermView[]> {
  return readTerms(input.db, { state: input.state ?? 'all' });
}

/** One series' terms, newest first: the active ones unless `state` says otherwise (the title page, the guide). */
export async function mislabelTermsForSeries(input: {
  db?: DbClient;
  seriesId: number;
  state?: MislabelTermState | 'all';
}): Promise<MislabelTermView[]> {
  return readTerms(input.db, { state: input.state ?? 'active', seriesId: input.seriesId });
}
