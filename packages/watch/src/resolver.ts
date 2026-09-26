// Resolving a spoken title (DESIGN-049 D-13): normalize, score every pool title, decide resolved /
// ambiguous / not found. Pure — the TMDB `search/multi` fallback and the pool query live in the caller.

import { groupByKeys } from './group';
import { keysOf, titleKeyRank } from './identity';
import { normalizeTitle, stripTrailingTag, type NormalizedTitle } from './normalize';
import type { ExternalIds, WatchKind } from './types';
import { compareText, kindScopedKeys } from './util';

/** One title the resolver may pick: a Title State, a ledger item or a recommendation signal. */
export interface ResolverCandidate {
  titleKey: string;
  kind: WatchKind;
  title: string;
  year: number | null;
  /** The owner has a Title State for it (+0.05). */
  inHistory: boolean;
  /** Ids the source knows; pool entries sharing any identity key are the same title. */
  ids?: ExternalIds;
}

/**
 * How far the pool's best title settles the query (DESIGN-051 D-15x, D-15y), on `resolved` and `ambiguous`.
 * `exact`: one of its entries matches the query exactly before any bonus (1.0, or 0.95 once one side's trailing tag
 * is dropped), not by a prefix or a fuzzy score. `yearUnmatched`: the query names a year the title does not have
 * (not its year, not one of its own words as in "Blade Runner 2049") while its year is known, so the title meant may
 * not be in the pool at all.
 */
export interface ResolveFit {
  exact: boolean;
  yearUnmatched: boolean;
}

export type ResolveResult =
  | ({
      status: 'resolved';
      /** The best-matching pool entry of the winning title (an in-history entry wins a tie). */
      candidate: ResolverCandidate;
      score: number;
      /** Every pool entry that is the same title (shares an identity key), best first. */
      sameTitle: ResolverCandidate[];
    } & ResolveFit)
  | ({
      status: 'ambiguous';
      /** Up to three distinct titles, best first — one representative entry each. */
      options: ResolverCandidate[];
      best: number;
    } & ResolveFit)
  | { status: 'not_found'; best: number };

/** Resolved needs at least this score… */
export const RESOLVE_MIN_SCORE = 0.9;
/** …and no different title within this margin (a difference of exactly 0.05 still resolves). */
export const RESOLVE_MARGIN = 0.05;
/** Below this the resolver answers not found (and the caller may try TMDB). */
export const AMBIGUOUS_MIN_SCORE = 0.6;
/**
 * A title named exactly (DESIGN-051 D-15y): 1.0, or 0.95 once one side's trailing country or year tag is dropped. A
 * prefix (0.85), a fuzzy score (under 0.9) or the whole-word prefix (0.7) is a near title, not an exact one.
 */
export const EXACT_TITLE_SCORE = 0.95;
const HISTORY_BONUS = 0.05;
const YEAR_BONUS = 0.05;
const MAX_OPTIONS = 3;
const EPSILON = 1e-9;

/** Jaro-Winkler similarity in [0, 1] (prefix scale 0.1 over up to 4 characters, boost above 0.7). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatched = new Array<boolean>(la).fill(false);
  const bMatched = new Array<boolean>(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const hi = Math.min(lb - 1, i + window);
    for (let j = Math.max(0, i - window); j <= hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let halfTranspositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (k < lb && !bMatched[k]) k++;
    if (a[i] !== b[k]) halfTranspositions++;
    k++;
  }
  const t = halfTranspositions / 2;
  const jaro = (matches / la + matches / lb + (matches - t) / matches) / 3;
  if (jaro <= 0.7) return jaro;
  let prefix = 0;
  while (prefix < 4 && prefix < la && prefix < lb && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Q-05 (owner/driver ruling, PLAN-068 S5): a query whose words are the LEADING WHOLE WORDS of a longer
 * title ("dune" → "Dune: Prophecy") scores this. It lists the title among the options of an ambiguous
 * answer but can never resolve alone: even with both bonuses it is 0.8, under RESOLVE_MIN_SCORE (and a
 * single-option ambiguous answer reads "Did you mean …?").
 */
export const WORD_PREFIX_SCORE = 0.7;

/** `query` is the leading whole words of `title` (both normalized): "dune" of "dune prophecy". */
function isWordPrefix(query: string, title: string): boolean {
  return query.length > 0 && title.length > query.length && title.startsWith(`${query} `);
}

/**
 * The query's words for the Q-05 rule: as normalized, and — when it ends in its bare year hint ("dune
 * 2024") — also without that year, which is a hint, not a title word (the D-25 0.95-rule reading).
 */
