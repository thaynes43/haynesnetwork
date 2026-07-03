import { pgTable, uuid, text, integer, timestamp, jsonb, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { mediaItems } from './media-items';
import {
  FIX_REASONS,
  FIX_STATUSES,
  FIX_PATHS,
  type FixReason,
  type FixStatus,
  type FixPath,
} from './enums';
import { ledgerEvents } from './ledger-events';

const FIX_REASONS_SQL_LIST = FIX_REASONS.map((r) => `'${r}'`).join(',');
const FIX_STATUSES_SQL_LIST = FIX_STATUSES.map((s) => `'${s}'`).join(',');
const FIX_PATHS_SQL_LIST = FIX_PATHS.map((p) => `'${p}'`).join(',');

/**
 * One ordered step in fix_requests.actions_taken (D-09) — raw *arr responses included
 * (AC-07): {step: 'resolve_grab'|'mark_failed'|'delete_file'|'trigger_search',
 * endpoint, ok, status, response, at}. actionsTaken[0] is the creation snapshot
 * ({step: 'created', requester: {email, displayName}}) so the audit-grade row outlives
 * the requester.
 */
export interface FixActionEntry {
  step: string;
  at: string; // ISO timestamp
  [key: string]: unknown;
}

/**
 * DESIGN-005 D-09 — Fix requests (ADR-007 mark-failed + search semantics, R-45..R-47).
 * Rows are the BC-03 audit record (D-12 — permission_audit is NOT extended); status
 * transitions happen only via the packages/domain writers (Fix Lifecycle, DDD-001
 * T-43): pending → actioned → search_triggered → completed, any *arr failure → failed.
 */
export const fixRequests = pgTable(
  'fix_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterId: uuid('requester_id').references(() => users.id, { onDelete: 'set null' }),
    // audit-grade row: outlives the user; requester email/displayName snapshotted in actionsTaken[0]
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'restrict' }),
    // RESTRICT: fix history must not silently vanish; media_items rows tombstone, never delete (D-05)
    targetArrChildId: integer('target_arr_child_id'), // episode id (sonarr) / album id (lidarr); NULL for radarr
    targetLabel: text('target_label'), // e.g. 'S06E02 · Rich' / album title — display-durable
    reason: text('reason').$type<FixReason>().notNull(),
    reasonText: text('reason_text'),
    status: text('status').$type<FixStatus>().notNull().default('pending'),
    pathTaken: text('path_taken').$type<FixPath>(), // null until actioned
    actionsTaken: jsonb('actions_taken').$type<FixActionEntry[]>().notNull().default([]),
    completedEventId: uuid('completed_event_id').references(() => ledgerEvents.id, {
      onDelete: 'set null',
    }),
    // the observed replacement-import event that closed the loop (ADR-007 C-06)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'fix_requests_reason_enum',
      sql`${t.reason} = ANY (ARRAY[${sql.raw(FIX_REASONS_SQL_LIST)}])`,
    ),
    check(
      'fix_requests_status_enum',
      sql`${t.status} = ANY (ARRAY[${sql.raw(FIX_STATUSES_SQL_LIST)}])`,
    ),
    check(
      'fix_requests_path_enum',
      sql`${t.pathTaken} IS NULL OR ${t.pathTaken} = ANY (ARRAY[${sql.raw(FIX_PATHS_SQL_LIST)}])`,
    ),
    // reason_text required IFF reason = 'other' (R-45): free text rides only on 'other'
    check(
      'fix_requests_reason_text_iff_other',
      sql`
      (${t.reason} = 'other' AND ${t.reasonText} IS NOT NULL AND btrim(${t.reasonText}) <> '')
      OR (${t.reason} <> 'other' AND ${t.reasonText} IS NULL)`,
    ),
    index('fix_requests_requester_created_idx').on(t.requesterId, t.createdAt.desc()),
    index('fix_requests_item_idx').on(t.mediaItemId),
    index('fix_requests_status_idx').on(t.status),
  ],
);

export type FixRequestRow = typeof fixRequests.$inferSelect;
export type FixRequestInsert = typeof fixRequests.$inferInsert;
