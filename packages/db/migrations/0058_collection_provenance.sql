-- Collection PROVENANCE (owner directive 2026-07-16 — "tagging collections for what created them").
-- ADDITIVE only.
--   • plex_collections.created_by — the software that created the Plex collection: 'kometa' (the
--     collection carries Kometa's Plex label, verified live) / 'plex' (unlabelled, hand-made) /
--     NULL (the label read did not run this sync). NULLABLE + OPEN (no CHECK) on purpose: the
--     vocabulary belongs to external software the app does not own, and a null preserves the prior
--     value on the next upsert so a transient label-read failure never re-tags a collection.
--   • books_collections.created_by — the software that created the book collection: 'libretto' (the
--     source description carries Libretto's [libretto:<recipeId>] marker) / 'kavita' / 'audiobookshelf'
--     (unmarked, hand-made in the source app). OPEN text like above.
-- Both columns are a rebuildable DERIVED-CACHE annotation (the collection_type class): recomputed
-- from the source at every collections-sync / books-collections-sync upsert by the versioned
-- @hnet/domain provenance deriver, so every pre-existing mirror row starts NULL and the NEXT sync
-- fills the whole estate — no backfill needed here.
-- A down-migration drops both columns.
ALTER TABLE "plex_collections" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "books_collections" ADD COLUMN "created_by" text;
