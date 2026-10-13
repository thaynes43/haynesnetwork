import { pgTable, uuid, text, integer, timestamp, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { mediaItems } from './media-items';
import { repairRequests } from './repair-requests';
import {
  MISLABEL_TERM_ORIGINS,
  MISLABEL_TERM_STATES,
  type MislabelTermOrigin,
  type MislabelTermState,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * ADR-110 C-04, C-05 / DESIGN-055 D-05 (PLAN-077 P4, migration 0101) — the Mislabel Block's terms (T-310): one row per
 * (series, release group) a person confirmed mis-numbers that series. The term is the "must not contain" regex written
 * into the one app-owned Sonarr release profile ("haynesnetwork: mislabelled releases (managed, do not edit)"): the
 * series title and the group, so it is series-scoped by its own text and needs no tags. A row is inserted only in the
 * transaction of the profile write and its read-back (a row exists only for a term Sonarr confirmed); it lives 365 days
 * (`expires_at`), at most 500 are active, and it ends `expired` (the hourly upkeep) or `removed` (staff, or a write
 * that could not be read back). `repair_request_id` is the confirmed Episode Re-map that offered it (null for the
 * adoption of Case A's hand-made profile). Only the packages/domain/src/mislabel-block.ts single writer changes a row
 * (the no-direct-state-writes guard).
 */
export const mislabelBlockTerms = pgTable(
  'mislabel_block_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instance: text('instance').notNull().default('sonarr'),
    seriesId: integer('series_id').notNull(),
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    seriesTitle: text('series_title').notNull(),
    releaseGroup: text('release_group').notNull(),
    term: text('term').notNull(),
    state: text('state').$type<MislabelTermState>().notNull().default('active'),
    origin: text('origin').$type<MislabelTermOrigin>().notNull(),
    repairRequestId: uuid('repair_request_id').references(() => repairRequests.id, { onDelete: 'set null' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedReason: text('ended_reason'),
  },
  (t) => [
    check('mislabel_block_terms_instance_enum', sql`${t.instance} = 'sonarr'`),
    check('mislabel_block_terms_state_enum', sql`${t.state} = ANY (ARRAY[${sql.raw(sqlList(MISLABEL_TERM_STATES))}])`),
    check('mislabel_block_terms_origin_enum', sql`${t.origin} = ANY (ARRAY[${sql.raw(sqlList(MISLABEL_TERM_ORIGINS))}])`),
    check(
      'mislabel_block_terms_ended_iff_inactive',
      sql`(${t.state} = 'active') = (${t.endedAt} IS NULL)`,
    ),
    // One live term per (series, group).
    uniqueIndex('mislabel_block_terms_active_uq')
      .on(t.instance, t.seriesId, sql`lower(${t.releaseGroup})`)
      .where(sql`${t.state} = 'active'`),
    index('mislabel_block_terms_state_idx').on(t.state, t.expiresAt),
    index('mislabel_block_terms_series_idx').on(t.seriesId),
  ],
);

export type MislabelBlockTermRow = typeof mislabelBlockTerms.$inferSelect;
export type MislabelBlockTermInsert = typeof mislabelBlockTerms.$inferInsert;
