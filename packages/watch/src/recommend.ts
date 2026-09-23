// Recommendations (ADR-089, DESIGN-049 D-16..D-19): the Taste Profile, the exclusion sets, the hard
// exclusions, candidate merging, the score and the one-line reason. Deterministic: the same inputs in
// any order give the same picks in the same order.

import { canonicalGenre, canonicalGenres } from './genres';
import { groupByKeys } from './group';
import { keysOf, titleKeyRank } from './identity';
import { isKidsTitle } from './progress';
import { spokenTitle } from './spoken';
import { DAY_SECONDS, YEAR_SECONDS, type TitleIds, type WatchKind } from './types';
import { compareText, kindScopedKeys, validTime } from './util';

// ---------------------------------------------------------------------------------------------------
// Taste Profile (D-16)

export type Dismissal = 'not_interested' | 'not_mine';

/** One of the owner's titles as the Taste Profile sees it. */
export interface ProfileTitle {
  kind: WatchKind;
  title: string;
  /** Ledger genres first, else Plex (any spelling; canonicalized here). */
  genres: readonly string[];
  isKids: boolean;
  /** Ever Watched (T-247) — see {@link isEverWatched}. */
  everWatched: boolean;
  /** A live dismissal mark on the title. */
  dismissed?: Dismissal | null;
  episodesWatched?: number | null;
  episodesTotal?: number | null;
  eventWatchedEpisodes?: number | null;
  lastWatchedAt: number | null;
}

export type GenreWeights = Record<string, number>;

/** Two genre-weight vectors, each summing to 1 (or empty): grown-up titles and children's titles. */
export interface TasteProfile {
  adult: GenreWeights;
  kids: GenreWeights;
}

function completion(t: ProfileTitle): number {
  if (t.kind === 'movie') return 1;
  const watched = Math.max(0, t.episodesWatched ?? 0);
  const total = Math.max(0, t.episodesTotal ?? 0);
  const everEpisodes = Math.max(watched, t.eventWatchedEpisodes ?? 0);
  const ratio = total > 0 ? Math.min(1, watched / total) : 0;
  return Math.max(ratio, everEpisodes >= 3 ? 0.25 : 0);
}

/**
 * A title's D-16 weight: `0.5 ^ (years since last watched)` (a 12-month half-life) × completion
 * (movies 1; shows watched/total, at least 0.25 once three episodes are watched — Plex or events).
 * A title with no last-watched time weighs 0.
 */
export function titleWeight(t: ProfileTitle, now: number): number {
  const last = validTime(t.lastWatchedAt);
  if (last === null) return 0;
  const decay = 0.5 ** (Math.max(0, now - last) / YEAR_SECONDS);
  return decay * completion(t);
}

function normalizeWeights(plus: Map<string, number>, minus: Map<string, number>): GenreWeights {
  const kept = [...plus.entries()]
    .map(([genre, w]) => [genre, Math.max(0, w - (minus.get(genre) ?? 0))] as const)
    .filter(([, w]) => w > 0)
    .sort((a, b) => compareText(a[0], b[0]));
  const sum = kept.reduce((s, [, w]) => s + w, 0);
  return Object.fromEntries(kept.map(([genre, w]) => [genre, w / sum]));
}

/**
 * The Taste Profile (D-16). Each Ever Watched title with genres adds its weight split evenly over its
 * canonical genres; a `not_mine` title is left out; a `not_interested` title subtracts half its
 * weight from its genres (floored at 0). Children's titles build the separate `kids` profile. Each
 * vector is normalized to sum 1.
 */
export function buildTasteProfile(titles: readonly ProfileTitle[], now: number): TasteProfile {
  const acc = {
    adult: { plus: new Map<string, number>(), minus: new Map<string, number>() },
    kids: { plus: new Map<string, number>(), minus: new Map<string, number>() },
  };
  for (const t of titles) {
    if (!t.everWatched || t.dismissed === 'not_mine') continue;
    const genres = canonicalGenres(t.genres);
    const weight = titleWeight(t, now);
    if (genres.length === 0 || !(weight > 0)) continue;
    const bucket = t.isKids ? acc.kids : acc.adult;
    const negative = t.dismissed === 'not_interested';
    const into = negative ? bucket.minus : bucket.plus;
    const share = (negative ? weight / 2 : weight) / genres.length;
    for (const g of genres) into.set(g, (into.get(g) ?? 0) + share);
  }
  return {
    adult: normalizeWeights(acc.adult.plus, acc.adult.minus),
    kids: normalizeWeights(acc.kids.plus, acc.kids.minus),
  };
}

