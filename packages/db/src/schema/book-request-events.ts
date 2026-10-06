import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import {
  BOOK_REQUEST_EVENT_ACTORS,
  BOOK_REQUEST_EVENT_KINDS,
  type BookRequestEventActor,
  type BookRequestEventKind,
  type BookRequestEventReason,
} from './enums';

const KINDS_SQL_LIST = BOOK_REQUEST_EVENT_KINDS.map((k) => `'${k}'`).join(',');
const ACTORS_SQL_LIST = BOOK_REQUEST_EVENT_ACTORS.map((a) => `'${a}'`).join(',');

/**
 * ADR-101 / DESIGN-028 amendment 2026-10-06 (issue #741, migration 0096) — the REQUEST EVENT: one append-only row per
 * `book_requests` row a single writer minted, changed or deleted, inserted in the SAME transaction as the write by
 * `@hnet/domain` book-request-events.ts (the only domain module that writes book_requests; a guard test pins it).
 * `before` / `after` hold only the recorded fields the write changed (a mint: `before` {} and every recorded field in
 * `after`; a delete: the reverse), keyed by column name. The bookkeeping stamps (`last_searched_at`,
 * `last_reconciled_at`, `english_edition_tried_at`, the Mint Backoff columns, `updated_at`) are not recorded, so a
 * write that only stamps writes no event.
 *
 * `request_id` has NO foreign key: a dropped collection want leaves with its row, and its history must outlive it.
 * Never updated or deleted (guard-listed for INSERT only; nothing in the app deletes it).
 */
export const bookRequestEvents = pgTable(
  'book_request_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The book_requests row (no FK: a deleted want keeps its history). */
    requestId: uuid('request_id').notNull(),
    /** mint | update | delete. */
    kind: text('kind').$type<BookRequestEventKind>().notNull(),
    /** The decision that made the write (`ll_book_gone_repointed`, `parked`, `ll_rerequest`, …). */
    reason: text('reason').$type<BookRequestEventReason>().notNull(),
    /** The single writer that made it (the domain function name, e.g. `repointRequestLlBook`). */
    writer: text('writer').notNull(),
    /** The job and leg it ran in (`goodreads-sync`, `format-pairing.rerequest`, `wrong-volume-requests-repair`). */
    site: text('site'),
    /** sync | repair | user. */
    actor: text('actor').$type<BookRequestEventActor>().notNull(),
    /** The person, when `actor = 'user'`. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** The changed recorded fields' values before the write (column name → value). */
    before: jsonb('before').$type<Record<string, unknown>>().notNull(),
    /** Their values after it. */
    after: jsonb('after').$type<Record<string, unknown>>().notNull(),
    /** The writer's own context for the decision (a re-request's outcome, the id it was judged on, …). */
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'book_request_events_kind_enum',
      sql`${t.kind} = ANY (ARRAY[${sql.raw(KINDS_SQL_LIST)}])`,
    ),
    check(
      'book_request_events_actor_enum',
      sql`${t.actor} = ANY (ARRAY[${sql.raw(ACTORS_SQL_LIST)}])`,
    ),
    // A request's history, newest first (the review / repair read).
    index('book_request_events_request_created_idx').on(t.requestId, t.createdAt.desc()),
    // What one decision did across the estate in a window.
    index('book_request_events_reason_created_idx').on(t.reason, t.createdAt.desc()),
  ],
);

export type BookRequestEventRow = typeof bookRequestEvents.$inferSelect;
export type BookRequestEventInsert = typeof bookRequestEvents.$inferInsert;
