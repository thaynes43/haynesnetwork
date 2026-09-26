// ADR-092 / DESIGN-051 D-05 / D-07 (PLAN-071) — the owner's plex.tv watchlist as every reader sees it: the
// 15-minute cache (`watch_reco_signals` source `watchlist`, written only by the `watch` sync) with the account's
// Watchlist Changes (T-260) since that sync overlaid at READ time. Pure: the query (queries/watchlist.ts) hands
// in the rows and marks; nothing here writes, and nothing writes through into the cache — so a sync that read
// plex.tv just before a change can never hide it from the next answer.
//
// Also the one place that says which Watch Marks are watch STATEMENTS (`watched`, `not_interested`, `not_mine`):
// the watchlist actions mean nothing to Ever Watched, exclusions, the Taste Profile, dismissals or Unfinished.
import {
  WATCH_STATEMENT_ACTIONS,
  WATCH_WATCHLIST_ACTIONS,
  type WatchMarkAction,
  type WatchMarkRow,
  type WatchStatementAction,
  type WatchWatchlistAction,
} from '@hnet/db/schema';
import { keysOf, nameKey } from './identity';
import type { TitleIds, WatchKind } from './types';

/** A watch statement (`watched`, `not_interested`, `not_mine`) — what every statement reader counts. */
export function isStatementAction(action: WatchMarkAction | string): action is WatchStatementAction {
  return (WATCH_STATEMENT_ACTIONS as readonly string[]).includes(action);
}

/** A Watchlist Change action (`watchlist_add`, `watchlist_remove`). */
export function isWatchlistAction(action: WatchMarkAction | string): action is WatchWatchlistAction {
  return (WATCH_WATCHLIST_ACTIONS as readonly string[]).includes(action);
}

/** The statement marks only (DESIGN-051 D-07: every other reader of `watch_marks.action` ignores the rest). */
export function statementMarks<M extends Pick<WatchMarkRow, 'action'>>(
  marks: readonly M[],
): Array<M & { action: WatchStatementAction }> {
  return marks.filter((m): m is M & { action: WatchStatementAction } => isStatementAction(m.action));
}

/** One title on the (overlaid) watchlist. */
export interface WatchlistEntry extends TitleIds {
  kind: WatchKind;
  title: string;
  year: number | null;
  titleKey: string;
  plexGuid: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
  /** `cache` — a row the sync read from plex.tv; `change` — put there by a Watchlist Change since that sync. */
  source: 'cache' | 'change';
}

/** The mark columns the overlay reads. */
export type WatchlistMarkLike = Pick<
  WatchMarkRow,
  | 'id'
  | 'action'
  | 'kind'
  | 'titleKey'
  | 'title'
  | 'year'
  | 'plexGuid'
  | 'tmdbId'
  | 'tvdbId'
  | 'imdbId'
  | 'plexResult'
  | 'createdAt'
  | 'revertedAt'
  | 'revertResult'
>;

/**
 * D-05: events from this long before the cache's `fetchedAt` still apply — the gap between a change's row
 * (`created_at`, inserted before its Plex write) and the write itself. Re-applying an event the sync already
 * saw changes nothing (both operations are set operations), which is what makes the margin safe.
 */
export const WATCHLIST_OVERLAY_MARGIN_SECONDS = 5 * 60;
/**
 * DESIGN-051 D-03 step 2, D-13 — a `set_watchlist` remove also resolves among the titles a written remove took off
 * this recently, so a retried remove (Home Assistant's trailing `tools/list` failure, DESIGN-049 D-05) finds its
 * title and answers "isn't on your watchlist" instead of "couldn't find".
 */
export const WATCHLIST_REMOVE_REPLAY_SECONDS = 10 * 60;
/**
 * DESIGN-049 D-15 — how far back `undo_last_change` reaches (`UNDO_WINDOW_SECONDS` in `@hnet/domain` is this
 * value). An undo's inverse call can therefore run at most this long after its change was made, which bounds how
 * far back a change whose undo plex.tv never confirmed can matter (DESIGN-051 D-15r).
 */
export const WATCH_UNDO_WINDOW_SECONDS = 24 * 60 * 60;
/**
 * D-05: with no cached rows at all, the overlay replays the changes of the last day. (Nothing records a
 * watchlist fetch that found no titles — the sync's replace leaves no row, and `watch_accounts.resolved_at` is
 * stamped before the watchlist read, even when that read fails — so the look-back is the fallback.)
 */
export const WATCHLIST_NO_CACHE_LOOKBACK_SECONDS = 24 * 60 * 60;

