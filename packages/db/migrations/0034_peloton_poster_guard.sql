-- ADR-043 / DESIGN-021 (PLAN-024 — Peloton poster guard). Two ADDITIVE changes:
--   • poster_guard_applications — the APPEND-ONLY apply ledger the `poster-guard` sync mode writes: one
--     row every time it (re-)pushes a durable override poster to a k8plex Peloton show/season. It is
--     BOTH the drift baseline (the newest row per rating_key records the Plex thumb path observed right
--     AFTER our upload + the sha256 of the bytes we pushed) AND the audit trail (reason + previous_thumb).
--     Written ONLY by @hnet/domain runPelotonPosterGuard (guard-listed), which inserts the row in the SAME
--     transaction it records the apply. Bytes never land here — the override PNGs live in the image
--     (ADR-043 C-01); this table stores only their identity + provenance.
--   • SYNC_RUN_KINDS grows 'poster-guard' — the guard mode. Like the alert modes it writes NO sync_runs
--     row (this ledger IS its audit trail); the CHECK rebuild is PARITY-ONLY, so the CLI --mode parser
--     (which validates against SYNC_RUN_KINDS) accepts --mode=poster-guard.
-- No existing table is altered destructively; a down-migration drops poster_guard_applications and reverts
-- the sync_runs.run_kind CHECK (drop any poster-guard run first).
CREATE TABLE "poster_guard_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"rating_key" text NOT NULL,
	"target_kind" text NOT NULL,
	"show_title" text NOT NULL,
	"season_index" integer,
	"asset_name" text NOT NULL,
	"asset_sha256" text NOT NULL,
	"reason" text NOT NULL,
	"previous_thumb" text,
	"applied_thumb" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "poster_guard_applications_target_kind_enum" CHECK ("poster_guard_applications"."target_kind" = ANY (ARRAY['show','season'])),
	CONSTRAINT "poster_guard_applications_reason_enum" CHECK ("poster_guard_applications"."reason" = ANY (ARRAY['initial','drift','asset-updated']))
);
--> statement-breakpoint
-- Drift detection reads the newest row per target every run — index the (rating_key, created_at DESC) lookup.
CREATE INDEX "poster_guard_applications_rating_key_created_idx" ON "poster_guard_applications" USING btree ("rating_key","created_at" DESC);--> statement-breakpoint
-- sync_runs.run_kind admits 'poster-guard' — the guard mode brackets its run with a sync_runs row. The
-- CHECK is kept in lockstep with the SYNC_RUN_KINDS const array + the CLI --mode parser.
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard']));
