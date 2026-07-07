import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  numeric,
  timestamp,
  check,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { mediaItems } from './media-items';
import { trashBatches } from './trash-batches';
import { TRASH_BATCH_ITEM_STATES, type TrashBatchItemState } from './enums';

const TRASH_BATCH_ITEM_STATES_SQL_LIST = TRASH_BATCH_ITEM_STATES.map((s) => `'${s}'`).join(',');

/**
 * ADR-025 / DESIGN-011 — one row per proposed-deletion item in a batch. Snapshot columns
 * (title/year/poster/ids/size) are FROZEN at batch creation so the poster wall + counts are stable
 * even as Maintainerr's live collections drift. `maintainerr_media_id` (Plex ratingKey) is the
 * exclusion/handle key; `media_item_id` is our ledger link (nullable — an item unknown to our ledger
 * is snapshotted but the guardian can NEVER clear it for deletion: it lands `skipped`, C-07b).
 *
 * The deletion-snapshot columns (`deleted_*`) are written in the SAME transaction as the item's
 * `deleted` state + `trash_expedited` event at sweep time (Q-08) — the durable metrics source
 * PLAN-013 consumes (size/resolution/ratings frozen at the moment of deletion). Written ONLY by the
 * @hnet/domain trash-batches single-writers (no-direct-state-writes guard).
 */
export const trashBatchItems = pgTable(
  'trash_batch_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => trashBatches.id, { onDelete: 'cascade' }),
    maintainerrMediaId: text('maintainerr_media_id').notNull(),
    collectionId: integer('collection_id'), // source Maintainerr collection at snapshot time
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    // Snapshots frozen at batch creation (stable poster-wall + counts):
    title: text('title').notNull(),
    year: integer('year'),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    posterSource: text('poster_source'), // ADR-019 poster proxy source ('arr'|'tmdb'|null)
    state: text('state').$type<TrashBatchItemState>().notNull().default('pending'),
    // The CURRENT save holder (cleared on un-save); the full flip history is trash_batch_saves.
    savedBy: uuid('saved_by').references(() => users.id, { onDelete: 'set null' }),
    savedAt: timestamp('saved_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // Deletion snapshot (Q-08) — written at sweep-delete time, same tx as state='deleted':
    deletedSizeBytes: bigint('deleted_size_bytes', { mode: 'number' }),
    deletedResolution: text('deleted_resolution'), // media_metadata.resolution tier (PLAN-004)
    deletedImdbRating: numeric('deleted_imdb_rating'),
    deletedTmdbRating: numeric('deleted_tmdb_rating'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'trash_batch_items_state_enum',
      sql`${t.state} = ANY (ARRAY[${sql.raw(TRASH_BATCH_ITEM_STATES_SQL_LIST)}])`,
    ),
    // One row per (batch, Maintainerr item) — the snapshot is deduped.
    uniqueIndex('trash_batch_items_batch_media_unique').on(t.batchId, t.maintainerrMediaId),
    index('trash_batch_items_batch_state_idx').on(t.batchId, t.state),
  ],
);

export type TrashBatchItemRow = typeof trashBatchItems.$inferSelect;
export type TrashBatchItemInsert = typeof trashBatchItems.$inferInsert;
