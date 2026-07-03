import { pgTable, uuid, text, integer, timestamp, jsonb, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { ARR_KINDS, RESTORE_RUN_STATUSES, type ArrKind, type RestoreRunStatus } from './enums';

const ARR_KINDS_SQL_LIST = ARR_KINDS.map((k) => `'${k}'`).join(',');
const RESTORE_STATUSES_SQL_LIST = RESTORE_RUN_STATUSES.map((s) => `'${s}'`).join(',');

/** One approved-preview entry (D-16 step 2 input; the exact diff the admin approved). */
export interface RestorePreviewItem {
  mediaItemId: string;
  title: string;
  [key: string]: unknown; // externalId, year, qualityProfileName, rootFolder, arrTags, tombstonedAt?, …
}

/** One per-item execution result appended as each *arr POST returns (AC-09 report). */
export interface RestoreResultItem {
  mediaItemId: string;
  ok: boolean;
  at: string; // ISO timestamp
  newArrItemId?: number;
  error?: string;
  [key: string]: unknown;
}

/**
 * DESIGN-005 D-10 — the durable record of every Restore execution (R-52 audit +
 * AC-09 report). Rows are the BC-03 audit record (D-12); written only by the
 * packages/domain restore writers.
 */
export const restoreRuns = pgTable(
  'restore_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    arrKind: text('arr_kind').$type<ArrKind>().notNull(),
    arrInstanceId: text('arr_instance_id').notNull(),
    initiatedBy: uuid('initiated_by').references(() => users.id, { onDelete: 'set null' }), // admin (snapshot in preview)
    status: text('status').$type<RestoreRunStatus>().notNull().default('running'),
    preview: jsonb('preview').$type<RestorePreviewItem[]>().notNull(), // the exact diff the admin approved
    results: jsonb('results').$type<RestoreResultItem[]>().notNull().default([]),
    itemCount: integer('item_count').notNull(),
    successCount: integer('success_count').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'restore_runs_arr_kind_enum',
      sql`${t.arrKind} = ANY (ARRAY[${sql.raw(ARR_KINDS_SQL_LIST)}])`,
    ),
    check(
      'restore_runs_status_enum',
      sql`${t.status} = ANY (ARRAY[${sql.raw(RESTORE_STATUSES_SQL_LIST)}])`,
    ),
    index('restore_runs_started_idx').on(t.startedAt.desc()),
  ],
);

export type RestoreRunRow = typeof restoreRuns.$inferSelect;
export type RestoreRunInsert = typeof restoreRuns.$inferInsert;
