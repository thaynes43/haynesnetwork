import { pgTable, text, integer, boolean, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * ADR-054 / DESIGN-027 (PLAN-039) — the MAM compliance governor's SINGLE-ROW gate state (migration 0041).
 * One row (id='mam') recording the governor's last decision: whether the LazyLibrarian MAM Torznab
 * provider is currently OPEN (grabs flow) or PAUSED (near the rank cap), plus the counts + limit/buffer
 * that drove it and the zero-headroom-stuck bookkeeping.
 *
 * Written ONLY by the @hnet/domain `evaluateMamGovernor` single-writer: it (idempotently) actuates the LL
 * provider toggle, then in ONE transaction upserts this row AND — on a gate TRANSITION (open→paused /
 * paused→open) or a >48h zero-headroom episode — enqueues one `notification_outbox` row (the durable
 * transition record — CLAUDE.md hard rule 6; same-tx pattern as evaluateSmartAlerts). FIRST sight
 * (no row) records a BASELINE and pages nothing, so a deploy at 13/15 headroom writes state without a page.
 *
 * Derived, rebuildable OPERATIONAL state (the ADR-035 `trash_candidates_state` / ADR-040
 * `smart_drive_state` class): the writer appends no ledger/audit row of its own — its audit trail IS the
 * outbox rows + the gate transition history in the logs. The no-direct-state-writes guard covers this
 * table (both SQL + Drizzle forms).
 */
export const mamGateState = pgTable(
  'mam_gate_state',
  {
    /** Singleton sentinel — always 'mam' (one MAM provider, one gate). */
    id: text('id').primaryKey().default('mam'),
    /** true = the LL MAM provider is ENABLED (grabs flow); false = PAUSED (near/over the cap or fail-closed). */
    gateOpen: boolean('gate_open').notNull(),
    /** false = the last qBittorrent count FAILED — the run treated the account as at-cap (fail-closed). */
    countOk: boolean('count_ok').notNull(),
    /** downloading + seedingUnder72 — the unsatisfied count the gate is decided against. */
    unsatisfiedCount: integer('unsatisfied_count').notNull(),
    /** Still-downloading (progress < 1) torrents in the counted category. */
    downloadingCount: integer('downloading_count').notNull(),
    /** Complete-but-<72h-seeded torrents in the counted category. */
    seedingUnder72Count: integer('seeding_under72_count').notNull(),
    /** The MAM unsatisfied-torrent LIMIT in effect this run (New Member 20 → …). */
    limitValue: integer('limit_value').notNull(),
    /** The safety BUFFER in effect (gate closes at limit − buffer). */
    bufferValue: integer('buffer_value').notNull(),
    /** limit − buffer — the count at/above which the gate closes. */
    threshold: integer('threshold').notNull(),
    /** max(0, limit − unsatisfied) — remaining slots under the hard cap. */
    headroom: integer('headroom').notNull(),
    /** When headroom first hit 0 (unsatisfied ≥ limit); null while headroom > 0. Drives the >48h stuck alert. */
    zeroHeadroomSince: timestamp('zero_headroom_since', { withTimezone: true }),
    /** When the >48h zero-headroom "stuck" alert was last enqueued (dedupe within one stuck episode). */
    pinnedAlertedAt: timestamp('pinned_alerted_at', { withTimezone: true }),
    /** The last transition event enqueued ('mam_gate_paused' | 'mam_gate_resumed' | 'mam_gate_stuck' | null). */
    lastEventType: text('last_event_type'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('mam_gate_state_singleton', sql`${t.id} = 'mam'`)],
);

export type MamGateStateRow = typeof mamGateState.$inferSelect;
export type MamGateStateInsert = typeof mamGateState.$inferInsert;
