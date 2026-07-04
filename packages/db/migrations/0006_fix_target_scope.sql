-- DESIGN-005 D-09 (media-hierarchy actions) — Fix Requests gain a target SCOPE so a
-- Fix can repair a whole sonarr SEASON (roll-up), not only a single episode/album.
--   * target_scope: 'item' (radarr movie / whole unit) | 'episode' | 'album' (single
--     child) | 'season' (a whole sonarr season). Whole-show / whole-artist stay
--     Force-Search-only (no fix_requests row — D-15), so they are not scopes here.
--   * target_season: the sonarr season number, set IFF scope = 'season' (child null).
-- The scope + season also feed the open-fix dedupe key so two different seasons of one
-- show (both carrying a null child id) no longer collide.
ALTER TABLE "fix_requests" ADD COLUMN "target_scope" text DEFAULT 'item' NOT NULL;--> statement-breakpoint
ALTER TABLE "fix_requests" ADD COLUMN "target_season" integer;--> statement-breakpoint
-- Backfill existing rows from their kind + child id (fresh feature ⇒ usually none):
-- a child id means episode (sonarr) or album (lidarr); no child means the radarr movie.
UPDATE "fix_requests" f SET "target_scope" = CASE
  WHEN f."target_arr_child_id" IS NULL THEN 'item'
  WHEN (SELECT m."arr_kind" FROM "media_items" m WHERE m."id" = f."media_item_id") = 'lidarr' THEN 'album'
  ELSE 'episode'
END;--> statement-breakpoint
ALTER TABLE "fix_requests" ADD CONSTRAINT "fix_requests_target_scope_enum" CHECK ("fix_requests"."target_scope" = ANY (ARRAY['item','season','episode','album']));--> statement-breakpoint
ALTER TABLE "fix_requests" ADD CONSTRAINT "fix_requests_target_season_iff_season" CHECK (
  ("fix_requests"."target_scope" = 'season' AND "fix_requests"."target_season" IS NOT NULL)
  OR ("fix_requests"."target_scope" <> 'season' AND "fix_requests"."target_season" IS NULL));
