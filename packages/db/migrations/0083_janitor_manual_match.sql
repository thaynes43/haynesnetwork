-- ADR-083 / DESIGN-046 D-12 (PLAN-065 — Q-01, the janitor's Lidarr classification). Journal idx 82.
-- ADDITIVE: arr_queue_cleanup_actions.action_class admits `manual_match`: Lidarr could not match the downloaded
-- files to an album with confidence ("Album match is not close enough…", "Has missing tracks", "Couldn't find
-- similar album…"), so only a person can decide. Report only, like `unknown`: it has no enforce cell and is never
-- acted on. No new table or column. The list is built from QUEUE_CLEANUP_ACTION_CLASSES (enums.ts). The previous
-- image never writes the value, so it runs unchanged against this CHECK. A down-migration restores the 0075 CHECK
-- after moving rows with the value back to `unknown` (their class before D-12).
ALTER TABLE "arr_queue_cleanup_actions" DROP CONSTRAINT "arr_queue_cleanup_actions_class_enum";--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD CONSTRAINT "arr_queue_cleanup_actions_class_enum" CHECK ("arr_queue_cleanup_actions"."action_class" = ANY (ARRAY['have_better','retry_import','bad_release','manual_match','unknown']));
