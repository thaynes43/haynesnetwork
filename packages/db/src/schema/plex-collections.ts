import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  unique,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { plexLibraries } from './plex-libraries';
import { mediaItems } from './media-items';

/**
 * ADR-064 / DESIGN-035 D-01 (PLAN-037 — mirrored Plex collections). External software (Plex/Kometa)
 * is ALWAYS the source of truth for collections (owner doctrine R1, extending CLAUDE.md hard rule 4)
 * — these tables are the app's MIRROR of them, nothing more. One `plex_collections` row per
 * collection per library; identity is `(plex_library_id, rating_key)` (keys, never names — the
 * plex_libraries rule; a rename re-titles the same row). `child_count` is the RAW Plex member count,
 * kept for diagnostics only — the walls always show the ACCESSIBLE ledger-member count (ADR-064
 * C-03: counts are leak vectors).
 *
 * Rebuildable DERIVED CACHE (the media_plex_matches exemption class): written ONLY by the
 * @hnet/domain `syncPlexCollections` single-writer (guard-listed), which the `collections-sync`
 * mode drives — upsert + reconcile-DELETE scoped to fully-read sections (a partial read never
 * tombstones). No per-row audit event (synced/derived data — the documented no-audit exemption).
 */
export const plexCollections = pgTable(
  'plex_collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The Plex library (section) the collection lives in — scopes reconcile + the member join. */
    plexLibraryId: uuid('plex_library_id')
      .notNull()
      .references(() => plexLibraries.id, { onDelete: 'cascade' }),
    /** The collection's Plex metadata ratingKey (decimal id, kept as text) — the drill-in group key. */
    ratingKey: text('rating_key').notNull(),
    title: text('title').notNull(),
    /** The RAW Plex member count (diagnostics only — never shown; the wall count is access-gated). */
    childCount: integer('child_count').notNull().default(0),
    /**
     * DESIGN-035 D-10' / R-214 (migration 0062) — the OPEN, free-form category ANNOTATION (T-186).
     * Derived from the collection's own Plex LABELS at EVERY sync upsert by the versioned
     * @hnet/domain `deriveCollectionCategory` (owner inline label first, else Kometa's section-label
     * map) — a rebuildable annotation like the row it sits on, never migrated state. Drives the
     * grouped walls' `?ctype=` category chip row + the dynamic categoryCounts. NULLABLE + OPEN (no
     * CHECK, no enum): categories are whatever the owner labels, and a new label becomes a new chip
     * on the next sync with zero migration. A null means either no owner/section label OR that the
     * label read did not run this sync — the writer's COALESCE preserves the prior value on null so a
     * transient read failure never wipes the category (symmetric with `created_by`).
     */
    category: text('category'),
    /**
     * PROVENANCE — the software that CREATED this collection (owner directive 2026-07-16 — "tagging
     * collections for what created them"). Kometa LABELS its managed Plex collections (verified live
     * on the HOps server): a `Kometa`-labelled collection derives 'kometa', an unlabelled one 'plex'
     * (hand-made). Recomputed from the collection's labels at every sync upsert by the versioned
     * @hnet/domain `derivePlexCollectionProvenance` — rebuildable like the row it sits on, never
     * migrated state. NULLABLE + OPEN (no CHECK): the vocabulary belongs to external software the app
     * does not own, and a null means the label read did not run this sync (the writer preserves the
     * prior value rather than misfiling — a transient read failure never re-tags a collection).
     */
    createdBy: text('created_by'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Identity — the sync upserts on this key; the drill-in resolves a ?group=<ratingKey> through it.
    unique('plex_collections_library_rating_key_unique').on(t.plexLibraryId, t.ratingKey),
    // D-10' — `category` is OPEN (free-form, no CHECK): the chip vocabulary is whatever the owner
    // labels in Kometa, derived each sync. A new label needs no migration.
  ],
);

export type PlexCollectionRow = typeof plexCollections.$inferSelect;
export type PlexCollectionInsert = typeof plexCollections.$inferInsert;

/**
 * ADR-064 / DESIGN-035 D-01 — one row per collection member, stored RAW regardless of ledger match
 * (owner R3 mirror-everything: a chart entry the *arrs don't manage still mirrors). `rating_key` is
 * the MEMBER title's ratingKey — the read-time join into `media_plex_matches (plex_library_id,
 * rating_key)` resolves it to a gated ledger item; members with no match are simply invisible on the
 * ledger walls (ADR-064 C-06). `sort_order` records the source-read position (DESIGN-035 D-07 —
 * stored honestly, unconsumed in v1: whether Plex's collectionSort survives the /children read is
 * unverified). Same derived-cache class + single-writer confinement as plex_collections; member
 * reconcile is additionally scoped to FULLY-read collections (D-08 — a truncated read never
 * tombstones members it didn't see).
 */
export const plexCollectionMembers = pgTable(
  'plex_collection_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => plexCollections.id, { onDelete: 'cascade' }),
    /**
     * The member TITLE's ratingKey (the media_plex_matches join key within the owning library) — set
     * on a HELD (Plex-child) member. NULLABLE since DESIGN-035 D-16 (migration 0065): a WANTED member
     * (an *arr-native title not in Plex) has no ratingKey and keys off `media_item_id` instead.
     */
    ratingKey: text('rating_key'),
    /**
     * DESIGN-035 D-16 (migration 0065) — the resolved ledger item for a WANTED member (an *arr-native
     * collection title that is monitored but not on disk). Held Plex-child rows leave this null and
     * resolve their ledger item at read time via media_plex_matches; a wanted row carries it directly
     * (rating_key null, held false). ON DELETE SET NULL — a title leaving the ledger nulls the link.
     */
    mediaItemId: uuid('media_item_id').references(() => mediaItems.id, { onDelete: 'set null' }),
    /**
     * DESIGN-035 D-16 — true = a HELD member (on disk, in the Plex collection); false = a WANTED
     * member (monitored, not on disk — the wanted_items slice of the *arr-native membership). The two
     * populations are disjoint (held from Plex children, wanted from the *arr membership's on_disk=0
     * slice), so the read-model union never double-counts. Defaults true (every legacy row is held).
     */
    held: boolean('held').notNull().default(true),
    /** Position in the source /children read (0-based). Stored, unconsumed in v1 (D-07). */
    sortOrder: integer('sort_order').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Identity of a HELD (Plex-child) member — the sync upserts on this key. rating_key is nullable
    // now (wanted rows carry null here), and Postgres treats nulls as distinct, so wanted rows never
    // collide on this unique; they are keyed by the partial unique below instead.
    unique('plex_collection_members_collection_rating_key_unique').on(t.collectionId, t.ratingKey),
    // DESIGN-035 D-16 — identity of a WANTED member (media_item_id set, rating_key null). Partial so
    // it only constrains the *arr-native rows.
    uniqueIndex('plex_collection_members_collection_media_item_unique')
      .on(t.collectionId, t.mediaItemId)
      .where(sql`${t.mediaItemId} IS NOT NULL`),
    // The drill-in predicate + group counts join members by (collection, member) and by rating_key.
    index('plex_collection_members_rating_key_idx').on(t.ratingKey),
    // The wanted-tile union joins by the resolved ledger item.
    index('plex_collection_members_media_item_idx').on(t.mediaItemId),
  ],
);

export type PlexCollectionMemberRow = typeof plexCollectionMembers.$inferSelect;
export type PlexCollectionMemberInsert = typeof plexCollectionMembers.$inferInsert;
