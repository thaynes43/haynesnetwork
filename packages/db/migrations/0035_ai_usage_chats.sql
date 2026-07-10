-- ADR-044 / DESIGN-022 (PLAN-021 — AI usage metrics). Two ADDITIVE changes:
--   • ai_usage_chats — the synced MIRROR of Open WebUI chat usage the `ai-usage-sync` sync mode upserts:
--     one row per OWUI chat (keyed by the OWUI chat id), carrying the per-chat aggregates the Metrics →
--     AI sub-tab reads (message/image/token/duration counts + the models used + the owner attribution).
--     It is a rebuildable READ-MODEL (the ADR-035 trash_candidates / ADR-040 smart_drive_state class):
--     the data of record lives in Open WebUI; this table is a re-syncable copy. Written ONLY by the
--     @hnet/domain syncAiUsage single-writer (guard-listed), which upserts each chat in one transaction.
--     No per-row audit event — synced usage data, not a role/permission mutation.
--   • SYNC_RUN_KINDS grows 'ai-usage-sync' — the OWUI-usage ingestion mode. Like the alert/outbox modes
--     it writes NO sync_runs row (this mirror IS its trail); the CHECK rebuild is PARITY-ONLY, so the CLI
--     --mode parser (which validates against SYNC_RUN_KINDS) accepts --mode=ai-usage-sync.
-- No existing table is altered destructively; a down-migration drops ai_usage_chats and reverts the
-- sync_runs.run_kind CHECK (drop any ai-usage-sync run first, though the mode writes none).
CREATE TABLE "ai_usage_chats" (
	"owui_chat_id" text PRIMARY KEY NOT NULL,
	"owui_user_id" text NOT NULL,
	"user_name" text,
	"user_email" text,
	"user_role" text,
	"title" text,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_model" text,
	"message_count" integer DEFAULT 0 NOT NULL,
	"image_count" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"total_duration_ms" bigint DEFAULT 0 NOT NULL,
	"chat_created_at" timestamp with time zone NOT NULL,
	"chat_updated_at" timestamp with time zone NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Trend bucketing reads by chat-creation day — index the time axis.
CREATE INDEX "ai_usage_chats_created_idx" ON "ai_usage_chats" USING btree ("chat_created_at");--> statement-breakpoint
-- Per-user attribution (admin/full) groups by owner — index the attribution key.
CREATE INDEX "ai_usage_chats_user_idx" ON "ai_usage_chats" USING btree ("owui_user_id");--> statement-breakpoint
-- sync_runs.run_kind admits 'ai-usage-sync' — kept in lockstep with the SYNC_RUN_KINDS const array +
-- the CLI --mode parser. Parity only: the mode writes no sync_runs row (its trail is ai_usage_chats).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync']));
