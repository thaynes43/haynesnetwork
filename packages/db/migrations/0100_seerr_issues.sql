-- ADR-111 C-01 / ADR-112 C-02 / DESIGN-055 D-10, D-12 (PLAN-077 P3). Journal idx 99. ADDITIVE, three parts:
-- (1) seerr_issues (T-311): the read-only mirror of every Seerr issue, plus the staff columns ("fixed by hand" and the
--     note naming the missing capability). Single writer packages/domain/src/seerr-issues.ts.
-- (2) sync_runs.run_kind admits 'seerr-issues' (parity only: the mode writes no sync_runs row).
-- (3) permission_audit.action admits 'update_seerr_issue_note' (the staff note's audit row, same transaction).
-- The previous image never writes the new values and never reads the new table, so it runs unchanged against this
-- schema. A down-migration drops the table, deletes audit rows with the new action, then restores the 0081 and 0073
-- CHECKs.
CREATE TABLE "seerr_issues" (
	"seerr_issue_id" integer PRIMARY KEY NOT NULL,
	"issue_type" smallint NOT NULL,
	"status" text NOT NULL,
	"problem_season" integer DEFAULT 0 NOT NULL,
	"problem_episode" integer DEFAULT 0 NOT NULL,
	"media_type" text,
	"tmdb_id" integer,
	"tvdb_id" integer,
	"media_item_id" uuid,
	"target_child_id" integer,
	"reporter_seerr_user_id" integer,
	"reporter_name" text,
	"reporter_user_id" uuid,
	"message" text,
	"comment_count" integer DEFAULT 0 NOT NULL,
	"seerr_created_at" timestamp with time zone NOT NULL,
	"seerr_updated_at" timestamp with time zone NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"staff_handled_at" timestamp with time zone,
	"staff_handled_by" uuid,
	"staff_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seerr_issues_status_enum" CHECK ("seerr_issues"."status" = ANY (ARRAY['open','resolved'])),
	CONSTRAINT "seerr_issues_type_enum" CHECK ("seerr_issues"."issue_type" = ANY (ARRAY[1,2,3,4])),
	CONSTRAINT "seerr_issues_media_type_enum" CHECK ("seerr_issues"."media_type" IS NULL OR "seerr_issues"."media_type" = ANY (ARRAY['movie','tv'])),
	CONSTRAINT "seerr_issues_problem_nonnegative" CHECK ("seerr_issues"."problem_season" >= 0 AND "seerr_issues"."problem_episode" >= 0),
	CONSTRAINT "seerr_issues_handled_has_note" CHECK ("seerr_issues"."staff_handled_at" IS NULL OR ("seerr_issues"."staff_note" IS NOT NULL AND length(btrim("seerr_issues"."staff_note")) > 0))
);--> statement-breakpoint
ALTER TABLE "seerr_issues" ADD CONSTRAINT "seerr_issues_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seerr_issues" ADD CONSTRAINT "seerr_issues_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seerr_issues" ADD CONSTRAINT "seerr_issues_staff_handled_by_users_id_fk" FOREIGN KEY ("staff_handled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "seerr_issues_item_idx" ON "seerr_issues" ("media_item_id");--> statement-breakpoint
CREATE INDEX "seerr_issues_status_idx" ON "seerr_issues" ("status");--> statement-breakpoint
CREATE INDEX "seerr_issues_created_idx" ON "seerr_issues" ("seerr_created_at" DESC);--> statement-breakpoint
-- sync_runs.run_kind admits 'seerr-issues' (parity only: the mode writes no sync_runs row).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync','activity-scan','failure-digest','collections-sync','format-pairing','books-collections-sync','queue-cleanup','watch','watchlist-registry','seerr-issues']));--> statement-breakpoint
-- permission_audit.action admits 'update_seerr_issue_note' (ADR-112 C-02: the staff note's audit row).
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level','assign_pending_role','update_bulletin_views','link_integration','unlink_integration','request_book_search','request_book_fix','update_book_actions','activity_retry_import','activity_force_search','update_activity_actions','update_collection_actions','create_collection_suggestion','review_collection_suggestion','upsert_collection','delete_collection','update_media_action_budget','update_seerr_issue_note']));
