import { pgTable, uuid, text, integer, timestamp, jsonb, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { mediaItems } from './media-items';
import { fixRequests, type FixActionEntry } from './fix-requests';
import {
  FIX_REASONS,
  REPAIR_REQUEST_KINDS,
  REPAIR_REQUEST_SCOPES,
  REPAIR_REQUEST_STATUSES,
  type FixReason,
  type RepairRequestKind,
  type RepairRequestScope,
  type RepairRequestStatus,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * ADR-109 C-04 / DESIGN-055 D-02 (PLAN-077 P2, migration 0099) — Repair Requests (T-302): the audited record of one
 * remedy a person confirmed in the Repair Guide. BC-03, like fix_requests: the row is the audit (no permission_audit
 * coupling), it commits with its `repair_requested` ledger event BEFORE any *arr call, and only the
 * packages/domain/src/repair-requests.ts single writer changes it (the no-direct-state-writes guard).
 *
 * `preview` holds exactly what the person was shown and confirmed; `actions_taken` every call made, in the
 * FixActionEntry shape (actionsTaken[0] is the requester snapshot, so the row outlives the user). `season_number` is
 * the season of the target (null for a movie); `target_child_ids` the episode ids the remedy acts on.
 */
export const repairRequests = pgTable(
  'repair_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requesterId: uuid('requester_id').references(() => users.id, { onDelete: 'set null' }),
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'restrict' }),
    kind: text('kind').$type<RepairRequestKind>().notNull(),
    scope: text('scope').$type<RepairRequestScope>().notNull(),
    seasonNumber: integer('season_number'),
    targetChildIds: integer('target_child_ids').array().notNull().default(sql`'{}'::integer[]`),
    targetLabel: text('target_label'),
    /** A FIX_REASONS value when the guide started from Fix; null from Force Search. */
    reason: text('reason').$type<FixReason>(),
    preview: jsonb('preview').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').$type<RepairRequestStatus>().notNull().default('pending'),
    actionsTaken: jsonb('actions_taken').$type<FixActionEntry[]>().notNull().default([]),
    /**
     * The open Seerr issue the request answers: set (PLAN-077 P7) only when the guide was opened from that issue's report
     * on the same title, validated by the writer; its completion lets the bridge resolve the issue. Null otherwise.
     */
    seerrIssueId: integer('seerr_issue_id'),
    /** The classic Fix the guide ended in, when it did. */
    fixRequestId: uuid('fix_request_id').references(() => fixRequests.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    check('repair_requests_kind_enum', sql`${t.kind} = ANY (ARRAY[${sql.raw(sqlList(REPAIR_REQUEST_KINDS))}])`),
    check('repair_requests_scope_enum', sql`${t.scope} = ANY (ARRAY[${sql.raw(sqlList(REPAIR_REQUEST_SCOPES))}])`),
    check(
      'repair_requests_status_enum',
      sql`${t.status} = ANY (ARRAY[${sql.raw(sqlList(REPAIR_REQUEST_STATUSES))}])`,
    ),
    check(
      'repair_requests_reason_enum',
      sql`${t.reason} IS NULL OR ${t.reason} = ANY (ARRAY[${sql.raw(sqlList(FIX_REASONS))}])`,
    ),
    // A season or an episode names its season; a movie names none.
    check(
      'repair_requests_season_iff_tv',
      sql`(${t.scope} = 'item' AND ${t.seasonNumber} IS NULL) OR (${t.scope} <> 'item' AND ${t.seasonNumber} IS NOT NULL)`,
    ),
    index('repair_requests_requester_created_idx').on(t.requesterId, t.createdAt.desc()),
    index('repair_requests_item_idx').on(t.mediaItemId),
    index('repair_requests_status_idx').on(t.status),
    index('repair_requests_seerr_issue_idx').on(t.seerrIssueId).where(sql`${t.seerrIssueId} IS NOT NULL`),
  ],
);

export type RepairRequestRow = typeof repairRequests.$inferSelect;
export type RepairRequestInsert = typeof repairRequests.$inferInsert;
