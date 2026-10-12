// ADR-110 / DESIGN-055 D-05 (PLAN-077 P2): TITLE EVIDENCE, what a release or file name's own title says about which
// episode (or movie) it is. Pure: no I/O, no database.
//
// A TV name's title segment is the tokens after its `SxxEyy` (or `NxNN`) token up to the first stop token; it is scored
// against every title of the judged season by token-set Dice, two-part TVDB titles (`A / B`, `A; B`) part by part. The
// verdict against the episodes the file is mapped to is `agrees`, `disagrees` (another episode is the clear match),
// `silent` (no segment, or nothing to compare it with) or `ambiguous`. Silence and ambiguity are never evidence against
// an import (D-05 rule 5). A movie name's title is scored by containment of the movie's title in it, with a year check.
// The Import Check (D-07), the Release Pick (D-06) and the Title Check census read these verdicts; the thresholds are
// starting values the census tunes (Q-06, PLAN-077 P4).
import { foldReleaseName } from './release-terms';

/**
 * Bump when the stop-token list or the rules change, so a stored verdict can be told apart from one the current rules
 * would give.
 */
export const TITLE_EVIDENCE_VERSION = 1;
/** D-05 rule 4 (Q-06 starting value): the least score that counts as a match. */
export const TITLE_AGREE_MIN = 0.8;
/** D-05 rule 4 (Q-06 starting value): how far another episode must beat the mapped one to disagree. */
export const TITLE_DISAGREE_MARGIN = 0.3;

export type TitleVerdict = 'agrees' | 'disagrees' | 'silent' | 'ambiguous';

export interface TitleEvidenceEpisode {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string | null;
}

export interface ParsedReleaseName {
  /** Tokens before the episode token (TV); [] for a movie. */
  seriesTokens: string[];
  /** TV: the last 1900..2099 token of seriesTokens (not the first token). Movie: the release year. */
  year: number | null;
  /** From `SxxEyy` / `NxNN`; null when the name has no episode token (a movie). */
  season: number | null;
  /** Every episode number the name carries (`S01E55E56` and `S01E55-E56` give [55, 56]); [] for a movie. */
  episodes: number[];
  /** TV: the episode-title segment. Movie: the movie-title segment. */
  titleTokens: string[];
}

// ---------------------------------------------------------------------------
// Tokens. `foldReleaseName` (DESIGN-052 D-12) does the folding: HTML entities decoded, apostrophes removed (before and
// after NFKD), accents dropped, `&` read as `and`, lower case. A vulgar fraction gets a separator first, so `2½`
// reads as `2 1 2` the way `2.1.2` does, and a thousands comma joins its digits (`12,000` reads as `12000`, the way a
// release name writes it). Every other character that is not a letter, mark or digit separates tokens.
// ---------------------------------------------------------------------------

const VULGAR_FRACTION = /[¼-¾⅐-⅟↉]/g;
const THOUSANDS_COMMA = /(\d),(?=\d{3}(?!\d))/g;
/** An indexer's double-escaped ampersand (`&amp;amp;`), read as one `&`. */
const ESCAPED_AMPERSAND = /&(?:amp;)+/gi;
const TOKEN_SEPARATORS = /[^\p{L}\p{M}\p{N}]+/u;

export function normalizeTokens(text: string): string[] {
  return foldReleaseName(
    text
      .replace(ESCAPED_AMPERSAND, '&')
      .replace(VULGAR_FRACTION, ' $&')
      .replace(THOUSANDS_COMMA, '$1'),
  )
    .split(TOKEN_SEPARATORS)
    .filter((t) => t.length > 0);
}

// ---------------------------------------------------------------------------
// Stop tokens (TITLE_EVIDENCE_VERSION 1). A title segment ends at the first stop token. Ordinary words are never on the
// lists ("it", "now", "max", "stan", "spa", "complete", "extended", "uncut"): a stop token placed inside a real title
// cuts the title short. A tag that is also a word ("Franklin and the Red Scooter", "The French Connection", "Tangled in
// the Web") stops only where it reads as a tag, which the rules below decide from the token after it.
// ---------------------------------------------------------------------------

