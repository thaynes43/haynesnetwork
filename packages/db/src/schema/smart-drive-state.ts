import { pgTable, text, integer, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * ADR-040 / DESIGN-020 D-08 (PLAN-019) — the per-drive LAST-KNOWN SMART state, the substrate the
 * `smart-alerts` sync mode diffs against to detect a "transition since the last check" (migration
 * 0033). One row per SMART device, keyed by `drive_key` = `instance/device` (unique across the two
 * smartctl jobs — the in-cluster DaemonSet and the NAS `role=nas` scrape).
 *
 * Written ONLY by the @hnet/domain `evaluateSmartAlerts` single-writer: on a CRITICAL transition it
 * enqueues one `notification_outbox` row AND upserts this row in the SAME transaction (the outbox row
 * is the durable transition record — CLAUDE.md hard rule 6). FIRST sight of a drive records its state
 * as a BASELINE and enqueues nothing — so the known expendable-staging-pool bad state (wear 100,
 * `critical_warning` bit 2, FAILED) is recorded, not paged; only NEW deterioration pages.
 *
 * Derived, rebuildable OPERATIONAL state (the ADR-035 `trash_candidates_state` class): the writer
 * appends no ledger/audit row of its own — its audit trail IS the outbox rows. The no-direct-state-
 * writes guard covers this table (both SQL + Drizzle forms).
 */
export const smartDriveState = pgTable(
  'smart_drive_state',
  {
    /** `instance/device` — unique across both smartctl jobs (e.g. `haynestower/nvme1`, `10.42.0.244:9633/nvme0n1`). */
    driveKey: text('drive_key').primaryKey(),
    /** A human label for the push copy (model + short serial, or the drive key). */
    label: text('label'),
    /** Curated NVMe pool this drive belongs to ('Cache-apps' | 'Cache-staging'), else null. */
    pool: text('pool'),
    /** Last-known SMART overall health: 'pass' (smart_status=1) | 'fail' (smart_status=0). */
    smartStatus: text('smart_status').notNull(),
    /** Last-known wear indicator (`smartctl_device_percentage_used`; 0..100+, can exceed 100). */
    wearPct: integer('wear_pct').notNull(),
    /** Last-known lifetime media/uncorrectable error count (any nonzero = start decom). */
    mediaErrors: integer('media_errors').notNull(),
    /** Last-known available spare (%). */
    availableSpare: integer('available_spare').notNull(),
    /** Last-known NVMe critical_warning BITMASK (bit 2 = value 4 = NVM subsystem reliability degraded). */
    criticalWarning: integer('critical_warning').notNull(),
    /** The last transition event enqueued for this drive ('smart_degraded'|'smart_recovered'|null). */
    lastEventType: text('last_event_type'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('smart_drive_state_status_check', sql`${t.smartStatus} = ANY (ARRAY['pass','fail'])`),
  ],
);

export type SmartDriveStateRow = typeof smartDriveState.$inferSelect;
export type SmartDriveStateInsert = typeof smartDriveState.$inferInsert;
