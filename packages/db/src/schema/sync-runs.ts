import { pgTable, uuid, text, timestamp, jsonb, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  SYNC_SOURCES,
  SYNC_RUN_KINDS,
  SYNC_RUN_STATUSES,
  type SyncSource,
  type SyncRunKind,
  type SyncRunStatus,
} from './enums';

const SYNC_SOURCES_SQL_LIST = SYNC_SOURCES.map((s) => `'${s}'`).join(',');
const SYNC_RUN_KINDS_SQL_LIST = SYNC_RUN_KINDS.map((k) => `'${k}'`).join(',');
const SYNC_RUN_STATUSES_SQL_LIST = SYNC_RUN_STATUSES.map((s) => `'${s}'`).join(',');

/**
 * DESIGN-005 D-11 — sync observability (DDD-001 T-37): one append-only row per run,
 * never updated after finish. The mass-tombstone guard abort (D-14) lands here as
 * status = 'aborted' with the reason in `error`. Written only by startSyncRun /
 * finishSyncRun in packages/domain (D-12).
 */
export const syncRuns = pgTable(
  'sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').$type<SyncSource>().notNull(),
    runKind: text('run_kind').$type<SyncRunKind>().notNull(),
    status: text('status').$type<SyncRunStatus>().notNull().default('running'),
    stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
    // {itemsSeen, upserted, tombstoned, eventsIngested, requestsMatched, …}
    error: text('error'), // incl. the mass-tombstone abort reason
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    check(
      'sync_runs_source_enum',
      sql`${t.source} = ANY (ARRAY[${sql.raw(SYNC_SOURCES_SQL_LIST)}])`,
    ),
    check(
      'sync_runs_run_kind_enum',
      sql`${t.runKind} = ANY (ARRAY[${sql.raw(SYNC_RUN_KINDS_SQL_LIST)}])`,
    ),
    check(
      'sync_runs_status_enum',
      sql`${t.status} = ANY (ARRAY[${sql.raw(SYNC_RUN_STATUSES_SQL_LIST)}])`,
    ),
  ],
);

export type SyncRunRow = typeof syncRuns.$inferSelect;
export type SyncRunInsert = typeof syncRuns.$inferInsert;
