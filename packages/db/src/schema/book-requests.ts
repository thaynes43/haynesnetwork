import { pgTable, uuid, text, timestamp, check, unique, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userIntegrations } from './user-integrations';
import { integrationShelfItems } from './integration-shelf-items';
import { booksItems } from './books-items';
import { BOOK_REQUEST_STATUSES } from './enums';
import type { BookRequestStatus } from './enums';

const REQUEST_STATUS_SQL_LIST = BOOK_REQUEST_STATUSES.map((s) => `'${s}'`).join(',');

/**
 * ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) — the request / Missing LEDGER: one row per
 * shelf want that is NOT in the library, tracking BOTH formats (owner ruling — "we grab both so it's one
 * for all"). Each format carries its own lifecycle status (requested → wanted → grabbed → landed, or the
 * per-format `missing` — the *arr wanted/missing idiom, R3). `matched_books_item_id` links the library
 * mirror when the item is (or becomes) present; `ll_book_id` is the LazyLibrarian book id the pushes used.
 *
 * ADR-046 STANDS: books_items stays a pure mirror — request/Missing state lives HERE, never bolted onto
 * the mirror. Single-writer (@hnet/domain book-requests.ts, guard-listed). The SYNC-driven mint/status
 * reconcile is NOT audited (synced/derived read-model, the media_items class). The USER-initiated manual
 * "Search again" DOES write a `permission_audit` row (request_book_search) — R3/AC-04.
 */
export const bookRequests = pgTable(
  'book_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => userIntegrations.id, { onDelete: 'cascade' }),
    /** The shelf want this request was minted from — one request per shelf item. */
    shelfItemId: uuid('shelf_item_id')
      .notNull()
      .references(() => integrationShelfItems.id, { onDelete: 'cascade' }),
    /** The library mirror match, when present (ISBN → title/author). Null = not (yet) in the library. */
    matchedBooksItemId: uuid('matched_books_item_id').references(() => booksItems.id, {
      onDelete: 'set null',
    }),
    /** The LazyLibrarian book id the pushes used (the GB volume id resolved for addBook). Nullable. */
    llBookId: text('ll_book_id'),
    /** Denormalized title/author snapshot for the wall (survives a shelf-item edit). */
    title: text('title').notNull(),
    author: text('author'),
    /** Per-format lifecycle status. Both formats are always queued (unless unroutable — see below). */
    ebookStatus: text('ebook_status').$type<BookRequestStatus>().notNull().default('requested'),
    audioStatus: text('audio_status').$type<BookRequestStatus>().notNull().default('requested'),
    /**
     * Why this request is NOT routed to LazyLibrarian (null = routable, the normal case). v1 value:
     * 'comic' — GB tags the item a comic / graphic novel, which is Kapowarr's domain, not LL's (owner note
     * 2026-07-13). The sync leaves an unroutable request in `missing` and NEVER pushes it to LL; the tab
     * surfaces it honestly ("routes via the saga pairing phase, not queued"). A saga residual (DESIGN-028).
     */
    unroutableReason: text('unroutable_reason'),
    /** When a manual "Search again" last fired a real LL searchBook (audited). Nullable. */
    lastSearchedAt: timestamp('last_searched_at', { withTimezone: true }),
    /** When the sync last reconciled LL statuses into this row. Nullable. */
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'book_requests_ebook_status_enum',
      sql`${t.ebookStatus} = ANY (ARRAY[${sql.raw(REQUEST_STATUS_SQL_LIST)}])`,
    ),
    check(
      'book_requests_audio_status_enum',
      sql`${t.audioStatus} = ANY (ARRAY[${sql.raw(REQUEST_STATUS_SQL_LIST)}])`,
    ),
    // One request per shelf item (the mint is upsert-on-conflict on this key).
    unique('book_requests_shelf_item_unique').on(t.shelfItemId),
    // The requests/Missing wall reads one integration's requests.
    index('book_requests_integration_idx').on(t.integrationId),
  ],
);

export type BookRequestRow = typeof bookRequests.$inferSelect;
export type BookRequestInsert = typeof bookRequests.$inferInsert;
