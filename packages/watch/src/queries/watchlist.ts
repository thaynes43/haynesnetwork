// ADR-092 / DESIGN-051 D-02 / D-05 (PLAN-071) — the watchlist reads. `selectWatchlist` is the ONE query every
// watchlist reader goes through (the `watchlist` tool, `watch_status`, the resolver pool, `recommend`'s
// candidates): the account's cached `watch_reco_signals` rows (`source = 'watchlist'`, the `watch` sync their
// only writer) with the pure D-05 overlay of its Watchlist Changes applied. `selectTitleFacts` reads what the
// D-02 "on Plex" rule and the started / watched words need for a handful of titles. SELECT only.
import {
  watchMarks,
  watchTitles,
  WATCH_WATCHLIST_ACTIONS,
  type DbClient,
  type WatchTitleRow,
} from '@hnet/db';
import { and, eq, gt, inArray, or, sql, type SQL } from 'drizzle-orm';
import { nameKey, titleKeyFor } from '../identity';
import type { TitleIds } from '../types';
import {
  overlayWatchlist,
  WATCHLIST_NO_CACHE_LOOKBACK_SECONDS,
  WATCHLIST_OVERLAY_MARGIN_SECONDS,
  type WatchlistEntry,
} from '../watchlist';
import { selectLedgerByIds, type LedgerCandidate } from './ledger';
import { selectSignals } from './signals';

export interface OverlaidWatchlist {
  /** Newest-watchlisted first: the overlay's additions on top, then the cached rows in rank order. */
  entries: WatchlistEntry[];
  /** The cache's `fetched_at` (the sync run's start), or `now − 24 h` when nothing is cached. */
  fetchedAt: Date;
}

/**
 * D-05: the account's watchlist as of now — the cached rows with every WRITTEN Watchlist Change (and every
 * written revert) since `fetchedAt − 5 min` applied. `now` only bounds the look-back when the sync has
 * cached nothing yet.
 */
export async function selectWatchlist(
  db: DbClient,
  plexAccountId: number,
  opts: { now: Date },
): Promise<OverlaidWatchlist> {
  const rows = await selectSignals(db, plexAccountId, 'watchlist');
  const cached = rows.map((r) => r.fetchedAt.getTime());
  const fetchedAt =
    cached.length > 0
      ? new Date(Math.min(...cached))
      : new Date(opts.now.getTime() - WATCHLIST_NO_CACHE_LOOKBACK_SECONDS * 1000);
  const since = new Date(fetchedAt.getTime() - WATCHLIST_OVERLAY_MARGIN_SECONDS * 1000);
  const marks = await db
    .select({
      id: watchMarks.id,
      action: watchMarks.action,
      kind: watchMarks.kind,
      titleKey: watchMarks.titleKey,
      title: watchMarks.title,
      year: watchMarks.year,
      plexGuid: watchMarks.plexGuid,
      tmdbId: watchMarks.tmdbId,
      tvdbId: watchMarks.tvdbId,
      imdbId: watchMarks.imdbId,
      plexResult: watchMarks.plexResult,
      createdAt: watchMarks.createdAt,
      revertedAt: watchMarks.revertedAt,
      revertResult: watchMarks.revertResult,
    })
    .from(watchMarks)
    .where(
      and(
        eq(watchMarks.plexAccountId, plexAccountId),
        inArray(watchMarks.action, [...WATCH_WATCHLIST_ACTIONS]),
        or(
          and(eq(watchMarks.plexResult, 'written'), gt(watchMarks.createdAt, since)),
          and(eq(watchMarks.revertResult, 'written'), gt(watchMarks.revertedAt, since)),
        ),
      ),
    )
    .orderBy(watchMarks.createdAt, watchMarks.id);
  const base: WatchlistEntry[] = rows.map((r) => {
    const ids = {
      plexGuid: r.plexGuid,
      tmdbId: r.tmdbId,
      tvdbId: r.kind === 'show' ? r.tvdbId : null,
      imdbId: r.imdbId,
    };
    return {
      kind: r.kind,
      title: r.title,
      year: r.year,
      titleKey: titleKeyFor({ kind: r.kind, title: r.title, year: r.year, ...ids }),
      ...ids,
      source: 'cache',
    };
  });
  return {
    entries: overlayWatchlist(base, marks, Math.floor(fetchedAt.getTime() / 1000)),
    fetchedAt,
  };
}