/** The external-id keys of a title (plex guid, TVDB for shows, TMDB, IMDb) — never the `name:` key. */
function strongKeys(ids: TitleIds & { titleKey?: string | null }): string[] {
  return keysOf(ids).filter((k) => !k.startsWith('name:'));
}

/**
 * The same title for the watchlist (D-05): the same kind and a shared plex guid or TMDB / TVDB / IMDb id; only
 * when either side knows no external id at all, the same normalized name and year.
 */
export function sameWatchlistTitle(
  a: TitleIds & { titleKey?: string | null },
  b: TitleIds & { titleKey?: string | null },
): boolean {
  if (a.kind !== b.kind) return false;
  const sa = strongKeys(a);
  const sb = strongKeys(b);
  if (sa.length > 0 && sb.length > 0) return sa.some((k) => sb.includes(k));
  return nameKey(a.kind, a.title, a.year) === nameKey(b.kind, b.title, b.year);
}

/** Whether `ids` is on the (overlaid) watchlist. */
export function isOnWatchlist(
  entries: readonly WatchlistEntry[],
  ids: TitleIds & { titleKey?: string | null },
): boolean {
  return entries.some((e) => sameWatchlistTitle(e, ids));
}

/** One change to apply: an add or a remove of the mark's title, at `at` (ms since the epoch). */
interface WatchlistEvent {
  op: 'add' | 'remove';
  at: number;
  markId: number;
  /** 0 for the change itself, 1 for its revert (a revert never precedes its change). */
  order: 0 | 1;
  mark: WatchlistMarkLike;
}

function ms(d: Date | string | null | undefined): number | null {
  if (!d) return null;
  const t = (d instanceof Date ? d : new Date(d)).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * The D-05 events since `fetchedAt − 5 min` (unix seconds), oldest first: each WRITTEN change at its
 * `created_at`, and each WRITTEN revert as the inverse at its `reverted_at`. A failed or pending change changed
 * nothing, and neither did a failed revert.
 */
export function watchlistEvents(marks: readonly WatchlistMarkLike[], fetchedAt: number): WatchlistEvent[] {
  const since = (fetchedAt - WATCHLIST_OVERLAY_MARGIN_SECONDS) * 1000;
  const out: WatchlistEvent[] = [];
  for (const m of marks) {
    if (!isWatchlistAction(m.action)) continue;
    const op = m.action === 'watchlist_add' ? 'add' : 'remove';
    const created = ms(m.createdAt);
    if (m.plexResult === 'written' && created !== null && created > since) {
      out.push({ op, at: created, markId: m.id, order: 0, mark: m });
    }
    // A revert never precedes its change (D-15u): a row stamped before its own `created_at` (an undo that read its
    // clock before it waited on the lock, then picked a change made meanwhile) is applied at the change's time.
    const stamped = ms(m.revertedAt);
    const reverted = stamped === null ? null : Math.max(stamped, created ?? stamped);
    if (m.revertResult === 'written' && reverted !== null && reverted > since) {
      out.push({ op: op === 'add' ? 'remove' : 'add', at: reverted, markId: m.id, order: 1, mark: m });
    }
  }
  return out.sort((a, b) => a.at - b.at || a.markId - b.markId || a.order - b.order);
}

/** The synthetic entry a change puts on the list: the mark's resolved identity. */
export function entryOfMark(m: WatchlistMarkLike): WatchlistEntry {
  return {
    kind: m.kind,
    title: m.title,
    year: m.year,
    titleKey: m.titleKey,
    plexGuid: m.plexGuid,
    tmdbId: m.tmdbId,
    tvdbId: m.kind === 'show' ? m.tvdbId : null,
    imdbId: m.imdbId,
    source: 'change',
  };
}

/**
 * D-05's overlay: the cached rows (in rank order, newest-watchlisted first) with the account's Watchlist Changes
 * since `fetchedAt − 5 min` applied oldest first. An add of a title not present puts it at the top; a remove
 * drops every row of the same title. Both are set operations, so an event the cache already reflects changes
 * nothing.
 */
export function overlayWatchlist(
  base: readonly WatchlistEntry[],
  marks: readonly WatchlistMarkLike[],
  fetchedAt: number,
): WatchlistEntry[] {
  let list = [...base];
  for (const e of watchlistEvents(marks, fetchedAt)) {
    const entry = entryOfMark(e.mark);
    if (e.op === 'add') {
      if (!isOnWatchlist(list, entry)) list = [entry, ...list];
    } else {
      list = list.filter((x) => !sameWatchlistTitle(x, entry));
    }
  }
  return list;
}
