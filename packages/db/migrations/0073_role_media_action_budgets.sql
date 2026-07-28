-- ADR-080 (PLAN-041 Gap B — per-role media-action rate budgets). Journal idx 72.
-- The one budget mechanism every media family (arr Fix/Force-Search, book Fix/Force-Search, and the
-- coming ytdl leg) draws: ONE per-role number, applied INDEPENDENTLY to each existing pool. Row
-- identity is the role (role_id PK, FK → roles ON DELETE CASCADE). fix_per_hour is CHECK-bounded
-- 0..1000 (0 = the documented emergency block for that role's non-admin media actions, C-05).
-- No seed rows: absence resolves to the code fallback 25 (today's constant), so deploy is zero-change
-- (ADR-080 C-03). Written ONLY by the @hnet/domain setRoleMediaActionBudget single-writer, which
-- co-writes an update_media_action_budget permission_audit row (before/after) in the SAME transaction
-- (hard rule 6); guard-listed in no-direct-state-writes. A down-migration drops the table (and reverts
-- the permission_audit CHECK below — delete any update_media_action_budget rows first).
CREATE TABLE "role_media_action_budgets" (
	"role_id" uuid PRIMARY KEY NOT NULL,
	"fix_per_hour" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_media_action_budgets_range" CHECK ("role_media_action_budgets"."fix_per_hour" >= 0 AND "role_media_action_budgets"."fix_per_hour" <= 1000)
);
--> statement-breakpoint
ALTER TABLE "role_media_action_budgets" ADD CONSTRAINT "role_media_action_budgets_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Rebuild the permission_audit action CHECK to admit 'update_media_action_budget' (the migration 0066
-- idiom — drop + re-add the whole enum list, mirroring PERMISSION_AUDIT_ACTIONS in enums.ts). Additive.
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level','assign_pending_role','update_bulletin_views','link_integration','unlink_integration','request_book_search','request_book_fix','update_book_actions','activity_retry_import','activity_force_search','update_activity_actions','update_collection_actions','create_collection_suggestion','review_collection_suggestion','upsert_collection','delete_collection','update_media_action_budget']));
