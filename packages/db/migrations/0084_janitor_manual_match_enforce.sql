-- ADR-094 / DESIGN-046 D-13 + D-14 (PLAN-065 — the janitor acts on Lidarr's manual_match and blocks the failing
-- release name; owner ruling 2026-09-29). Journal idx 83. ADDITIVE, four parts:
-- (1) arr_queue_cleanup_actions.action admits `skipped_loop` (D-13, the loop guard held an album the janitor already
--     removed as manual_match on 2 earlier downloads) and `skipped_unblockable` (D-14, the release name cannot be
--     blocked safely, so the download is left alone). The list is built from QUEUE_CLEANUP_ACTIONS (enums.ts).
-- (2) A nullable `target_id` column on arr_queue_cleanup_actions: the record's search target (Sonarr episodeId,
--     Radarr movieId, Lidarr albumId); null on every earlier row.
-- (3) A partial index on the rows that landed (outcome done) per target: the loop guard and the repeat-search list.
-- (4) The janitor release block's append-only term records, arr_queue_cleanup_block_terms (D-14).
-- The previous image never writes the new values, never names the new column and never reads the new table, so it runs
-- unchanged against this schema. A down-migration drops the table, the index and the column, then restores the 0082
-- CHECK after deleting rows with either new value.
ALTER TABLE "arr_queue_cleanup_actions" DROP CONSTRAINT "arr_queue_cleanup_actions_action_enum";--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD CONSTRAINT "arr_queue_cleanup_actions_action_enum" CHECK ("arr_queue_cleanup_actions"."action" = ANY (ARRAY['none','removed_blocklisted','retried_import','blocklisted_searched','skipped_young','skipped_cap','skipped_mixed','skipped_gone','skipped_loop','skipped_unblockable']));--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD COLUMN "target_id" integer;--> statement-breakpoint
CREATE INDEX "arr_queue_cleanup_actions_target_done_idx" ON "arr_queue_cleanup_actions" USING btree ("instance","target_id","created_at") WHERE "arr_queue_cleanup_actions"."outcome" = 'done' AND "arr_queue_cleanup_actions"."target_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "arr_queue_cleanup_block_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance" text NOT NULL,
	"term" text NOT NULL,
	"release_title" text,
	"download_id" text,
	"target_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "arr_queue_cleanup_block_terms_instance_enum" CHECK ("arr_queue_cleanup_block_terms"."instance" = ANY (ARRAY['sonarr','radarr','lidarr']))
);--> statement-breakpoint
CREATE INDEX "arr_queue_cleanup_block_terms_live_idx" ON "arr_queue_cleanup_block_terms" USING btree ("instance","expires_at");
