// DESIGN-049 D-13 — resolving a spoken title for the watch tools: the pool (the owner's Title States, the
// live ledger, the recommendation signals) scored by the pure resolver, then — only when nothing in the pool
// is close — ONE TMDB `search/multi` call, accepted only on an exact normalized title match (such a title is
// "not on Plex"). Read-only: TMDB and SELECTs. Ambiguous and not-found never write (the callers return).
import type { DbClient } from '@hnet/db';
import type { TmdbClient } from '@hnet/arr/read';
import {
  normalizeTitle,
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
 * hint is the hit's year ("dark matter 2024"). Every accepted hit, in TMDB's order, one per (kind, id). A year the
 * query names settles it whenever a hit has that year (DESIGN-051 D-15v): only those hits are kept.
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
  // DESIGN-051 D-15v: "Shōgun (2024)" names the year the way D-13 reads it, but a parenthesized year leaves the
  // title's norm, so every "Shōgun" scores 1 and the exact check above never weighs it. When some hit has the
  // named year, keep only those; when none does ("Blade Runner 2049" is a 2017 film), the year was the title's.
  if (q.year !== null && hits.some((h) => h.year === q.year)) return hits.filter((h) => h.year === q.year);
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
  tmdb?: WatchTmdbSearch | null;
  /** Bounds the watchlist overlay's look-back when nothing is cached (DESIGN-051 D-05). Default: the clock. */
  now?: Date;
  pool?: 'all' | 'watchlist';
  tmdbAmbiguity?: 'first' | 'ask';
}

/**
 * Resolve `query` for the owner (D-13). The TMDB fallback runs only for "not found" and only when a
 * client is given; a TMDB failure answers "not found" (the voice turn must not fail on it).
 *
 * ADR-092 / DESIGN-051:
 * - `pool: 'watchlist'` — a `set_watchlist` remove: the pool is only the overlaid watchlist plus the titles a
 *   Watchlist Change may have left on plex.tv's list (a written remove of the last 10 minutes or one whose undo
 *   never confirmed, an add that failed or never finalized which the cache cannot have seen: D-13, D-15q, D-15r),
 *   so a retried remove finds the title and plex.tv's live state answers; there is no TMDB fallback (D-03 step 2).
 * - `tmdbAmbiguity: 'ask'` — a `set_watchlist` add, which can download the title (ADR-092 C-07): EVERY exact TMDB
 *   hit of the eligible kind(s) counts, and more than one distinct title is ambiguous (listed with their years, one
 *   option per title that reads differently), never the first hit. Hits that all read the same (one name, year and
 *   kind) are `indistinct`, never a question no argument can answer (D-15w). The mark flows keep D-13's first exact
 *   hit. Either way a year the query names keeps only the hits of that year when there are any (D-15v).
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
  const pool = await selectResolverPool(db, input.plexAccountId, {
    kind,
    now: input.now ?? new Date(),
    ...(watchlistOnly ? { only: 'watchlist' as const } : {}),
  });
  const r = resolveTitle(input.query, pool, { kind });
  if (r.status === 'resolved') {
    const members = r.sameTitle as PoolEntry[];
    return fromPool(members, r.candidate as PoolEntry);
  }
  if (r.status === 'ambiguous') return { status: 'ambiguous', options: r.options as PoolEntry[] };
  if (input.tmdb && !watchlistOnly) {
    try {
      const hits = await fromTmdb(input.tmdb, input.query, kind);
      if (input.tmdbAmbiguity === 'ask' && hits.length > 1) {
        // One option per title that reads differently: the question lists each once, and a hit that shares its
        // name, year and kind with another can only be told apart by an argument set_watchlist does not have.
        const distinct = new Map<string, ResolvedWatchTitle>();
        for (const h of hits) if (!distinct.has(spokenKey(h))) distinct.set(spokenKey(h), h);
        if (distinct.size === 1) return { status: 'indistinct', options: hits.map(tmdbOption) };
        return { status: 'ambiguous', options: [...distinct.values()].map(tmdbOption) };
      }
      const hit = hits[0];
      if (hit) return hit;
    } catch {
      // TMDB down or unconfigured upstream: the pool said not found, so the answer stays not found.
    }
  }
  return { status: 'not_found' };
}
