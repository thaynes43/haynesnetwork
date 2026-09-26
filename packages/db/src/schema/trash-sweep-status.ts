import { pgTable, smallint, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { TRASH_SWEEP_OUTCOMES, type TrashSweepOutcome } from './enums';

const OUTCOMES_SQL_LIST = TRASH_SWEEP_OUTCOMES.map((o) => `'${o}'`).join(',');

/**
 * ADR-093 C-16 / DESIGN-052 D-05 / D-14 (PLAN-072, migration 0081) — the ONE-ROW record of how the scheduled sweep of
 * a due batch last ended. Written only when at least one batch was due, by the scheduled sweep only (the web
 * Expire now never writes it). `paused_since` is set on the first non-ok outcome and cleared by the next ok one; the
 * Trash page's paused banner and the Loki page read it once it is 6 hours old (D-10, D-21). `last_reason` is a reason
 * CODE (`stale`, `account_unverified`, `validate`, `read_back`, `duplicate_profile`, …), never a message.
 *
 * Written ONLY by the @hnet/domain trash-batches sweep (the no-direct-state-writes guard covers it).
 */
export const trashSweepStatus = pgTable(
  'trash_sweep_status',
  {
    id: smallint('id').primaryKey(),
    lastOutcome: text('last_outcome').$type<TrashSweepOutcome>().notNull(),
    lastReason: text('last_reason'),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull(),
    pausedSince: timestamp('paused_since', { withTimezone: true }),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  },
  (t) => [
    check('trash_sweep_status_singleton', sql`${t.id} = 1`),
    check(
      'trash_sweep_status_outcome_enum',
      sql`${t.lastOutcome} = ANY (ARRAY[${sql.raw(OUTCOMES_SQL_LIST)}])`,
    ),
  ],
);

export type TrashSweepStatusRow = typeof trashSweepStatus.$inferSelect;
