import { pgTable, uuid, text, integer, timestamp, check, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ACTIVITY_FAILURE_KINDS, type ActivityFailureKind } from './enums';

const ACTIVITY_FAILURE_KINDS_SQL_LIST = ACTIVITY_FAILURE_KINDS.map((k) => `'${k}'`).join(',');

/**
 * ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the DURABLE import-failure ledger (migration
 * 0048). This is the ONLY persisted Activity state: the tab + wall badges read LIVE per source (ADR-059
 * Q-01 — live poll-through), but a FAILURE must survive a request so it can (a) drive the outbox transition
 * (enqueue once per new failure — R2 / the future admin digest) and (b) give the failure a stable identity
 * for the detail-page URL + the audited Admin action. The mam_gate_state / smart_drive_state class:
 * derived, rebuildable operational state; the writer appends no ledger row of its own — its trail is the
 * outbox rows + the per-action permission_audit rows.
 *
 * One row per OPEN failure keyed by (source, source_ref). Written ONLY by the @hnet/domain
 * `evaluateActivityFailures` single-writer (the `activity-scan` sync mode); a failure that CLEARS is closed
 * (`resolved_at` set) rather than deleted so the detail page and the audit chain survive. The action stamps
 * (`last_action_*`) are written by the audited retry-import / force-research mutations.
 */
export const activityImportFailures = pgTable(
  'activity_import_failures',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The source family the failure came from ('books' in SLICE 1; 'radarr'/'sonarr'/'lidarr'/'kapowarr'
     *  later). NOT a CHECK enum — the fan-out adds sources without a migration. */
    source: text('source').notNull(),
    /** The ActivityKind of the item ('book'|'audiobook'|'comic' in SLICE 1). */
    kind: text('kind').notNull(),
    /** The adapter-owned stable ref for this failure (e.g. the LL bookId + format, or the SAB nzo_id). The
     *  (source, source_ref) pair is the upsert key. Also the ActivityItem.id the live read joins on. */
    sourceRef: text('source_ref').notNull(),
    /** The section that gates the failure detail's VISIBILITY ('books' | null = the universal *arr walls). */
    section: text('section'),
    /** The failure class the UI + actions switch on. */
    failureKind: text('failure_kind').$type<ActivityFailureKind>().notNull(),
    /** The human failure reason (the LL DLResult / "downloaded but never imported" copy). */
    failureReason: text('failure_reason'),
    /** Display facts for the ledger/detail without re-fetching the source. */
    title: text('title').notNull(),
    year: integer('year'),
    /** The user-facing source app the failure came from ('lazylibrarian'|'sabnzbd'|…). */
    sourceApp: text('source_app'),
    /** The downstream operator deep link (LL/SAB/*arr) — Admin-only in the UI. */
    downstreamUrl: text('downstream_url'),
    /** First time this failure was observed (the "stuck since" line). */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Most recent scan that still saw this failure open (staleness / liveness). */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when a scan no longer sees the failure (imported/cleared). Null ⇒ OPEN. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** When the `activity_import_failed` outbox row was enqueued (dedupe — enqueue once per failure). */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    /** The last Admin action stamps (retry-import / force-research). */
    lastActionAt: timestamp('last_action_at', { withTimezone: true }),
    lastActionBy: uuid('last_action_by'),
    lastAction: text('last_action'),
  },
  (t) => [
    uniqueIndex('activity_import_failures_source_ref_idx').on(t.source, t.sourceRef),
    // The tab/detail read: OPEN failures first (resolved_at null), newest strand first.
    index('activity_import_failures_open_idx').on(t.resolvedAt, t.firstSeenAt),
    check(
      'activity_import_failures_kind_enum',
      sql`${t.failureKind} = ANY (ARRAY[${sql.raw(ACTIVITY_FAILURE_KINDS_SQL_LIST)}])`,
    ),
  ],
);

export type ActivityImportFailureRow = typeof activityImportFailures.$inferSelect;
export type ActivityImportFailureInsert = typeof activityImportFailures.$inferInsert;
