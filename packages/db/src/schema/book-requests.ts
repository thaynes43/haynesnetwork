import {
  pgTable,
  uuid,
  text,
  timestamp,
  check,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { userIntegrations } from './user-integrations';
import { integrationShelfItems } from './integration-shelf-items';
import { booksItems } from './books-items';
import { BOOK_REQUEST_ORIGINS, BOOK_REQUEST_STATUSES } from './enums';
import type { BookRequestOrigin, BookRequestStatus } from './enums';

const REQUEST_STATUS_SQL_LIST = BOOK_REQUEST_STATUSES.map((s) => `'${s}'`).join(',');
const REQUEST_ORIGIN_SQL_LIST = BOOK_REQUEST_ORIGINS.map((o) => `'${o}'`).join(',');

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
 *
 * ADR-065 / DESIGN-036 (PLAN-050 — book ⇄ audiobook pairing) widens the ledger with the SYSTEM-WANT
 * seat: `origin` discriminates who minted the row ('goodreads' = a user's shelf want, the keys above
 * NOT NULL; 'pairing' = the estate's want for an unpaired library title's missing format — no user, no
 * shelf, `pairing_books_item_id` names the anchor). The origin↔keys coherence is CHECK-enforced and a
 * partial unique caps pairing wants at ONE open want per anchor item (the missing format is implied by
 * the anchor's media_kind). On a pairing want the HELD format sits `landed`; only the missing format
 * runs the lifecycle. One ledger, one status machine, one reconcile path — never a parallel table.
 */
export const bookRequests = pgTable(
  'book_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The minting user's integration. NULL ⇔ a system want (origin='pairing') — ADR-065 C-03. */
    integrationId: uuid('integration_id').references(() => userIntegrations.id, {
      onDelete: 'cascade',
    }),
    /** The shelf want this request was minted from — one request per shelf item. NULL ⇔ origin='pairing'. */
    shelfItemId: uuid('shelf_item_id').references(() => integrationShelfItems.id, {
      onDelete: 'cascade',
    }),
    /** WHO minted the row: 'goodreads' (a user's shelf want) | 'pairing' (the estate's system want). */
    origin: text('origin').$type<BookRequestOrigin>().notNull().default('goodreads'),
    /**
     * ADR-065 — the ANCHOR library item whose MISSING format this pairing want fills (a `book` anchor
     * wants the audiobook; an `audiobook` anchor wants the ebook). NULL ⇔ origin='goodreads'. Distinct
     * from `matched_books_item_id` (which links the want's OWN format into the library and stays NULL
     * on a pairing want — the wanted composition excludes matched rows).
     */
    pairingBooksItemId: uuid('pairing_books_item_id').references(() => booksItems.id, {
      onDelete: 'cascade',
    }),
    /** The library mirror match, when present (ISBN → title/author). Null = not (yet) in the library. */
    matchedBooksItemId: uuid('matched_books_item_id').references(() => booksItems.id, {
      onDelete: 'set null',
    }),
    /** The LazyLibrarian book id the pushes used (the GB volume id resolved for addBook). Nullable. */
    llBookId: text('ll_book_id'),
    /** Denormalized title/author snapshot for the wall (survives a shelf-item edit). */
    title: text('title').notNull(),
    author: text('author'),
    /** Per-format lifecycle status. Books queue BOTH ebook+audio; a comic uses comic_status instead. */
    ebookStatus: text('ebook_status').$type<BookRequestStatus>().notNull().default('requested'),
    audioStatus: text('audio_status').$type<BookRequestStatus>().notNull().default('requested'),
    /**
     * ADR-056 / PLAN-046 — the COMIC format lifecycle. NULL ⇒ this request is NOT a comic (a book/audiobook
     * want — the ebook/audio path above). Non-null ⇒ a comic (Kapowarr's domain, never LazyLibrarian's):
     * `comic_status` IS the actionable state (requested → wanted → grabbed → landed / missing) and ebook/audio
     * stay 'missing' (N/A for a comic). The comic-ness discriminator the API/wall + force-search dispatch read.
     */
    comicStatus: text('comic_status').$type<BookRequestStatus>(),
    /** ADR-056 — the LOCAL Kapowarr volume id the routing added (the ll_book_id analog: reconcile + force-search key). */
    kapowarrVolumeId: text('kapowarr_volume_id'),
    /** ADR-056 — the resolved ComicVine volume id (audit/debug + dedupe against a search result's already_added). */
    comicvineId: text('comicvine_id'),
    /**
     * Why this request is NOT routed (null = routed / routable, the normal case). v1 value:
     * 'comic' — a comic-classified want that could NOT be routed to Kapowarr this run (Kapowarr unreachable /
     * blocked / no ComicVine match), so it stays PARKED in comic_status='requested'. Once Kapowarr routes it
     * (comic_status='wanted', kapowarr_volume_id set) this clears to NULL. `comic_status IS NOT NULL` — not
     * this column — is the durable "is a comic" signal (a parked comic still carries comic_status). (ADR-056.)
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
    // ADR-056 / PLAN-046 — comic_status is nullable (NULL ⇒ not a comic); when set it is one of the five
    // BOOK_REQUEST_STATUSES (kept in lockstep with the const via REQUEST_STATUS_SQL_LIST).
    check(
      'book_requests_comic_status_enum',
      sql`${t.comicStatus} IS NULL OR ${t.comicStatus} = ANY (ARRAY[${sql.raw(REQUEST_STATUS_SQL_LIST)}])`,
    ),
    // ADR-065 — origin is one of the two known minters.
    check(
      'book_requests_origin_enum',
      sql`${t.origin} = ANY (ARRAY[${sql.raw(REQUEST_ORIGIN_SQL_LIST)}])`,
    ),
    // ADR-065 C-03 — origin↔keys coherence: a goodreads want carries its shelf+integration keys; a
    // pairing want carries its library anchor. No half-keyed row is representable.
    check(
      'book_requests_origin_keys',
      sql`(${t.origin} = 'goodreads' AND ${t.shelfItemId} IS NOT NULL AND ${t.integrationId} IS NOT NULL) OR (${t.origin} = 'pairing' AND ${t.pairingBooksItemId} IS NOT NULL)`,
    ),
    // One request per shelf item (the mint is upsert-on-conflict on this key; NULLs — the pairing
    // wants — are exempt by Postgres unique semantics).
    unique('book_requests_shelf_item_unique').on(t.shelfItemId),
    // ADR-065 C-03 — ONE open pairing want per (books_item, format): the missing format is implied by
    // the anchor's media_kind, so the item-scoped partial unique realizes the (item, format) rule.
    uniqueIndex('book_requests_pairing_item_unique')
      .on(t.pairingBooksItemId)
      .where(sql`${t.pairingBooksItemId} IS NOT NULL`),
    // The requests/Missing wall reads one integration's requests.
    index('book_requests_integration_idx').on(t.integrationId),
  ],
);

export type BookRequestRow = typeof bookRequests.$inferSelect;
export type BookRequestInsert = typeof bookRequests.$inferInsert;
