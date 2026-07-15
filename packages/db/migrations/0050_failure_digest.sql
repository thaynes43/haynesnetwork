-- ADR-060 follow-up (PLAN-048 tail — the nightly admin failure digest, 2026-07-15). Parity CHECK
-- rebuilds ONLY (the 0024/0030/0033/0040/0041/0048/0049 relax pattern):
--   • NOTIFY_OUTBOX_EVENT_TYPES grows 'activity_failure_digest' — the ONE nightly email-channel row
--     the failure-digest sync mode enqueues when OPEN activity_import_failures exist.
--   • SYNC_RUN_KINDS grows 'failure-digest' (the mode writes NO sync_runs row; CLI parser parity).
-- A down-migration reverts the two CHECKs (delete any activity_failure_digest outbox row first).
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_event_type_enum";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_event_type_enum" CHECK ("notification_outbox"."event_type" = ANY (ARRAY['batch_created','batch_leaving_soon','batch_leaving_soon_reminder','batch_final_warning','batch_swept','smart_degraded','smart_recovered','ticket_created','mam_gate_paused','mam_gate_resumed','mam_gate_stuck','activity_import_failed','ticket_replied','ticket_status_changed','activity_failure_digest']));--> statement-breakpoint
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync','activity-scan','failure-digest']));
