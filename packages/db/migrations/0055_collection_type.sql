-- DESIGN-035 D-10 / PRD R-214 (PLAN-053 — Collection Type facet). ADDITIVE only.
--   • plex_collections.collection_type — the owner-ruled six-bucket ANNOTATION (T-186):
--     'trilogy' / 'franchise_universe' / 'director' / 'actor' / 'list' / 'other'
--     (2026-07-16 rulings, FINAL — producer/writer fold into 'director'). NOT NULL DEFAULT
--     'other': every pre-existing mirror row starts honestly un-bucketed and the NEXT
--     collections-sync re-annotates the whole estate — the column is recomputed from the title
--     at every upsert by the versioned @hnet/domain classifier (classifyCollectionType), so it
--     is rebuildable exactly like the derived-cache row it sits on (no backfill needed here).
--   • CHECK kept in parity with the @hnet/db COLLECTION_TYPES const array.
-- A down-migration drops the CHECK then the column.
ALTER TABLE "plex_collections" ADD COLUMN "collection_type" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "plex_collections" ADD CONSTRAINT "plex_collections_collection_type_enum" CHECK ("plex_collections"."collection_type" = ANY (ARRAY['trilogy','franchise_universe','director','actor','list','other']));
