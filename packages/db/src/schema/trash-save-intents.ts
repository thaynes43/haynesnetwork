import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  check,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { mediaItems } from './media-items';
import { TRASH_MEDIA_KINDS, TRASH_SAVE_INTENT_ORIGINS, type TrashMediaKind } from './enums';
import type { TrashSaveIntentOrigin } from './enums';

const TRASH_MEDIA_KINDS_SQL_LIST = TRASH_MEDIA_KINDS.map((k) => `'${k}'`).join(',');
const ORIGINS_SQL_LIST = TRASH_SAVE_INTENT_ORIGINS.map((o) => `'${o}'`).join(',');

/**
 * ADR-086 / DESIGN-048 D-01 — the DURABLE, REVOCABLE record that the household wants a title kept.
 *
 * Why this table exists: a Maintainerr exclusion is keyed on `mediaServerId` = the **Plex
 * ratingKey**, which is NOT a stable identity. Replacing a title's file (upgrade grab → delete →
 * import) makes Plex drop the item and mint a new one under a new key, and Maintainerr's nightly
 * `removeLeftoverExclusions()` then deletes the now-dangling exclusion — silently erasing the
 * owner's Save. Maintainerr owns ENFORCEMENT; it demonstrably does not own a durable record of
 * INTENT, so the app does (ADR-086 D-2, amending ADR-023 narrowly).
 *
 * Keyed on `media_item_id` — the *arr identity (tmdb/tvdb), which survives a re-key.
 * `maintainerr_media_id` is the LAST key we successfully excluded, refreshed on every relink; it is
 * the comparison basis for the changed-key-only reconciler (ADR-086 D-4), never an identity.
 *
 * Written ONLY by the @hnet/domain save-intent single-writer, in the SAME TRANSACTION as the
 * `trash_excluded` ledger row it records (hard rule 6). Joins the no-direct-state-writes guard list.
 *
 * Revocation is EXPLICIT (`revoked_at`), never inferred from a missing exclusion — that is what
 * stops the reconciler re-protecting something the owner deliberately un-saved (ADR-086 D-3/C-10).
 */
export const trashSaveIntents = pgTable(
  'trash_save_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The *arr identity this intent is about — stable across Plex re-keys. */
    mediaItemId: uuid('media_item_id')
      .notNull()
      .references(() => mediaItems.id, { onDelete: 'cascade' }),
    /** Denormalised from media_items.arr_kind so the reconciler's hot query filters without joining. */
    mediaKind: text('media_kind').$type<TrashMediaKind>().notNull(),
    /** The Plex ratingKey we last successfully excluded. Refreshed on relink; NOT an identity. */
    maintainerrMediaId: text('maintainerr_media_id').notNull(),
    /** How the intent came to exist. 'backfill' = seeded from ledger history by migration 0076. */
    origin: text('origin').$type<TrashSaveIntentOrigin>().notNull(),
    savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
    savedByUserId: uuid('saved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Set by an un-save. A revoked row is never resurrected — a later re-save inserts a NEW row. */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedByUserId: uuid('revoked_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** How many times the reconciler has re-applied this intent onto a new key. */
    relinkCount: integer('relink_count').notNull().default(0),
    lastRelinkedAt: timestamp('last_relinked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'trash_save_intents_media_kind_enum',
      sql.raw(`media_kind IN (${TRASH_MEDIA_KINDS_SQL_LIST})`),
    ),
    check('trash_save_intents_origin_enum', sql.raw(`origin IN (${ORIGINS_SQL_LIST})`)),
    /**
     * ADR-086 D-1: AT MOST ONE unrevoked intent per media item. The reconciler relies on this
     * invariant, so it is enforced in the schema rather than in the writer — and it is what the
     * writer's upsert targets.
     */
    uniqueIndex('trash_save_intents_one_open_per_item')
      .on(t.mediaItemId)
      .where(sql`revoked_at IS NULL`),
    /** The reconciler scans open intents by kind every incremental tick. */
    index('trash_save_intents_open_kind_idx')
      .on(t.mediaKind)
      .where(sql`revoked_at IS NULL`),
  ],
);

export type TrashSaveIntentRow = typeof trashSaveIntents.$inferSelect;
export type NewTrashSaveIntentRow = typeof trashSaveIntents.$inferInsert;
