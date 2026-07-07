-- ADR-030 / DESIGN-013 (PLAN-013 disk + reclaim metrics) — two additive changes:
--
-- 1. Admit 'space_targets' to app_settings.key. The Storage utilization surface stores the per-Plex-
--    server space TARGETS (jsonb object keyed by plex_servers slug → percent-used ceiling, e.g.
--    { "haynestower": 80 }) in the generic audited app_settings store (Q-06 reuse; not a bespoke
--    table). app_settings.key is CHECK-constrained to APP_SETTING_KEYS (built from the const array),
--    so admitting the new value rebuilds that constraint — drop + re-add with the full ARRAY incl.
--    the new value, mirroring the 0019 (motd) / 0020 (notifications 'trash') CHECK rebuilds. Additive:
--    existing rows keep validating; no new table, column, or FK. A down-migration reverts to the
--    prior three-value CHECK (drop any stored 'space_targets' row first if reverting).
--
-- 2. A partial index on trash_batch_items for the reclaim-attribution window scans. The reclaim
--    queries (category × resolution over a window; cumulative-by-day curve) scan the DELETED subset
--    by deleted_at; a partial index keyed by (state, deleted_at) WHERE state='deleted' serves those
--    range scans without touching the hot pending path (the deleted rows are a small terminal slice).
--    CREATE INDEX (non-CONCURRENTLY) is fine — additive, and the table is small.
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd','space_targets']));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trash_batch_items_deleted_at_idx" ON "trash_batch_items" USING btree ("state","deleted_at") WHERE "state" = 'deleted';
