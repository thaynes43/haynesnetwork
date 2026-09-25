// DESIGN-049 D-13 — the resolver POOL: every title a spoken query may name. The owner's Title States (in
// history), the live *arr ledger (Sonarr shows, Radarr movies, not tombstoned) and the recommendation
// signals (watchlist, TMDB seeds). SELECT only; the pure `resolveTitle` does the scoring.
import {
  mediaItems,
  watchMarks,
  watchRecoSignals,
  watchTitles,
  type DbClient,
  type WatchRecoSource,
} from '@hnet/db';
import { and, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { titleKeyFor } from '../identity';
import {
  entryOfMark,
  isOnWatchlist,
  WATCHLIST_REMOVE_REPLAY_SECONDS,
  type WatchlistEntry,
} from '../watchlist';
import { selectWatchlist } from './watchlist';
import type { ResolverCandidate } from '../resolver';
import type { WatchKind } from '../types';

/**
 * Where a pool entry came from. `tmdb` is never in the pool itself: it names a TMDB-fallback hit offered as an
 * option of an ambiguous `set_watchlist` add (DESIGN-051, PLAN-071 ruling 1). `watchlist_removed` is a title a
 * Watchlist Change removed in the last 10 minutes — only in the pool of a `set_watchlist` remove.
 */
export type PoolSource = 'title' | WatchLedgerSource | WatchRecoSource | 'tmdb' | 'watchlist_removed';
type WatchLedgerSource = 'ledger';

/** A resolver candidate that remembers where it came from. */
export interface PoolEntry extends ResolverCandidate {
  source: PoolSource;
  /** `watch_titles.id` (source `title`). */
  titleRowId: number | null;
  /** `media_items.id` (source `ledger`, or a Title State's ledger link). */
  mediaItemId: string | null;
}

const KIND_OF_ARR = { sonarr: 'show', radarr: 'movie' } as const;

/**
 * The overlaid watchlist (DESIGN-051 D-05) as pool entries of source `watchlist`; with `recentlyRemoved`, also
 * the titles a written `watchlist_remove` took off in the last 10 minutes (and not back on since) as
 * `watchlist_removed` — the pool of a `set_watchlist` remove, so a retried remove still finds its title.
 */
async function watchlistPool(
  db: DbClient,
  plexAccountId: number,
  kind: WatchKind | null,
  now: Date,
  recentlyRemoved: boolean,
): Promise<PoolEntry[]> {
  const { entries } = await selectWatchlist(db, plexAccountId, { now });
  const removed = recentlyRemoved
    ? (await selectRecentlyRemoved(db, plexAccountId, now))
        .map((m) => entryOfMark(m))
        .filter((e) => !isOnWatchlist(entries, e))
    : [];
  const pool: PoolEntry[] = [];
  const seen = new Set<string>();
  const push = (e: WatchlistEntry, source: PoolSource) => {
    if (kind && e.kind !== kind) return;
    if (seen.has(e.titleKey)) return;
    seen.add(e.titleKey);
    pool.push({
      titleKey: e.titleKey,
      kind: e.kind,
      title: e.title,
      year: e.year,
      inHistory: false,
      ids: { plexGuid: e.plexGuid, tmdbId: e.tmdbId, tvdbId: e.tvdbId, imdbId: e.imdbId },
      source,
      titleRowId: null,
      mediaItemId: null,
    });
  };
  for (const e of entries) push(e, 'watchlist');
  for (const e of removed) push(e, 'watchlist_removed');
  return pool;
}

/** Written, unreverted `watchlist_remove` marks of the last {@link WATCHLIST_REMOVE_REPLAY_SECONDS}. */
async function selectRecentlyRemoved(db: DbClient, plexAccountId: number, now: Date) {
  return db
    .select()
    .from(watchMarks)
    .where(
      and(
        eq(watchMarks.plexAccountId, plexAccountId),
        eq(watchMarks.action, 'watchlist_remove'),
        eq(watchMarks.plexResult, 'written'),
        isNull(watchMarks.revertedAt),
        gt(watchMarks.createdAt, new Date(now.getTime() - WATCHLIST_REMOVE_REPLAY_SECONDS * 1000)),
      ),
    )
    .orderBy(desc(watchMarks.createdAt), desc(watchMarks.id));
}

/**
 * The D-13 pool for the owner, optionally one kind only. Title States are `inHistory`. Ledger items and
 * signals carry the ids they know, so `resolveTitle` folds a title seen by several sources into one. The
 * watchlist part is the OVERLAID watchlist (DESIGN-051 D-05: `selectWatchlist`, so a title added a moment ago
 * resolves and one just removed does not come from it); `only: 'watchlist'` is the pool of a `set_watchlist`
 * remove (DESIGN-051 D-03 step 2): nothing but the titles on the watchlist.
 */
export async function selectResolverPool(
  db: DbClient,
  plexAccountId: number,
  opts: { kind?: WatchKind | null; now: Date; only?: 'watchlist' },
): Promise<PoolEntry[]> {
  const kind = opts.kind ?? null;
  if (opts.only === 'watchlist') return watchlistPool(db, plexAccountId, kind, opts.now, true);
  const titleWhere = [eq(watchTitles.plexAccountId, plexAccountId)];
  if (kind) titleWhere.push(eq(watchTitles.kind, kind));
  const titles = await db
    .select({
      id: watchTitles.id,
      kind: watchTitles.kind,
      titleKey: watchTitles.titleKey,
      title: watchTitles.title,
      year: watchTitles.year,
      plexGuid: watchTitles.plexGuid,
      tmdbId: watchTitles.tmdbId,
      tvdbId: watchTitles.tvdbId,
      imdbId: watchTitles.imdbId,
      mediaItemId: watchTitles.mediaItemId,
    })
    .from(watchTitles)
    .where(and(...titleWhere));

  const arrKinds =
    kind === 'show' ? (['sonarr'] as const) : kind === 'movie' ? (['radarr'] as const) : (['sonarr', 'radarr'] as const);
  const ledger = await db
    .select({
      id: mediaItems.id,
      arrKind: mediaItems.arrKind,
      title: mediaItems.title,
      year: mediaItems.year,
      tmdbId: mediaItems.tmdbId,
      tvdbId: mediaItems.tvdbId,
      imdbId: mediaItems.imdbId,
    })
    .from(mediaItems)
    .where(and(inArray(mediaItems.arrKind, [...arrKinds]), isNull(mediaItems.deletedFromArrAt)));

  // The TMDB seeds straight from the cache; the watchlist through the D-05 overlay (below).
  const signalWhere = [
    eq(watchRecoSignals.plexAccountId, plexAccountId),
    eq(watchRecoSignals.source, 'tmdb_seed'),
  ];
  if (kind) signalWhere.push(eq(watchRecoSignals.kind, kind));
  const signals = await db
    .select({
      source: watchRecoSignals.source,
      kind: watchRecoSignals.kind,
      title: watchRecoSignals.title,
      year: watchRecoSignals.year,
      plexGuid: watchRecoSignals.plexGuid,
      tmdbId: watchRecoSignals.tmdbId,
      tvdbId: watchRecoSignals.tvdbId,
      imdbId: watchRecoSignals.imdbId,
    })
    .from(watchRecoSignals)
    .where(and(...signalWhere));

  const pool: PoolEntry[] = titles.map((t) => ({
    titleKey: t.titleKey,
    kind: t.kind,
    title: t.title,
    year: t.year,
    inHistory: true,
    ids: { plexGuid: t.plexGuid, tmdbId: t.tmdbId, tvdbId: t.tvdbId, imdbId: t.imdbId },
    source: 'title',
    titleRowId: t.id,
    mediaItemId: t.mediaItemId,
  }));
  for (const m of ledger) {
    const k: WatchKind = m.arrKind === 'sonarr' ? KIND_OF_ARR.sonarr : KIND_OF_ARR.radarr;
    const ids = { tmdbId: m.tmdbId, tvdbId: k === 'show' ? m.tvdbId : null, imdbId: m.imdbId };
    pool.push({
      titleKey: titleKeyFor({ kind: k, title: m.title, year: m.year, ...ids }),
      kind: k,
      title: m.title,
      year: m.year,
      inHistory: false,
      ids,
      source: 'ledger',
      titleRowId: null,
      mediaItemId: m.id,
    });
  }
  // A seed title recommended by several of the owner's titles appears once per seed; one entry is enough.
  const seen = new Set<string>();
  for (const s of signals) {
    const ids = { plexGuid: s.plexGuid, tmdbId: s.tmdbId, tvdbId: s.tvdbId, imdbId: s.imdbId };
    const titleKey = titleKeyFor({ kind: s.kind, title: s.title, year: s.year, ...ids });
    const dedupe = `${s.source}\u0000${titleKey}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    pool.push({
      titleKey,
      kind: s.kind,
      title: s.title,
      year: s.year,
      inHistory: false,
      ids,
      source: s.source,
      titleRowId: null,
      mediaItemId: null,
    });
  }
  pool.push(...(await watchlistPool(db, plexAccountId, kind, opts.now, false)));
  return pool;
}
