import {
  pgTable,
  uuid,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  check,
  unique,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { BOOKS_SOURCES, BOOKS_MEDIA_KINDS, type BooksSource, type BooksMediaKind } from './enums';

const BOOKS_SOURCES_SQL_LIST = BOOKS_SOURCES.map((s) => `'${s}'`).join(',');
const BOOKS_MEDIA_KINDS_SQL_LIST = BOOKS_MEDIA_KINDS.map((k) => `'${k}'`).join(',');

/**
 * ADR-046 / DESIGN-024 (PLAN-023 — Books & Audiobooks) — the books LEDGER row: one entry per
 * Kavita series (Books=EBooks, Comics) or Audiobookshelf library item (Audio Books). It is the
 * app-owned, one-way SYNCED MIRROR of the two book servers (owner ruling 2026-07-10: "full ledger
 * integration in v1"), the substrate the Library Books/Audiobooks/Comics poster walls read.
 *
 * WHY A DEDICATED TABLE, not media_items (ADR-046): media_items is hard-wired to the three *arr kinds
 * (arr_kind CHECK; a per-kind external-id CHECK; NOT-NULL monitored/quality_profile/root_folder; the
 * Fix/Restore/Ledger machinery all assume an *arr of record). Books have NONE of those semantics —
 * forcing them in would corrupt those invariants and drag books into the /ledger admin's Fix/bulk-add
 * surfaces (nonsensical: you cannot Radarr-search a book). So books get their own leaner, honest shape,
 * exactly like the ai_usage_chats / smart_drive_state / authentik_users mirrors. hard rule 4 EXTENDED:
 * Kavita/ABS are the source of truth for book media; the app only syncs IN — NO write-back (no Fix, no
 * Restore) exists for books.
 *
 * Rebuildable READ-MODEL: the data of record lives in Kavita/ABS. Written ONLY by the @hnet/domain
 * `syncBooks` single-writer (guard-listed), which upserts the current snapshot and TOMBSTONES rows no
 * longer served (deleted_at set; never hard-deleted — the wall shows live rows only). No per-row audit
 * event — synced content, not a role/permission mutation (the documented no-ledger-row exemption).
 */
export const booksItems = pgTable(
  'books_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Which book server serves this row: 'kavita' | 'audiobookshelf'. */
    source: text('source').$type<BooksSource>().notNull(),
    /** The app media kind: 'book' (Kavita EBooks) | 'comic' (Kavita Comics) | 'audiobook' (ABS). */
    mediaKind: text('media_kind').$type<BooksMediaKind>().notNull(),
    /** The server's stable id — Kavita series id (as text) / ABS library-item uuid. Identity with `source`. */
    externalId: text('external_id').notNull(),
    /** The server library id (Kavita libraryId '1'/'2' / ABS library uuid) — provenance + deep-link. */
    libraryId: text('library_id').notNull(),
    libraryName: text('library_name').notNull(),
    title: text('title').notNull(),
    sortTitle: text('sort_title').notNull(),
    /** Author/creator — ABS metadata.authorName; Kavita best-effort from the author folder. Nullable. */
    author: text('author'),
    /** Narrator — ABS only. Nullable. */
    narrator: text('narrator'),
    /** Series/collection name — ABS metadata.seriesName (Kavita's series IS the title). Nullable. */
    seriesName: text('series_name'),
    /** Publication year — ABS publishedYear (Kavita's series list carries none). Nullable. */
    year: integer('year'),
    /**
     * ADR-051 C-05 / DESIGN-026 D-05 (PLAN-029) — the precise Date RELEASED for a book item: ABS
     * `media.metadata.publishedDate` (a full instant where present, richer than the January-1 `year`).
     * Kavita's series list carries no date → null (Release Date stays honestly absent from the Kavita
     * registry). The Audiobooks wall's Release-Date sort/facet reads this; a null sorts NULLS-LAST.
     */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    /** Genres/tags (ABS metadata.genres; Kavita has none in the series list). */
    genres: jsonb('genres').$type<string[]>().notNull().default([]),
    /**
     * The self-versioning cover reference used to build the authed cover-proxy URL + its strong ETag:
     * Kavita `coverImage` (e.g. `v1243_c1250.png` — changes when the art changes), ABS `updatedAt` (ms).
     * Null ⇒ the wall shows the KindIcon fallback tile.
     */
    coverRef: text('cover_ref'),
    /** The public deep-link to the item in Kavita/ABS (opens in a new tab). */
    deepLinkUrl: text('deep_link_url').notNull(),
    /** Kavita page count (book/comic). Nullable. */
    pageCount: integer('page_count'),
    /** Kavita word count (book). Nullable. */
    wordCount: integer('word_count'),
    /** ABS runtime in whole seconds. Nullable. */
    durationSeconds: integer('duration_seconds'),
    /** ABS on-disk size in bytes. Nullable (Kavita's series list carries none). */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    /**
     * DESIGN-024 D-01 amendment (detail-page parity, 2026-07-17) — the About/Details enrichment.
     * summary: the About blurb (Kavita `/api/Series/metadata` summary HTML-stripped; ABS description).
     * publisher: Kavita `publishers[0].name` / ABS `media.metadata.publisher`. isbn: ABS
     * `media.metadata.isbn` (Kavita ISBNs live in the heavier series-detail call we skip → null — the
     * M2 caveat; populated-value-gated in the UI). file_count: ABS `media.numAudioFiles` (Kavita null).
     * All nullable — an un-enriched row or a source with no value degrades to null (section collapses).
     */
    summary: text('summary'),
    publisher: text('publisher'),
    isbn: text('isbn'),
    fileCount: integer('file_count'),
    /**
     * Enrichment bookkeeping (the books-sync change-gate): the instant the per-series Kavita metadata
     * call last ran for this row. Null ⇒ never enriched (a new / pre-feature row) ⇒ the next sync
     * enriches it; thereafter a Kavita series is re-enriched ONLY when its `source_updated_at` changes,
     * so the hourly sync issues no per-series call for the ~1,400 unchanged series. ABS rows set it
     * every run (their enrichment rides the existing list read — free).
     */
    metadataSyncedAt: timestamp('metadata_synced_at', { withTimezone: true }),
    /** Source-specific extras (Kavita format int; ABS numTracks/numChapters/language) — honest catch-all. */
    attrs: jsonb('attrs').$type<Record<string, unknown>>().notNull().default({}),
    /** When the server first had this item (Kavita `created` / ABS `addedAt`). Nullable. */
    sourceAddedAt: timestamp('source_added_at', { withTimezone: true }),
    /** Last change on the server (Kavita `lastChapterAddedUtc` / ABS `updatedAt`). Nullable. */
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    // Sync bookkeeping (mirrors media_items).
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    /** TOMBSTONE: set when the item vanished from the server; null = live (the wall shows live only). */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'books_items_source_enum',
      sql`${t.source} = ANY (ARRAY[${sql.raw(BOOKS_SOURCES_SQL_LIST)}])`,
    ),
    check(
      'books_items_media_kind_enum',
      sql`${t.mediaKind} = ANY (ARRAY[${sql.raw(BOOKS_MEDIA_KINDS_SQL_LIST)}])`,
    ),
    unique('books_items_source_external_unique').on(t.source, t.externalId),
    index('books_items_kind_sort_idx').on(t.mediaKind, t.sortTitle),
    index('books_items_kind_live_idx').on(t.mediaKind, t.deletedAt),
  ],
);

export type BooksItemRow = typeof booksItems.$inferSelect;
export type BooksItemInsert = typeof booksItems.$inferInsert;
