-- ADR-072 / DESIGN-043 D-14/D-15 / PLAN-052 PR4a (2026-07-18) — collections become DIRECT-ADD; the
-- suggest→approve machinery is torn down. Four changes, all additive-or-teardown, no destructive data
-- loss beyond the (dead) suggestion aggregate the owner rejected:
--
--   1. DROP the collection_suggestions table (the retired propose→approve aggregate — ADR-072 killed it).
--   2. Rebuild role_collection_action_grants.action from the suggest/manage/acquire triad to a single
--      `find_missing` action (the per-collection acquisition-knob gate). The old grant rows are cleared
--      FIRST (their actions no longer satisfy the new CHECK); the grid ships Admin-only (empty) — PR4c.
--   3. Widen permission_audit.action to admit the two direct-write audit actions (upsert_collection,
--      delete_collection). The retired suggestion audit actions STAY in the enum so the CHECK never
--      rejects the append-only history rows those events already wrote.
--   4. Add tickets.collection_override_payload (jsonb, nullable) — the over-cap ticket carries the FULL
--      requested collection definition so an admin Approve materializes it unbounded (D-11).
--
-- A down-migration recreates collection_suggestions, restores the suggest/manage/acquire CHECK, drops the
-- payload column, and narrows permission_audit — safe only if no rows use the new values.

-- 1. Drop the retired suggestion aggregate (CASCADE clears its indexes/constraints).
DROP TABLE IF EXISTS "collection_suggestions";--> statement-breakpoint

-- 2. Rebuild the collection action grant set → `find_missing` (clear the old triad rows first).
DELETE FROM "role_collection_action_grants";--> statement-breakpoint
ALTER TABLE "role_collection_action_grants" DROP CONSTRAINT "role_collection_action_grants_action_enum";--> statement-breakpoint
ALTER TABLE "role_collection_action_grants" ADD CONSTRAINT "role_collection_action_grants_action_enum" CHECK ("role_collection_action_grants"."action" = ANY (ARRAY['find_missing']));--> statement-breakpoint

-- 3. Widen the permission_audit action set (keep every historical value; add the two direct-write ones).
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level','assign_pending_role','update_bulletin_views','link_integration','unlink_integration','request_book_search','request_book_fix','update_book_actions','activity_retry_import','activity_force_search','update_activity_actions','update_collection_actions','create_collection_suggestion','review_collection_suggestion','upsert_collection','delete_collection']));--> statement-breakpoint

-- 4. The over-cap ticket's full requested-collection definition payload (null for every other category).
ALTER TABLE "tickets" ADD COLUMN "collection_override_payload" jsonb;
