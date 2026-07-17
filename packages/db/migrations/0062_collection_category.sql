-- DESIGN-035 D-10' / PRD R-214 — the label-driven collection CATEGORY.
--
-- The title-only Collection Type classifier (migration 0055) is replaced by a label-driven one:
-- the owner deliberately labels every collection in Kometa and the app derives ONE free-form
-- category from those labels (@hnet/domain deriveCollectionCategory). The category vocabulary is
-- therefore OPEN — a new owner label becomes a new chip with zero migration — so the closed
-- six-bucket CHECK enum is retired and the column becomes nullable free text.
--
--   1. DROP the `plex_collections_collection_type_enum` CHECK (the closed vocabulary is gone).
--   2. RENAME `collection_type` -> `category` (same annotation, now open).
--   3. DROP the NOT NULL + 'other' DEFAULT (null = no owner/section label OR label read not run
--      this sync; the sync writer COALESCE-preserves the prior value on null).
--
-- No value backfill: `category` is a rebuildable derived annotation recomputed from the
-- collection's labels at the NEXT collections-sync upsert (the whole column re-derives), exactly
-- like the derived-cache row it sits on. The stale title-derived values are simply overwritten.
ALTER TABLE "plex_collections" DROP CONSTRAINT "plex_collections_collection_type_enum";--> statement-breakpoint
ALTER TABLE "plex_collections" RENAME COLUMN "collection_type" TO "category";--> statement-breakpoint
ALTER TABLE "plex_collections" ALTER COLUMN "category" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plex_collections" ALTER COLUMN "category" DROP DEFAULT;
