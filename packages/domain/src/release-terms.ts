// ADR-093 C-07 / C-19 / DESIGN-052 D-11 / D-12 (PLAN-072) — the Release Block's "must not contain" TERMS, pure.
//
// A term is a Perl-style regex (`/pattern/i`) Radarr and Sonarr match against every release title they consider.
// They never validate a term on write and compile it only at decision time, so ONE term that does not compile in .NET
// rejects every release on that *arr (ADR-093 C-19). This module is therefore the only place a term is built
// (`renderTerm`) and the grammar check the writer runs before every POST / PUT (`isGrammarTerm`) accepts exactly the
// three templates below and nothing else:
//
//   movie, group known   /^{T}SEP+{Y}SEP(?=.*(?<![a-z0-9]){R}p(?![a-z0-9])){X}.*SEP{G}(?:SEP|$)/i
//   show, per season     /^{T}SEP+(?:{Y}SEP+)?s0*{S}(?:e[0-9]+)*(?![0-9a-z])(?=.*(?<![a-z0-9]){R}p(?![a-z0-9])).*SEP{G}(?:SEP|$)/i
//   exact release name   /^{name tokens joined by SEP*}(?:SEP|$)/i
//
// SEP is `[^a-z0-9]`, which matches identically in .NET and JavaScript under `i` (`\W` does not), so the in-app
// self-check tests what the *arr will run. Every title, year and group token is `[a-z0-9]+`; R is 2160 / 1080 / 720
// / 480; S is digits; the only flag is `i`. The sentinel is the one plain (non-regex) term.

/** The plain term that keeps the app's profile valid when it holds no live term (an *arr refuses an empty profile). */
export const RELEASE_BLOCK_SENTINEL = 'hnet-release-block-sentinel';
/** The app-owned profile's exact name on Radarr and on Sonarr (D-13). */
export const RELEASE_BLOCK_PROFILE_NAME = 'haynesnetwork: deleted releases (managed, do not edit)';

export const TERM_RESOLUTIONS = [2160, 1080, 720, 480] as const;
export type TermResolution = (typeof TERM_RESOLUTIONS)[number];

const SEP = '[^a-z0-9]';
const REMUX_LOOKAHEAD = '(?=.*(?<![a-z0-9])remux(?![a-z0-9]))';
const resolutionLookahead = (r: TermResolution) => `(?=.*(?<![a-z0-9])${r}p(?![a-z0-9]))`;

export type TermParts =
  | {
      shape: 'movie_group';
      title: string[];
      years: number[];
      resolution: TermResolution;
      remux: boolean;
      group: string[];
    }
  | {
      shape: 'show_group';
      title: string[];
      years: number[];
      season: number;
      resolution: TermResolution;
      group: string[];
    }
  | { shape: 'exact'; tokens: string[] };

// ---------------------------------------------------------------------------
// Tokens (D-12): NFKD, combining marks removed, apostrophes removed, `&` read as `and`, lower case, split on
// [^a-z0-9]+.
// ---------------------------------------------------------------------------

const APOSTROPHES = /['‘’ʼ`´]/g;

/** Fold a name the way the tokens are built: accents and apostrophes removed, `&` read as `and`, lower case. */
export function foldReleaseName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(APOSTROPHES, '')
    .replace(/&/g, ' and ')
    .toLowerCase();
}

