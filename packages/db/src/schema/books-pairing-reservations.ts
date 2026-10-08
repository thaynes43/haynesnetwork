import { index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { booksItems } from './books-items';

/** DESIGN-036 / T-294: a prior pair's unread book defers acquisition without claiming held coverage.
 * Derived read-model, written only by syncFormatPairs in the same transaction that drops the pair.
 * No expiry; fresh identity/coverage or a fully known tombstone clears it. No per-row Request Event.
 */
export const booksPairingReservations = pgTable(
  'books_pairing_reservations',
  {
    bookItemId: uuid('book_item_id')
      .notNull()
      .references(() => booksItems.id, { onDelete: 'cascade' }),
    audioItemId: uuid('audio_item_id')
      .notNull()
      .references(() => booksItems.id, { onDelete: 'cascade' }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.bookItemId, t.audioItemId] }),
    index('books_pairing_reservations_audio_idx').on(t.audioItemId),
  ],
);
