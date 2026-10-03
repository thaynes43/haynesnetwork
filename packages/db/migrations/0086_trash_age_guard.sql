-- DESIGN-052 D-26 (the Trash Age Guard; owner ruling 2026-10-03 "Yes, newest date wins"). Journal idx 85. ADDITIVE,
-- two parts:
-- (1) media_plex_matches.plex_added_at: the matched title's Plex `addedAt` in that library (the server's "date added"),
--     stamped by the plex-match sync on every run. Nullable; existing rows read null until the next plex-match run.
-- (2) trash_batch_items.keep_reason admits `recently_added` (TRASH_KEEP_REASONS): the sweep keeps a batch item that was
--     downloaded, upgraded or added to any Plex server in the last 180 days.
-- The previous image never names the column and never writes the new reason, so it runs unchanged against this schema.
-- A down-migration clears `recently_added` reasons to null, restores the 0081 CHECK and drops the column.
ALTER TABLE "media_plex_matches" ADD COLUMN "plex_added_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trash_batch_items" DROP CONSTRAINT "trash_batch_items_keep_reason_enum";--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD CONSTRAINT "trash_batch_items_keep_reason_enum" CHECK ("trash_batch_items"."keep_reason" IS NULL OR "trash_batch_items"."keep_reason" = ANY (ARRAY['tag','recently_watched','watchlisted','unevaluable','not_in_pool','live_excluded','release_unrecorded','recently_added']));