function wordPrefixQueries(q: NormalizedTitle): string[] {
  const suffix = q.year === null ? null : ` ${q.year}`;
  return suffix !== null && q.norm.endsWith(suffix)
    ? [q.norm, q.norm.slice(0, -suffix.length)]
    : [q.norm];
}

/**
 * The D-13 match score of a query against one title, before bonuses: 1.0 exact; 0.95 exact once ONE
 * side's trailing country or year tag is dropped ("the office us" vs "The Office"; two different tags
 * never match); 0.85 when one is a prefix of the other and the shorter is at least 60% of the longer;
 * otherwise the better of Jaro-Winkler × 0.9 (when Jaro-Winkler is at least 0.9) and the Q-05
 * whole-word prefix (0.7, the query's words leading the title's); else 0.
 */
export function titleMatchScore(
  query: string | NormalizedTitle,
  title: string | NormalizedTitle,
): number {
  const q = typeof query === 'string' ? normalizeTitle(query) : query;
  const c = typeof title === 'string' ? normalizeTitle(title) : title;
  if (!q.norm || !c.norm) return 0;
  if (q.norm === c.norm) return 1;
  if (stripTrailingTag(q.norm) === c.norm || q.norm === stripTrailingTag(c.norm)) return 0.95;
  const [shorter, longer] = q.norm.length <= c.norm.length ? [q.norm, c.norm] : [c.norm, q.norm];
  if (longer.startsWith(shorter) && shorter.length >= 0.6 * longer.length) return 0.85;
  const jw = jaroWinkler(q.norm, c.norm);
  const fuzzy = jw >= 0.9 ? jw * 0.9 : 0;
  const wordPrefix = wordPrefixQueries(q).some((words) => isWordPrefix(words, c.norm));
  return Math.max(fuzzy, wordPrefix ? WORD_PREFIX_SCORE : 0);
}

/** A title's own year: its `year`, else a year its title carries ("Dune (2021)"); null when neither is known. */
function knownYear(c: Pick<ResolverCandidate, 'title' | 'year'>): number | null {
  return c.year ?? normalizeTitle(c.title).year;
}

/**
 * DESIGN-051 D-15x — `c` has the year `query` names: as its year (or its title's parenthesized year), or as one of
 * its title's own words ("Blade Runner 2049", a 2017 film, has 2049). False when the query names no year.
 */
export function hasNamedYear(
  query: string | NormalizedTitle,
  c: Pick<ResolverCandidate, 'title' | 'year'>,
): boolean {
  const q = typeof query === 'string' ? normalizeTitle(query) : query;
  if (q.year === null) return false;
  const norm = normalizeTitle(c.title);
  return c.year === q.year || norm.year === q.year || norm.norm.split(' ').includes(String(q.year));
}

/** One title's grouping keys, as {@link resolveTitle} groups pool entries (kind-scoped, so a show never merges a movie). */
function groupKeys(c: ResolverCandidate): string[] {
  return kindScopedKeys(
    c.kind,
    keysOf({ ...c.ids, kind: c.kind, title: c.title, year: c.year, titleKey: c.titleKey }),
  );
}

/**
 * DESIGN-051 D-15x — the pool's own title for a TMDB hit: the entries of `kind` that `resolveTitle` would group with
 * an entry carrying `tmdbId`, in-history first. Empty when no entry carries it, or when the group also carries another
 * TMDB id (two titles merged by one name and year), so a hit never takes another title's identity.
 */
export function poolTitleOf<C extends ResolverCandidate>(pool: readonly C[], kind: WatchKind, tmdbId: number): C[] {
  const eligible = pool.filter((c) => c.kind === kind);
  if (!eligible.some((c) => c.ids?.tmdbId === tmdbId)) return [];
  const group = groupByKeys(eligible, groupKeys).find((g) => g.some((c) => c.ids?.tmdbId === tmdbId)) ?? [];
  const other = group.some((c) => {
    const id = c.ids?.tmdbId;
    return id !== null && id !== undefined && id !== tmdbId;
  });
  if (other) return [];
  return [...group].sort(
    (a, b) =>
      Number(b.inHistory) - Number(a.inHistory) ||
      titleKeyRank(a.titleKey) - titleKeyRank(b.titleKey) ||
      compareText(a.titleKey, b.titleKey),
  );
}

interface Scored {
  c: ResolverCandidate;
  base: number;
  match: number;
}

