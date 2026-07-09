-- ADR-034 / DESIGN-015 (PLAN-016 Pushover batch-lifecycle notifications). All ADDITIVE:
--   • notification_outbox — the transactional OUTBOX. A batch writer enqueues a row here in the SAME
--     transaction as its state transition (enqueueOutbox, guard-listed single-writer); the
--     notify-outbox sync mode drains DUE rows (sent_at IS NULL AND attempts < 5 AND
--     earliest_send_at <= now()) to api.pushover.net, marking sent_at / backing off on failure.
--   • APP_SETTING_KEYS grows 'notify_window' — the delivery-window jsonb ({startHour,endHour,tz}),
--     written only by the @hnet/domain setAppSetting single-writer (audited); the key CHECK is rebuilt.
--   • SYNC_RUN_KINDS grows 'notify-outbox' — the drainer mode; parity CHECK rebuild only (like
--     trash-batch-sweep/space-policy it writes NO sync_runs row — its trail is the outbox rows).
-- No existing table is altered destructively; a down-migration drops the table + due index and reverts
-- the two CHECKs (drop any notify_window row / notify-outbox run before reverting).
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text DEFAULT 'pushover' NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"earliest_send_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "notification_outbox_channel_enum" CHECK ("notification_outbox"."channel" = ANY (ARRAY['pushover'])),
	CONSTRAINT "notification_outbox_event_type_enum" CHECK ("notification_outbox"."event_type" = ANY (ARRAY['batch_created','batch_leaving_soon','batch_leaving_soon_reminder','batch_swept']))
);
--> statement-breakpoint
-- The drainer's scan: due, not-yet-sent rows oldest-first (partial — sent rows drop out of the index).
CREATE INDEX "notification_outbox_due_idx" ON "notification_outbox" USING btree ("earliest_send_at") WHERE "notification_outbox"."sent_at" IS NULL;--> statement-breakpoint
-- app_settings.key admits 'notify_window' — the delivery-window jsonb (mirrors the 0019/0021/0022
-- CHECK-relax pattern: drop + re-add with the full ARRAY from the const source-of-truth).
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd','space_targets','space_policy','notify_window']));--> statement-breakpoint
-- sync_runs.run_kind admits 'notify-outbox' — the drainer mode. Parity only (the mode writes no
-- sync_runs row); the CHECK is kept in lockstep with the const array + the CLI --mode parser.
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox']));
