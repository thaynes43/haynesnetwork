import { pgTable, uuid, text, integer, timestamp, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { mediaItems } from './media-items';
import { repairRequests } from './repair-requests';
import {
  MISLABEL_TERM_KINDS,
  MISLABEL_TERM_ORIGINS,
  MISLABEL_TERM_STATES,
  type MislabelTermKind,
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
 *
 * ADR-113 / DESIGN-055 Q-10 ruling (migration 0102) — a term also names a MISLABELLED NAME instead of a group: `kind`
 * `pair` (`S01E11 Secret Menu`), `double` (`S01E13E14`) or `alias` (an alternate title of the series), with
 * `name_token` its display text and `release_group` null. A group term has `kind` `group`, its group, and no
 * `name_token`. A name term comes only from staff (`origin` `staff`, the in-cluster tool) or the adoption; a group term
 * only from a confirmed re-map or the adoption. One live term per (series, kind, group or name token).
 */
export const mislabelBlockTerms = pgTable(
  'mislabel_block_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instance: text('instance').notNull().default('sonarr'),
    seriesId: integer('series_id').notNull(),
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    seriesTitle: text('series_title').notNull(),
    kind: text('kind').$type<MislabelTermKind>().notNull().default('group'),
    /** The release group (kind `group`); null for a mislabelled-name term. */
    releaseGroup: text('release_group'),
    /** A mislabelled name's display text (kinds `pair`, `double`, `alias`); null for a group term. */
    nameToken: text('name_token'),
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
    check('mislabel_block_terms_kind_enum', sql`${t.kind} = ANY (ARRAY[${sql.raw(sqlList(MISLABEL_TERM_KINDS))}])`),
    // A group term names its group and no name; a name term names its name and no group.
    check(
      'mislabel_block_terms_kind_fields',
      sql`(${t.kind} = 'group' AND ${t.releaseGroup} IS NOT NULL AND ${t.nameToken} IS NULL) OR (${t.kind} <> 'group' AND ${t.releaseGroup} IS NULL AND ${t.nameToken} IS NOT NULL)`,
    ),
    // ADR-113: a group term comes from a re-map or the adoption, a name term from staff or the adoption.
    check(
      'mislabel_block_terms_kind_origin',
      sql`(${t.kind} = 'group' AND ${t.origin} IN ('remap','adoption')) OR (${t.kind} <> 'group' AND ${t.origin} IN ('staff','adoption'))`,
    ),
    // One live term per (series, kind, group or name token).
    uniqueIndex('mislabel_block_terms_active_uq')
      .on(t.instance, t.seriesId, t.kind, sql`lower(coalesce(${t.releaseGroup}, ${t.nameToken}))`)
      .where(sql`${t.state} = 'active'`),
    index('mislabel_block_terms_state_idx').on(t.state, t.expiresAt),
    index('mislabel_block_terms_series_idx').on(t.seriesId),
  ],
);

export type MislabelBlockTermRow = typeof mislabelBlockTerms.$inferSelect;
export type MislabelBlockTermInsert = typeof mislabelBlockTerms.$inferInsert;