export function releaseTokens(value: string): string[] {
  return foldReleaseName(value)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

const isYearToken = (t: string) => /^(19|20)\d{2}$/.test(t);

/** The last path segment of a file path (either separator), without a media file extension. */
export function releaseBaseName(value: string): string {
  const segment =
    value
      .split(/[\\/]/)
      .filter((s) => s.length > 0)
      .pop() ?? value;
  return segment.replace(/\.(mkv|mp4|avi|m4v|ts|wmv|mov|iso|nzb)$/i, '');
}

/** Words a trailing `-XXX` can be that are not a release group (`WEB-DL`, `Blu-Ray`, `DTS-HD`, `H-264` …). */
const NOT_A_GROUP = new Set([
  'dl',
  'rip',
  'ray',
  'hd',
  'ma',
  'x',
  'es',
  'sd',
  'audio',
  'dts',
  'web',
  'hdr',
  'dv',
]);

/** The scene release group: the text after the last `-` of the base name when it is one alphanumeric word. */
export function parseReleaseGroup(name: string): string | null {
  const base = releaseBaseName(name);
  const idx = base.lastIndexOf('-');
  if (idx < 0) return null;
  const candidate = base.slice(idx + 1).trim();
  if (!/^[A-Za-z0-9]+$/.test(candidate)) return null;
  if (NOT_A_GROUP.has(candidate.toLowerCase()) || /^\d+$/.test(candidate)) return null;
  return candidate;
}

export interface ParsedReleaseName {
  tokens: string[];
  /** Tokens before the year (movies) or before the year / season marker (shows). */
  titleTokens: string[];
  year: number | null;
  resolution: TermResolution | null;
  season: number | null;
  group: string | null;
  remux: boolean;
}

/**
 * Parse a release (or file) name. The year is a 19xx / 20xx token after at least one title token; when two year-like
 * tokens are adjacent (`Blade.Runner.2049.2017`) the later one is the year. A year in `preferYears` wins over the
 * heuristic (the *arr's own years).
 */
export function parseReleaseName(
  name: string,
  preferYears: readonly number[] = [],
): ParsedReleaseName {
  const tokens = releaseTokens(releaseBaseName(name));
  let yearIdx = -1;
  const preferred = new Set(preferYears);
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i] as string;
    if (isYearToken(t) && preferred.has(Number(t))) {
      yearIdx = i;
      break;
    }
  }
  if (yearIdx < 0) {
    for (let i = 1; i < tokens.length; i += 1) {
      const t = tokens[i] as string;
      if (!isYearToken(t)) continue;
      const next = tokens[i + 1];
      if (next !== undefined && isYearToken(next)) continue;
      yearIdx = i;
      break;
    }
  }
  let seasonIdx = -1;
  let season: number | null = null;
  for (let i = 1; i < tokens.length; i += 1) {
    const m = /^s(\d{1,3})(?:e\d+)*$/.exec(tokens[i] as string);
    if (m) {
      seasonIdx = i;
      season = Number(m[1]);
      break;
    }
  }
  let resolution: TermResolution | null = null;
  for (const t of tokens) {
    const m = /^(2160|1080|720|480)p$/.exec(t);
    if (m) {
      resolution = Number(m[1]) as TermResolution;
      break;
    }
  }
  const cut = [yearIdx, seasonIdx].filter((i) => i > 0);
  const titleEnd = cut.length > 0 ? Math.min(...cut) : 0;
  return {
    tokens,
    titleTokens: titleEnd > 0 ? tokens.slice(0, titleEnd) : [],
    year: yearIdx > 0 ? Number(tokens[yearIdx]) : null,
    resolution,
    season,
    group: parseReleaseGroup(name),
    remux: tokens.includes('remux'),
  };
}

/** A parsed name names a RELEASE (not only a title): a title, then a year or a season, and a resolution or a group. */
export function looksLikeRelease(p: ParsedReleaseName): boolean {
  return (
    p.titleTokens.length > 0 &&
    (p.year !== null || p.season !== null) &&
    (p.resolution !== null || p.group !== null)
  );
}

/** D-25be — does the name carry a token besides its title, its year, its season marker and its resolution? */
export function hasTokenBeyondRelease(p: ParsedReleaseName): boolean {
  const rest = p.tokens.slice(p.titleTokens.length);
  return rest.some(
    (t) =>
      !(p.year !== null && t === String(p.year)) &&
      !/^s\d{1,3}(?:e\d+)*$/.test(t) &&
      !/^(2160|1080|720|480)p$/.test(t),
  );
}

/** An *arr quality resolution as a term resolution, or null (576, 0, unknown). */
export function toTermResolution(value: number | null | undefined): TermResolution | null {
  return (TERM_RESOLUTIONS as readonly number[]).includes(value ?? -1)
    ? (value as TermResolution)
    : null;
}

/** The resolution a quality NAME carries (`Remux-2160p`, `WEBDL-1080p`, `Bluray-720p`), or null. */
export function resolutionFromQualityName(name: string | null | undefined): TermResolution | null {
  const m = /(2160|1080|720|480)p/i.exec(name ?? '');
  return m ? (Number(m[1]) as TermResolution) : null;
}

// ---------------------------------------------------------------------------
// Rendering and the grammar (D-12)
// ---------------------------------------------------------------------------

const yearsPattern = (years: readonly number[]) => {
  const distinct = [...new Set(years)].sort((a, b) => a - b);
  return distinct.length === 1 ? String(distinct[0]) : `(?:${distinct.join('|')})`;
};