/**
 * For each canonical genre, the owner's most-watched title sharing it — the "<genre> like <title>"
 * reason (D-19). Most-watched = most episodes (Plex or events; a movie counts 1), then the most
 * recently watched, then title. Only Ever Watched, undismissed titles; split like the profile.
 */
export function genreExemplars(titles: readonly ProfileTitle[]): {
  adult: Record<string, string>;
  kids: Record<string, string>;
} {
  const best = { adult: new Map<string, ProfileTitle>(), kids: new Map<string, ProfileTitle>() };
  const amount = (t: ProfileTitle) =>
    t.kind === 'movie' ? 1 : Math.max(t.episodesWatched ?? 0, t.eventWatchedEpisodes ?? 0);
  const better = (a: ProfileTitle, b: ProfileTitle) =>
    amount(a) - amount(b) ||
    (validTime(a.lastWatchedAt) ?? 0) - (validTime(b.lastWatchedAt) ?? 0) ||
    compareText(b.title, a.title);
  for (const t of titles) {
    if (!t.everWatched || t.dismissed) continue;
    const bucket = t.isKids ? best.kids : best.adult;
    for (const g of canonicalGenres(t.genres)) {
      const current = bucket.get(g);
      if (!current || better(t, current) > 0) bucket.set(g, t);
    }
  }
  const out = (m: Map<string, ProfileTitle>) =>
    Object.fromEntries(
      [...m.entries()].sort((a, b) => compareText(a[0], b[0])).map(([g, t]) => [g, t.title]),
    );
  return { adult: out(best.adult), kids: out(best.kids) };
}

// ---------------------------------------------------------------------------------------------------
// Exclusion sets (D-10 Ever Watched, D-18 started / dismissed)

/** Identity-key sets (see `identityKeys`); a candidate sharing ANY key with any set is excluded. */
export interface Exclusions {
  everWatched: ReadonlySet<string>;
  started: ReadonlySet<string>;
  notInterested: ReadonlySet<string>;
  notMine: ReadonlySet<string>;
}

/** What the exclusions need from one of the owner's Title States. */
export interface HistoryFacts extends TitleIds {
  titleKey: string;
  /** Plex episodes watched (shows). */
  episodesWatched?: number | null;
  /** Watched in Plex now (movie watched / show fully watched). */
  plexWatched?: boolean | null;
  /** Any watched Watch Event (shows: `eventWatchedEpisodes > 0`). */
  eventWatched?: boolean | null;
  /** Movies: resume percent. */
  resumePercent?: number | null;
  /** Shows: the next episode has a resume point (D-07 `next_resume`). */
  nextResume?: boolean | null;
}

export type MarkAction = 'watched' | Dismissal;

/** A live (unreverted) Watch Mark with the identity it resolved to. */
export interface LiveMark extends TitleIds {
  titleKey: string;
  action: MarkAction;
}

/**
 * Ever Watched (T-247, D-10): Plex episodes watched, watched in Plex, a watched event, or a live
 * `watched` mark — unless a live `not_mine` mark says it was someone else.
 */
export function isEverWatched(
  t: Pick<HistoryFacts, 'episodesWatched' | 'plexWatched' | 'eventWatched'>,
  marks: { watched?: boolean; notMine?: boolean } = {},
): boolean {
  if (marks.notMine) return false;
  return (
    (t.episodesWatched ?? 0) > 0 ||
    t.plexWatched === true ||
    t.eventWatched === true ||
    marks.watched === true
  );
}

/**
 * Currently started (D-18): a show with a watched episode or a started next episode (a resume-only
 * start is Unfinished too), a movie with a resume point. Those belong to Unfinished, not picks.
 */