/** Always a stop: none of these is a word in a title. */
const STOP_TOKENS: ReadonlySet<string> = new Set([
  // resolution and format
  '4k',
  'uhd',
  // sources (`blu` from Blu-ray)
  'webdl',
  'webrip',
  'dlrip',
  'hdtv',
  'pdtv',
  'sdtv',
  'tvrip',
  'hdrip',
  'bluray',
  'blu',
  'bdrip',
  'brrip',
  'dvdrip',
  'remux',
  // services
  'amzn',
  'nf',
  'hmax',
  'dsnp',
  'pcok',
  'atvp',
  'hulu',
  'skst',
  'dscp',
  'pmtp',
  // codecs
  'x264',
  'x265',
  'h264',
  'h265',
  'hevc',
  'avc',
  'av1',
  'xvid',
  'divx',
  // audio
  'ac3',
  'eac3',
  'dts',
  'truehd',
  'flac',
  'mp3',
  // hdr
  'hdr',
  'hdr10',
  'hdr10plus',
  'dv',
  'dovi',
  'sdr',
  // language and subtitles
  'multi',
  'multisub',
  'vostfr',
  'swesub',
  // misc
  'repack',
  'rerip',
  'readnfo',
  // a source tag written inside the title by one uploader of the library's Aqua Teen Hunger Force (live, 2026-10-12)
  'nortv',
]);

const RESOLUTION = /^\d{3,4}[pi]$/;
/** Always a stop: resolutions, bit depths, `aac2`, `dd`, `ddp5` and the like. */
const STOP_PATTERNS: readonly RegExp[] = [RESOLUTION, /^\d+bit$/, /^aac\d*$/, /^ddp?\d*$/];

/**
 * Words that are also tags: a stop only when the token after it is a stop too (`Title.FRENCH.1080p`, and the German
 * `GERMAN.DL.1080P` where DL is dual language), never inside a title (`S10E02.French.Alps.1080p`).
 */
const STOP_BEFORE_STOP: ReadonlySet<string> = new Set([
  'dl',
  'red',
  'cr',
  'roku',
  'atmos',
  'opus',
  'dual',
  'dubbed',
  'subbed',
  'latino',
  'castellano',
  'french',
  'german',
  'spanish',
  'italian',
  'nordic',
  'proper',
  'internal',
]);

const isAlwaysStop = (t: string) => STOP_TOKENS.has(t) || STOP_PATTERNS.some((re) => re.test(t));

/**
 * Which tokens are stops. `web` is a stop before `dl` or `rip` (`WEB-DL`, `WEB.DL`, `WEB-Rip`) and before any other
 * stop except a resolution: a release writes the resolution before its source (`1080p.WEB`), so `Tangled.in.the.Web.
 * 1080p` keeps its last word. `h` is a stop only as the H of `H.264` / `H.265`. Read from the end, so a tag word before
 * a tag word before a stop (`iNTERNAL.WEB.H264`) stops at the first.
 */
function stopFlags(tokens: readonly string[]): boolean[] {
  const flags = tokens.map(() => false);
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i] as string;
    const next = tokens[i + 1];
    const nextIsStop = flags[i + 1] === true;
    if (isAlwaysStop(t)) flags[i] = true;
    else if (t === 'web')
      flags[i] =
        next === 'dl' ||
        next === 'rip' ||
        (nextIsStop && next !== undefined && !RESOLUTION.test(next));
    else if (t === 'h') flags[i] = next === '264' || next === '265';
    else if (STOP_BEFORE_STOP.has(t)) flags[i] = nextIsStop;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const VIDEO_EXTENSION = /\.(mkv|mp4|m4v|avi|wmv|mov|mpg|mpeg|ts|m2ts|webm|iso)$/i;
