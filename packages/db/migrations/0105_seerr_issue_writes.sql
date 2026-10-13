-- ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7, the owner's Q-02 ruling: comment and resolve as a dedicated Seerr user).
-- Journal idx 104. ADDITIVE, four parts:
-- (1) seerr_issue_writes: the Seerr Issue bridge's comment and resolve, one row per issue and kind ever (unique), the
--     row committed as `intended` before the Seerr call and completed after it. Single writer
--     packages/domain/src/seerr-issue-writes.ts. A write never names Seerr user 1 (the owner's account).
-- (2) fix_requests.seerr_issue_id: the open Seerr issue a Fix answers (the guide opened from its report), beside
--     repair_requests.seerr_issue_id (0099), which P7 starts to set. Both get a partial index.
-- (3) app_settings.key admits 'seerr_issue_bridge' (the bridge user and the comment and resolve switches; absent means
--     nothing is ever written to Seerr).
-- The previous image never reads the new table or column and never writes the new key, so it runs unchanged against
-- this schema. A down-migration drops the table, the column and the indexes, deletes any 'seerr_issue_bridge' row and
-- restores the 0098 CHECK.
CREATE TABLE "seerr_issue_writes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seerr_issue_id" integer NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'intended' NOT NULL,
	"body" text NOT NULL,
	"seerr_user_id" integer NOT NULL,
	"seerr_comment_id" integer,
	"repair_request_id" uuid,
	"fix_request_id" uuid,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_error" text,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "seerr_issue_writes_kind_enum" CHECK ("seerr_issue_writes"."kind" = ANY (ARRAY['comment','resolve'])),
	CONSTRAINT "seerr_issue_writes_state_enum" CHECK ("seerr_issue_writes"."state" = ANY (ARRAY['intended','done','failed','skipped'])),
	CONSTRAINT "seerr_issue_writes_not_owner" CHECK ("seerr_issue_writes"."seerr_user_id" > 1),
	CONSTRAINT "seerr_issue_writes_done_at_iff_done" CHECK (("seerr_issue_writes"."state" = 'done') = ("seerr_issue_writes"."done_at" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "seerr_issue_writes" ADD CONSTRAINT "seerr_issue_writes_seerr_issue_id_seerr_issues_seerr_issue_id_fk" FOREIGN KEY ("seerr_issue_id") REFERENCES "public"."seerr_issues"("seerr_issue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seerr_issue_writes" ADD CONSTRAINT "seerr_issue_writes_repair_request_id_repair_requests_id_fk" FOREIGN KEY ("repair_request_id") REFERENCES "public"."repair_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seerr_issue_writes" ADD CONSTRAINT "seerr_issue_writes_fix_request_id_fix_requests_id_fk" FOREIGN KEY ("fix_request_id") REFERENCES "public"."fix_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seerr_issue_writes_issue_kind_uq" ON "seerr_issue_writes" ("seerr_issue_id","kind");--> statement-breakpoint
CREATE INDEX "seerr_issue_writes_state_idx" ON "seerr_issue_writes" ("state");--> statement-breakpoint
-- The open Seerr issue a Fix answers (P7), beside repair_requests.seerr_issue_id.
ALTER TABLE "fix_requests" ADD COLUMN "seerr_issue_id" integer;--> statement-breakpoint
CREATE INDEX "fix_requests_seerr_issue_idx" ON "fix_requests" ("seerr_issue_id") WHERE "fix_requests"."seerr_issue_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "repair_requests_seerr_issue_idx" ON "repair_requests" ("seerr_issue_id") WHERE "repair_requests"."seerr_issue_id" IS NOT NULL;--> statement-breakpoint
-- app_settings.key admits 'seerr_issue_bridge' (ADR-111 C-03: the bridge user and its kill switch).
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','trash_relink_enabled','motd','space_targets','space_policy','notify_window','pool_refresh_after_save','final_warning','upload_capacity_mbps','download_capacity_mbps','authentik_owned_groups','authentik_group_map','collection_size_cap','mam_governor_config','arr_queue_cleanup_config','seerr_watchlist_enroll','repair_guide_remedies','playback_known_issue_servers','seerr_issue_bridge']));
