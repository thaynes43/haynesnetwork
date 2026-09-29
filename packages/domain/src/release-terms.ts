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
//   exact release name   /^{name words joined by SEP*}(?:SEP|$)/i
//
// SEP is `[^a-z0-9]`, which matches identically in .NET and JavaScript under `i` (`\W` does not), so the in-app
// self-check tests what the *arr will run. Year and group tokens are `[a-z0-9]+`; R is 2160 / 1080 / 720 / 480; S is
// digits; the only flag is `i`. The sentinel is the one plain (non-regex) term.
//
// A title word (T is its words joined by SEP+; the exact form's words are joined by SEP*) is folded letters and digits,
// written so the term matches the RAW title Radarr and Sonarr test as well as its folded form (DESIGN-052 D-25dd):
//   - an apostrophe a raw name has inside the word is an optional separator or apostrophe entity: `(?:SEP|&(?:#39|apos);)?`
//     in T (`bob(?:[^a-z0-9]|&(?:#39|apos);)?s` matches "Bob's", "Bobs" and "Bob&#39;s"), `(?:SEP|&(?:#39|apos);)*` in
//     the exact form (a word boundary like any other);
//   - an accented letter a raw name has is an alternation of the folded letter and the accented ones, `(?:u|ü)`, each
//     accented letter one character in U+00C0..U+024F or U+1E00..U+1EFF that folds to that letter;
//   - an `and` that is neither the first nor the last word may be absent, `(?:(?:and|amp)SEP+)?`
//     (`(?:(?:and|amp)SEP*)?` in the exact form): the fold reads `&` as `and`, a raw `&` is a separator, and a
//     double-escaped `&amp;` is a separator around `amp` (D-25di).

/** The plain term that keeps the app's profile valid when it holds no live term (an *arr refuses an empty profile). */
export const RELEASE_BLOCK_SENTINEL = 'hnet-release-block-sentinel';
/** The app-owned profile's exact name on Radarr and on Sonarr (D-13). */
export const RELEASE_BLOCK_PROFILE_NAME = 'haynesnetwork: deleted releases (managed, do not edit)';

export const TERM_RESOLUTIONS = [2160, 1080, 720, 480] as const;
export type TermResolution = (typeof TERM_RESOLUTIONS)[number];

const SEP = '[^a-z0-9]';
const REMUX_LOOKAHEAD = '(?=.*(?<![a-z0-9])remux(?![a-z0-9]))';
const resolutionLookahead = (r: TermResolution) => `(?=.*(?<![a-z0-9])${r}p(?![a-z0-9]))`;
/** D-25dd / D-25di — an `and` word that may be absent, or be the `amp` of a double-escaped `&amp;`, in the title
 *  (words joined by SEP+) and in the exact form (SEP*). */
const OPTIONAL_AND_TITLE = `(?:(?:and|amp)${SEP}+)?`;
const OPTIONAL_AND_EXACT = `(?:(?:and|amp)${SEP}*)?`;
/** D-25dd / D-25di — where a raw name has an apostrophe inside a word: a separator or an apostrophe entity, at most
 *  one in the title, any number in the exact form (where it is a word boundary like any other). */
const APOS_ENTITY = '&(?:#39|apos);';
const JOIN_TITLE = `(?:${SEP}|${APOS_ENTITY})?`;
const JOIN_EXACT = `(?:${SEP}|${APOS_ENTITY})*`;
/** D-25dd — the accented letters a term may carry: Latin-1 Supplement and Latin Extended-A / B / Additional letters. */
const ACCENT_RANGES = '\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u024f\\u1e00-\\u1eff';
const ACCENT_LETTER = new RegExp(`^[${ACCENT_RANGES}]$`);

/**
 * D-25dd — one word of a term's title or exact form: its folded text, where a raw name had an apostrophe inside it, and
 * which accented letters a raw name had at each position. A plain string is a word with neither.
 */
export interface TermWord {
  /** The folded word, `[a-z0-9]+`. */
  text: string;
  /** Offsets inside `text` (1 .. length − 1) where a raw name has an apostrophe. */
  joins?: readonly number[];
  /** Offset → the accented letters (one character each, lower case unless that is two characters, as for `İ`) a raw
   *  name has there; each folds to that letter. */
  accents?: Readonly<Record<number, readonly string[]>>;
}
export type TermToken = string | TermWord;