function compareMembers(a: Scored, b: Scored): number {
  return (
    b.match - a.match ||
    Number(b.c.inHistory) - Number(a.c.inHistory) ||
    titleKeyRank(a.c.titleKey) - titleKeyRank(b.c.titleKey) ||
    compareText(a.c.titleKey, b.c.titleKey) ||
    compareText(a.c.title, b.c.title)
  );
}

interface RankedTitle {
  score: number;
  inHistory: boolean;
  members: Scored[];
}

function compareTitles(a: RankedTitle, b: RankedTitle): number {
  const ra = a.members[0]?.c;
  const rb = b.members[0]?.c;
  return (
    b.score - a.score ||
    Number(b.inHistory) - Number(a.inHistory) ||
    (rb?.year ?? 0) - (ra?.year ?? 0) ||
    compareText(ra?.title ?? '', rb?.title ?? '') ||
    compareText(ra?.titleKey ?? '', rb?.titleKey ?? '')
  );
}

/**
 * Resolve a spoken title against the pool (D-13). Pool entries that share an identity key are one
 * title (a Title State, its ledger item and a watchlist row are not "different titles"). A title's
 * score is its best entry's match + 0.05 when the query's year hint equals the entry's year, + 0.05
 * when any of its entries is in the owner's history; bonuses never lift a zero match.
 *
 * A year the query names settles same-name titles (DESIGN-051 D-15x, as D-15v settles TMDB's hits): when one of the
 * titles it names exactly has that year, the exact titles without it drop out ("Shōgun (2024)" is never asked
 * between the 2024 and the 1980 show); near titles stay. Each non-`not_found` result says how far its best title fits
 * the query ({@link ResolveFit}), which the caller weighs before it trusts the pool (DESIGN-051 D-15x, D-15y).
 *
 * Resolved when the best is at least 0.9 and the runner-up title is at least 0.05 below it;
 * ambiguous when the best is at least 0.6 (up to three titles); otherwise not found.
 */
export function resolveTitle(
  query: string,
  pool: readonly ResolverCandidate[],
  opts: { kind?: WatchKind | null } = {},
): ResolveResult {
  const q = normalizeTitle(query);
  if (!q.norm) return { status: 'not_found', best: 0 };
  const eligible = opts.kind ? pool.filter((c) => c.kind === opts.kind) : pool;
  const scored: Scored[] = eligible.map((c) => {
    const norm = normalizeTitle(c.title);
    const base = titleMatchScore(q, norm);
    const year = c.year ?? norm.year;
    const yearBonus = base > 0 && q.year !== null && year === q.year ? YEAR_BONUS : 0;
    return { c, base, match: base + yearBonus };
  });
  let titles: RankedTitle[] = groupByKeys(scored, (s) => groupKeys(s.c))
    .map((group) => {
      const members = [...group].sort(compareMembers);
      const inHistory = group.some((s) => s.c.inHistory);
      const top = members[0];
      const score = top && top.base > 0 ? top.match + (inHistory ? HISTORY_BONUS : 0) : 0;
      return { score, inHistory, members };
    })
    .filter((t) => t.score > 0)
    .sort(compareTitles);

  const isExact = (t: RankedTitle) => t.members.some((m) => m.base >= EXACT_TITLE_SCORE - EPSILON);
  const named = (t: RankedTitle) => t.members.some((m) => hasNamedYear(q, m.c));
  // DESIGN-051 D-15x: the named year settles the titles named exactly; near titles are other titles and stay.
  if (q.year !== null && titles.some((t) => isExact(t) && named(t))) {
    titles = titles.filter((t) => !isExact(t) || named(t));
  }

  const best = titles[0];
  const top = best?.members[0];
  if (!best || !top) return { status: 'not_found', best: 0 };
  const fit: ResolveFit = {
    exact: isExact(best),
    yearUnmatched: q.year !== null && !named(best) && best.members.some((m) => knownYear(m.c) !== null),
  };
  const runnerUp = titles[1];
  const clear = !runnerUp || best.score - runnerUp.score >= RESOLVE_MARGIN - EPSILON;
  if (best.score >= RESOLVE_MIN_SCORE - EPSILON && clear) {
    return {
      status: 'resolved',
      candidate: top.c,
      score: best.score,
      sameTitle: best.members.map((m) => m.c),
      ...fit,
    };
  }
  if (best.score >= AMBIGUOUS_MIN_SCORE - EPSILON) {
    const options = titles
      .slice(0, MAX_OPTIONS)
      .map((t) => t.members[0]?.c)
      .filter((c): c is ResolverCandidate => c !== undefined);
    return { status: 'ambiguous', options, best: best.score, ...fit };
  }
  return { status: 'not_found', best: best.score };
}