/** The Title State columns the watchlist answers read (no episode maps). */
export type TitleFactsRow = Pick<
  WatchTitleRow,
  | 'kind'
  | 'titleKey'
  | 'title'
  | 'year'
  | 'plexGuid'
  | 'tmdbId'
  | 'tvdbId'
  | 'imdbId'
  | 'onPlex'
  | 'episodesWatched'
  | 'episodesTotal'
  | 'eventWatchedEpisodes'
  | 'nextSeason'
  | 'nextEpisode'
  | 'nextResume'
  | 'resumePercent'
  | 'plexWatched'
  | 'lastWatchedAt'
  | 'showStatus'
>;

/** What the D-02 "on Plex" rule and the started / watched words need for some titles. */
export interface TitleFacts {
  /** The owner's Title States that may be these titles (the caller matches them). */
  titles: TitleFactsRow[];
  /** Live Sonarr / Radarr items sharing an external id with them, with `onPlex` (a `media_plex_matches` row). */
  ledger: LedgerCandidate[];
}

const uniq = <T>(values: ReadonlyArray<T | null | undefined>): T[] => [
  ...new Set(values.filter((v): v is T => v !== null && v !== undefined)),
];

/**
 * DESIGN-051 D-02 — the facts behind "on Plex" (recommend's DESIGN-049 D-17 rule: a ledger item with the same
 * external id and a `media_plex_matches` row, or a Title State with `on_plex`) and behind "started" /
 * "watched", for a few titles (a page of the watchlist, or one title). Two SELECTs; the pure `titleFactsFor`
 * matches them.
 */
export async function selectTitleFacts(
  db: DbClient,
  plexAccountId: number,
  titles: ReadonlyArray<TitleIds & { titleKey?: string | null }>,
): Promise<TitleFacts> {
  if (titles.length === 0) return { titles: [], ledger: [] };
  const guids = uniq(titles.map((t) => t.plexGuid?.trim() || null));
  const tmdb = uniq(titles.map((t) => t.tmdbId));
  const tvdb = uniq(titles.map((t) => (t.kind === 'show' ? t.tvdbId : null)));
  const imdb = uniq(titles.map((t) => t.imdbId?.trim().toLowerCase() || null));
  const keys = uniq([
    ...titles.map((t) => t.titleKey),
    ...titles.map((t) => nameKey(t.kind, t.title, t.year)),
  ]);
  const match: SQL[] = [];
  if (guids.length > 0) match.push(inArray(watchTitles.plexGuid, guids));
  if (tmdb.length > 0) match.push(inArray(watchTitles.tmdbId, tmdb));
  if (tvdb.length > 0) match.push(inArray(watchTitles.tvdbId, tvdb));
  if (imdb.length > 0) match.push(sql`lower(${watchTitles.imdbId}) = ANY (${sql.param(imdb)}::text[])`);
  if (keys.length > 0) match.push(inArray(watchTitles.titleKey, keys));
  const kinds = uniq(titles.map((t) => t.kind));
  const [rows, ledger] = await Promise.all([
    db
      .select({
        kind: watchTitles.kind,
        titleKey: watchTitles.titleKey,
        title: watchTitles.title,
        year: watchTitles.year,
        plexGuid: watchTitles.plexGuid,
        tmdbId: watchTitles.tmdbId,
        tvdbId: watchTitles.tvdbId,
        imdbId: watchTitles.imdbId,
        onPlex: watchTitles.onPlex,
        episodesWatched: watchTitles.episodesWatched,
        episodesTotal: watchTitles.episodesTotal,
        eventWatchedEpisodes: watchTitles.eventWatchedEpisodes,
        nextSeason: watchTitles.nextSeason,
        nextEpisode: watchTitles.nextEpisode,
        nextResume: watchTitles.nextResume,
        resumePercent: watchTitles.resumePercent,
        plexWatched: watchTitles.plexWatched,
        lastWatchedAt: watchTitles.lastWatchedAt,
        showStatus: watchTitles.showStatus,
      })
      .from(watchTitles)
      .where(
        and(
          eq(watchTitles.plexAccountId, plexAccountId),
          inArray(watchTitles.kind, kinds),
          or(...match),
        ),
      ),
    selectLedgerByIds(db, titles),
  ]);
  return { titles: rows, ledger };
}
