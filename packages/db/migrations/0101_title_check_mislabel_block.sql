-- ADR-110 C-03, C-04, C-05, C-08 / DESIGN-055 D-04, D-05 (PLAN-077 P4). Journal idx 100. ADDITIVE, four parts:
-- (1) title_checks (T-305): the census Title Check, one Title Evidence verdict per imported Sonarr episode file. Single
--     writer packages/domain/src/title-check.ts.
-- (2) mislabel_block_terms (T-310): the Mislabel Block's terms, one live (series, release group) at most, each inserted
--     in the transaction of its profile write and read-back. Single writer packages/domain/src/mislabel-block.ts.
-- (3) sync_runs.run_kind admits 'title-check' (parity only: the mode writes no sync_runs row).
-- (4) permission_audit.action admits 'remove_mislabel_term' (staff removing a term, same transaction).
-- The Episode Re-map itself needs no schema: repair_requests already admits kind 'remap' (0099), and its kill switch is a
-- key of the repair_guide_remedies jsonb setting. The previous image never writes the new values and never reads the new
-- tables, so it runs unchanged against this schema. A down-migration drops both tables, deletes audit rows with the new
-- action, then restores the 0100 CHECKs.
CREATE TABLE "title_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance" text DEFAULT 'sonarr' NOT NULL,
	"series_id" integer NOT NULL,
	"media_item_id" uuid,
	"season_number" integer NOT NULL,
	"episode_id" integer NOT NULL,
	"episode_ids" integer[] NOT NULL,
	"episode_file_id" integer NOT NULL,
	"source_title" text NOT NULL,
	"verdict" text NOT NULL,
	"best_episode_id" integer,
	"score" real,
	"best_score" real,
	"evidence_version" integer NOT NULL,
	"origin" text NOT NULL,
	"imported_at" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "title_checks_instance_enum" CHECK ("title_checks"."instance" = 'sonarr'),
	CONSTRAINT "title_checks_verdict_enum" CHECK ("title_checks"."verdict" = ANY (ARRAY['agrees','disagrees','silent','ambiguous'])),
	CONSTRAINT "title_checks_origin_enum" CHECK ("title_checks"."origin" = ANY (ARRAY['history','backfill'])),
	CONSTRAINT "title_checks_episode_ids_nonempty" CHECK (cardinality("title_checks"."episode_ids") > 0)
);--> statement-breakpoint
ALTER TABLE "title_checks" ADD CONSTRAINT "title_checks_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "title_checks_file_uq" ON "title_checks" ("instance","episode_file_id");--> statement-breakpoint
CREATE INDEX "title_checks_series_idx" ON "title_checks" ("series_id","season_number");--> statement-breakpoint
CREATE INDEX "title_checks_item_idx" ON "title_checks" ("media_item_id");--> statement-breakpoint
CREATE INDEX "title_checks_imported_idx" ON "title_checks" ("imported_at" DESC);--> statement-breakpoint
CREATE INDEX "title_checks_open_flag_idx" ON "title_checks" ("series_id") WHERE "title_checks"."verdict" = 'disagrees' AND "title_checks"."cleared_at" IS NULL;--> statement-breakpoint
CREATE TABLE "mislabel_block_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance" text DEFAULT 'sonarr' NOT NULL,
	"series_id" integer NOT NULL,
	"media_item_id" uuid,
	"series_title" text NOT NULL,
	"release_group" text NOT NULL,
	"term" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"origin" text NOT NULL,
	"repair_request_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "mislabel_block_terms_instance_enum" CHECK ("mislabel_block_terms"."instance" = 'sonarr'),
	CONSTRAINT "mislabel_block_terms_state_enum" CHECK ("mislabel_block_terms"."state" = ANY (ARRAY['active','expired','removed'])),
	CONSTRAINT "mislabel_block_terms_origin_enum" CHECK ("mislabel_block_terms"."origin" = ANY (ARRAY['remap','adoption'])),
	CONSTRAINT "mislabel_block_terms_ended_iff_inactive" CHECK (("mislabel_block_terms"."state" = 'active') = ("mislabel_block_terms"."ended_at" IS NULL))
);--> statement-breakpoint
ALTER TABLE "mislabel_block_terms" ADD CONSTRAINT "mislabel_block_terms_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mislabel_block_terms" ADD CONSTRAINT "mislabel_block_terms_repair_request_id_repair_requests_id_fk" FOREIGN KEY ("repair_request_id") REFERENCES "public"."repair_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mislabel_block_terms" ADD CONSTRAINT "mislabel_block_terms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mislabel_block_terms_active_uq" ON "mislabel_block_terms" ("instance","series_id",lower("release_group")) WHERE "mislabel_block_terms"."state" = 'active';--> statement-breakpoint
CREATE INDEX "mislabel_block_terms_state_idx" ON "mislabel_block_terms" ("state","expires_at");--> statement-breakpoint
CREATE INDEX "mislabel_block_terms_series_idx" ON "mislabel_block_terms" ("series_id");--> statement-breakpoint
-- sync_runs.run_kind admits 'title-check' (parity only: the mode writes no sync_runs row).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync','activity-scan','failure-digest','collections-sync','format-pairing','books-collections-sync','queue-cleanup','watch','watchlist-registry','seerr-issues','title-check']));--> statement-breakpoint
-- permission_audit.action admits 'remove_mislabel_term' (ADR-110 C-08: staff removing a term).
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level','assign_pending_role','update_bulletin_views','link_integration','unlink_integration','request_book_search','request_book_fix','update_book_actions','activity_retry_import','activity_force_search','update_activity_actions','update_collection_actions','create_collection_suggestion','review_collection_suggestion','upsert_collection','delete_collection','update_media_action_budget','update_seerr_issue_note','remove_mislabel_term']));
