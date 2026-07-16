-- ADR-067 / DESIGN-039 (PLAN-055 — Google Books quota resilience). Journal idx 56 — idx 55 /
-- migration 0056 is held by a parallel track on its own branch; the coordinator reconciles at
-- merge (the established two-track numbering protocol). Two pieces:
--   • gb_quota_state — the SINGLE-ROW GB quota circuit breaker (the mam_gate_state class:
--     unaudited rebuildable operational state, guard-listed, single-writer in packages/domain).
--     A daily-quota 429 opens it until the next 07:00 UTC; a per-minute 429 for 2 minutes; any
--     completed GB call clears it. No seed row — the breaker seeds itself on first trip.
--   • book_fix_requests.status CHECK rebuild — 'queued' joins the lifecycle (a fix meeting the
--     open breaker parks instead of failing; the goodreads-sync-hosted retry pass completes it).
-- A down-migration drops gb_quota_state and reverts the CHECK (re-fail queued rows first).
CREATE TABLE "gb_quota_state" (
	"id" text PRIMARY KEY DEFAULT 'gb' NOT NULL,
	"exhausted_until" timestamp with time zone,
	"tripped_at" timestamp with time zone,
	"trip_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gb_quota_state_singleton" CHECK ("gb_quota_state"."id" = 'gb')
);--> statement-breakpoint
ALTER TABLE "book_fix_requests" DROP CONSTRAINT "book_fix_requests_status_enum";--> statement-breakpoint
ALTER TABLE "book_fix_requests" ADD CONSTRAINT "book_fix_requests_status_enum" CHECK ("book_fix_requests"."status" = ANY (ARRAY['pending','queued','search_triggered','failed','completed']));