/** Build a term from its parts. Throws on parts outside the grammar (a token that is not `[a-z0-9]+`, no year …). */
export function renderTerm(parts: TermParts): string {
  const okTokens = (tokens: readonly string[]) =>
    tokens.length > 0 && tokens.every((t) => /^[a-z0-9]+$/.test(t));
  switch (parts.shape) {
    case 'movie_group': {
      if (!okTokens(parts.title) || !okTokens(parts.group)) throw new Error('term: bad tokens');
      if (parts.years.length === 0 || !parts.years.every((y) => /^\d{4}$/.test(String(y)))) {
        throw new Error('term: bad years');
      }
      return (
        `/^${parts.title.join(`${SEP}+`)}${SEP}+${yearsPattern(parts.years)}${SEP}` +
        resolutionLookahead(parts.resolution) +
        (parts.remux ? REMUX_LOOKAHEAD : '') +
        `.*${SEP}${parts.group.join(`${SEP}*`)}(?:${SEP}|$)/i`
      );
    }
    case 'show_group': {
      if (!okTokens(parts.title) || !okTokens(parts.group)) throw new Error('term: bad tokens');
      if (parts.years.length === 0 || !parts.years.every((y) => /^\d{4}$/.test(String(y)))) {
        throw new Error('term: bad years');
      }
      if (!Number.isInteger(parts.season) || parts.season < 1) throw new Error('term: bad season');
      return (
        `/^${parts.title.join(`${SEP}+`)}${SEP}+(?:${yearsPattern(parts.years)}${SEP}+)?` +
        `s0*${parts.season}(?:e[0-9]+)*(?![0-9a-z])` +
        resolutionLookahead(parts.resolution) +
        `.*${SEP}${parts.group.join(`${SEP}*`)}(?:${SEP}|$)/i`
      );
    }
    case 'exact': {
      if (!okTokens(parts.tokens)) throw new Error('term: bad tokens');
      return `/^${parts.tokens.join(`${SEP}*`)}(?:${SEP}|$)/i`;
    }
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const TOK = '[a-z0-9]+';
const YEAR = '\\d{4}';
const Y_META = `(?:${YEAR}|${esc('(?:')}${YEAR}(?:${esc('|')}${YEAR})+${esc(')')})`;
const RES_META = `${esc('(?=.*(?<![a-z0-9])')}(?:2160|1080|720|480)${esc('p(?![a-z0-9]))')}`;
const TITLE_META = `${TOK}(?:${esc(`${SEP}+`)}${TOK})*`;
const GROUP_META = `${TOK}(?:${esc(`${SEP}*`)}${TOK})*`;
const TAIL_META = `${esc(`.*${SEP}`)}${GROUP_META}${esc(`(?:${SEP}|$)/i`)}`;

const MOVIE_META = new RegExp(
  `^${esc('/^')}${TITLE_META}${esc(`${SEP}+`)}${Y_META}${esc(SEP)}${RES_META}(?:${esc(REMUX_LOOKAHEAD)})?${TAIL_META}$`,
);
const SHOW_META = new RegExp(
  `^${esc('/^')}${TITLE_META}${esc(`${SEP}+`)}${esc('(?:')}${Y_META}${esc(`${SEP}+)?`)}` +
    `${esc('s0*')}[1-9]\\d*${esc('(?:e[0-9]+)*(?![0-9a-z])')}${RES_META}${TAIL_META}$`,
);
const EXACT_META = new RegExp(
  `^${esc('/^')}${TOK}(?:${esc(`${SEP}*`)}${TOK})*${esc(`(?:${SEP}|$)/i`)}$`,
);

/**
 * DESIGN-052 D-12 / D-13 step 2 — is this exactly one of the three templates (or the sentinel), and does it compile?
 * The writer refuses to POST / PUT a profile holding any term for which this is false.
 */
export function isGrammarTerm(term: string): boolean {
  if (term === RELEASE_BLOCK_SENTINEL) return true;
  if (term.length > 1_000) return false;
  if (!MOVIE_META.test(term) && !SHOW_META.test(term) && !EXACT_META.test(term)) return false;
  return compileTerm(term) !== null;
}

/** Compile a `/pattern/i` term the way the *arr does (`PerlRegexFactory`), or null when it is not one. */
export function compileTerm(term: string): RegExp | null {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(term);
  if (!m || m[2] !== 'i') return null;
  try {
    return new RegExp(m[1] as string, 'i');
  } catch {
    return null;
  }
}

/** Does the term match this release name? The name is folded like the tokens (D-25: accents, apostrophes, `&`). */
export function termMatches(term: string, releaseName: string): boolean {
  const re = compileTerm(term);
  if (re === null) return false;
  return re.test(releaseName) || re.test(foldReleaseName(releaseName));
}

// ---------------------------------------------------------------------------
// Deriving a record's term (D-11 / D-12)
// ---------------------------------------------------------------------------

export type TermConfidence = 'verified' | 'low_confidence';

export interface TermDerivationInput {
  kind: 'movie' | 'show';
  /** The *arr's title (the fallback title tokens). */
  arrTitle: string;
  /** The *arr's year and (Radarr) secondary year. */
  arrYears: ReadonlyArray<number | null | undefined>;
  /** Real release names, most preferred first (grab sourceTitle, sceneName, originalFilePath's last segment, the
   *  ledger's sourceTitle, a legacy SAB name). The first one is the record's release name. */
  releaseNames: readonly string[];
  /** Radarr's / Sonarr's renamed file name — used only when no real release name is known (low confidence). */
  renamedFileName: string | null;
  releaseGroup: string | null;
  resolution: TermResolution | null;
  remux: boolean;
  /** Shows: the season this record blocks. */
  season?: number | null;
}

export interface DerivedTerm {
  term: string;
  shape: 'group' | 'exact';
  confidence: TermConfidence;
  years: number[];
}

/**
 * D-12 — the term for one record, or null when none can block its release (the item is then kept,
 * `release_unrecorded`). Group form when the group and resolution are known; it must match every real release name of
 * the record (self-check), else it falls back to the exact form of the first name. A record whose only name is the
 * *arr's renamed file cannot validate its term against a real release: its term is `low_confidence` and its year
 * window is widened by one on each side.
 */
export function deriveTerm(input: TermDerivationInput): DerivedTerm | null {
  const names = input.releaseNames.filter((n) => n.trim().length > 0);
  const renamedOnly = names.length === 0;
  if (renamedOnly && (input.renamedFileName === null || input.renamedFileName.trim().length === 0))
    return null;

  const arrYears = input.arrYears.filter(
    (y): y is number => typeof y === 'number' && y >= 1900 && y <= 2099,
  );
  const parsed = names.map((n) => parseReleaseName(n, arrYears));
  const years = new Set<number>(arrYears);
  for (const p of parsed) if (p.year !== null) years.add(p.year);
  if (renamedOnly) {
    for (const y of arrYears) {
      years.add(y - 1);
      years.add(y + 1);
    }
  }
  const yearList = [...years].sort((a, b) => a - b);

  const primary = parsed[0];
  const renamed = renamedOnly ? parseReleaseName(input.renamedFileName as string, arrYears) : null;
  const titleTokens =
    primary && primary.titleTokens.length > 0
      ? primary.titleTokens
      : renamed && renamed.titleTokens.length > 0
        ? renamed.titleTokens
        : releaseTokens(input.arrTitle);
  const groupSource = input.releaseGroup ?? primary?.group ?? renamed?.group ?? null;
  const group = groupSource === null ? [] : releaseTokens(groupSource);
  const resolution = input.resolution ?? primary?.resolution ?? renamed?.resolution ?? null;
  const remux = input.remux || primary?.remux === true;
  // A Sonarr relative path carries its season folder (`Season 03/…`): the self-check reads the file's own name.
  const checkNames = renamedOnly ? [releaseBaseName(input.renamedFileName as string)] : names;
  const confidence: TermConfidence = renamedOnly ? 'low_confidence' : 'verified';

  if (group.length > 0 && resolution !== null && titleTokens.length > 0 && yearList.length > 0) {
    let term: string | null = null;
    try {
      if (input.kind === 'movie') {
        term = renderTerm({
          shape: 'movie_group',
          title: titleTokens,
          years: yearList,
          resolution,
          remux,
          group,
        });
      } else {
        const season = input.season ?? primary?.season ?? renamed?.season ?? null;
        if (season !== null && season >= 1) {
          term = renderTerm({
            shape: 'show_group',
            title: titleTokens,
            years: yearList,
            season,
            resolution,
            group,
          });
        }
      }
    } catch {
      term = null;
    }
    if (
      term !== null &&
      isGrammarTerm(term) &&
      checkNames.every((n) => termMatches(term as string, n))
    ) {
      return { term, shape: 'group', confidence, years: yearList };
    }
  }

  // The exact form: only from a real release name (the renamed file is no release anyone posts), and only from one that
  // names a release (a resolution or a group): the exact form of a bare "Title (Year)" would block every release.
  if (renamedOnly || primary === undefined) return null;
  if (!looksLikeRelease(primary)) return null;
  // D-25be — the exact form is a PREFIX match, so it must carry something past the title, the year / season and the
  // resolution: a group, or at least one other token (a source, a codec …). The exact form of "Trap.2024.1080p" would
  // block every 1080p release of the title, as the bare "Title (Year)" of D-25ae would block every release.
  if (primary.group === null && !hasTokenBeyondRelease(primary)) return null;
  const tokens = primary.tokens;
  if (tokens.length === 0) return null;
  let exact: string;
  try {
    exact = renderTerm({ shape: 'exact', tokens });
  } catch {
    return null;
  }
  if (!isGrammarTerm(exact) || !termMatches(exact, names[0] as string)) return null;
  return { term: exact, shape: 'exact', confidence: 'verified', years: yearList };
}
