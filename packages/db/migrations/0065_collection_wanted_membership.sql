-- DESIGN-035 D-16 (2026-07-18) — Wanted-tile membership: the collection view goes from held-only to
-- the FULL intended membership (held on-disk tiles + WANTED not-on-disk tiles). The not-held members
-- come from the *arr-native collection membership (M-a, owner D-D ruling); this migration adds the
-- storage. Movies leg ships now; TV + books stay held-only (no schema difference — the model is
-- medium-neutral).
--
-- `plex_collection_members` grows two disjoint member populations in one table:
--   • HELD rows   — the existing Plex-child members (rating_key set, held=true), unchanged.
--   • WANTED rows — *arr-native titles monitored-but-not-on-disk (media_item_id set, rating_key NULL,
--                   held=false).
--
--   1. rating_key becomes NULLABLE (a wanted member has no Plex ratingKey).
--   2. media_item_id uuid NULL → media_items ON DELETE SET NULL (the resolved ledger item of a wanted
--      member; held rows leave it null and resolve via media_plex_matches at read time).
--   3. held boolean NOT NULL DEFAULT true (every pre-existing row is a held Plex-child member).
--   4. A PARTIAL unique (collection_id, media_item_id) WHERE media_item_id IS NOT NULL keys the wanted
--      rows; the legacy (collection_id, rating_key) unique still keys held rows (nulls-distinct means
--      wanted rows, whose rating_key is NULL, never collide on it).
--   5. An index on media_item_id for the wanted-tile union.
--
-- Additive + rebuildable: the wanted rows are a derived-cache annotation the next collections-sync
-- populates; no backfill. A down-migration drops the two columns, the partial unique, and the index,
-- and restores rating_key NOT NULL (safe only if no wanted rows exist).
ALTER TABLE "plex_collection_members" ALTER COLUMN "rating_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plex_collection_members" ADD COLUMN "media_item_id" uuid;--> statement-breakpoint
ALTER TABLE "plex_collection_members" ADD COLUMN "held" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "plex_collection_members"
  ADD CONSTRAINT "plex_collection_members_media_item_id_fk"
  FOREIGN KEY ("media_item_id") REFERENCES "media_items"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "plex_collection_members_collection_media_item_unique"
  ON "plex_collection_members" ("collection_id", "media_item_id")
  WHERE "media_item_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "plex_collection_members_media_item_idx" ON "plex_collection_members" ("media_item_id");