const EPISODE_SXXEYY = /^s(\d{1,4})e(\d{1,4})((?:e\d{1,4})*)$/;
const EPISODE_NXNN = /^(\d{1,2})x(\d{1,3})$/;
const EXTRA_EPISODE = /^e(\d{1,4})$/;
const YEAR = /^(19|20)\d{2}$/;
/** The widest multi-episode range read as a range; anything wider keeps only the numbers written. */
const MAX_EPISODE_SPAN = 200;

function baseName(name: string): string {
  const segment =
    name
      .split(/[\\/]/)
      .filter((s) => s.length > 0)
      .pop() ?? name;
  return segment.replace(VIDEO_EXTENSION, '');
}

function episodeToken(token: string): { season: number; episodes: number[] } | null {
  const sxe = EPISODE_SXXEYY.exec(token);
  if (sxe) {
    const extra = [...(sxe[3] ?? '').matchAll(/e(\d{1,4})/g)].map((m) => Number(m[1]));
    return { season: Number(sxe[1]), episodes: [Number(sxe[2]), ...extra] };
  }
  const nx = EPISODE_NXNN.exec(token);
  if (nx) return { season: Number(nx[1]), episodes: [Number(nx[2])] };
  return null;
}

/**
 * The episode numbers of a multi-episode name, read the way Sonarr reads them: the range from the first number to the
 * last (`S01E01-E03` and `S01E01-S01E03` are 1, 2 and 3; `S01E55E56` is 55 and 56). Numbers that do not rise keep
 * only what is written.
 */
function episodeRange(numbers: readonly number[]): number[] {
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  if (
    first !== undefined &&
    last !== undefined &&
    last > first &&
    last - first <= MAX_EPISODE_SPAN
  ) {
    return Array.from({ length: last - first + 1 }, (_, k) => first + k);
  }
  return [...new Set(numbers)];
}

interface Tokenized {
  tokens: string[];
  stops: boolean[];
  parsed: ParsedReleaseName;
}

function tokenize(name: string): Tokenized {
  const tokens = normalizeTokens(baseName(name));
  const stops = stopFlags(tokens);
  for (let i = 0; i < tokens.length; i += 1) {
    const ep = episodeToken(tokens[i] as string);
    if (!ep) continue;
    const numbers = [...ep.episodes];
    let end = i + 1;
    for (; end < tokens.length; end += 1) {
      const t = tokens[end] as string;
      const extra = EXTRA_EPISODE.exec(t);
      if (extra) {
        numbers.push(Number(extra[1]));
        continue;
      }
      const again = episodeToken(t);
      if (again === null || again.season !== ep.season) break;
      numbers.push(...again.episodes);
    }
    let stop = end;
    while (stop < tokens.length && !stops[stop]) stop += 1;
    const seriesTokens = tokens.slice(0, i);
    let year: number | null = null;
    for (let j = seriesTokens.length - 1; j >= 1; j -= 1) {
      if (YEAR.test(seriesTokens[j] as string)) {
        year = Number(seriesTokens[j]);
        break;
      }
    }
    const parsed = {
      seriesTokens,
      year,
      season: ep.season,
      episodes: episodeRange(numbers),
      titleTokens: tokens.slice(end, stop),
    };
    return { tokens, stops, parsed };
  }
  let firstStop = stops.indexOf(true);
  if (firstStop < 0) firstStop = tokens.length;
  let yearIdx = -1;
  for (let j = firstStop - 1; j >= 1; j -= 1) {
    if (YEAR.test(tokens[j] as string)) {
      yearIdx = j;
      break;
    }
  }
  const parsed = {
    seriesTokens: [],
    year: yearIdx >= 0 ? Number(tokens[yearIdx]) : null,
    season: null,
    episodes: [],
    titleTokens: tokens.slice(0, yearIdx >= 0 ? yearIdx : firstStop),
  };
  return { tokens, stops, parsed };
}

