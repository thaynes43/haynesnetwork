import { pgTable, uuid, text, integer, timestamp, jsonb, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { mediaItems } from './media-items';

/**
 * ADR-109 C-04, C-06 / DESIGN-055 D-06 (PLAN-077 P5, migration 0103) — a Release List (T-316): the Release Pick's list as
 * one person was shown it, for one missing episode or movie. BC-03. Written only by the single writer
 * packages/domain/src/release-pick.ts (the no-direct-state-writes guard), in the same transaction as its
 * `release_list_requested` ledger event, the budget unit.
 *
 * `rows` is exactly what the person saw (the plain-words reasons, the state of each row). `offers` holds what a grab
 * needs for each row the person may pick (the *arr's `guid` and `indexerId`, the row's own quality and languages for an
 * override): it stays on the server, so a guid (which can be an indexer URL) never reaches a browser, and a grab sent to
 * any web pod finds the list the person saw. `searched_at` is when the *arr searched; a grab is refused once the *arr's
 * own release cache (30 minutes) may have dropped the row.
 */
export const releasePickLists = pgTable(
  'release_pick_lists',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** null: the in-cluster tool (it never records a list today; kept nullable like repair_requests). */
    requesterId: uuid('requester_id').references(() => users.id, { onDelete: 'set null' }),
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    arrKind: text('arr_kind').$type<'sonarr' | 'radarr'>().notNull(),
    /** The episode id (Sonarr); null for a movie. */
    targetChildId: integer('target_child_id'),
    /** The episode's season (Sonarr); null for a movie. */
    seasonNumber: integer('season_number'),
    targetLabel: text('target_label').notNull(),
    searchedAt: timestamp('searched_at', { withTimezone: true }).notNull(),
    /** The plain-words reasons version the rows were written with (RELEASE_REASONS_VERSION). */
    reasonsVersion: integer('reasons_version').notNull(),
    rows: jsonb('rows').$type<Record<string, unknown>[]>().notNull().default([]),
    offers: jsonb('offers').$type<Record<string, unknown>[]>().notNull().default([]),
    counts: jsonb('counts').$type<Record<string, number>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('release_pick_lists_arr_kind_enum', sql`${t.arrKind} = ANY (ARRAY['sonarr','radarr'])`),
    check(
      'release_pick_lists_target_iff_tv',
      sql`(${t.arrKind} = 'radarr' AND ${t.targetChildId} IS NULL AND ${t.seasonNumber} IS NULL) OR (${t.arrKind} = 'sonarr' AND ${t.targetChildId} IS NOT NULL AND ${t.seasonNumber} IS NOT NULL)`,
    ),
    index('release_pick_lists_requester_target_idx').on(t.requesterId, t.mediaItemId, t.targetChildId, t.createdAt.desc()),
    index('release_pick_lists_created_idx').on(t.createdAt),
  ],
);

export type ReleasePickListRow = typeof releasePickLists.$inferSelect;
export type ReleasePickListInsert = typeof releasePickLists.$inferInsert;
