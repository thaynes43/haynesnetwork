// DESIGN-049 D-13 — resolving a spoken title for the watch tools: the pool (the owner's Title States, the
// live ledger, the recommendation signals) scored by the pure resolver, then — when nothing in the pool is
// close, or the pool's title is not the year the query names (DESIGN-051 D-15x), or, for an add, the pool's title
// is not one it may take outright (D-15y) — ONE TMDB `search/multi` call, accepted only on an exact normalized
// title match (a title the pool does not know is "not on Plex"). Read-only: TMDB and SELECTs. Ambiguous and
// not-found never write (the callers return).
import type { DbClient } from '@hnet/db';
import type { TmdbClient } from '@hnet/arr/read';
import {
  hasNamedYear,
  normalizeTitle,
  poolTitleOf,
  resolveTitle,
  selectResolverPool,
  titleKeyFor,
  titleKeyRank,
  titleMatchScore,
  type ExternalIds,
  type PoolEntry,
  type WatchKind,
} from '@hnet/watch';
import { resolveDb } from '../db-client';

/** The one TMDB call the resolver may make. */
export type WatchTmdbSearch = Pick<TmdbClient, 'searchMulti'>;

export interface ResolvedWatchTitle {
  status: 'resolved';
  /** `pool` — a title the app knows; `tmdb` — only TMDB knows it (never on Plex). */
  source: 'pool' | 'tmdb';
  kind: WatchKind;
  title: string;
  year: number | null;
  /** The identity to record: the Title State's key when the owner has one, else the strongest key. */
  titleKey: string;
  ids: { plexGuid: string | null; tmdbId: number | null; tvdbId: number | null; imdbId: string | null };
  /** The owner's Title State row, when there is one. */
  titleRowId: number | null;
  /** Every ledger item that is this title. */
  mediaItemIds: string[];
  /** The pool entries that are this title (empty for `tmdb`). */
  members: PoolEntry[];
}

export type WatchResolution =
  | ResolvedWatchTitle
  | { status: 'ambiguous'; options: PoolEntry[] }
  | { status: 'not_found' };

/**
 * DESIGN-051 D-15w — only with `tmdbAmbiguity: 'ask'`: TMDB lists several titles for the query that read the same
 * (one name, year and kind, such as two 2020 movies called "Alone"). No argument of `set_watchlist` can pick one, so
 * the caller answers without a question. `options` holds every such hit.
 */
export interface IndistinctWatchTitles {
  status: 'indistinct';
  options: PoolEntry[];
}