/**
 * Parse a release or file name (D-05 rule 2). The FIRST `SxxEyy[Eyy...]` or `NxNN` token makes it a TV name: the
 * tokens before it are the series, directly following `Eyy` (`S01E55-E56`) or same-season `SxxEyy` tokens
 * (`S01E01-S01E09`) extend its episodes, and the title segment runs from there to the first stop token, so a number in
 * the title (`S02E06_125_Years_Young`) is a title word, never an episode. A name without one is a movie: the year is
 * the last 1900..2099 token before the first stop token that is not the first token (`Blade.Runner.2049.2017`,
 * `2001.A.Space.Odyssey.1968`), and the title is what comes before it.
 */
export function parseReleaseName(name: string): ParsedReleaseName {
  return tokenize(name).parsed;
}

/** Dice coefficient on token SETS: 2|A∩B| / (|A| + |B|); 0 when either is empty. */
export function titleSimilarity(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared += 1;
  return (2 * shared) / (sa.size + sb.size);
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export interface EpisodeTitleEvidence {
  verdict: TitleVerdict;
  /** The name's episode-title segment ([] when it has none). */
  titleTokens: string[];
  /** The episodes judged against, found in `episodes`, in season and episode order. */
  againstEpisodeIds: number[];
  againstScore: number | null;
  /** The best-scoring episode of the judged season; null when silent or when no title shares a token with the name. */
  bestEpisodeId: number | null;
  bestScore: number | null;
}

/** TVDB's two-part titles: "Franklin Rides a Bike / Franklin Is Messy". */
const TITLE_PARTS = /\s+\/\s+|;/;
/** A title that says nothing yet. A fresh episode is often "TBA". */
const PLACEHOLDER_TITLE = /^(tba|tbd)$/i;

function knownTitle(title: string | null): string | null {
  const t = title?.trim() ?? '';
  return t.length > 0 && !PLACEHOLDER_TITLE.test(t) ? t : null;
}

const IN_WORD_HYPHEN = /(?<=[\p{L}\p{N}])-(?=[\p{L}\p{N}])/gu;
const ACCENTED_LETTER = /\p{L}/gu;
const COMBINING_MARK = /[̀-ͯ]/;

/**
 * The ways a reference title is read, since releases write the same title several ways: as written (accents folded,
 * "Café" as `cafe`), with its in-word hyphens joined (TVDB's "Boba or Bo-Bust" as `Boba.or.BoBust`), and with its
 * accented letters dropped (one uploader writes "No Way, Soufflé!" as `No.Way.Souffl`). A title scores its best reading.
 */
function titleReadings(title: string): string[][] {
  const readings = [normalizeTokens(title)];
  const joined = title.replace(IN_WORD_HYPHEN, '');
  if (joined !== title) readings.push(normalizeTokens(joined));
  const dropped = title
    .normalize('NFC')
    .replace(ACCENTED_LETTER, (ch) => (COMBINING_MARK.test(ch.normalize('NFD')) ? '' : ch));
  if (dropped !== title.normalize('NFC')) readings.push(normalizeTokens(dropped));
  return readings;
}

const bestReading = (segment: readonly string[], title: string) =>
  Math.max(...titleReadings(title).map((tokens) => titleSimilarity(segment, tokens)));

/** An episode's score: the best of its whole title and each part of a two-part title. 0 for a placeholder title. */
function episodeScore(segment: readonly string[], title: string | null): number {
  const t = knownTitle(title);
  if (t === null) return 0;
  let best = bestReading(segment, t);
  const parts = t.split(TITLE_PARTS);
  if (parts.length > 1) for (const part of parts) best = Math.max(best, bestReading(segment, part));
  return best;
}

/** Scores are ratios of small integers; a difference that is exactly the margin must not miss it by a rounding step. */
const FLOAT_SLACK = 1e-9;

const byEpisodeOrder = (a: TitleEvidenceEpisode, b: TitleEvidenceEpisode) =>
  a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber;

/**
 * D-05 rules 3 and 4: judge a TV name against the episodes its file is mapped to (`againstEpisodeIds`, else the name's
 * own season and episode numbers). Every episode of the judged season is scored; the mapped episodes' score is the best
 * of their concatenated titles (a multi-episode file) and each one's own score.
 *
 * - `silent`: the name has no episode token or no title segment, or every mapped episode's title is empty or TBA/TBD.
 * - `agrees`: the mapped score is at least TITLE_AGREE_MIN and no other episode of the season scores higher (D-05 rule
 *   4: the mapped episode is the best match).
 * - `disagrees`: the best episode is not a mapped one, scores at least TITLE_AGREE_MIN and beats the mapped score by at
 *   least TITLE_DISAGREE_MARGIN (a mapping that finds no episode counts as 0).
 * - `ambiguous`: anything else.
 */
export function episodeTitleEvidence(input: {
  name: string;
  episodes: readonly TitleEvidenceEpisode[];
  againstEpisodeIds?: readonly number[];
}): EpisodeTitleEvidence {
  const parsed = parseReleaseName(input.name);
  const segment = parsed.season === null ? [] : parsed.titleTokens;

  const own = input.episodes.filter(
    (e) => e.seasonNumber === parsed.season && parsed.episodes.includes(e.episodeNumber),
  );
  let against = own;
  if (input.againstEpisodeIds) {
    const wanted = new Set(input.againstEpisodeIds);
    const given = input.episodes.filter((e) => wanted.has(e.id));
    // Sonarr's history has one row per episode, so a multi-episode file (`S01E16E17`) is often judged through one of
    // its episodes. When the given episodes include one the name carries, judge against all of the name's episodes:
    // the other half of the file is not "another episode" that disagrees.
    against = given.some((e) => own.includes(e)) ? [...new Set([...given, ...own])] : given;
  }
  against = [...against].sort(byEpisodeOrder);
  const againstIds = new Set(against.map((e) => e.id));
  const silent = (): EpisodeTitleEvidence => ({
    verdict: 'silent',
    titleTokens: segment,
    againstEpisodeIds: [...againstIds],
    againstScore: null,
    bestEpisodeId: null,
    bestScore: null,
  });
  if (segment.length === 0) return silent();
  const knownAgainst = against.filter((e) => knownTitle(e.title) !== null);
  if (against.length > 0 && knownAgainst.length === 0) return silent();

  const seasons = new Set(
    against.length > 0 ? against.map((e) => e.seasonNumber) : [parsed.season],
  );
  const candidates = input.episodes.filter((e) => seasons.has(e.seasonNumber)).sort(byEpisodeOrder);
  const scores = new Map(candidates.map((e) => [e.id, episodeScore(segment, e.title)] as const));

  let againstScore: number | null = null;
  if (knownAgainst.length > 0) {
    const joined = knownAgainst.map((e) => knownTitle(e.title) as string).join(' ');
    againstScore = Math.max(
      bestReading(segment, joined),
      ...knownAgainst.map((e) => scores.get(e.id) ?? 0),
    );
  }

  let best: TitleEvidenceEpisode | null = null;
  let bestScore = 0;
  let otherBest = 0;
  for (const e of candidates) {
    const s = scores.get(e.id) ?? 0;
    if (s > bestScore) {
      best = e;
      bestScore = s;
    }
    if (!againstIds.has(e.id)) otherBest = Math.max(otherBest, s);
  }

  let verdict: TitleVerdict = 'ambiguous';
  if (againstScore !== null && againstScore >= TITLE_AGREE_MIN && otherBest <= againstScore) {
    verdict = 'agrees';
  } else if (
    best !== null &&
    !againstIds.has(best.id) &&
    bestScore >= TITLE_AGREE_MIN &&
    bestScore - (againstScore ?? 0) >= TITLE_DISAGREE_MARGIN - FLOAT_SLACK
  ) {
    verdict = 'disagrees';
  }
  return {
    verdict,
    titleTokens: segment,
    againstEpisodeIds: [...againstIds],
    againstScore,
    bestEpisodeId: best?.id ?? null,
    bestScore: best ? bestScore : null,
  };
}

// ---------------------------------------------------------------------------
// Movies and series years
// ---------------------------------------------------------------------------

export interface MovieTitleEvidence {
  verdict: 'agrees' | 'ambiguous' | 'silent';
  titleTokens: string[];
  /** The best containment of one of the movie's titles in the name's title; null when nothing was scored. */
  score: number | null;
  nameYear: number | null;
}

/** A season pack's marker (`Show.S01.1080p`, `Show.Season.2`), read only before the first stop token. */
const SEASON_PACK = /^s\d{1,2}$/;
/** An obfuscated download name (`a8f7d6e5c4b3a2918273645.mkv`): one long run of letters and digits mixed. */
const OBFUSCATED = /^(?=[a-z]*\d)(?=\d*[a-z])[a-z0-9]{12,}$/;

function isSeasonPack({ tokens, stops }: Tokenized): boolean {
  for (let i = 0; i < tokens.length && !stops[i]; i += 1) {
    const t = tokens[i] as string;
    if (SEASON_PACK.test(t) || (t === 'season' && /^\d{1,2}$/.test(tokens[i + 1] ?? '')))
      return true;
  }
  return false;
}

/**
 * A movie name against the movie's titles (its title and alternative titles). A TV name (an episode token, or a season
 * pack such as `Star.Wars.Rebels.S01.1080p`) is a TV release grabbed for a movie: `ambiguous`. Otherwise the score is
 * the best containment |T ∩ S| / |T| of a title's tokens T in the name's title tokens S, so a name that carries a
 * second title (`Orumcek Adam ... [Spider Man Brand New Day] 2026`) still matches. `agrees` at TITLE_AGREE_MIN or more
 * unless both years are known and differ by more than 1. A name with no title, or an obfuscated one, is `silent`.
 */
export function movieTitleEvidence(input: {
  name: string;
  titles: readonly string[];
  year?: number | null;
}): MovieTitleEvidence {
  const tokenized = tokenize(input.name);
  const { parsed } = tokenized;
  const nameYear = parsed.year;
  if (parsed.season !== null || isSeasonPack(tokenized)) {
    return { verdict: 'ambiguous', titleTokens: parsed.titleTokens, score: null, nameYear };
  }
  // An obfuscated name says nothing about the title, so the caller can fall back to the release title.
  if (
    parsed.titleTokens.length === 0 ||
    (nameYear === null && parsed.titleTokens.every((t) => OBFUSCATED.test(t)))
  ) {
    return { verdict: 'silent', titleTokens: [], score: null, nameYear };
  }
  const have = new Set(parsed.titleTokens);
  let score: number | null = null;
  for (const title of input.titles) {
    for (const reading of titleReadings(title)) {
      const want = new Set(reading);
      if (want.size === 0) continue;
      let shared = 0;
      for (const t of want) if (have.has(t)) shared += 1;
      score = Math.max(score ?? 0, shared / want.size);
    }
  }
  const yearClash =
    input.year !== undefined &&
    input.year !== null &&
    nameYear !== null &&
    Math.abs(input.year - nameYear) > 1;
  const verdict = score !== null && score >= TITLE_AGREE_MIN && !yearClash ? 'agrees' : 'ambiguous';
  return { verdict, titleTokens: parsed.titleTokens, score, nameYear };
}

/** The release's own year when it conflicts with the series' year (both known and |diff| > 1), else null. TV only. */
export function seriesYearConflict(input: {
  name: string;
  seriesYear: number | null;
}): number | null {
  const parsed = parseReleaseName(input.name);
  if (parsed.season === null || parsed.year === null || input.seriesYear === null) return null;
  return Math.abs(parsed.year - input.seriesYear) > 1 ? parsed.year : null;
}
