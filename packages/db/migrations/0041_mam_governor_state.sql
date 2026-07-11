-- ADR-054 / DESIGN-027 (PLAN-039 — MAM compliance governor). Three ADDITIVE changes:
--   • mam_gate_state — the SINGLE-ROW (id='mam') gate state the `mam-governor` sync mode upserts each run:
--     whether the LazyLibrarian MAM Torznab provider is currently OPEN (grabs flow) or PAUSED (near the
--     rank cap / fail-closed), plus the qBittorrent-derived counts + the limit/buffer that drove it and
--     the zero-headroom-stuck bookkeeping. Written ONLY by @hnet/domain evaluateMamGovernor (guard-listed);
--     on a gate TRANSITION (open↔paused) or a >48h zero-headroom episode it enqueues one notification_outbox
--     row AND upserts this row in the SAME transaction (the outbox row is the durable transition record —
--     CLAUDE.md hard rule 6). First sight (no row) records a BASELINE and enqueues nothing (a deploy at
--     13/15 headroom writes state without paging). A singleton CHECK pins id='mam'.
--   • SYNC_RUN_KINDS grows 'mam-governor' — the governor mode; parity CHECK rebuild only (like
--     smart-alerts/notify-outbox it writes NO sync_runs row — its trail is the outbox rows + this table).
--   • NOTIFY_OUTBOX_EVENT_TYPES grows 'mam_gate_paused'/'mam_gate_resumed'/'mam_gate_stuck' — the three
--     governor push types (transitions + the pinned-at-0-for-48h alert); CHECK relax (0024/0030/0040 pattern).
-- No existing table is altered destructively; a down-migration drops mam_gate_state and reverts the two
-- CHECKs (drop any mam-governor run / mam_gate_* outbox row first).
CREATE TABLE "mam_gate_state" (
	"id" text PRIMARY KEY DEFAULT 'mam' NOT NULL,
	"gate_open" boolean NOT NULL,
	"count_ok" boolean NOT NULL,
	"unsatisfied_count" integer NOT NULL,
	"downloading_count" integer NOT NULL,
	"seeding_under72_count" integer NOT NULL,
	"limit_value" integer NOT NULL,
	"buffer_value" integer NOT NULL,
	"threshold" integer NOT NULL,
	"headroom" integer NOT NULL,
	"zero_headroom_since" timestamp with time zone,
	"pinned_alerted_at" timestamp with time zone,
	"last_event_type" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mam_gate_state_singleton" CHECK ("mam_gate_state"."id" = 'mam')
);
--> statement-breakpoint
-- sync_runs.run_kind admits 'mam-governor' — the governor mode. Parity only (the mode writes no
-- sync_runs row); the CHECK is kept in lockstep with the const array + the CLI --mode parser.
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor']));--> statement-breakpoint
-- notification_outbox.event_type admits the three governor push types (mirrors the 0024/0030/0040
-- CHECK-relax pattern — drop + re-add with the full ARRAY from the const source-of-truth).
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_event_type_enum";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_event_type_enum" CHECK ("notification_outbox"."event_type" = ANY (ARRAY['batch_created','batch_leaving_soon','batch_leaving_soon_reminder','batch_final_warning','batch_swept','smart_degraded','smart_recovered','ticket_created','mam_gate_paused','mam_gate_resumed','mam_gate_stuck']));
