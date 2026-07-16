import { pgTable, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * ADR-067 / DESIGN-039 (PLAN-055) — the Google Books quota circuit breaker's SINGLE-ROW state
 * (migration 0057). One row (id='gb') remembering quota exhaustion ACROSS processes (web app +
 * goodreads-sync + format-pairing CronJobs share ONE GB key): a DAILY-quota 429 ("per day" in the
 * body) sets `exhausted_until` to the next 07:00 UTC (GB_DAILY_RESET_UTC_HOUR); a per-minute 429
 * to now + 2 min; any completed GB call clears all three state columns. After expiry exactly ONE
 * consumer probes half-open — `consultGbQuotaGate` claims the probe atomically by extending the
 * window while the probe runs.
 *
 * Written ONLY by the @hnet/domain gb-quota-breaker single-writers (tripGbQuotaBreaker /
 * clearGbQuotaBreaker / consultGbQuotaGate's probe claim), consulted by every GB call site through
 * the ONE guardedGbResolve seam.
 *
 * Derived, rebuildable OPERATIONAL state (the ADR-054 `mam_gate_state` / ADR-040
 * `smart_drive_state` class): the writer appends no ledger/audit/outbox row (quota exhaustion is
 * routine daily weather, self-healing by construction — ADR-067 C-09); its trail is this row + the
 * one-line skip logs + the queued-fix actions_taken steps. The no-direct-state-writes guard covers
 * this table in all six regex families (SQL + Drizzle forms).
 */
export const gbQuotaState = pgTable(
  'gb_quota_state',
  {
    /** Singleton sentinel — always 'gb' (one Google Books key, one breaker). */
    id: text('id').primaryKey().default('gb'),
    /** Non-null and in the future = the breaker is OPEN (GB calls are pointless until then). */
    exhaustedUntil: timestamp('exhausted_until', { withTimezone: true }),
    /** When the current episode tripped; null when clear. */
    trippedAt: timestamp('tripped_at', { withTimezone: true }),
    /** Why it tripped — 'daily' | 'minute' plus optional redacted detail; null when clear. */
    tripReason: text('trip_reason'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('gb_quota_state_singleton', sql`${t.id} = 'gb'`)],
);

export type GbQuotaStateRow = typeof gbQuotaState.$inferSelect;
export type GbQuotaStateInsert = typeof gbQuotaState.$inferInsert;
