-- ADR-083 / DESIGN-046 D-11 (PLAN-065 — the queue janitor acts once per download; issue #583 item 1). Journal idx 81.
-- ADDITIVE: arr_queue_cleanup_actions.action admits two new values. `skipped_mixed`: the record would qualify on its
-- own, but the other records of its download do not all qualify for the same action, so the download is left alone.
-- `skipped_gone`: the removal answered 404 (the *arr no longer tracked the download; not an error). No new table or
-- column. The list is built from QUEUE_CLEANUP_ACTIONS (enums.ts). The previous image never writes either value, so it
-- runs unchanged against this CHECK. A down-migration restores the 0075 CHECK after deleting rows with either value.
ALTER TABLE "arr_queue_cleanup_actions" DROP CONSTRAINT "arr_queue_cleanup_actions_action_enum";--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD CONSTRAINT "arr_queue_cleanup_actions_action_enum" CHECK ("arr_queue_cleanup_actions"."action" = ANY (ARRAY['none','removed_blocklisted','retried_import','blocklisted_searched','skipped_young','skipped_cap','skipped_mixed','skipped_gone']));
