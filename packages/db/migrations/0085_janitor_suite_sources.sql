-- ADR-095 / DESIGN-046 D-15..D-20 (PLAN-065 — the queue janitor covers the download suite: LazyLibrarian and Kapowarr
-- through the source adapter seam; owner direction 2026-09-29). Journal idx 84. ADDITIVE, five parts:
-- (1) arr_queue_cleanup_actions.instance admits `lazylibrarian` and `kapowarr` (built from QUEUE_CLEANUP_INSTANCES).
-- (2) queue_item_id drops NOT NULL: LazyLibrarian has no queue, so its rows carry the new `item_ref` instead
--     (`<bookId>/<ebook|audiobook>`); a nullable `attempts` column holds a fail_loop row's failed-grab count.
-- (3) action_class admits `leftover` and `fail_loop` (QUEUE_CLEANUP_ACTION_CLASSES).
-- (4) action admits `removed_leftover` and `skipped_seeding` (QUEUE_CLEANUP_ACTIONS).
-- (5) A partial index on the rows that carry an item_ref: the LazyLibrarian loop guard and fail-loop lookups.
-- The previous image never writes the new values, never names the new columns, and always writes queue_item_id, so it
-- runs unchanged against this schema. A down-migration deletes the rows of the two new instances (every row with a new
-- value or a null queue_item_id is one of theirs), drops the index and the two columns, restores NOT NULL and the 0084
-- CHECKs.
ALTER TABLE "arr_queue_cleanup_actions" DROP CONSTRAINT "arr_queue_cleanup_actions_instance_enum";--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD CONSTRAINT "arr_queue_cleanup_actions_instance_enum" CHECK ("arr_queue_cleanup_actions"."instance" = ANY (ARRAY['sonarr','radarr','lidarr','lazylibrarian','kapowarr']));--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ALTER COLUMN "queue_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD COLUMN "item_ref" text;--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD COLUMN "attempts" integer;--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" DROP CONSTRAINT "arr_queue_cleanup_actions_class_enum";--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD CONSTRAINT "arr_queue_cleanup_actions_class_enum" CHECK ("arr_queue_cleanup_actions"."action_class" = ANY (ARRAY['have_better','retry_import','bad_release','manual_match','leftover','fail_loop','unknown']));--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" DROP CONSTRAINT "arr_queue_cleanup_actions_action_enum";--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD CONSTRAINT "arr_queue_cleanup_actions_action_enum" CHECK ("arr_queue_cleanup_actions"."action" = ANY (ARRAY['none','removed_blocklisted','retried_import','blocklisted_searched','skipped_young','skipped_cap','skipped_mixed','skipped_gone','skipped_loop','skipped_unblockable','removed_leftover','skipped_seeding']));--> statement-breakpoint
CREATE INDEX "arr_queue_cleanup_actions_item_ref_idx" ON "arr_queue_cleanup_actions" USING btree ("instance","item_ref","created_at") WHERE "arr_queue_cleanup_actions"."item_ref" IS NOT NULL;
