import { pgTable, uuid, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { SYNC_SOURCES, type SyncSource } from './enums';

const SYNC_SOURCES_SQL_LIST = SYNC_SOURCES.map((s) => `'${s}'`).join(',');

/**
 * DESIGN-005 D-11 — the cursor of record: one row per source (DDD-001 T-42 Sync
 * Cursor), advanced in the SAME transaction as each committed ingestion batch — a
 * crash never re-processes committed events (and re-delivery is harmless anyway via
 * the D-07 dedupe unique index). Written only by the packages/domain sync writers
 * (D-12).
 */
export const syncState = pgTable(
  'sync_state',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').$type<SyncSource>().notNull().unique(),
    historyCursor: timestamp('history_cursor', { withTimezone: true }), // max ingested history `date` / Seerr `createdAt`
    lastFullSyncAt: timestamp('last_full_sync_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'sync_state_source_enum',
      sql`${t.source} = ANY (ARRAY[${sql.raw(SYNC_SOURCES_SQL_LIST)}])`,
    ),
  ],
);

export type SyncStateRow = typeof syncState.$inferSelect;
export type SyncStateInsert = typeof syncState.$inferInsert;
