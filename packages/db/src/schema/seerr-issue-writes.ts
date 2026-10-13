import { pgTable, uuid, integer, text, timestamp, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { seerrIssues } from './seerr-issues';
import { repairRequests } from './repair-requests';
import { fixRequests } from './fix-requests';
import {
  SEERR_ISSUE_WRITE_KINDS,
  SEERR_ISSUE_WRITE_STATES,
  type SeerrIssueWriteKind,
  type SeerrIssueWriteState,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7, migration 0105) — the Seerr Issue bridge's writes: one row per issue and
 * kind, ever (the unique index), so an issue gets at most one fix-it-yourself comment and one resolve. The row is the
 * audit (BC-05, the repair_requests pattern): it commits as `intended` BEFORE the Seerr call and is completed after it,
 * so a crash, a retry or a webhook arriving beside the sync never posts twice; a stale `intended` row is reconciled
 * against the issue's own comments before anything is sent again. `seerr_user_id` is the bridge user the write posted
 * as (`X-API-User`); `seerr_comment_id` the comment Seerr stored. A resolve names the completed Repair Request or Fix
 * that earned it. Only the packages/domain/src/seerr-issue-writes.ts single writer changes a row (the
 * no-direct-state-writes guard).
 */
export const seerrIssueWrites = pgTable(
  'seerr_issue_writes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seerrIssueId: integer('seerr_issue_id')
      .notNull()
      .references(() => seerrIssues.seerrIssueId, { onDelete: 'restrict' }),
    kind: text('kind').$type<SeerrIssueWriteKind>().notNull(),
    state: text('state').$type<SeerrIssueWriteState>().notNull().default('intended'),
    /** Exactly the text posted (the comment, or the resolve's outcome note). */
    body: text('body').notNull(),
    /** The Seerr bridge user the write posts as (`X-API-User`). */
    seerrUserId: integer('seerr_user_id').notNull(),
    /** The comment Seerr stored for this write, once known. */
    seerrCommentId: integer('seerr_comment_id'),
    /** A resolve: the completed Repair Request or Fix that earned it. */
    repairRequestId: uuid('repair_request_id').references(() => repairRequests.id, { onDelete: 'set null' }),
    fixRequestId: uuid('fix_request_id').references(() => fixRequests.id, { onDelete: 'set null' }),
    attempts: integer('attempts').notNull().default(1),
    lastError: text('last_error'),
    /** `skipped`: why (Seerr had resolved or deleted the issue first). */
    skipReason: text('skip_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp('done_at', { withTimezone: true }),
  },
  (t) => [
    check('seerr_issue_writes_kind_enum', sql`${t.kind} = ANY (ARRAY[${sql.raw(sqlList(SEERR_ISSUE_WRITE_KINDS))}])`),
    check('seerr_issue_writes_state_enum', sql`${t.state} = ANY (ARRAY[${sql.raw(sqlList(SEERR_ISSUE_WRITE_STATES))}])`),
    // The bridge never posts as Seerr user 1, the owner's admin account (Q-02 ruling).
    check('seerr_issue_writes_not_owner', sql`${t.seerrUserId} > 1`),
    check('seerr_issue_writes_done_at_iff_done', sql`(${t.state} = 'done') = (${t.doneAt} IS NOT NULL)`),
    uniqueIndex('seerr_issue_writes_issue_kind_uq').on(t.seerrIssueId, t.kind),
    index('seerr_issue_writes_state_idx').on(t.state),
  ],
);

export type SeerrIssueWriteRow = typeof seerrIssueWrites.$inferSelect;
export type SeerrIssueWriteInsert = typeof seerrIssueWrites.$inferInsert;
