import { pgTable, text, integer, date, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * ADR-067 / DESIGN-039 (PLAN-055 amend — D-21..D-24) — the daily Google Books CALL BUDGET ledger
 * (migration 0070). The sibling of gb_quota_state: where the breaker remembers a real 429, THIS row
 * remembers how many first-party GB HTTP calls the estate has already spent against the CURRENT
 * quota-day so its own consumers (format-pairing resolve, goodreads enrichment, book Fix) stay inside
 * the shared key's LOW per-day cap forever, unattended — pacing us so we never REACH a daily 429.
 *
 * ONE row (id='gb'): `quota_day` is the date of the GB_DAILY_RESET_UTC_HOUR boundary (default 07:00
 * UTC) the counts belong to; `*_calls` are per-consumer running tallies. The single-writer's upsert
 * rolls the counters to 0 when the stored `quota_day` is stale (a new quota-day started), so the row
 * is self-resetting and needs no cron. Every outbound GB call is counted in the shared http wrapper
 * (an injected onCall meter), attributed to its consumer at the resolve seam, and persisted here.
 *
 * Written ONLY by the @hnet/domain gb-call-budget single-writer (recordGbCalls). Derived, rebuildable
 * OPERATIONAL state (the gb_quota_state / mam_gate_state class): the writer appends no ledger/audit/
 * outbox row (routine daily weather, self-healing on the day roll — ADR-067 C-09); its trail is this
 * row + the runs' one-line skippedBudget logs. Guarded in all six no-direct-state-writes families.
 */
export const gbCallBudget = pgTable(
  'gb_call_budget',
  {
    /** Singleton sentinel — always 'gb' (one Google Books key, one budget). */
    id: text('id').primaryKey().default('gb'),
    /** The date of the reset boundary (GB_DAILY_RESET_UTC_HOUR) the tallies below belong to. */
    quotaDay: date('quota_day').notNull(),
    /** format-pairing resolve GB calls spent this quota-day. */
    pairingCalls: integer('pairing_calls').notNull().default(0),
    /** goodreads-sync enrichment GB calls spent this quota-day. */
    goodreadsCalls: integer('goodreads_calls').notNull().default(0),
    /** book Fix (interactive + the queued-fix retry pass) GB calls spent this quota-day. */
    bookfixCalls: integer('bookfix_calls').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('gb_call_budget_singleton', sql`${t.id} = 'gb'`)],
);

export type GbCallBudgetRow = typeof gbCallBudget.$inferSelect;
export type GbCallBudgetInsert = typeof gbCallBudget.$inferInsert;
