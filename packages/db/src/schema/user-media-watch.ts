import { pgTable, uuid, integer, boolean, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { mediaItems } from './media-items';
import { users } from './users';

/**
 * ADR-053 / DESIGN-026 D-07 (PLAN-029) — the PER-USER video watch read-model (ADDITIVE). One row per
 * (media_item, app_user): whether the signed-in user has watched / is in-progress on a title, plus
 * their own play_count / last_viewed_at. Attributed by the metadata harvest by re-keying the Tautulli
 * history `user_id` (a one-field subset add) through the user_account_map, ALONGSIDE — never replacing
 * — the household SUM/MAX on media_metadata (play_count/last_viewed_at/last_watched_*, which the trash
 * walls + guardian keep + item-detail "last watched" depend on — ADR-053 C-03). The ADR-051 registry's
 * per-user Watched / Unwatched / In-progress facets (Movies/TV/Music) read this; coverage is sparse
 * (live-verified) so those facets are populated-value-gated.
 *
 * Rebuildable read-model (data of record = Tautulli): written ONLY by the @hnet/domain
 * `upsertUserMediaWatchBatch` single-writer (guard-listed), no per-row audit event (the media_metadata
 * class — synced descriptive data, documented no-audit exemption). Q-01 (DESIGN-026): the dedicated
 * rollup table (this) vs a per-user column set — the rollup keeps the household columns untouched AND
 * is the shape the Feed-attribution reuse wants. Cascade on media_item / user delete.
 */
export const userMediaWatch = pgTable(
  'user_media_watch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** This user's play count for the title (SUM across the estate's Tautulli instances). */
    playCount: integer('play_count'),
    /** This user's most-recent view instant (MAX across instances). Null = never watched by them. */
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    /** True once the user completed the title (a watched play — Tautulli watched_status 1). */
    watched: boolean('watched').notNull().default(false),
    /** True when the user has started but not finished (a partial play — watched_status 0.x). */
    inProgress: boolean('in_progress').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('user_media_watch_item_user_unique').on(t.mediaItemId, t.appUserId),
    // The per-user facet reads (this viewer's watched/in-progress items).
    index('user_media_watch_user_idx').on(t.appUserId),
  ],
);

export type UserMediaWatchRow = typeof userMediaWatch.$inferSelect;
export type UserMediaWatchInsert = typeof userMediaWatch.$inferInsert;
