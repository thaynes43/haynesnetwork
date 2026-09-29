import { pgTable, uuid, text, integer, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ARR_KINDS, type ArrKind } from './enums';

const ARR_KINDS_SQL_LIST = ARR_KINDS.map((v) => `'${v}'`).join(',');

/**
 * ADR-094 / DESIGN-046 D-14 (migration 0084) — the JANITOR RELEASE BLOCK's records (T-269). One append-only row per
 * block: the "must not contain" term the queue janitor derived from a failing `manual_match` release's name, written
 * into the janitor's own release profile on that *arr BEFORE the download is removed. The row is inserted in the same
 * transaction as the profile write and its read-back, so a row exists only for a term the *arr confirmed.
 *
 * The profile's desired state is the sentinel plus the distinct `term`s of this instance whose `expires_at` is still
 * ahead (365 days from the block; a later block of the same term keeps it longer), newest first, capped. Nothing
 * deletes a row: an expired row simply stops counting, and the next reconcile removes its term from the profile.
 * `reconcileJanitorReleaseBlock` (@hnet/domain `janitor-release-block.ts`) is the SOLE writer (the no-direct-state-
 * writes guard covers this table). Keyed by instance so the block can extend beyond Lidarr; Lidarr only today.
 */
export const arrQueueCleanupBlockTerms = pgTable(
  'arr_queue_cleanup_block_terms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The *arr whose janitor profile holds the term (lidarr today). */
    instance: text('instance').$type<ArrKind>().notNull(),
    /** The whole-name "must not contain" term (`/^…$/i`, DESIGN-046 D-14 grammar). */
    term: text('term').notNull(),
    /** The release name the term was derived from (the grab's `sourceTitle`, else the queue title). Display only. */
    releaseTitle: text('release_title'),
    /** The download the block was written for. */
    downloadId: text('download_id'),
    /** The search target of the download's first record (Lidarr: the albumId), when known. */
    targetId: integer('target_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** created_at + 365 days: the term leaves the profile once every row carrying it has expired. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // The desired-state read: one instance's live terms.
    index('arr_queue_cleanup_block_terms_live_idx').on(t.instance, t.expiresAt),
    check(
      'arr_queue_cleanup_block_terms_instance_enum',
      sql`${t.instance} = ANY (ARRAY[${sql.raw(ARR_KINDS_SQL_LIST)}])`,
    ),
  ],
);

export type ArrQueueCleanupBlockTermRow = typeof arrQueueCleanupBlockTerms.$inferSelect;
export type ArrQueueCleanupBlockTermInsert = typeof arrQueueCleanupBlockTerms.$inferInsert;
