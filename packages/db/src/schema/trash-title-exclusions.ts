import { pgTable, uuid, text, integer, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { mediaItems } from './media-items';
import { trashBatchItems } from './trash-batch-items';
import {
  TITLE_EXCLUSION_ARR_KINDS,
  TITLE_EXCLUSION_ORIGINS,
  type TitleExclusionArrKind,
  type TitleExclusionOrigin,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');

/**
 * ADR-097 / DESIGN-052 D-27 (migration 0087) — the TITLE EXCLUSION audit (T-274): one append-only row per import-list
 * exclusion the app wrote on Radarr (by tmdb id) or Sonarr (by tvdb id) for a title Trash is about to delete, or
 * deleted before the app wrote them (the backfill, D-28). An exclusion stops Kometa and the *arr's own import lists
 * from adding the title again; a person's Seerr request still can (the owner's ruling of 2026-10-03).
 *
 * The row is inserted, in the writer's transaction, as soon as the *arr acknowledges the `POST` (`arr_exclusion_id` is
 * the id its 201 answer returned); a later failure in the same call (another POST, the read-back) still commits it, so
 * every exclusion the app wrote keeps its row. A title the *arr already excluded
 * (Maintainerr's own `listExclusions`, or an earlier run) gets no write and no row. Nothing updates or deletes a row.
 * `ensureTitleExclusions` (@hnet/domain `title-exclusion.ts`) is the SOLE writer (the no-direct-state-writes guard
 * covers this table).
 */
export const trashTitleExclusions = pgTable(
  'trash_title_exclusions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    arrKind: text('arr_kind').$type<TitleExclusionArrKind>().notNull(),
    /** Radarr's key (set for every radarr row). */
    tmdbId: integer('tmdb_id'),
    /** Sonarr's key (set for every sonarr row). */
    tvdbId: integer('tvdb_id'),
    /** The title as sent to the *arr (the ledger's title). */
    title: text('title').notNull(),
    /** The year as sent (Radarr only; null when unknown, sent as 0). */
    year: integer('year'),
    /** The *arr's own exclusion id, from the read-back. */
    arrExclusionId: integer('arr_exclusion_id').notNull(),
    origin: text('origin').$type<TitleExclusionOrigin>().notNull(),
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    /** The Trash batch item it was written for (the sweep and the backfill; null for Expedite). */
    batchItemId: uuid('batch_item_id').references(() => trashBatchItems.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('trash_title_exclusions_kind_created_idx').on(t.arrKind, t.createdAt),
    check(
      'trash_title_exclusions_arr_kind_enum',
      sql`${t.arrKind} = ANY (ARRAY[${sql.raw(sqlList(TITLE_EXCLUSION_ARR_KINDS))}])`,
    ),
    check(
      'trash_title_exclusions_origin_enum',
      sql`${t.origin} = ANY (ARRAY[${sql.raw(sqlList(TITLE_EXCLUSION_ORIGINS))}])`,
    ),
    // The key the *arr excludes by: a tmdb id on Radarr, a tvdb id on Sonarr (COALESCE: a NULL would pass a CHECK).
    check(
      'trash_title_exclusions_key',
      sql`(${t.arrKind} = 'radarr' AND COALESCE(${t.tmdbId}, 0) > 0) OR (${t.arrKind} = 'sonarr' AND COALESCE(${t.tvdbId}, 0) > 0)`,
    ),
  ],
);

export type TrashTitleExclusionRow = typeof trashTitleExclusions.$inferSelect;
export type TrashTitleExclusionInsert = typeof trashTitleExclusions.$inferInsert;