export type TermParts =
  | {
      shape: 'movie_group';
      title: TermToken[];
      years: number[];
      resolution: TermResolution;
      remux: boolean;
      group: string[];
    }
  | {
      shape: 'show_group';
      title: TermToken[];
      years: number[];
      season: number;
      resolution: TermResolution;
      group: string[];
    }
  | { shape: 'exact'; tokens: TermToken[] };

// ---------------------------------------------------------------------------
// Tokens (D-12): NFKD, combining marks removed, apostrophes removed, `&` read as `and`, lower case, split on
// [^a-z0-9]+. The tokens decide what a name's title, year and season are; the term writes each title word back with
// the raw name's apostrophes and accented letters (`termWords`, D-25dd).
// ---------------------------------------------------------------------------

const APOSTROPHE_CHARS = "'‘’ʼ`´";
const APOSTROPHES = new RegExp(`[${APOSTROPHE_CHARS}]`, 'g');
const APOSTROPHE = new RegExp(`^[${APOSTROPHE_CHARS}]$`);
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * D-25di — the HTML entities an indexer's double-escaped title carries, read as their character in one pass:
 * `&amp;` as `&`, `&#39;` and `&apos;` as an apostrophe. The term writes each of them back (`OPTIONAL_AND_*`,
 * `JOIN_*`), so a term built from either spelling matches both. Any other entity stays as it is written.
 */
