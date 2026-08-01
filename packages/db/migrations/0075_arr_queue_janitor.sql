-- ADR-083 / DESIGN-046 (PLAN-065 — *arr queue janitor). Journal idx 74. ADDITIVE changes:
--   • arr_queue_cleanup_actions — the APPEND-ONLY census + action ledger (DESIGN-046 D-06): ONE row per queue
--     item per run (the census record AND the action audit in ONE table). Written ONLY by @hnet/domain
--     evaluateQueueCleanup (the `queue-cleanup` sync mode) — this table IS the janitor's audit trail (NO
--     permission_audit / ledger_events coupling, the poster_guard_applications append-only class). Two indexes
--     per D-06: (created_at) for the digest/tuning read, (instance, download_id, created_at) for retry-
--     escalation counting + "seen before" dedup. CHECKs pin instance / action_class / mode / action / outcome
--     to the APP_SETTING/QUEUE_CLEANUP const-array source of truth (enums.ts).
--   • sync_runs.run_kind admits 'queue-cleanup' (parity only — the mode writes NO sync_runs row); the
--     0024/0030/0048/0056 relax pattern (drop + re-add the full ARRAY from SYNC_RUN_KINDS, now with the new key).
--   • app_settings.key admits 'arr_queue_cleanup_config' — the DB-backed audited janitor config (jsonb
--     { modes, maxActionsPerRun, minItemAgeHours, retryEscalateRuns }) written through the setAppSetting
--     single-writer (audit row same-tx, hard rule 6; setArrQueueCleanupConfig validates first). No row ⇒
--     all-census (observe-only). Same CHECK-rebuild pattern as 0074 (drop + re-add the full APP_SETTING_KEYS
--     array, now including the new key).
-- A down-migration drops the table and reverts the two CHECKs (delete any arr_queue_cleanup_config row first).
CREATE TABLE "arr_queue_cleanup_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance" text NOT NULL,
	"queue_item_id" integer NOT NULL,
	"download_id" text,
	"title" text,
	"action_class" text NOT NULL,
	"mode" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arr_queue_cleanup_actions_instance_enum" CHECK ("arr_queue_cleanup_actions"."instance" = ANY (ARRAY['sonarr','radarr','lidarr'])),
	CONSTRAINT "arr_queue_cleanup_actions_class_enum" CHECK ("arr_queue_cleanup_actions"."action_class" = ANY (ARRAY['have_better','retry_import','bad_release','unknown'])),
	CONSTRAINT "arr_queue_cleanup_actions_mode_enum" CHECK ("arr_queue_cleanup_actions"."mode" = ANY (ARRAY['census','enforce'])),
	CONSTRAINT "arr_queue_cleanup_actions_action_enum" CHECK ("arr_queue_cleanup_actions"."action" = ANY (ARRAY['none','removed_blocklisted','retried_import','blocklisted_searched','skipped_young','skipped_cap'])),
	CONSTRAINT "arr_queue_cleanup_actions_outcome_enum" CHECK ("arr_queue_cleanup_actions"."outcome" = ANY (ARRAY['observed','done','error']))
);
--> statement-breakpoint
CREATE INDEX "arr_queue_cleanup_actions_created_idx" ON "arr_queue_cleanup_actions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "arr_queue_cleanup_actions_download_idx" ON "arr_queue_cleanup_actions" USING btree ("instance","download_id","created_at");--> statement-breakpoint
-- sync_runs.run_kind admits 'queue-cleanup' (parity only — the mode writes no sync_runs row).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync','activity-scan','failure-digest','collections-sync','format-pairing','books-collections-sync','queue-cleanup']));--> statement-breakpoint
-- app_settings.key admits 'arr_queue_cleanup_config' (the 0074 relax pattern).
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd','space_targets','space_policy','notify_window','pool_refresh_after_save','final_warning','upload_capacity_mbps','download_capacity_mbps','authentik_owned_groups','authentik_group_map','collection_size_cap','mam_governor_config','arr_queue_cleanup_config']));
