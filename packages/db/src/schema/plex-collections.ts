import { pgTable, uuid, text, integer, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { plexLibraries } from './plex-libraries';

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
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Identity — the sync upserts on this key; the drill-in resolves a ?group=<ratingKey> through it.
    unique('plex_collections_library_rating_key_unique').on(t.plexLibraryId, t.ratingKey),
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
    /** The member TITLE's ratingKey (the media_plex_matches join key within the owning library). */
    ratingKey: text('rating_key').notNull(),
    /** Position in the source /children read (0-based). Stored, unconsumed in v1 (D-07). */
    sortOrder: integer('sort_order').notNull().default(0),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Identity — the sync upserts on this key.
    unique('plex_collection_members_collection_rating_key_unique').on(t.collectionId, t.ratingKey),
    // The drill-in predicate + group counts join members by (collection, member) and by rating_key.
    index('plex_collection_members_rating_key_idx').on(t.ratingKey),
  ],
);

export type PlexCollectionMemberRow = typeof plexCollectionMembers.$inferSelect;
export type PlexCollectionMemberInsert = typeof plexCollectionMembers.$inferInsert;
