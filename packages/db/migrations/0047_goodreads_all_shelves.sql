-- ADR-057 (PLAN-045 — Integrations hub + all-shelves acquisition; owner ruling: A1 OVERRULED, ALL synced
-- shelves acquire). ADDITIVE/backfill only — no new table, no new column. The v1 Goodreads MVP synced the
-- want shelf only (user_integrations.shelves default '["to-read"]'); PLAN-045 extends the sync + the
-- acquisition path to all four shelves: to-read · currently-reading · read · did-not-finish (the first
-- three are Goodreads built-ins; did-not-finish is the conventional CUSTOM shelf slug — the sync tolerates
-- its absence, A3). Request minting was already shelf-agnostic (one book_requests row per live shelf item),
-- so widening the shelves list IS the acquisition change; the request's source shelf rides the existing
-- integration_shelf_items.shelf column via the shelf_item join — no new column needed.
--   • DEFAULT: new integrations sync all four shelves.
--   • BACKFILL: existing goodreads rows still on the exact v1 default '["to-read"]' widen to all four
--     (a deliberately-customized shelves list — anything else — is left untouched).
-- A down-migration restores the '["to-read"]' default and narrows backfilled rows the same way.
ALTER TABLE "user_integrations" ALTER COLUMN "shelves" SET DEFAULT '["to-read","currently-reading","read","did-not-finish"]'::jsonb;--> statement-breakpoint
UPDATE "user_integrations"
SET "shelves" = '["to-read","currently-reading","read","did-not-finish"]'::jsonb, "updated_at" = now()
WHERE "provider" = 'goodreads' AND "shelves" = '["to-read"]'::jsonb;
