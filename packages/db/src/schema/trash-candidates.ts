import { pgTable, uuid, text, integer, bigint, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { TRASH_MEDIA_KINDS, type TrashMediaKind } from './enums';

const TRASH_MEDIA_KINDS_SQL_LIST = TRASH_MEDIA_KINDS.map((k) => `'${k}'`).join(',');

/**
 * ADR-035 / DESIGN-010 amendment (2026-07-09) — the Trash candidate READ-MODEL. A per-kind snapshot
 * of Maintainerr's pending-deletion set (rule-collection membership + per-item size/ids), refreshed
 * by the sync CronJobs (full/incremental) and on demand, so the Trash walls/Overview serve pages,
 * facets, and counts from Postgres in milliseconds instead of re-crawling Maintainerr's paged
 * collection API on every request (the measured 6–9 s cold path).
 *
 * READ-MODEL ONLY (C-02): Maintainerr stays the deletion system of record. Every DESTRUCTIVE or
 * mutating flow (expedite, batch create/sweep, guardian, exclusion writes) still reads the LIVE
 * Maintainerr pending set through the guarded seams — this table never feeds a delete decision.
 * Rows carry only Maintainerr-owned facts; the ledger/metadata join happens at read time so
 * title/tags/watch/requester facets stay as fresh as the media sync. Written ONLY by the
 * @hnet/domain trash-candidates refresher (the no-direct-state-writes guard covers it); it is
 * derived, rebuildable state, so refreshes write no ledger audit rows (ADR-035 C-05 exemption).
 */
export const trashCandidates = pgTable(
  'trash_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The kind bucket this row serves ('movie'|'tv') — resolved at refresh with the same
     *  collection-type/external-id rules the live read uses. */
    mediaKind: text('media_kind').$type<TrashMediaKind>().notNull(),
    /** Maintainerr rule-collection id + title (Leaving-Soon manual collections are never snapshotted). */
    collectionId: integer('collection_id').notNull(),
    collectionTitle: text('collection_title'),
    deleteAfterDays: integer('delete_after_days'),
    /** Maintainerr's item id (Plex ratingKey) — null ⇒ listed but unactionable. */
    maintainerrMediaId: text('maintainerr_media_id'),
    tmdbId: integer('tmdb_id'),
    tvdbId: integer('tvdb_id'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    /** Maintainerr's addDate VERBATIM (text, not timestamptz) so the wire shape round-trips
     *  byte-identically through the snapshot (scheduledDeleteAt is computed at read). */
    addDate: text('add_date'),
    /** Crawl order within the refresh (collections order, then page order) — reads ORDER BY this so
     *  the snapshot serves rows exactly as a live crawl would have. */
    ord: integer('ord').notNull().default(0),
  },
  (t) => [
    index('trash_candidates_kind_idx').on(t.mediaKind),
    check('trash_candidates_kind_check', sql.raw(`media_kind IN (${TRASH_MEDIA_KINDS_SQL_LIST})`)),
  ],
);

/**
 * One bookkeeping row PER KIND: when the snapshot was last rebuilt + its aggregate count/bytes (the
 * Overview's cheap numbers + the walls' "candidates as of N min ago" honesty line). A kind with no
 * state row has never been refreshed — readers then refresh inline before serving.
 */
export const trashCandidatesState = pgTable(
  'trash_candidates_state',
  {
    mediaKind: text('media_kind').$type<TrashMediaKind>().primaryKey(),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull(),
    itemCount: integer('item_count').notNull(),
    totalSizeBytes: bigint('total_size_bytes', { mode: 'number' }).notNull(),
  },
  () => [
    check(
      'trash_candidates_state_kind_check',
      sql.raw(`media_kind IN (${TRASH_MEDIA_KINDS_SQL_LIST})`),
    ),
  ],
);

export type TrashCandidateRow = typeof trashCandidates.$inferSelect;
export type NewTrashCandidateRow = typeof trashCandidates.$inferInsert;
export type TrashCandidatesStateRow = typeof trashCandidatesState.$inferSelect;
