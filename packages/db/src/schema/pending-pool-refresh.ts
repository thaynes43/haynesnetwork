import { pgTable, text, timestamp, uuid, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { TRASH_MEDIA_KINDS, type TrashMediaKind } from './enums';

const TRASH_MEDIA_KINDS_SQL_LIST = TRASH_MEDIA_KINDS.map((k) => `'${k}'`).join(',');

/**
 * DESIGN-010/014 amendment (2026-07-09, build D) — the DEBOUNCED pool-refresh marker. When
 * `pool_refresh_after_save` is on, a save/un-save on a pending wall upserts one row per kind with a
 * FUTURE `due_at` (= now + delayMinutes) — a trailing debounce (each save pushes `due_at` out, so a
 * burst coalesces to one run `delayMinutes` after the LAST save). Two triggers drain it:
 *   - an in-process timer in the web pod (fast path; lost on restart), and
 *   - the incremental sync post-step (crash-safe BACKSTOP: any `due_at <= now` marker fires there).
 * Draining = POST /api/rules/execute (re-evaluate the rules → excluded/shielded items leave the
 * collection) then DELETE the drained rows. Written ONLY by the @hnet/domain pool-refresh single
 * writer. Ephemeral, derived state — no ledger audit row (the setting change is the audited event;
 * the marker is just a due-timer). `requested_by` attributes the last save that (re)armed it.
 */
export const pendingPoolRefresh = pgTable(
  'pending_pool_refresh',
  {
    /** One marker per batchable kind ('movie'|'tv'). */
    mediaKind: text('media_kind').$type<TrashMediaKind>().primaryKey(),
    /** When the debounced rule re-execution becomes due (now + delayMinutes; pushed out on each save). */
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    /** When this marker was last (re)armed. */
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    /** The user whose save last (re)armed it (best-effort attribution; null after the user is deleted). */
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [
    check(
      'pending_pool_refresh_kind_check',
      sql.raw(`media_kind IN (${TRASH_MEDIA_KINDS_SQL_LIST})`),
    ),
    // The backstop scans `due_at <= now` every incremental tick.
    index('pending_pool_refresh_due_idx').on(t.dueAt),
  ],
);

export type PendingPoolRefreshRow = typeof pendingPoolRefresh.$inferSelect;
export type NewPendingPoolRefreshRow = typeof pendingPoolRefresh.$inferInsert;