export function isStarted(
  t: Pick<HistoryFacts, 'kind' | 'episodesWatched' | 'nextResume' | 'resumePercent'>,
): boolean {
  if (t.kind === 'show') return (t.episodesWatched ?? 0) > 0 || t.nextResume === true;
  return (t.resumePercent ?? 0) > 0;
}

type HistoryNode = { keys: string[]; kind: WatchKind } & (
  { title: HistoryFacts; mark?: undefined } | { mark: LiveMark; title?: undefined }
);

/**
 * Build the four exclusion sets from the owner's Title States and live marks. Records that share an
 * identity key (same kind, transitively) are one title, and the title's EVERY key joins the set its
 * facts call for: a mark that knew only the TMDB id still excludes the ledger copy that knows only the
 * TVDB id, and two Title State rows of one show agree. Ever Watched (T-247) holds unless a `not_mine`
 * mark covers the title; `not_mine` and `not_interested` titles land in their own sets either way.
 */
export function buildExclusions(
  titles: readonly HistoryFacts[],
  marks: readonly LiveMark[],
): Exclusions {
  const everWatched = new Set<string>();
  const started = new Set<string>();
  const notInterested = new Set<string>();
  const notMine = new Set<string>();
  const nodes: HistoryNode[] = [
    ...titles.map((t) => ({ keys: keysOf(t), kind: t.kind, title: t })),
    ...marks.map((m) => ({ keys: keysOf(m), kind: m.kind, mark: m })),
  ];
  for (const group of groupByKeys(nodes, (n) => kindScopedKeys(n.kind, n.keys))) {
    const actions = new Set(group.flatMap((n) => (n.mark ? [n.mark.action] : [])));
    const facts = group.flatMap((n) => (n.title ? [n.title] : []));
    const mine = !actions.has('not_mine');
    const ever = mine && (actions.has('watched') || facts.some((t) => isEverWatched(t)));
    const add = (set: Set<string>) => group.forEach((n) => n.keys.forEach((k) => set.add(k)));
    if (ever) add(everWatched);
    if (facts.some(isStarted)) add(started);
    if (actions.has('not_interested')) add(notInterested);
    if (!mine) add(notMine);
  }
  return { everWatched, started, notInterested, notMine };
}

// ---------------------------------------------------------------------------------------------------
// Candidates (D-17), exclusions (D-18), merging

export interface RecoSeed {
  /** The owner's title whose TMDB recommendations listed the candidate. */
  titleKey: string;
  title: string;
  lastWatchedAt: number | null;
}

export interface CandidateRatings {
  /** IMDb, 0–10. */
  imdb?: number | null;
  /** TMDB, 0–10. */
  tmdb?: number | null;
  /** Rotten Tomatoes, 0–100. */
  rottenTomatoes?: number | null;
}

/** A recommendation candidate from the library, the watchlist or a TMDB seed (or all three). */
export interface RecoCandidate extends TitleIds {
  titleKey: string;
  year: number | null;
  genres: readonly string[];
  contentRating?: string | null;
  /** Children's title per the source; ORed with {@link isKidsTitle}. */
  isKids?: boolean | null;
  onPlex: boolean;
  /** When it was added to Plex (unix seconds). */
  addedAt?: number | null;
  ratings?: CandidateRatings | null;
  /** On the owner's plex.tv watchlist. */
  watchlist?: boolean | null;
  /** The owner's titles whose TMDB recommendations include it. */
  seeds?: readonly RecoSeed[] | null;
}

function isKidsCandidate(c: RecoCandidate): boolean {
  return c.isKids === true || isKidsTitle(c);
}

/** A title is children's when any of its sources says so, or when their genres together do. */
function isKidsGroup(group: readonly RecoCandidate[]): boolean {
  const first = group[0];
  if (!first) return false;
  return (
    group.some(isKidsCandidate) ||
    isKidsTitle({ kind: first.kind, genres: group.flatMap((c) => [...c.genres]) })
  );
}

function candidateGroupKeys(c: RecoCandidate): string[] {
  return kindScopedKeys(c.kind, keysOf(c));
}

/**
 * The D-18 hard exclusions, applied last and in code (AC-21). A candidate is dropped when ANY of its
 * identity keys — or of any candidate it shares a key with (the same title from another source) — is
 * Ever Watched, started, `not_interested` or `not_mine`. `kids: false` drops children's titles,
 * `kids: true` keeps only them (a title is children's when any of its sources says so, or their
 * genres together do). Survivors keep their input order.
 */
