import {
  pgTable,
  uuid,
  boolean,
  doublePrecision,
  timestamp,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { booksItems } from './books-items';
import { users } from './users';

/**
 * ADR-053 / DESIGN-026 D-07 (PLAN-029) — the PER-USER book read-state read-model (ABS only). One row
 * per (books_item, app_user): whether the signed-in user has finished / is in-progress on an
 * audiobook, plus their fractional progress (0..1). Read via the ABS ADMIN token — `GET /api/users/{id}`
 * → `mediaProgress[]` (isFinished / progress) — joined on books_items.external_id = ABS libraryItemId
 * through the user_account_map ABS handle. Feeds the ADR-051 Audiobooks Read / In-progress facet
 * (populated-value-gated).
 *
 * KAVITA READ-STATE IS DEFERRED (ADR-053 C-05): Kavita exposes no admin per-user progress read, so
 * the Books/Comics walls ship without read facets. This table therefore only ever carries ABS
 * (audiobook) rows in v1.
 *
 * Rebuildable read-model (data of record = ABS): written ONLY by the @hnet/domain
 * `upsertUserBookProgressBatch` single-writer (guard-listed), no per-row audit event (the books_items
 * class — synced descriptive data, documented no-audit exemption). Cascade on books_item / user delete.
 */
export const userBookProgress = pgTable(
  'user_book_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    booksItemId: uuid('books_item_id')
      .notNull()
      .references(() => booksItems.id, { onDelete: 'cascade' }),
    appUserId: uuid('app_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** ABS `isFinished` — the user completed the audiobook. */
    isFinished: boolean('is_finished').notNull().default(false),
    /** ABS `progress` fraction 0..1 (null when the source omitted it). */
    progress: doublePrecision('progress'),
    /** Started but not finished (0 < progress < 1). */
    inProgress: boolean('in_progress').notNull().default(false),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('user_book_progress_item_user_unique').on(t.booksItemId, t.appUserId),
    index('user_book_progress_user_idx').on(t.appUserId),
  ],
);

export type UserBookProgressRow = typeof userBookProgress.$inferSelect;
export type UserBookProgressInsert = typeof userBookProgress.$inferInsert;