function firstOf<K extends keyof ExternalIds>(members: readonly PoolEntry[], key: K): ExternalIds[K] | null {
  for (const m of members) {
    const v = m.ids?.[key];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function fromPool(members: readonly PoolEntry[], best: PoolEntry): ResolvedWatchTitle {
  const ids = {
    plexGuid: firstOf(members, 'plexGuid') ?? null,
    tmdbId: firstOf(members, 'tmdbId') ?? null,
    tvdbId: best.kind === 'show' ? (firstOf(members, 'tvdbId') ?? null) : null,
    imdbId: firstOf(members, 'imdbId') ?? null,
  };
  const titleRow = members.find((m) => m.titleRowId !== null);
  const merged = titleKeyFor({ kind: best.kind, title: best.title, year: best.year, ...ids });
  const keys = [merged, ...members.map((m) => m.titleKey)];
  const titleKey =
    titleRow?.titleKey ?? [...keys].sort((a, b) => titleKeyRank(a) - titleKeyRank(b))[0] ?? merged;
  return {
    status: 'resolved',
    source: 'pool',
    kind: best.kind,
    title: titleRow?.title ?? best.title,
    year: titleRow?.year ?? best.year,
    titleKey,
    ids,
    titleRowId: titleRow?.titleRowId ?? null,
    mediaItemIds: [...new Set(members.flatMap((m) => (m.mediaItemId ? [m.mediaItemId] : [])))],
    members: [...members],
  };
}

function yearOf(date: string | null | undefined): number | null {
  const m = /^(\d{4})-/.exec(date ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * D-13's last resort. Movies and shows only (people are dropped), the `kind` filter applies, and a hit is
 * accepted only on an EXACT normalized title match — or the year-tag-dropped form when the spoken year
 * hint is the hit's year ("dark matter 2024"). Every accepted hit, in TMDB's order, one per (kind, id). The year the
 * query names is weighed by the caller (DESIGN-051 D-15v, D-15x, D-15ac), after an add has counted the pool's own
 * title among the hits.
 */
async function fromTmdb(
  tmdb: WatchTmdbSearch,
  query: string,
  kind: WatchKind | null,
): Promise<ResolvedWatchTitle[]> {
  const q = normalizeTitle(query);
  // Search without a trailing year ("dark matter 2024", "Dune (2021)"): TMDB's multi search reads it as a
  // title word. The exact-match check below still weighs the year.
  const term =
    query
      .trim()
      .replace(/\s*\(\s*(?:19|20)\d{2}\s*\)\s*$/, '')
      .replace(/\s+(?:19|20)\d{2}$/, '')
      .trim() || query.trim();
  const page = await tmdb.searchMulti(term);
  const hits: ResolvedWatchTitle[] = [];
  for (const r of page.results) {
    const k: WatchKind | null = r.media_type === 'tv' ? 'show' : r.media_type === 'movie' ? 'movie' : null;
    if (k === null || (kind && k !== kind)) continue;
    const title = (k === 'show' ? r.name : r.title) ?? r.name ?? r.title ?? null;
    if (!title) continue;
    const year = yearOf(k === 'show' ? r.first_air_date : r.release_date);
    const score = titleMatchScore(q, title);
    const exact = score === 1 || (score === 0.95 && q.year !== null && q.year === year);
    if (!exact) continue;
    if (hits.some((h) => h.kind === k && h.ids.tmdbId === r.id)) continue;
    const ids = { plexGuid: null, tmdbId: r.id, tvdbId: null, imdbId: null };
    hits.push({
      status: 'resolved',
      source: 'tmdb',
      kind: k,
      title,
      year,
      titleKey: titleKeyFor({ kind: k, title, year, ...ids }),
      ids,
      titleRowId: null,
      mediaItemIds: [],
      members: [],
    });
  }
  return hits;
}

/** What a TMDB hit reads as when spoken (its title, year and kind): hits that share it cannot be told apart. */
function spokenKey(t: Pick<ResolvedWatchTitle, 'kind' | 'title' | 'year'>): string {
  return `${t.kind}|${normalizeTitle(t.title).norm}|${t.year ?? ''}`;
}

/** A TMDB hit as an ambiguity option (title, year and kind are what the answer lists). */
function tmdbOption(t: ResolvedWatchTitle): PoolEntry {
  return {
    titleKey: t.titleKey,
    kind: t.kind,
    title: t.title,
    year: t.year,
    inHistory: false,
    ids: t.ids,
    source: 'tmdb',
    titleRowId: null,
    mediaItemId: null,
  };
}

/**
 * An add's question about TMDB's hits (ADR-092 C-07): one option per title that reads differently, so the question
 * lists each once; hits that all read the same (one name, year and kind) can only be told apart by an argument
 * `set_watchlist` does not have, so they are `indistinct` (DESIGN-051 D-15w). A lone hit is asked about ("Did you
 * mean …?", D-15ac).
 */
function askAbout(hits: readonly ResolvedWatchTitle[]): WatchResolution | IndistinctWatchTitles {
  const distinct = new Map<string, ResolvedWatchTitle>();
  for (const h of hits) if (!distinct.has(spokenKey(h))) distinct.set(spokenKey(h), h);
  if (distinct.size === 1 && hits.length > 1) return { status: 'indistinct', options: hits.map(tmdbOption) };
  return { status: 'ambiguous', options: [...distinct.values()].map(tmdbOption) };
}

/** What {@link resolveWatchTitle} answers: `indistinct` only in the `'ask'` mode (DESIGN-051 D-15w). */
export type ResolveWatchTitleResult<A extends 'first' | 'ask'> = A extends 'ask'
  ? WatchResolution | IndistinctWatchTitles
  : WatchResolution;

/** The inputs of {@link resolveWatchTitle}. */
export interface ResolveWatchTitleInput {
  db?: DbClient;
  plexAccountId: number;
  query: string;
  kind?: WatchKind | null;
  /** The TMDB search (D-13's last resort, for "not found"); null or absent ⇒ no TMDB call at all. */
  tmdb?: WatchTmdbSearch | null;
  /**
   * DESIGN-051 D-15aa — the same search with a SINGLE attempt, for a TMDB call made while the pool already has an
   * answer (a named year the pool's title does not have, an add's near or unconfirmed title, D-15x, D-15y): the
   * pool's answer stands if it fails, so retries buy little, and `mark_watched`'s Plex work follows it. Absent ⇒
   * `tmdb`.
   */
  tmdbOnce?: WatchTmdbSearch | null;
  /** Bounds the watchlist overlay's look-back when nothing is cached (DESIGN-051 D-05). Default: the clock. */
  now?: Date;
  pool?: 'all' | 'watchlist';
  tmdbAmbiguity?: 'first' | 'ask';
}

/**
 * Resolve `query` for the owner (D-13). The TMDB fallback runs for "not found" (and, below, when the pool's answer
 * does not settle the query), only when a client is given, at most once; a TMDB failure leaves the pool's answer
 * ("not found" when the pool had none): the voice turn must not fail on it. When the pool had an answer, the call
 * goes through `tmdbOnce` when one is given (a single attempt, DESIGN-051 D-15aa).
 *
 * Every mode (DESIGN-051 D-15x): a year the query names settles the pool's same-name titles as it settles TMDB's
 * hits (D-15v). When the pool's title is another year's ("Shōgun (2024)" and only the 1980 show is known), the TMDB
 * fallback runs as for "not found"; its hits of the named year win (the first one here, as D-13 reads it), else the
 * pool's answer stands. A TMDB hit the pool knows (the same kind and TMDB id) resolves to the pool's title.
 *
 * ADR-092 / DESIGN-051:
 * - `pool: 'watchlist'` — a `set_watchlist` remove: the pool is only the overlaid watchlist plus the titles a
 *   Watchlist Change may have left on plex.tv's list (a written remove of the last 10 minutes or one whose undo
 *   never confirmed, an add that failed or never finalized which the cache cannot have seen: D-13, D-15q, D-15r),
 *   so a retried remove finds the title and plex.tv's live state answers; there is no TMDB fallback (D-03 step 2),
 *   and a watchlist title of another year than the one named is not found (D-15x).
 * - `tmdbAmbiguity: 'ask'` — a `set_watchlist` add, which can download the title (ADR-092 C-07): EVERY exact TMDB
 *   hit of the eligible kind(s) counts, and more than one distinct title is ambiguous (listed with their years, one
 *   option per title that reads differently), never the first hit. Hits that all read the same (one name, year and
 *   kind) are `indistinct`, never a question no argument can answer (D-15w). The mark flows keep D-13's first exact
 *   hit. Either way a year the query names keeps only the hits of that year when there are any (D-15v). The pool's
 *   title is taken outright only when the owner or the library knows it (not only a TMDB recommendation, D-15x), the
 *   query names it exactly and its year is not another than the one named (D-15y); otherwise TMDB's exact hits
 *   decide as above, the pool's own exact title counting as one when TMDB's page leaves it out (D-15ac), and when
 *   there are none (or TMDB fails) the pool's title is asked about, never taken, except a recommendation the query
 *   names with its own year (the answer to that question). An add never takes a hit of another year than the one
 *   named (D-15ac): when no hit has it, the pool's answer stands, or with none the hits are asked about.
 */
export async function resolveWatchTitle<A extends 'first' | 'ask' = 'first'>(
  input: ResolveWatchTitleInput & { tmdbAmbiguity?: A },
): Promise<ResolveWatchTitleResult<A>> {
  // Only the 'ask' mode can come back `indistinct` (below), which is what the result type says.
  return (await resolveAny(input)) as ResolveWatchTitleResult<A>;
}

async function resolveAny(input: ResolveWatchTitleInput): Promise<WatchResolution | IndistinctWatchTitles> {
  const db = resolveDb(input.db);
  const kind = input.kind ?? null;
  const watchlistOnly = input.pool === 'watchlist';
  const ask = input.tmdbAmbiguity === 'ask';
  // A `set_watchlist` add: 'ask' over the full pool (the remove is 'ask' over the watchlist, with no TMDB).
  const add = ask && !watchlistOnly;
  const pool = await selectResolverPool(db, input.plexAccountId, {
    kind,
    now: input.now ?? new Date(),
    ...(watchlistOnly ? { only: 'watchlist' as const } : {}),
  });
  const q = normalizeTitle(input.query);
  const r = resolveTitle(input.query, pool, { kind });

  // What the pool answers when TMDB cannot settle it (or is not asked).
  let fallback: WatchResolution;
  if (r.status === 'resolved') {
    const members = r.sameTitle as PoolEntry[];
    const title = fromPool(members, r.candidate as PoolEntry);
    // DESIGN-051 D-15x: a TMDB recommendation is a title only TMDB knows, so an add weighs it as TMDB's (C-07).
    const seedOnly = members.every((m) => m.source === 'tmdb_seed');
    const unsettled = r.yearUnmatched || (add && (!r.exact || seedOnly));
    if (!unsettled) return title;
    // D-15x: the watchlist holds the title, but of another year than the one named.
    if (watchlistOnly) return { status: 'not_found' };
    if (!add) fallback = title;
    // D-15y: never take a near title, another year's, or an unconfirmed recommendation: ask about it instead. A
    // recommendation named with its own year is the answer to that question.
    else if (seedOnly && r.exact && !r.yearUnmatched && q.year !== null) fallback = title;
    else fallback = { status: 'ambiguous', options: [r.candidate as PoolEntry] };
  } else if (r.status === 'ambiguous') {
    const options = r.options as PoolEntry[];
    if (!r.yearUnmatched && !(add && !r.exact)) return { status: 'ambiguous', options };
    if (watchlistOnly) return { status: 'not_found' };
    fallback = { status: 'ambiguous', options };
  } else {
    fallback = { status: 'not_found' };
  }
  if (!input.tmdb || watchlistOnly) return fallback;
  // D-15aa: with the pool's answer in hand, the call that may beat it makes one attempt.
  const search = r.status === 'not_found' ? input.tmdb : (input.tmdbOnce ?? input.tmdb);

  let hits: ResolvedWatchTitle[];
  try {
    hits = await fromTmdb(search, input.query, kind);
  } catch {
    // TMDB down or unconfigured upstream: the pool's answer stands.
    return fallback;
  }
  // DESIGN-051 D-15ac: an add counts the pool's own title named exactly (a TMDB recommendation, which TMDB knows)
  // among TMDB's exact hits when TMDB's page leaves it out, so "shogun" asks between the 1980 show and the 2024 one
  // rather than adding the only one the page lists. Only once TMDB answered with an exact hit: with none, the pool's
  // answer stands as before (asked about, or a recommendation named with its own year).
  if (add && hits.length > 0 && r.status === 'resolved' && r.exact) {
    const own = fromPool(r.sameTitle as PoolEntry[], r.candidate as PoolEntry);
    const id = own.ids.tmdbId;
    if (id !== null && !hits.some((h) => h.kind === own.kind && h.ids.tmdbId === id)) hits.push(own);
  }
  // D-15v: "Shōgun (2024)" names the year the way D-13 reads it, but a parenthesized year leaves the title's norm,
  // so every "Shōgun" scores 1 and the exact check never weighs it. When some hit has the named year (as its year
  // or one of its title's own words, "Blade Runner 2049" a 2017 film, D-15x), only those are kept.
  const named = hits.filter((h) => hasNamedYear(q, h));
  if (named.length > 0) hits = named;
  else if (q.year !== null && hits.length > 0) {
    // No hit has the named year. Past a pool title the pool's answer stands (D-15x): for an add, a recommendation
    // named with its own year, or the question about the pool's title. D-15ac: an add, which can download, never
    // takes a hit of another year than the one named; with no pool answer it asks about the hits. The mark flows
    // keep D-13's reading of the year as a hint when the pool has nothing close.
    if (r.status !== 'not_found') return fallback;
    if (ask) return askAbout(hits);
  }
  if (ask && hits.length > 1) return askAbout(hits);
  const hit = hits[0];
  if (!hit) return fallback;
  // D-15x: a title the pool knows is the pool's (its Title State, ledger items and watchlist rows).
  const known = hit.ids.tmdbId === null ? [] : poolTitleOf(pool, hit.kind, hit.ids.tmdbId);
  const first = known[0];
  return first ? fromPool(known, first) : hit;
}
