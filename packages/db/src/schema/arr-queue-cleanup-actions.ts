import { pgTable, uuid, text, integer, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  QUEUE_CLEANUP_ACTION_CLASSES,
  QUEUE_CLEANUP_ACTIONS,
  QUEUE_CLEANUP_INSTANCES,
  QUEUE_CLEANUP_MODES,
  QUEUE_CLEANUP_OUTCOMES,
  type QueueCleanupAction,
  type QueueCleanupActionClass,
  type QueueCleanupInstance,
  type QueueCleanupMode,
  type QueueCleanupOutcome,
} from './enums';

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(',');
const INSTANCES_SQL_LIST = sqlList(QUEUE_CLEANUP_INSTANCES);
const ACTION_CLASSES_SQL_LIST = sqlList(QUEUE_CLEANUP_ACTION_CLASSES);
const MODES_SQL_LIST = sqlList(QUEUE_CLEANUP_MODES);
const ACTIONS_SQL_LIST = sqlList(QUEUE_CLEANUP_ACTIONS);
const OUTCOMES_SQL_LIST = sqlList(QUEUE_CLEANUP_OUTCOMES);

/**
 * ADR-083 / DESIGN-046 D-06 (PLAN-065 — *arr queue janitor) — the append-only census + action ledger
 * (migration 0075). ONE row per queue item PER RUN: the census record AND the action audit in one table.
 * The queue-cleanup sync mode's `evaluateQueueCleanup` single-writer is the SOLE writer; there is NO
 * permission_audit / ledger_events coupling — this table IS the janitor's attribution + audit trail (the
 * mam_gate_state / smart_drive_state derived-operational-state class, but append-only like
 * poster_guard_applications). Digest (D-07) + classifier tuning read it; a retention sweep is Q-02.
 *
 * `mode` records the class×instance mode in effect at the run (`census` observes only; `enforce` may act).
 * `action` is what actually happened; `outcome` is `observed` (census / no-op), `done` (the enforce action
 * landed), or `error` (the *arr write failed — logged, still counts against the per-run cap). `reason` is the
 * first statusMessage (≤500 chars) that drove the classification. The `(instance, download_id, created_at
 * desc)` index powers retry-escalation counting + "seen before" dedup (D-04/D-06).
 */
export const arrQueueCleanupActions = pgTable(
  'arr_queue_cleanup_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The instance the item came from: sonarr|radarr|lidarr, and since ADR-095 (migration 0085) the suite sources
     *  lazylibrarian|kapowarr (QUEUE_CLEANUP_INSTANCES). */
    instance: text('instance').$type<QueueCleanupInstance>().notNull(),
    /** The queue record id (`queue[].id`; Kapowarr's queue entry id) — NOT stable across runs (an item re-queued gets
     *  a new id). Nullable since migration 0085 (DESIGN-046 D-15): LazyLibrarian has no queue, so its rows carry
     *  `itemRef` instead. */
    queueItemId: integer('queue_item_id'),
    /** The download-client id (`queue[].downloadId`) — stable across runs, the retry-escalation / dedup key. */
    downloadId: text('download_id'),
    /** The queue item's release title (display only). */
    title: text('title'),
    /**
     * DESIGN-046 D-13 (migration 0084) — the record's search target, the id the owning *arr searches by: Sonarr
     * the episodeId, Radarr the movieId, Lidarr the albumId. Null when the record carries none (an unknown-artist
     * Lidarr record) and on every row written before D-13. Keys the manual_match loop guard (prior removals of
     * the same album) and the digest's repeat-search list (the same target searched on 2+ runs in 7 days).
     */
    targetId: integer('target_id'),
    /**
     * DESIGN-046 D-15 (migration 0085) — the source's own string reference for what the row is about, where it is not
     * an integer: LazyLibrarian `<bookId>/<ebook|audiobook>` (the book format a grab, a leftover or a fail loop is
     * for). Null on every *arr and Kapowarr row. Keys the loop guard and the fail-loop signal for LazyLibrarian (the
     * way `targetId` keys them for the rest).
     */
    itemRef: text('item_ref'),
    /** DESIGN-046 D-18 (migration 0085) — `fail_loop` rows: the failed grabs the source recorded for the item. Null on
     *  every other row. */
    attempts: integer('attempts'),
    /** The Action Class the classifier assigned (T-239). */
    actionClass: text('action_class').$type<QueueCleanupActionClass>().notNull(),
    /** The class×instance mode in effect this run (census | enforce). */
    mode: text('mode').$type<QueueCleanupMode>().notNull(),
    /** What the janitor did (none | removed_blocklisted | retried_import | blocklisted_searched | skipped_*;
     *  `skipped_loop` since D-13). */
    action: text('action').$type<QueueCleanupAction>().notNull(),
    /** observed | done | error. */
    outcome: text('outcome').$type<QueueCleanupOutcome>().notNull(),
    /** The first statusMessage that drove the classification (≤500 chars). */
    reason: text('reason'),
    /** The *arr write error message when outcome = 'error'. */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The digest + tuning read: newest observations first.
    index('arr_queue_cleanup_actions_created_idx').on(t.createdAt),
    // Retry-escalation counting + "seen before" dedup: the per-download history, newest first.
    index('arr_queue_cleanup_actions_download_idx').on(t.instance, t.downloadId, t.createdAt),
    // D-13 loop guard + repeat-search lookups: the actions that LANDED, per search target. Partial, so it holds
    // only the few rows the janitor acted on, not the hourly census.
    index('arr_queue_cleanup_actions_target_done_idx')
      .on(t.instance, t.targetId, t.createdAt)
      .where(sql`${t.outcome} = 'done' AND ${t.targetId} IS NOT NULL`),
    // D-15 loop guard + fail-loop lookups for sources keyed by a string reference (LazyLibrarian). Partial, so it
    // holds only the source rows that carry one, not the *arr census.
    index('arr_queue_cleanup_actions_item_ref_idx')
      .on(t.instance, t.itemRef, t.createdAt)
      .where(sql`${t.itemRef} IS NOT NULL`),
    check('arr_queue_cleanup_actions_instance_enum', sql`${t.instance} = ANY (ARRAY[${sql.raw(INSTANCES_SQL_LIST)}])`),
    check(
      'arr_queue_cleanup_actions_class_enum',
      sql`${t.actionClass} = ANY (ARRAY[${sql.raw(ACTION_CLASSES_SQL_LIST)}])`,
    ),
    check('arr_queue_cleanup_actions_mode_enum', sql`${t.mode} = ANY (ARRAY[${sql.raw(MODES_SQL_LIST)}])`),
    check('arr_queue_cleanup_actions_action_enum', sql`${t.action} = ANY (ARRAY[${sql.raw(ACTIONS_SQL_LIST)}])`),
    check(
      'arr_queue_cleanup_actions_outcome_enum',
      sql`${t.outcome} = ANY (ARRAY[${sql.raw(OUTCOMES_SQL_LIST)}])`,
    ),
  ],
);

export type ArrQueueCleanupActionRow = typeof arrQueueCleanupActions.$inferSelect;
export type ArrQueueCleanupActionInsert = typeof arrQueueCleanupActions.$inferInsert;
