// DESIGN-049 D-10 / D-18 — the owner's live Watch Marks (unreverted): the `watched` marks join Ever
// Watched, the dismissals exclude titles from Unfinished and picks. SELECT only.
//
// ADR-092 / DESIGN-051 D-07 — the live WATCH STATEMENTS only (`watched`, `not_interested`, `not_mine`): a
// Watchlist Change (`watchlist_add` / `watchlist_remove`) says nothing about viewing, so Ever Watched, the
// exclusions, the Taste Profile, the dismissed flag, Unfinished, recent history and the seed picker — every
// caller of this query — never see one. Only their own queries read them: the watchlist overlay
// (`selectWatchlist`), undo and its replay guard, the `set_watchlist` remove pool (`selectResolverPool`) and the
// unsettled check (`@hnet/domain`'s `selectUnsettledWatchlistRun`).
import {
  WATCH_STATEMENT_ACTIONS,
  watchMarks,
  type DbClient,
  type WatchMarkRow,
  type WatchStatementAction,
} from '@hnet/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';

/** A live watch statement: a mark whose action is `watched`, `not_interested` or `not_mine`. */
export type LiveWatchMark = WatchMarkRow & { action: WatchStatementAction };

export async function selectLiveMarks(db: DbClient, plexAccountId: number): Promise<LiveWatchMark[]> {
  const rows = await db
    .select()
    .from(watchMarks)
    .where(
      and(
        eq(watchMarks.plexAccountId, plexAccountId),
        isNull(watchMarks.revertedAt),
        inArray(watchMarks.action, [...WATCH_STATEMENT_ACTIONS]),
      ),
    );
  return rows as LiveWatchMark[];
}
