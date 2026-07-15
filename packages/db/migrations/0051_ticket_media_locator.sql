-- ADR-061 / DESIGN-032 (PLAN-038 — ticket media precision). ADDITIVE locator columns on tickets
-- (NULL target_kind = the whole title, the unchanged pre-locator meaning) + the Q-03 owner ruling:
-- DELETE the pre-locator tickets (seed/test data — the 0040 messages precedent; replies/events
-- cascade). target_label SNAPSHOTS the display label so a ticket renders without a live *arr read.
-- A down-migration drops the five columns + the CHECK (the deleted seed rows are gone by design).
DELETE FROM "tickets";--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "target_kind" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "target_child_id" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "target_season" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "target_episode" integer;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "target_label" text;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_target_kind_enum" CHECK ("tickets"."target_kind" IS NULL OR "tickets"."target_kind" = ANY (ARRAY['season','episode','album','track']));
