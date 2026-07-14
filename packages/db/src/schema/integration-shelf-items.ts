import { pgTable, uuid, text, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { userIntegrations } from './user-integrations';

/**
 * ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP) — the synced RSS MIRROR: one row per
 * (integration, shelf, external book id). The `goodreads-sync` mode pages each linked user's PUBLIC shelf
 * RSS read-only and this table records what it saw (title/author/ISBN/GB keys when derivable + when the
 * item was shelved). A rebuildable READ-MODEL (data of record = the user's Goodreads shelf), the
 * books_items class: written ONLY by the @hnet/domain shelf-item single-writer (guard-listed), which
 * upserts the snapshot + tombstones rows a fully-read shelf no longer serves. NO per-row audit event.
 */
export const integrationShelfItems = pgTable(
  'integration_shelf_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => userIntegrations.id, { onDelete: 'cascade' }),
    /** The Goodreads shelf slug this item was read from (e.g. 'to-read'). */
    shelf: text('shelf').notNull(),
    /** The provider's stable book id — the Goodreads book_id from the RSS item. Identity with (integration, shelf). */
    externalBookId: text('external_book_id').notNull(),
    title: text('title').notNull(),
    author: text('author'),
    /** ISBN (13 preferred, else 10) from the RSS item — the primary library-match + LL key. Nullable. */
    isbn: text('isbn'),
    /** Google Books volume id derived by GB enrichment (retry/backoff) — the LazyLibrarian addBook key. Nullable. */
    gbVolumeId: text('gb_volume_id'),
    /** The Goodreads book_image_url (an external CDN cover) — fallback art when no library match exists. */
    coverUrl: text('cover_url'),
    /** When the user shelved the item (RSS user_date_added / pubDate). Nullable. */
    shelvedAt: timestamp('shelved_at', { withTimezone: true }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** TOMBSTONE: set when the item left the shelf; null = live. Coverage/requests read live rows only. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('integration_shelf_items_unique').on(t.integrationId, t.shelf, t.externalBookId),
    // The coverage + request-minting reads scope to one integration's live shelf items.
    index('integration_shelf_items_integration_live_idx').on(t.integrationId, t.deletedAt),
  ],
);

export type IntegrationShelfItemRow = typeof integrationShelfItems.$inferSelect;
export type IntegrationShelfItemInsert = typeof integrationShelfItems.$inferInsert;
