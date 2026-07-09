-- ADR-025 errata / DESIGN-011 amendment (2026-07-09, build B) — "requested items start saved
-- (overridable)". Two additive columns on trash_batch_items, both nullable/defaulted so existing
-- rows are unaffected (no backfill):
--
--   saved_reason      — WHY an item is in the `saved` state. NULL for an ordinary human rescue
--                       (the existing filled shield). 'requested' for a SYSTEM auto-save written at
--                       snapshot for a requester-carrying / mediarequests item (the person-shield):
--                       saved_by stays NULL (no human saver) and NO Maintainerr exclusion is created
--                       — the sweep guardian already keeps requester items, so the auto-save is a
--                       display/curation state, not a mass Maintainerr mutation.
--   requested_override — sticky audit flag: TRUE once a human with save rights explicitly UN-SAVES a
--                       requester auto-save. At sweep the guardian's requester auto-keep is honored
--                       UNLESS this is set, so an explicitly-unsaved requested item becomes deletable
--                       (requested + never-unsaved → kept; requested + explicitly-unsaved → deleted).
ALTER TABLE "trash_batch_items" ADD COLUMN "saved_reason" text;--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD COLUMN "requested_override" boolean NOT NULL DEFAULT false;