const ENTITIES = /&(amp|#39|apos);/gi;
const decodeEntities = (value: string) =>
  value.replace(ENTITIES, (_, e: string) => (e.toLowerCase() === 'amp' ? '&' : "'"));

/**
 * Fold a name the way the tokens are built: entities decoded, accents and apostrophes removed, `&` read as `and`,
 * lower case. Apostrophes are removed before NFKD as well as after it: NFKD turns `´` into a space and an accent, so
 * removed only after it the fold would read "d´Amélie" as two words where `termWords` reads one (D-25di); after it, a
 * letter whose decomposition carries one (`ŉ`, a fullwidth apostrophe) loses it too. `termWords` folds each character
 * with this same function, so the two readings agree.
 */
export function foldReleaseName(value: string): string {
  return decodeEntities(value)
    .normalize('NFC')
    .replace(APOSTROPHES, '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(APOSTROPHES, '')
    .replace(/&/g, ' and ')
    .toLowerCase();
}

export function releaseTokens(value: string): string[] {
  return foldReleaseName(value)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** What one character folds to: exactly what `foldReleaseName` makes of it. */
const foldChar = (ch: string) => foldReleaseName(ch);

interface MutableWord {
  text: string;
  joins: number[];
  accents: Record<number, string[]>;
}

const toTermWord = (w: MutableWord): TermWord => ({
  text: w.text,
  ...(w.joins.length > 0 ? { joins: [...w.joins].sort((a, b) => a - b) } : {}),
  ...(Object.keys(w.accents).length > 0 ? { accents: w.accents } : {}),
});

/**
 * D-25dd — a name's words as its RAW characters show them: `releaseTokens(value)` word for word, each with the
 * apostrophes the name has inside it and the accented letters it has. Each character is folded by `foldReleaseName`
 * itself, so the words are the tokens; should a word still differ from its token, that word alone is the plain token
 * (D-25di: a disagreement never drops the other words' apostrophes and accents), and when the counts differ the plain
 * tokens are returned, so a term is never built from words the fold did not give.
 */
export function termWords(value: string): TermWord[] {
  const words: MutableWord[] = [];
  let current: MutableWord | null = null;
  let apostrophe = false;
  const end = () => {
    if (current !== null) words.push(current);
    current = null;
    apostrophe = false;
  };
  for (const ch of decodeEntities(value).normalize('NFC')) {
    const folded = foldChar(ch);
    if (folded === '' && (APOSTROPHE.test(ch) || APOSTROPHE.test(ch.normalize('NFKD')))) {
      // Inside a word it may join two parts ("Bob's"); after a separator it is nothing ("Rock 'n' Roll").
      apostrophe = current !== null;
      continue;
    }
    for (const c of folded) {
      if (!/[a-z0-9]/.test(c)) {
        end();
        continue;
      }
      const word: MutableWord = current ?? { text: '', joins: [], accents: {} };
      if (current !== null && apostrophe) word.joins.push(word.text.length);
      apostrophe = false;
      // The accented letter in lower case; `İ` stays itself (its lower case is two characters, `i` and a dot).
      const lower = ch.toLowerCase();
      const letter = lower.length === 1 ? lower : ch;
      if (folded.length === 1 && letter !== c && ACCENT_LETTER.test(letter))
        word.accents[word.text.length] = [letter];
      word.text += c;
      current = word;
    }
  }
  end();
  const plain = releaseTokens(value);
  if (words.length !== plain.length) return plain.map((text) => ({ text }));
  return words.map((w, i) => (w.text === plain[i] ? toTermWord(w) : { text: plain[i] as string }));
}

/**
 * D-25dd — `into` with the apostrophes and accented letters of `from` added, when `from` starts with the same words
 * (another release name of the record, the renamed file, the *arr's title): the term then matches each of their raw
 * forms. `into` is returned unchanged when `from` names other words.
 */
export function mergeTermWords(into: readonly TermWord[], from: readonly TermWord[]): TermWord[] {
  if (from.length < into.length || into.some((w, i) => w.text !== from[i]?.text)) return [...into];
  return into.map((w, i) => {
    const other = from[i] as TermWord;
    const joins = [...new Set([...(w.joins ?? []), ...(other.joins ?? [])])];
    const accents: Record<number, string[]> = {};
    for (const source of [w.accents ?? {}, other.accents ?? {}]) {
      for (const [k, letters] of Object.entries(source)) {
        const at = Number(k);
        accents[at] = [...new Set([...(accents[at] ?? []), ...letters])].sort();
      }
    }
    return toTermWord({ text: w.text, joins, accents });
  });
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

const asWord = (t: TermToken): TermWord => (typeof t === 'string' ? { text: t } : t);

/** A word inside the grammar: `[a-z0-9]+`, joins strictly inside it, accented letters that fold to their letter. */
function okWord(t: TermToken): boolean {
  const w = asWord(t);
  if (!/^[a-z0-9]+$/.test(w.text)) return false;
  if (!(w.joins ?? []).every((j) => Number.isInteger(j) && j >= 1 && j < w.text.length))
    return false;
  return Object.entries(w.accents ?? {}).every(([k, letters]) => {
    const at = Number(k);
    const base = w.text[at];
    return (
      Number.isInteger(at) &&
      base !== undefined &&
      /[a-z]/.test(base) &&
      letters.length > 0 &&
      letters.every(
        (l) => l.length === 1 && ACCENT_LETTER.test(l) && l !== base && foldChar(l) === base,
      )
    );
  });
}

/** One word: its letters (an accented position as `(?:u|ü)`), its apostrophe offsets joined by `join`. */
function renderWord(t: TermToken, join: string): string {
  const w = asWord(t);
  const joins = new Set(w.joins ?? []);
  let out = '';
  for (let i = 0; i < w.text.length; i += 1) {
    if (joins.has(i)) out += join;
    const base = w.text[i] as string;
    const letters = [...new Set(w.accents?.[i] ?? [])].filter((l) => l !== base).sort();
    out += letters.length > 0 ? `(?:${[base, ...letters].join('|')})` : base;
  }
  return out;
}

/** Words joined by `sep`; an `and` that is neither the first nor the last word may be absent (`optionalAnd`). */
function renderWords(
  words: readonly TermToken[],
  sep: string,
  join: string,
  optionalAnd: string,
): string {
  let out = renderWord(words[0] as TermToken, join);
  let i = 1;
  while (i < words.length) {
    const w = asWord(words[i] as TermToken);
    const plainAnd =
      w.text === 'and' && (w.joins ?? []).length === 0 && Object.keys(w.accents ?? {}).length === 0;
    out += sep;
    if (plainAnd && i < words.length - 1) {
      // `x(?:and SEP)?y` after the separator: "x and y", "x & y" and "x y" all match.
      out += optionalAnd + renderWord(words[i + 1] as TermToken, join);
      i += 2;
      continue;
    }
    out += renderWord(w, join);
    i += 1;
  }
  return out;
}

/** Build a term from its parts. Throws on parts outside the grammar (a token that is not `[a-z0-9]+`, no year …). */
export function renderTerm(parts: TermParts): string {
  const okWords = (words: readonly TermToken[]) => words.length > 0 && words.every(okWord);
  const okGroup = (tokens: readonly string[]) =>
    tokens.length > 0 && tokens.every((t) => /^[a-z0-9]+$/.test(t));
  const title = (words: readonly TermToken[]) =>
    renderWords(words, `${SEP}+`, JOIN_TITLE, OPTIONAL_AND_TITLE);
  switch (parts.shape) {
    case 'movie_group': {
      if (!okWords(parts.title) || !okGroup(parts.group)) throw new Error('term: bad tokens');
      if (parts.years.length === 0 || !parts.years.every((y) => /^\d{4}$/.test(String(y)))) {
        throw new Error('term: bad years');
      }
      return (
        `/^${title(parts.title)}${SEP}+${yearsPattern(parts.years)}${SEP}` +
        resolutionLookahead(parts.resolution) +
        (parts.remux ? REMUX_LOOKAHEAD : '') +
        `.*${SEP}${parts.group.join(`${SEP}*`)}(?:${SEP}|$)/i`
      );
    }
    case 'show_group': {
      if (!okWords(parts.title) || !okGroup(parts.group)) throw new Error('term: bad tokens');
      if (parts.years.length === 0 || !parts.years.every((y) => /^\d{4}$/.test(String(y)))) {
        throw new Error('term: bad years');
      }
      if (!Number.isInteger(parts.season) || parts.season < 1) throw new Error('term: bad season');
      return (
        `/^${title(parts.title)}${SEP}+(?:${yearsPattern(parts.years)}${SEP}+)?` +
        `s0*${parts.season}(?:e[0-9]+)*(?![0-9a-z])` +
        resolutionLookahead(parts.resolution) +
        `.*${SEP}${parts.group.join(`${SEP}*`)}(?:${SEP}|$)/i`
      );
    }
    case 'exact': {
      if (!okWords(parts.tokens)) throw new Error('term: bad tokens');
      return `/^${renderWords(parts.tokens, `${SEP}*`, JOIN_EXACT, OPTIONAL_AND_EXACT)}(?:${SEP}|$)/i`;
    }
  }
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const TOK = '[a-z0-9]+';
const YEAR = '\\d{4}';
const Y_META = `(?:${YEAR}|${esc('(?:')}${YEAR}(?:${esc('|')}${YEAR})+${esc(')')})`;
const RES_META = `${esc('(?=.*(?<![a-z0-9])')}(?:2160|1080|720|480)${esc('p(?![a-z0-9]))')}`;
// D-25dd — a letter or digit, or an accented alternation `(?:u|ü)`; a word's parts joined by `JOIN_TITLE` (an
// apostrophe); title words joined by `SEP+`, each after the first possibly behind an optional `and`.
const UNIT_META = `(?:[a-z0-9]|${esc('(?:')}[a-z](?:${esc('|')}[${ACCENT_RANGES}])+${esc(')')})`;
const PART_META = `${UNIT_META}+`;
const WORD_META = `${PART_META}(?:${esc(JOIN_TITLE)}${PART_META})*`;
const TITLE_META = `${WORD_META}(?:${esc(`${SEP}+`)}(?:${esc(OPTIONAL_AND_TITLE)})?${WORD_META})*`;
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
  `^${esc('/^')}${PART_META}(?:(?:${esc(`${SEP}*`)}(?:${esc(OPTIONAL_AND_EXACT)})?|${esc(JOIN_EXACT)})${PART_META})*` +
    `${esc(`(?:${SEP}|$)/i`)}$`,
);

/**
 * ADR-094 / DESIGN-046 D-14 — the janitor's WHOLE-NAME term: `/^SEP*{words joined by SEP*}SEP*$/i`. The exact form
 * above is a prefix match (it blocks every longer title that starts with the name); this one is anchored at both ends,
 * so it matches the release title as posted again (any separators, its raw apostrophes, accented letters and `&`, the
 * way `termWords` writes them) and no title with a word more or a word less. A separate grammar from the Release
 * Block's: `isGrammarTerm` never accepts it, and `isWholeNameTerm` accepts nothing else.
 */
export function renderWholeNameTerm(words: readonly TermToken[]): string {
  if (words.length === 0 || !words.every(okWord)) throw new Error('term: bad tokens');
  return `/^${SEP}*${renderWords(words, `${SEP}*`, JOIN_EXACT, OPTIONAL_AND_EXACT)}${SEP}*$/i`;
}

const WHOLE_META = new RegExp(
  `^${esc('/^')}${esc(`${SEP}*`)}${PART_META}(?:(?:${esc(`${SEP}*`)}(?:${esc(OPTIONAL_AND_EXACT)})?|${esc(JOIN_EXACT)})${PART_META})*` +
    `${esc(`${SEP}*$/i`)}$`,
);

/** ADR-094 / DESIGN-046 D-14 — is this exactly the whole-name template, and does it compile? The janitor's writer
 *  refuses to POST / PUT a profile holding any other term (its sentinel aside). */
export function isWholeNameTerm(term: string): boolean {
  if (term.length > 1_000) return false;
  if (!WHOLE_META.test(term)) return false;
  return compileTerm(term) !== null;
}

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

/**
 * Does the term match this release name AS IT IS — what Radarr and Sonarr test (`ReleaseRestrictionsSpecification`
 * runs the term against the raw release title; nothing folds accents, apostrophes or `&`)? D-25bq.
 */
export function termMatchesRaw(term: string, releaseName: string): boolean {
  const re = compileTerm(term);
  return re !== null && re.test(releaseName);
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
  /** D-25cr — the ledger's OTHER titles of the same *arr (title and year). A renamed-only record's widened year (y ± 1,
   *  never one of the *arr's own years) at which one of them has the term's title tokens is dropped: that window would
   *  block a different film or series of the same name (The Killer 2024 would block The Killer 2023). */
  namesakes?: ReadonlyArray<{ title: string; year: number | null }>;
}

export interface DerivedTerm {
  term: string;
  shape: 'group' | 'exact';
  confidence: TermConfidence;
  years: number[];
  /** D-25bq — a REAL release name of the record matched the term only in its folded form (since D-25dd, a character
   *  the grammar cannot write: a decomposed accent inside a word, a doubled apostrophe): the *arr, which tests the raw
   *  title, will not match that name. The term is `low_confidence`. */
  foldOnly: boolean;
  /** D-25cr — the widened years left out because a namesake holds them (empty when none was); counted by S6(e). */
  namesakeYears: number[];
}

/**
 * D-12 — the term for one record, or null when none can block its release (the item is then kept,
 * `release_unrecorded`). Group form when the group and resolution are known; it must match every real release name of
 * the record (self-check), else it falls back to the exact form of the FIRST name, which is checked against that name
 * only: a record with several real names whose term comes back `exact` needs `deriveTermsPerName` (D-25bp). A record
 * whose only name is the *arr's renamed file cannot validate its term against a real release: its term is
 * `low_confidence` and its year window is widened by one on each side, except at a year where a namesake (another title
 * of the *arr with the same title tokens, `namesakes`) sits (D-25cr). A real name the term matches only when folded
 * makes the term `low_confidence` too (D-25bq): the *arr tests the raw name. The title's words are written from the raw
 * names (their apostrophes, accented letters and `&`, D-25dd), so that happens only where the grammar cannot write one.
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
  const primary = parsed[0];
  const renamed = renamedOnly ? parseReleaseName(input.renamedFileName as string, arrYears) : null;
  const titleTokens =
    primary && primary.titleTokens.length > 0
      ? primary.titleTokens
      : renamed && renamed.titleTokens.length > 0
        ? renamed.titleTokens
        : releaseTokens(input.arrTitle);
  // D-25dd — the title's words as the raw names write them, so the term matches each raw name as Radarr and Sonarr test
  // it: the words of the name the title tokens came from, with the apostrophes and accented letters of every other raw
  // form that starts with the same words (the record's other release names, its renamed file, the *arr's title).
  const titleSource =
    primary && primary.titleTokens.length > 0
      ? releaseBaseName(names[0] as string)
      : renamed && renamed.titleTokens.length > 0
        ? releaseBaseName(input.renamedFileName as string)
        : input.arrTitle;
  let titleWords: TermWord[] = termWords(titleSource).slice(0, titleTokens.length);
  if (
    titleWords.length !== titleTokens.length ||
    titleWords.some((w, i) => w.text !== titleTokens[i])
  ) {
    titleWords = titleTokens.map((text) => ({ text }));
  }
  const rawForms = [
    ...names.map(releaseBaseName),
    ...(input.renamedFileName ? [releaseBaseName(input.renamedFileName)] : []),
    input.arrTitle,
  ];
  for (const raw of rawForms) titleWords = mergeTermWords(titleWords, termWords(raw));

  const years = new Set<number>(arrYears);
  for (const p of parsed) if (p.year !== null) years.add(p.year);
  const namesakeYears: number[] = [];
  if (renamedOnly) {
    // D-25cr — a widened year that a namesake holds would block that other title's releases: leave it out.
    const title = titleTokens.join(' ');
    const held = new Set(
      (input.namesakes ?? [])
        .filter((n) => typeof n.year === 'number' && releaseTokens(n.title).join(' ') === title)
        .map((n) => n.year as number),
    );
    for (const y of arrYears) {
      for (const w of [y - 1, y + 1]) {
        if (years.has(w) || arrYears.includes(w)) continue;
        if (held.has(w)) {
          if (!namesakeYears.includes(w)) namesakeYears.push(w);
          continue;
        }
        years.add(w);
      }
    }
    namesakeYears.sort((a, b) => a - b);
  }
  const yearList = [...years].sort((a, b) => a - b);
  const groupSource = input.releaseGroup ?? primary?.group ?? renamed?.group ?? null;
  const group = groupSource === null ? [] : releaseTokens(groupSource);
  const resolution = input.resolution ?? primary?.resolution ?? renamed?.resolution ?? null;
  const remux = input.remux || primary?.remux === true;
  // A Sonarr relative path carries its season folder (`Season 03/…`): the self-check reads the file's own name.
  const checkNames = renamedOnly ? [releaseBaseName(input.renamedFileName as string)] : names;
  // D-25bq — the fold exists for the renamed file (Radarr keeps "Don't" in it); a REAL name matched only when folded is
  // a release the *arr will not block, so the term is not verified. Since D-25dd the words carry the raw apostrophes,
  // accents and `&`, so this is left for what the grammar cannot write (a decomposed accent inside a word, a doubled
  // apostrophe, a character outside the accent ranges).
  const judge = (term: string, real: readonly string[]) => {
    const foldOnly = real.some((n) => !termMatchesRaw(term, n));
    const confidence: TermConfidence = renamedOnly || foldOnly ? 'low_confidence' : 'verified';
    return { foldOnly, confidence };
  };

  if (group.length > 0 && resolution !== null && titleTokens.length > 0 && yearList.length > 0) {
    let term: string | null = null;
    try {
      if (input.kind === 'movie') {
        term = renderTerm({
          shape: 'movie_group',
          title: titleWords,
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
            title: titleWords,
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
      return { term, shape: 'group', ...judge(term, names), years: yearList, namesakeYears };
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
  // D-25dd — the name's own words (its apostrophes and accented letters), the title's merged as above.
  const tokens = [
    ...titleWords,
    ...termWords(releaseBaseName(names[0] as string)).slice(titleWords.length),
  ];
  if (tokens.length === 0 || tokens.length !== primary.tokens.length) return null;
  let exact: string;
  try {
    exact = renderTerm({ shape: 'exact', tokens });
  } catch {
    return null;
  }
  if (!isGrammarTerm(exact) || !termMatches(exact, names[0] as string)) return null;
  return {
    term: exact,
    shape: 'exact',
    ...judge(exact, [names[0] as string]),
    years: yearList,
    namesakeYears,
  };
}

/**
 * D-25bp — every term a record with several real release names needs. `deriveTerm`'s exact fallback is the FIRST
 * name's exact form and blocks only that name, so when the combined derivation comes back `exact` and the record has
 * more than one distinct real name, each name gets its own derivation (its own group term when that name carries a
 * group and passes the self-check, else its own exact form). Null when any name yields no term: the item is then kept
 * `release_unrecorded` rather than deleted with one of its names unblocked. One entry (the combined term) otherwise.
 * The series path does the same per (season, group, resolution) key with its nameless-file rule (D-25bb).
 */
export function deriveTermsPerName(
  input: TermDerivationInput,
): Array<{ name: string | null; derived: DerivedTerm }> | null {
  const combined = deriveTerm(input);
  if (combined === null) return null;
  const names = [...new Set(input.releaseNames.map((n) => n.trim()).filter((n) => n.length > 0))];
  if (combined.shape === 'group' || names.length <= 1)
    return [{ name: names[0] ?? null, derived: combined }];
  const out: Array<{ name: string | null; derived: DerivedTerm }> = [];
  for (const name of names) {
    const derived = deriveTerm({
      ...input,
      releaseNames: [name],
      releaseGroup: null,
      renamedFileName: null,
    });
    if (derived === null) return null;
    out.push({ name, derived });
  }
  return out;
}
