-- ADR-040 / DESIGN-020 (PLAN-019 Metrics → Hardware + SMART alerting). Three ADDITIVE changes:
--   • smart_drive_state — the per-drive last-known SMART state the `smart-alerts` sync mode diffs
--     against for transition detection. Written ONLY by @hnet/domain evaluateSmartAlerts (guard-
--     listed); on a CRITICAL transition it enqueues one notification_outbox row AND upserts this row
--     in the SAME transaction (the outbox row is the durable transition record). First sight of a
--     drive records a BASELINE and enqueues nothing — the known staging-pool bad state never pages.
--   • SYNC_RUN_KINDS grows 'smart-alerts' — the detector mode; parity CHECK rebuild only (like
--     trash-batch-sweep/space-policy/notify-outbox it writes NO sync_runs row — its trail is the
--     outbox rows + this table).
--   • NOTIFY_OUTBOX_EVENT_TYPES grows 'smart_degraded'/'smart_recovered' — the two hardware push
--     event types (the renderer deep-links `…/metrics?tab=hardware`); CHECK relax (0024/0030 pattern).
-- No existing table is altered destructively; a down-migration drops smart_drive_state and reverts the
-- two CHECKs (drop any smart-alerts run / smart_* outbox row first).
CREATE TABLE "smart_drive_state" (
	"drive_key" text PRIMARY KEY NOT NULL,
	"label" text,
	"pool" text,
	"smart_status" text NOT NULL,
	"wear_pct" integer NOT NULL,
	"media_errors" integer NOT NULL,
	"available_spare" integer NOT NULL,
	"critical_warning" integer NOT NULL,
	"last_event_type" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "smart_drive_state_status_check" CHECK ("smart_drive_state"."smart_status" = ANY (ARRAY['pass','fail']))
);
--> statement-breakpoint
-- sync_runs.run_kind admits 'smart-alerts' — the detector mode. Parity only (the mode writes no
-- sync_runs row); the CHECK is kept in lockstep with the const array + the CLI --mode parser.
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts']));--> statement-breakpoint
-- notification_outbox.event_type admits the two SMART push types (mirrors the 0024/0030 CHECK-relax
-- pattern — drop + re-add with the full ARRAY from the const source-of-truth).
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_event_type_enum";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_event_type_enum" CHECK ("notification_outbox"."event_type" = ANY (ARRAY['batch_created','batch_leaving_soon','batch_leaving_soon_reminder','batch_final_warning','batch_swept','smart_degraded','smart_recovered']));
