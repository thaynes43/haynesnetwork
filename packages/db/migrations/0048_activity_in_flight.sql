-- ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight). ADDITIVE changes:
--   • activity_import_failures — the DURABLE import-failure ledger (the ONLY persisted Activity state; the
--     tab + wall badges read LIVE per ADR-059 Q-01). One row per OPEN failure keyed (source, source_ref);
--     written ONLY by @hnet/domain evaluateActivityFailures (the `activity-scan` sync mode). On a NEWLY-seen
--     failure it enqueues one notification_outbox 'activity_import_failed' row AND upserts this row in the
--     SAME transaction (ADR-034 C-01). A cleared failure is CLOSED (resolved_at set), not deleted, so the
--     detail page + audit chain survive. The mam_gate_state / smart_drive_state class (derived, rebuildable).
--   • role_activity_action_grants — the fine-grained Activity ACTION grants (the role_trash_action_grants
--     idiom, ADR-023): a ROW = the action is granted; an is_admin role stores none and implies all. Written
--     by setRoleActivityActions (co-writes an update_activity_actions permission_audit row, hard rule 6).
--   • SYNC_RUN_KINDS grows 'activity-scan'; NOTIFY_OUTBOX_EVENT_TYPES grows 'activity_import_failed';
--     PERMISSION_AUDIT_ACTIONS grows 'activity_retry_import'/'activity_force_search'/'update_activity_actions'
--     — parity CHECK rebuilds only (the 0024/0030/0040/0041 relax pattern; the mode writes NO sync_runs row).
-- A down-migration drops the two tables and reverts the three CHECKs (drop any activity-scan run /
-- activity_import_failed outbox row / activity_* audit row first).
CREATE TABLE "activity_import_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"section" text,
	"failure_kind" text NOT NULL,
	"failure_reason" text,
	"title" text NOT NULL,
	"year" integer,
	"source_app" text,
	"downstream_url" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"notified_at" timestamp with time zone,
	"last_action_at" timestamp with time zone,
	"last_action_by" uuid,
	"last_action" text,
	CONSTRAINT "activity_import_failures_kind_enum" CHECK ("activity_import_failures"."failure_kind" = ANY (ARRAY['stranded_import','postprocess_failed','download_failed','import_blocked']))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "activity_import_failures_source_ref_idx" ON "activity_import_failures" USING btree ("source","source_ref");--> statement-breakpoint
CREATE INDEX "activity_import_failures_open_idx" ON "activity_import_failures" USING btree ("resolved_at","first_seen_at");--> statement-breakpoint
CREATE TABLE "role_activity_action_grants" (
	"role_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_activity_action_grants_role_id_action_pk" PRIMARY KEY("role_id","action"),
	CONSTRAINT "role_activity_action_grants_action_enum" CHECK ("role_activity_action_grants"."action" = ANY (ARRAY['retry_import','force_research']))
);
--> statement-breakpoint
ALTER TABLE "role_activity_action_grants" ADD CONSTRAINT "role_activity_action_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- sync_runs.run_kind admits 'activity-scan' (parity only — the mode writes no sync_runs row).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync','activity-scan']));--> statement-breakpoint
-- notification_outbox.event_type admits 'activity_import_failed' (the 0024/0030/0040/0041 relax pattern).
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_event_type_enum";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_event_type_enum" CHECK ("notification_outbox"."event_type" = ANY (ARRAY['batch_created','batch_leaving_soon','batch_leaving_soon_reminder','batch_final_warning','batch_swept','smart_degraded','smart_recovered','ticket_created','mam_gate_paused','mam_gate_resumed','mam_gate_stuck','activity_import_failed']));--> statement-breakpoint
-- permission_audit.action admits the three Activity audit actions.
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level','assign_pending_role','update_bulletin_views','link_integration','unlink_integration','request_book_search','activity_retry_import','activity_force_search','update_activity_actions']));
