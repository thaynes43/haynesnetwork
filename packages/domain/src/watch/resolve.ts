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
 * hint is the hit's year ("dark matter 2024").
 */
async function fromTmdb(
  tmdb: WatchTmdbSearch,
  query: string,
  kind: WatchKind | null,
): Promise<ResolvedWatchTitle | null> {
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
  for (const r of page.results) {
    const k: WatchKind | null = r.media_type === 'tv' ? 'show' : r.media_type === 'movie' ? 'movie' : null;
    if (k === null || (kind && k !== kind)) continue;
    const title = (k === 'show' ? r.name : r.title) ?? r.name ?? r.title ?? null;
    if (!title) continue;
    const year = yearOf(k === 'show' ? r.first_air_date : r.release_date);
    const score = titleMatchScore(q, title);
    const exact = score === 1 || (score === 0.95 && q.year !== null && q.year === year);
    if (!exact) continue;
    const ids = { plexGuid: null, tmdbId: r.id, tvdbId: null, imdbId: null };
    return {
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
    };
  }
  return null;
}

/**
 * Resolve `query` for the owner (D-13). The TMDB fallback runs only for "not found" and only when a
 * client is given; a TMDB failure answers "not found" (the voice turn must not fail on it).
 */
export async function resolveWatchTitle(input: {
  db?: DbClient;
  plexAccountId: number;
  query: string;
  kind?: WatchKind | null;
  tmdb?: WatchTmdbSearch | null;
}): Promise<WatchResolution> {
  const db = resolveDb(input.db);
  const kind = input.kind ?? null;
  const pool = await selectResolverPool(db, input.plexAccountId, { kind });
  const r = resolveTitle(input.query, pool, { kind });
  if (r.status === 'resolved') {
    const members = r.sameTitle as PoolEntry[];
    return fromPool(members, r.candidate as PoolEntry);
  }
  if (r.status === 'ambiguous') return { status: 'ambiguous', options: r.options as PoolEntry[] };
  if (input.tmdb) {
    try {
      const hit = await fromTmdb(input.tmdb, input.query, kind);
      if (hit) return hit;
    } catch {
      // TMDB down or unconfigured upstream: the pool said not found, so the answer stays not found.
    }
  }
  return { status: 'not_found' };
}