export function excludeCandidates<T extends RecoCandidate>(
  candidates: readonly T[],
  exclusions: Exclusions,
  opts: { kids: boolean },
): T[] {
  const sets = [
    exclusions.everWatched,
    exclusions.started,
    exclusions.notInterested,
    exclusions.notMine,
  ];
  const keep = new Set<T>();
  for (const group of groupByKeys(candidates, candidateGroupKeys)) {
    const hit = group.some((c) => keysOf(c).some((k) => sets.some((s) => s.has(k))));
    if (hit) continue;
    if (isKidsGroup(group) !== opts.kids) continue;
    for (const c of group) keep.add(c);
  }
  return candidates.filter((c) => keep.has(c));
}

function validRating(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

function memberJson(c: RecoCandidate): string {
  return JSON.stringify(c);
}

function compareMembers(a: RecoCandidate, b: RecoCandidate): number {
  return (
    Number(b.onPlex) - Number(a.onPlex) ||
    titleKeyRank(a.titleKey) - titleKeyRank(b.titleKey) ||
    compareText(a.titleKey, b.titleKey) ||
    compareText(a.title, b.title) ||
    compareText(memberJson(a), memberJson(b))
  );
}

function mergeGroup(group: readonly RecoCandidate[]): RecoCandidate {
  const ordered = [...group].sort(compareMembers);
  const primary = ordered[0];
  if (!primary) throw new Error('mergeGroup: empty group');
  if (ordered.length === 1) return primary;
  const first = <V>(pick: (c: RecoCandidate) => V | null | undefined): V | null => {
    for (const c of ordered) {
      const v = pick(c);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  };
  const genres: string[] = [];
  for (const c of ordered) {
    for (const g of c.genres) {
      if (!genres.some((x) => x.toLowerCase() === g.toLowerCase())) genres.push(g);
    }
  }
  const seeds = new Map<string, RecoSeed>();
  for (const c of ordered)
    for (const s of c.seeds ?? []) if (!seeds.has(s.titleKey)) seeds.set(s.titleKey, s);
  const addedAt = ordered.reduce<number | null>((max, c) => {
    const t = validTime(c.addedAt);
    return t !== null && (max === null || t > max) ? t : max;
  }, null);
  const titleKey = [...ordered.map((c) => c.titleKey)].sort(
    (a, b) => titleKeyRank(a) - titleKeyRank(b) || compareText(a, b),
  )[0];
  return {
    ...primary,
    titleKey: titleKey ?? primary.titleKey,
    year: first((c) => c.year),
    plexGuid:
      first((c) => (c.plexGuid?.startsWith('plex://') ? c.plexGuid : null)) ??
      first((c) => c.plexGuid),
    tvdbId: first((c) => c.tvdbId),
    tmdbId: first((c) => c.tmdbId),
    imdbId: first((c) => c.imdbId),
    genres,
    contentRating: first((c) => c.contentRating),
    isKids: isKidsGroup(ordered),
    onPlex: ordered.some((c) => c.onPlex),
    addedAt,
    ratings: {
      imdb: first((c) => validRating(c.ratings?.imdb)),
      tmdb: first((c) => validRating(c.ratings?.tmdb)),
      rottenTomatoes: first((c) => validRating(c.ratings?.rottenTomatoes)),
    },
    watchlist: ordered.some((c) => c.watchlist === true),
    seeds: [...seeds.values()].sort((a, b) => compareText(a.titleKey, b.titleKey)),
  };
}

/**
 * Merge candidates that are the same title (they share an identity key, same kind) into one: on Plex
 * if any source is, on the watchlist if any is, the union of genres and seeds, the newest `addedAt`,
 * the strongest `titleKey`, and the first known id, year and rating in a fixed source order (Plex
 * entries first) so the result never depends on input order.
 */
export function mergeCandidates(candidates: readonly RecoCandidate[]): RecoCandidate[] {
  return groupByKeys(candidates, candidateGroupKeys).map(mergeGroup);
}

// ---------------------------------------------------------------------------------------------------
// Score and reason (D-19)

export type PickReasonKind =
  'watchlist' | 'seed' | 'genre' | 'rating' | 'new_on_plex' | 'new_to_you';

export interface ScoredPick {
  candidate: RecoCandidate;
  score: number;
  affinity: number;
  quality: number;
  boost: number;
  /** Spoken, e.g. "because you watched The Expanse". */
  reason: string;
  reasonKind: PickReasonKind;
}

export interface ScoreOptions {
  /** `show` or `movie` keeps only that kind; `any`/absent keeps both. */
  kind?: WatchKind | 'any' | null;
  /** The spoken `genre` parameter; keeps only candidates with that canonical genre. */
  genre?: string | null;
  now: number;
  /** Canonical genre → the owner's most-watched title sharing it ({@link genreExemplars}). */
  genreTitles?: Readonly<Record<string, string>>;
}

export const NEW_ON_PLEX_SECONDS = 21 * DAY_SECONDS;
const NEUTRAL_QUALITY = 0.6;
/** Genres too common to explain a pick; named only when nothing else is shared. */
const GENERIC_GENRES: ReadonlySet<string> = new Set(['drama']);

/** Mean of the available ratings scaled to 0–1 (IMDb and TMDB ÷ 10, Rotten Tomatoes ÷ 100); 0.6 when none. */
export function candidateQuality(ratings: CandidateRatings | null | undefined): number {
  const scaled: number[] = [];
  const add = (value: number | null | undefined, scale: number) => {
    const v = validRating(value);
    if (v !== null) scaled.push(Math.min(1, v / scale));
  };
  add(ratings?.imdb, 10);
  add(ratings?.tmdb, 10);
  add(ratings?.rottenTomatoes, 100);
  return scaled.length === 0 ? NEUTRAL_QUALITY : scaled.reduce((s, v) => s + v, 0) / scaled.length;
}

function isNewOnPlex(c: RecoCandidate, now: number): boolean {
  const added = validTime(c.addedAt);
  return c.onPlex && added !== null && now - added <= NEW_ON_PLEX_SECONDS;
}

function distinctSeeds(c: RecoCandidate): number {
  return new Set((c.seeds ?? []).map((s) => s.titleKey)).size;
}

function formatRating(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function genrePhrase(genre: string, title: string): string {
  return genre === 'kids' ? `for kids, like ${title}` : `${genre} like ${title}`;
}

function reasonFor(
  c: RecoCandidate,
  genres: readonly string[],
  profile: GenreWeights,
  wanted: string | null,
  opts: ScoreOptions,
): { reason: string; reasonKind: PickReasonKind } {
  if (c.watchlist === true) return { reason: 'on your watchlist', reasonKind: 'watchlist' };
  const seed = [...(c.seeds ?? [])].sort(
    (a, b) =>
      (validTime(b.lastWatchedAt) ?? 0) - (validTime(a.lastWatchedAt) ?? 0) ||
      compareText(a.title, b.title),
  )[0];
  if (seed) {
    return { reason: `because you watched ${spokenTitle(seed.title)}`, reasonKind: 'seed' };
  }
  const exemplars = opts.genreTitles ?? {};
  const shared = genres.filter((g) => {
    const t = exemplars[g];
    return t !== undefined && spokenTitle(t).length > 0;
  });
  // The requested genre, else the owner's strongest shared genre — drama last, since nearly every
  // show carries it ("sci-fi like The Expanse" says more than "drama like The Expanse").
  const rank = (g: string) => (GENERIC_GENRES.has(g) ? 1 : 0);
  const genre =
    wanted !== null && shared.includes(wanted)
      ? wanted
      : [...shared].sort(
          (a, b) => rank(a) - rank(b) || (profile[b] ?? 0) - (profile[a] ?? 0) || compareText(a, b),
        )[0];
  const exemplar = genre === undefined ? undefined : exemplars[genre];
  if (genre !== undefined && exemplar !== undefined) {
    return { reason: genrePhrase(genre, spokenTitle(exemplar)), reasonKind: 'genre' };
  }
  const imdb = validRating(c.ratings?.imdb);
  if (imdb !== null) return { reason: `rated ${formatRating(imdb)} on IMDb`, reasonKind: 'rating' };
  if (isNewOnPlex(c, opts.now)) return { reason: 'new on Plex', reasonKind: 'new_on_plex' };
  return { reason: 'new to you', reasonKind: 'new_to_you' };
}

const round6 = (n: number) => Math.round(n * 1e6);

function comparePicks(a: ScoredPick, b: ScoredPick): number {
  return (
    round6(b.score) - round6(a.score) ||
    round6(b.quality) - round6(a.quality) ||
    compareText(a.candidate.title, b.candidate.title) ||
    compareText(a.candidate.titleKey, b.candidate.titleKey)
  );
}

/**
 * Score candidates (D-19): `0.45 × affinity + 0.30 × quality + boosts`, where affinity is the profile
 * weight of the candidate's canonical genres over the profile's top-three weight sum (capped at 1),
 * quality is {@link candidateQuality}, and boosts are +0.35 on the watchlist, +0.3 × min(1, seeds ÷ 3)
 * for TMDB seed agreement and +0.1 when added to Plex within 21 days. Best first; ties break on
 * quality, then title. The reason is the first that applies: "on your watchlist"; "because you
 * watched <most recent seed>"; "<genre> like <most-watched title>"; "rated <x> on IMDb"; "new on
 * Plex"; and, so every pick has one (AC-21), "new to you". Does NOT exclude — see
 * {@link pickRecommendations}.
 */
export function scoreCandidates(
  candidates: readonly RecoCandidate[],
  profile: GenreWeights,
  opts: ScoreOptions,
): ScoredPick[] {
  const wanted = opts.genre ? canonicalGenre(opts.genre) : null;
  const topThree = Object.values(profile)
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((s, w) => s + w, 0);
  const picks: ScoredPick[] = [];
  for (const c of candidates) {
    if (opts.kind && opts.kind !== 'any' && c.kind !== opts.kind) continue;
    const genres = canonicalGenres(c.genres);
    if (wanted !== null && !genres.includes(wanted)) continue;
    const genreWeight = genres.reduce((s, g) => s + (profile[g] ?? 0), 0);
    const affinity = topThree > 0 ? Math.min(1, genreWeight / topThree) : 0;
    const quality = candidateQuality(c.ratings);
    const boost =
      (c.watchlist === true ? 0.35 : 0) +
      0.3 * Math.min(1, distinctSeeds(c) / 3) +
      (isNewOnPlex(c, opts.now) ? 0.1 : 0);
    const score = 0.45 * affinity + 0.3 * quality + boost;
    picks.push({
      candidate: c,
      score,
      affinity,
      quality,
      boost,
      ...reasonFor(c, genres, profile, wanted, opts),
    });
  }
  return picks.sort(comparePicks);
}

export interface RecommendInput {
  candidates: readonly RecoCandidate[];
  exclusions: Exclusions;
  profile: TasteProfile;
  /** From {@link genreExemplars}. */
  genreTitles?: { adult: Record<string, string>; kids: Record<string, string> };
  kind?: WatchKind | 'any' | null;
  genre?: string | null;
  kids?: boolean;
  now: number;
}

export interface Recommendations {
  /** Best first. */
  onPlex: ScoredPick[];
  /** Best first; listed separately as "Not on Plex yet" (D-20). */
  notOnPlex: ScoredPick[];
}

/**
 * The whole pure `recommend` pipeline: exclude (group-aware, D-18) → merge sources → score with the
 * grown-up or the children's profile → split on Plex / not on Plex. Paging is the formatter's job.
 */
export function pickRecommendations(input: RecommendInput): Recommendations {
  const kids = input.kids === true;
  const survivors = excludeCandidates(input.candidates, input.exclusions, { kids });
  const scored = scoreCandidates(
    mergeCandidates(survivors),
    kids ? input.profile.kids : input.profile.adult,
    {
      kind: input.kind,
      genre: input.genre,
      now: input.now,
      genreTitles: kids ? input.genreTitles?.kids : input.genreTitles?.adult,
    },
  );
  return {
    onPlex: scored.filter((p) => p.candidate.onPlex),
    notOnPlex: scored.filter((p) => !p.candidate.onPlex),
  };
}
