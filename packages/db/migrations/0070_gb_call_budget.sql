-- ADR-067 / DESIGN-039 (PLAN-055 amend — the daily GB CALL BUDGET, D-21..D-24). Journal idx 69.
-- The sibling of gb_quota_state: a single-row PERSISTENT daily call ledger so the estate's own
-- first-party Google Books consumers (format-pairing resolve, goodreads enrichment, book Fix) stay
-- inside the shared key's low per-day cap FOREVER, unattended — the breaker catches real 429s, this
-- row stops us reaching them. One row (id='gb') carrying the current quota-day (the GB_DAILY_RESET_UTC_HOUR
-- boundary, default 07:00 UTC) and a per-consumer running call count; a write whose stored quota_day is
-- stale rolls the counters to 0 for the new day in the same statement. Derived, rebuildable OPERATIONAL
-- state (the gb_quota_state / mam_gate_state class): NO audit/outbox row (routine daily weather, self-
-- healing on the day roll — its trail is this row + the runs' one-line skippedBudget logs). Written ONLY
-- by the @hnet/domain gb-call-budget single-writer; guarded in all six no-direct-state-writes families.
-- A down-migration drops the table.
CREATE TABLE "gb_call_budget" (
	"id" text PRIMARY KEY DEFAULT 'gb' NOT NULL,
	"quota_day" date NOT NULL,
	"pairing_calls" integer DEFAULT 0 NOT NULL,
	"goodreads_calls" integer DEFAULT 0 NOT NULL,
	"bookfix_calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gb_call_budget_singleton" CHECK ("gb_call_budget"."id" = 'gb')
);
