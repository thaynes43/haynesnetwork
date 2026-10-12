-- ADR-109 C-04, C-05 / DESIGN-055 D-02, D-07 / DESIGN-046 D-27 (PLAN-077 P2). Journal idx 98. ADDITIVE, four parts:
-- (1) repair_requests (T-302): the audited record of one remedy a person confirmed in the Repair Guide; P2 writes
--     kind `import_download` (the Import Check's ManualImport). Single writer packages/domain/src/repair-requests.ts.
-- (2) ledger_events.event_type admits `repair_requested`, `repair_completed` and `repair_failed` (built from
--     LEDGER_EVENT_TYPES, enums.ts).
-- (3) arr_queue_cleanup_actions.action_class admits `importable` and `title_mismatch` (QUEUE_CLEANUP_ACTION_CLASSES).
-- (4) arr_queue_cleanup_actions.action admits `imported` (QUEUE_CLEANUP_ACTIONS).
-- The previous image never writes the new values and never reads the new table, so it runs unchanged against this
-- schema. A down-migration drops the table, deletes rows with the new values, then restores the 0022 and 0085 CHECKs.
CREATE TABLE "repair_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid,
	"media_item_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"season_number" integer,
	"target_child_ids" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"target_label" text,
	"reason" text,
	"preview" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"actions_taken" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seerr_issue_id" integer,
	"fix_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "repair_requests_kind_enum" CHECK ("repair_requests"."kind" = ANY (ARRAY['remap','import_download','release_pick','audio_preference','language_search'])),
	CONSTRAINT "repair_requests_scope_enum" CHECK ("repair_requests"."scope" = ANY (ARRAY['item','season','episode'])),
	CONSTRAINT "repair_requests_status_enum" CHECK ("repair_requests"."status" = ANY (ARRAY['pending','actioned','completed','refused','failed','timed_out'])),
	CONSTRAINT "repair_requests_reason_enum" CHECK ("repair_requests"."reason" IS NULL OR "repair_requests"."reason" = ANY (ARRAY['wont_play_corrupt','wrong_language','wrong_version_quality','missing_subtitles','wrong_content','other'])),
	CONSTRAINT "repair_requests_season_iff_tv" CHECK (("repair_requests"."scope" = 'item' AND "repair_requests"."season_number" IS NULL) OR ("repair_requests"."scope" <> 'item' AND "repair_requests"."season_number" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "repair_requests" ADD CONSTRAINT "repair_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_requests" ADD CONSTRAINT "repair_requests_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repair_requests" ADD CONSTRAINT "repair_requests_fix_request_id_fix_requests_id_fk" FOREIGN KEY ("fix_request_id") REFERENCES "public"."fix_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "repair_requests_requester_created_idx" ON "repair_requests" ("requester_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "repair_requests_item_idx" ON "repair_requests" ("media_item_id");--> statement-breakpoint
CREATE INDEX "repair_requests_status_idx" ON "repair_requests" ("status");--> statement-breakpoint
ALTER TABLE "ledger_events" DROP CONSTRAINT "ledger_events_event_type_enum";--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_event_type_enum" CHECK ("ledger_events"."event_type" = ANY (ARRAY['grabbed','imported','deleted','download_failed','requested','fix_requested','fix_actioned','fix_completed','fix_failed','restored','search_requested','trash_excluded','trash_expedited','trash_restored','trash_batch_transition','trash_space_policy','repair_requested','repair_completed','repair_failed']));--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" DROP CONSTRAINT "arr_queue_cleanup_actions_class_enum";--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD CONSTRAINT "arr_queue_cleanup_actions_class_enum" CHECK ("arr_queue_cleanup_actions"."action_class" = ANY (ARRAY['have_better','retry_import','bad_release','manual_match','leftover','fail_loop','importable','title_mismatch','unknown']));--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" DROP CONSTRAINT "arr_queue_cleanup_actions_action_enum";--> statement-breakpoint
ALTER TABLE "arr_queue_cleanup_actions" ADD CONSTRAINT "arr_queue_cleanup_actions_action_enum" CHECK ("arr_queue_cleanup_actions"."action" = ANY (ARRAY['none','removed_blocklisted','retried_import','blocklisted_searched','skipped_young','skipped_cap','skipped_mixed','skipped_gone','skipped_loop','skipped_unblockable','removed_leftover','skipped_seeding','imported']));
