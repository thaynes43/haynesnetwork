-- DESIGN-005 D-07/D-17 — Force Search: a search-only Fix-flow action for missing
-- content ("not broken, just missing" — no blocklist, no file delete, no reason).
-- It records an audited 'search_requested' ledger event, so the ledger_events
-- event_type CHECK must be relaxed to admit the new value. Replaces (drops + re-adds)
-- the constraint in place; existing rows are unaffected.
ALTER TABLE "ledger_events" DROP CONSTRAINT "ledger_events_event_type_enum";--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_event_type_enum" CHECK ("ledger_events"."event_type" = ANY (ARRAY['grabbed','imported','deleted','download_failed','requested','fix_requested','fix_actioned','fix_completed','fix_failed','restored','search_requested']));
