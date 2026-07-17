import { pgTable, uuid, text, integer, boolean, timestamp, unique, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { booksItems } from './books-items';
import {
  BOOKS_COLLECTION_KINDS,
  BOOKS_SOURCES,
  type BooksCollectionKind,
  type BooksSource,
} from './enums';

const BOOKS_SOURCES_SQL = BOOKS_SOURCES.map((v) => `'${v}'`).join(',');
const BOOKS_COLLECTION_KINDS_SQL = BOOKS_COLLECTION_KINDS.map((v) => `'${v}'`).join(',');

/**
 * ADR-066 / DESIGN-038 D-01 (PLAN-051 — books collections mirror). External software (Kavita/ABS)
 * is ALWAYS the source of truth for book collections (owner doctrine R1, the ADR-064 model applied
 * to books) — these tables are the app's MIRROR of them, nothing more. One `books_collections` row
 * per collection per source per kind; identity is **`(source, external_id, kind)`** (a Kavita
 * reading list is a distinct id space from Kavita collections, so `kind` is part of the identity;
 * keys, never names). `ordered` records whether the SOURCE carries an explicit member order
 * (Kavita reading lists + ABS collections: yes, verified; Kavita collections: no — DESIGN-038
 * D-09). `item_count` is the RAW source member count, diagnostics only — the walls always show the
 * resolved live-member count of the wall's kind (never this column). `library_id` is the library
 * scope exactly as the source exposes it (ABS collections carry one; Kavita concepts are
 * server-wide → null).
 *
 * Rebuildable DERIVED CACHE (the plex_collections exemption class): written ONLY by the
 * @hnet/domain `syncBooksCollections` single-writer (guard-listed), which the
 * `books-collections-sync` mode drives — upsert + reconcile-DELETE scoped to fully-read
 * (source, kind) families (a partial read never tombstones). No per-row audit event.
 */
export const booksCollections = pgTable(
  'books_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Which book server serves this collection: 'kavita' | 'audiobookshelf'. */
    source: text('source').$type<BooksSource>().notNull(),
    /** The source's stable id — Kavita collection/reading-list id (as text) / ABS collection uuid. */
    externalId: text('external_id').notNull(),
    /** 'collection' | 'reading_list' — part of the identity (distinct Kavita id spaces). */
    kind: text('kind').$type<BooksCollectionKind>().notNull(),
    /** The source library scope where the source exposes one (ABS `libraryId`); Kavita ⇒ null. */
    libraryId: text('library_id'),
    title: text('title').notNull(),
    /** The RAW source member count (diagnostics only — never shown; the wall count is resolved). */
    itemCount: integer('item_count').notNull().default(0),
    /**
     * Whether the SOURCE carries an explicit member order (DESIGN-038 D-09): Kavita reading lists
     * (explicit `order` + update-position API) and ABS collections (`collectionBook.order ASC`,
     * verified) ⇒ true; Kavita collections (no member-order API) ⇒ false. Drives the drilled
     * wall's default `position` sort — an unordered drill never offers it (the D-06 contract).
     */
    ordered: boolean('ordered').notNull().default(false),
    /**
     * PROVENANCE — the software that CREATED this collection (owner directive 2026-07-16 — "tagging
     * collections for what created them"). Libretto (the "Kometa for books" collection manager)
     * plants a marker `[libretto:<recipeId>]` in the description it writes (Kavita `summary` / ABS
     * `description`): a marked collection derives 'libretto', an unmarked one the SOURCE app that
     * hand-made it ('kavita' / 'audiobookshelf'). Recomputed from the source description at every sync
     * upsert by the versioned @hnet/domain `deriveBooksCollectionProvenance` — rebuildable like the
     * row it sits on. OPEN text (no CHECK), like plex_collections.created_by; never null here (the
     * description rides the same read, so provenance is always derivable — no marker just means
     * hand-made).
     */
    createdBy: text('created_by'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Identity — the sync upserts on this key; ?group=<id> drills by the row uuid (stable app-side).
    unique('books_collections_source_external_kind_unique').on(t.source, t.externalId, t.kind),
    check('books_collections_source_enum', sql`${t.source} = ANY (ARRAY[${sql.raw(BOOKS_SOURCES_SQL)}])`),
    check(
      'books_collections_kind_enum',
      sql`${t.kind} = ANY (ARRAY[${sql.raw(BOOKS_COLLECTION_KINDS_SQL)}])`,
    ),
  ],
);

export type BooksCollectionRow = typeof booksCollections.$inferSelect;
export type BooksCollectionInsert = typeof booksCollections.$inferInsert;

/**
 * ADR-066 / DESIGN-038 D-01 — one row per collection member, stored RAW (the PLAN-037 idiom): the
 * `external_ref` is the source member id (Kavita seriesId as text / ABS library-item uuid — the
 * join key into `books_items (source, external_id)`), kept even when no mirror row exists (a
 * Manga-library series the app doesn't surface still mirrors — ADR-066 C-06). `books_item_id` is
 * the OPPORTUNISTIC resolution, refreshed by every sync against LIVE mirror rows and ON DELETE SET
 * NULL (the raw ref survives an item hard-delete). `position` semantics per source are DESIGN-038
 * D-09 (explicit order for reading lists — chapter-grain deduped to series grain at the EARLIEST
 * order; verified array order for ABS; honest-but-unconsumed response order for Kavita
 * collections). Same derived-cache class + single-writer confinement as books_collections; member
 * reconcile is additionally scoped to FULLY-read collections (a failed/truncated member read never
 * tombstones members it didn't see).
 */
export const booksCollectionMembers = pgTable(
  'books_collection_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => booksCollections.id, { onDelete: 'cascade' }),
    /** The RAW source member id (the books_items (source, external_id) join key). */
    externalRef: text('external_ref').notNull(),
    /** The resolved books_items row, when one exists live at sync time (refreshed every run). */
    booksItemId: uuid('books_item_id').references(() => booksItems.id, { onDelete: 'set null' }),
    /** Member position (0-based; D-09 semantics per source). */
    position: integer('position').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Identity — the sync upserts on this key.
    unique('books_collection_members_collection_external_ref_unique').on(t.collectionId, t.externalRef),
    // The drill-in predicate + group counts join members by their resolved books item.
    index('books_collection_members_books_item_idx').on(t.booksItemId),
  ],
);

export type BooksCollectionMemberRow = typeof booksCollectionMembers.$inferSelect;
export type BooksCollectionMemberInsert = typeof booksCollectionMembers.$inferInsert;
