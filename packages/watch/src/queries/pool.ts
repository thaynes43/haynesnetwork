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
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { titleKeyFor } from '../identity';
import {
  entryOfMark,
  isOnWatchlist,
  WATCH_UNDO_WINDOW_SECONDS,
  WATCHLIST_OVERLAY_MARGIN_SECONDS,
  WATCHLIST_REMOVE_REPLAY_SECONDS,
  type WatchlistEntry,
} from '../watchlist';
import { selectWatchlist } from './watchlist';
import type { ResolverCandidate } from '../resolver';
import type { WatchKind } from '../types';

/**
 * Where a pool entry came from. `tmdb` is never in the pool itself: it names a TMDB-fallback hit offered as an
 * option of an ambiguous `set_watchlist` add (DESIGN-051 D-03 step 2, ADR-092 C-07). `watchlist_recent` is a title a
 * Watchlist Change touched without it being on the (overlaid) list now — a written remove of the last 10 minutes,
 * a written remove whose undo plex.tv never confirmed, or an add that failed or never finalized which the cache
 * cannot have seen (DESIGN-051 D-15b, D-15q, D-15r) — only in the pool of a `set_watchlist` remove,
 * where plex.tv's live state decides.
 */
export type PoolSource = 'title' | WatchLedgerSource | WatchRecoSource | 'tmdb' | 'watchlist_recent';
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
 * The overlaid watchlist (DESIGN-051 D-05) as pool entries of source `watchlist`; with `recent`, also the titles of
 * {@link selectRecentWatchlistChanges} that are not on the list now, as `watchlist_recent`: the pool of a
 * `set_watchlist` remove, where plex.tv's live userState then decides.
 */
async function watchlistPool(
  db: DbClient,
  plexAccountId: number,
  kind: WatchKind | null,
  now: Date,
  recent: boolean,
): Promise<PoolEntry[]> {
  const { entries, fetchedAt } = await selectWatchlist(db, plexAccountId, { now });
  const removed = recent
    ? (await selectRecentWatchlistChanges(db, plexAccountId, now, fetchedAt))
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
  for (const e of removed) push(e, 'watchlist_recent');
  return pool;
}

/**
 * The Watchlist Changes a remove may be about although the overlaid list (which shows WRITTEN changes and reverts
 * only, D-05) does not show their title (DESIGN-051 D-03 step 2):
 *
 * - a written, unreverted remove of the last {@link WATCHLIST_REMOVE_REPLAY_SECONDS}: a retried remove finds its
 *   title and answers "isn't on" (DESIGN-051 D-03 step 2, D-13);
 * - a written remove whose undo plex.tv never confirmed (`revert_result = 'failed'`, still live), within the undo
 *   window: that undo's add may have put the title back after the cache's read (D-15r);
 * - an add that `failed` (it may have landed, D-15b) or is still `pending` (in flight, or its replica
 *   died after the PUT, D-15q), made since the cache's fetch less the overlay margin — every add the cache cannot
 *   have seen — or within the replay window, whichever reaches further back (reverted or not: plex.tv's live state
 *   decides either way).
 */
async function selectRecentWatchlistChanges(db: DbClient, plexAccountId: number, now: Date, fetchedAt: Date) {
  const replay = now.getTime() - WATCHLIST_REMOVE_REPLAY_SECONDS * 1000;
  const unseen = Math.min(replay, fetchedAt.getTime() - WATCHLIST_OVERLAY_MARGIN_SECONDS * 1000);
  const undoable = now.getTime() - WATCH_UNDO_WINDOW_SECONDS * 1000;
  const writtenRemove = and(
    eq(watchMarks.action, 'watchlist_remove'),
    eq(watchMarks.plexResult, 'written'),
    isNull(watchMarks.revertedAt),
  );
  return db
    .select()
    .from(watchMarks)
    .where(
      and(
        eq(watchMarks.plexAccountId, plexAccountId),
        or(
          and(writtenRemove, gt(watchMarks.createdAt, new Date(replay))),
          and(writtenRemove, eq(watchMarks.revertResult, 'failed'), gt(watchMarks.createdAt, new Date(undoable))),
          and(
            eq(watchMarks.action, 'watchlist_add'),
            inArray(watchMarks.plexResult, ['failed', 'pending']),
            gt(watchMarks.createdAt, new Date(unseen)),
          ),
        ),
      ),
    )
    .orderBy(desc(watchMarks.createdAt), desc(watchMarks.id));
}

/**
 * The D-13 pool for the owner, optionally one kind only. Title States are `inHistory`. Ledger items and
 * signals carry the ids they know, so `resolveTitle` folds a title seen by several sources into one. The
 * watchlist part is the OVERLAID watchlist (DESIGN-051 D-05: `selectWatchlist`, so a title added a moment ago
 * resolves and one just removed does not come from it); `only: 'watchlist'` is the pool of a `set_watchlist`
 * remove (DESIGN-051 D-03 step 2): the titles on the watchlist, plus the `watchlist_recent` ones a change may
 * have left there.
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
