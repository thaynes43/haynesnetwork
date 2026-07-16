import { pgTable, uuid, text, timestamp, check, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { booksItems } from './books-items';
import { FORMAT_PAIR_MATCH_KINDS, type FormatPairMatchKind } from './enums';

const MATCH_KIND_SQL_LIST = FORMAT_PAIR_MATCH_KINDS.map((k) => `'${k}'`).join(',');

/**
 * ADR-065 / DESIGN-036 (PLAN-050 — book ⇄ audiobook pairing) — the FORMAT PAIR: one row per declared
 * "this Kavita book row and this ABS audiobook row are the SAME title". Matched CONSERVATIVELY
 * (normalized title + author agreement — never a wrong pair; an ambiguous or author-less title stays
 * honestly UNPAIRED with no row here). Both sides are UNIQUE — each library row sits in at most one
 * pair — and comics never participate (ADR-065 C-01).
 *
 * WHY A DEDICATED TABLE, not columns on books_items (ADR-065): the mirror stays pure (ADR-046) and
 * the pair is a REBUILDABLE DERIVED CACHE over it (the media_plex_matches class — the book servers
 * are the sources of truth). Written ONLY by the @hnet/domain `syncFormatPairs` single-writer
 * (guard-listed), which recomputes the fresh pair set each `format-pairing` run: new pairs insert,
 * survivors advance last_seen_at, and a pair whose either side tombstoned (or whose match no longer
 * holds) is DELETED — the reconcile. No per-row audit event (synced/derived data, the documented
 * no-ledger-row exemption). The detail page's dual consume buttons, the wall's format-coverage
 * badge, and the pairing-want mint pass all read THIS one truth.
 */
export const booksFormatPairs = pgTable(
  'books_format_pairs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The Kavita `book` side (books_items.id). UNIQUE — a book pairs with at most one audiobook. */
    bookItemId: uuid('book_item_id')
      .notNull()
      .references(() => booksItems.id, { onDelete: 'cascade' }),
    /** The ABS `audiobook` side (books_items.id). UNIQUE — an audiobook pairs with at most one book. */
    audioItemId: uuid('audio_item_id')
      .notNull()
      .references(() => booksItems.id, { onDelete: 'cascade' }),
    /** How the pair was matched. v1: 'title_author' (the conservative matcher). */
    matchedVia: text('matched_via').$type<FormatPairMatchKind>().notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'books_format_pairs_via_enum',
      sql`${t.matchedVia} = ANY (ARRAY[${sql.raw(MATCH_KIND_SQL_LIST)}])`,
    ),
    // Each side sits in at most ONE pair (greedy one-to-one matching, ADR-065 C-02).
    unique('books_format_pairs_book_unique').on(t.bookItemId),
    unique('books_format_pairs_audio_unique').on(t.audioItemId),
  ],
);

export type BooksFormatPairRow = typeof booksFormatPairs.$inferSelect;
export type BooksFormatPairInsert = typeof booksFormatPairs.$inferInsert;
