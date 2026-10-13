-- ADR-114 / DESIGN-055 P4 decisions 26-34 (owner ruling on issue #928, 2026-10-13: "Carry marks, then move"). Journal
-- idx 103. ADDITIVE: three new tables, nothing else changes.
-- (1) watch_carries (T-326): one staff move's Watch Carry: its kind, scope, status, the Carry Snapshot's item map per
--     Plex server, and per-account counts (by account index) with the verification.
-- (2) watch_carry_states (T-327): the Carry Snapshot's states, one row per account and item with state, read before
--     anything moved. Inserted with the carry, never updated.
-- (3) watch_carry_marks: the carry's append-only audit, one row per mark written (state before, state written, the
--     Plex calls), inserted in the transaction of the carry's counters; carry-revert reads it back.
-- Single writer packages/domain/src/watch-carry.ts (the no-direct-state-writes guard). No friend token is ever stored.
-- The previous image never reads or writes these tables, so it runs unchanged against this schema. A down-migration
-- drops the three tables.
CREATE TABLE "watch_carries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"media_item_id" uuid,
	"series_id" integer NOT NULL,
	"season_numbers" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"status" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"items" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_carries_kind_enum" CHECK ("watch_carries"."kind" = ANY (ARRAY['season_remap','show_ordering','second_copy'])),
	CONSTRAINT "watch_carries_status_enum" CHECK ("watch_carries"."status" = ANY (ARRAY['snapshot','cleared','refused','waiting','verified','mismatch','reverted']))
);--> statement-breakpoint
ALTER TABLE "watch_carries" ADD CONSTRAINT "watch_carries_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_carries_item_idx" ON "watch_carries" ("media_item_id","created_at" DESC);--> statement-breakpoint
CREATE TABLE "watch_carry_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"carry_id" uuid NOT NULL,
	"server" text NOT NULL,
	"plex_account_id" text NOT NULL,
	"rating_key" text NOT NULL,
	"season_number" integer,
	"episode_number" integer,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"view_count" integer NOT NULL,
	"view_offset_ms" integer NOT NULL,
	"last_viewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_carry_states_has_state" CHECK ("watch_carry_states"."view_count" > 0 OR "watch_carry_states"."view_offset_ms" > 0)
);--> statement-breakpoint
ALTER TABLE "watch_carry_states" ADD CONSTRAINT "watch_carry_states_carry_id_watch_carries_id_fk" FOREIGN KEY ("carry_id") REFERENCES "public"."watch_carries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watch_carry_states_uq" ON "watch_carry_states" ("carry_id","server","plex_account_id","rating_key");--> statement-breakpoint
CREATE TABLE "watch_carry_marks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"carry_id" uuid NOT NULL,
	"server" text NOT NULL,
	"plex_account_id" text NOT NULL,
	"rating_key" text NOT NULL,
	"season_number" integer,
	"episode_number" integer,
	"phase" text NOT NULL,
	"reason" text NOT NULL,
	"parts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"before_state" jsonb NOT NULL,
	"target_state" jsonb NOT NULL,
	"calls" text[] DEFAULT '{}'::text[] NOT NULL,
	"ok" boolean NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_carry_marks_phase_enum" CHECK ("watch_carry_marks"."phase" = ANY (ARRAY['pre_clear','carry','revert'])),
	CONSTRAINT "watch_carry_marks_reason_enum" CHECK ("watch_carry_marks"."reason" = ANY (ARRAY['pre_clear','carried','partial','stale','restore']))
);--> statement-breakpoint
ALTER TABLE "watch_carry_marks" ADD CONSTRAINT "watch_carry_marks_carry_id_watch_carries_id_fk" FOREIGN KEY ("carry_id") REFERENCES "public"."watch_carries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_carry_marks_carry_idx" ON "watch_carry_marks" ("carry_id","created_at");
