import {
  pgTable,
  bigserial,
  bigint,
  text,
  integer,
  uuid,
  jsonb,
  timestamp,
  check,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { watchAccounts } from './watch-accounts';
import { users } from './users';
import {
  WATCH_MARK_ACTIONS,
  WATCH_MARK_PLEX_RESULTS,
  WATCH_MARK_REVERT_RESULTS,
  WATCH_MARK_SCOPES,
  WATCH_TITLE_KINDS,
  type PlexServerSlug,
  type WatchMarkAction,
  type WatchMarkPlexResult,
  type WatchMarkRevertResult,
  type WatchMarkScope,
  type WatchTitleKind,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');
const ACTIONS_SQL_LIST = sqlList(WATCH_MARK_ACTIONS);
const SCOPES_SQL_LIST = sqlList(WATCH_MARK_SCOPES);
const KINDS_SQL_LIST = sqlList(WATCH_TITLE_KINDS);
const PLEX_RESULTS_SQL_LIST = sqlList(WATCH_MARK_PLEX_RESULTS);
const REVERT_RESULTS_SQL_LIST = sqlList(WATCH_MARK_REVERT_RESULTS);

/** One Plex item a `watched` mark actually flipped from unwatched to watched (`flipped`). */
export interface WatchMarkFlip {
  server: PlexServerSlug;
  ratingKey: string;
}

/**
 * ADR-088 / DESIGN-049 D-07 + D-12..D-15 (PLAN-068) — Watch Marks (T-248): the owner's explicit
 * statements, made by voice ("I already watched X", "stop suggesting X", "someone else watched that").
 *
 * - `watched` marks a movie, a show, a season, an episode, or everything `through` an episode, and — owner
 *   ruling 2026-09-23, "Mark it in Plex too" — scrobbles it in Plex. `flipped` records EXACTLY the items
 *   that went from unwatched to watched, so `undo_last_change` unscrobbles precisely those and nothing
 *   the owner (or the children, who share the account) had already watched.
 * - `not_interested` and `not_mine` NEVER touch Plex (`plex_result = 'none'`).
 * - ADR-092 / DESIGN-051 D-07 (migration 0080) — `watchlist_add` / `watchlist_remove`, a Watchlist Change
 *   (T-260): the owner's plex.tv watchlist changed by `set_watchlist` (`scope` = the kind, `plex_guid` =
 *   `plex://<kind>/<discover id>`, `flipped = []`, `plex_result` `pending` → `written` | `failed`). Not a watch
 *   statement: only their own queries read them (the watchlist overlay, undo and its replay guard, the
 *   `set_watchlist` remove pool, the unsettled check; DESIGN-051 D-07).
 *
 * The row carries the resolved identity (`title_key` plus the external ids) so a later re-key of the
 * watch_titles row cannot orphan it. `query` is what was asked, trimmed to 200 characters by the writer.
 * `consumer` names the MCP consumer from config (`hop` in v1), deliberately not a CHECK — a second consumer
 * is a config change (D-03). The rows ARE the audit trail (no permission_audit coupling).
 *
 * Written ONLY by the @hnet/domain mark writers (markWatched / dismissTitle / changeWatchlist / undoLastChange)
 * — guard-listed.
 * Updated only to finalize `plex_result` and to record a revert; never deleted. The only NON-REBUILDABLE
 * table of the five (OPS-015 §7), hence the ON DELETE RESTRICT account FK below.
 */
export const watchMarks = pgTable(
  'watch_marks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /**
     * RESTRICT, not cascade: marks are the one Watch Companion table that cannot be rebuilt from Tautulli or
     * Plex (the owner's corrections and the undo record — OPS-015 §7), so an account delete or
     * delete-and-recreate must fail rather than silently wipe them. Writers never delete watch_accounts.
     */
    plexAccountId: bigint('plex_account_id', { mode: 'number' })
      .notNull()
      .references(() => watchAccounts.plexAccountId, { onDelete: 'restrict' }),
    action: text('action').$type<WatchMarkAction>().notNull(),
    scope: text('scope').$type<WatchMarkScope>().notNull(),
    // The resolved identity (D-13).
    titleKey: text('title_key').notNull(),
    kind: text('kind').$type<WatchTitleKind>().notNull(),
    title: text('title').notNull(),
    year: integer('year'),
    plexGuid: text('plex_guid'),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    imdbId: text('imdb_id'),
    season: integer('season'),
    episode: integer('episode'),
    /** What was asked (≤ 200 characters). */
    query: text('query').notNull(),
    /** The MCP consumer that made the call (`hop`, later `web`). */
    consumer: text('consumer').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The Plex items this mark actually changed — what undo reverses. */
    flipped: jsonb('flipped').$type<WatchMarkFlip[]>().notNull().default([]),
    plexResult: text('plex_result').$type<WatchMarkPlexResult>().notNull(),
    /** The first Plex error, trimmed. */
    plexError: text('plex_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    revertResult: text('revert_result').$type<WatchMarkRevertResult>(),
  },
  (t) => [
    /** undo_last_change: the account's newest unreverted mark; the replay check (D-14 step 7). */
    index('watch_marks_account_created_idx').on(t.plexAccountId, t.createdAt.desc()),
    check('watch_marks_action_enum', sql`${t.action} = ANY (ARRAY[${sql.raw(ACTIONS_SQL_LIST)}])`),
    check('watch_marks_scope_enum', sql`${t.scope} = ANY (ARRAY[${sql.raw(SCOPES_SQL_LIST)}])`),
    check('watch_marks_kind_enum', sql`${t.kind} = ANY (ARRAY[${sql.raw(KINDS_SQL_LIST)}])`),
    check(
      'watch_marks_plex_result_enum',
      sql`${t.plexResult} = ANY (ARRAY[${sql.raw(PLEX_RESULTS_SQL_LIST)}])`,
    ),
    check(
      'watch_marks_revert_result_enum',
      sql`${t.revertResult} IS NULL OR ${t.revertResult} = ANY (ARRAY[${sql.raw(REVERT_RESULTS_SQL_LIST)}])`,
    ),
  ],
);

export type WatchMarkRow = typeof watchMarks.$inferSelect;
export type WatchMarkInsert = typeof watchMarks.$inferInsert;
