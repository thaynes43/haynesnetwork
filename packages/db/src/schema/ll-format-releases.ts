import { pgTable, text, timestamp, uuid, check, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { LL_RELEASE_FORMATS, type LlReleaseFormat } from './enums';

const FORMAT_SQL_LIST = LL_RELEASE_FORMATS.map((f) => `'${f}'`).join(',');

/**
 * Issue #735 (DESIGN-028 amendment 2026-10-06, migration 0093) — the LAZYLIBRARIAN RELEASE: one row per LazyLibrarian
 * book and format the app had queued for a want it then abandoned, parked or re-pointed (a pairing want re-identified
 * or parked, a collection want parked or dropped, an English-edition switch or park, a Goodreads shelf item removed, a
 * Goodreads link unlinked). It is pending work, not history: each goodreads-sync and format-pairing run drains it
 * (`drainLlReleases`), and a row leaves the table once that format is settled. `unqueueBook` (back to `Skipped`) when a
 * fresh `getAllBooks` read shows the format `Wanted`, nothing holds it, and no live request still asks LazyLibrarian for
 * that book and format; dropped without a write when one does, when LazyLibrarian holds it or no longer has the book,
 * or when it is not `Wanted`. A `Snatched` format stays pending until its download ends either way.
 *
 * Without the row the app has no way to tell a book it queued from one a person queued by hand, so an orphan is only
 * ever unqueued for a want the app itself gave up. Written ONLY by the @hnet/domain `ll-release.ts` single writers
 * (guard-listed): `recordLlReleases`, inside the transaction of the writer that abandons the want, and the drain.
 * Derived operational state (the `gb_quota_state` class): no audit row; each outcome logs. `request_id` is the want
 * that gave the format up, kept for the log only (no foreign key: a dropped collection want leaves with its row).
 */
export const llFormatReleases = pgTable(
  'll_format_releases',
  {
    /** The LazyLibrarian book id (the Google Books volume id the push used). */
    llBookId: text('ll_book_id').notNull(),
    /** The format given up: 'ebook' | 'audiobook'. */
    format: text('format').$type<LlReleaseFormat>().notNull(),
    /** Why the want gave it up (`reidentified`, `parked:<reason>`, `english_edition`, `shelf_removed`, …). */
    reason: text('reason').notNull(),
    /** The want that gave it up (the latest one, when two did). */
    requestId: uuid('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.llBookId, t.format] }),
    check('ll_format_releases_format_enum', sql`${t.format} = ANY (ARRAY[${sql.raw(FORMAT_SQL_LIST)}])`),
  ],
);

export type LlFormatReleaseRow = typeof llFormatReleases.$inferSelect;
export type LlFormatReleaseInsert = typeof llFormatReleases.$inferInsert;
