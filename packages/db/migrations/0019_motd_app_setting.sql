-- ADR-027 / DESIGN-004 D-15 (PLAN-010 Message-of-the-Day) — the dashboard MOTD banner reuses the
-- generic audited app_settings store (Open decision #1: reuse, not a bespoke `motd` table). The MOTD
-- record lives under a new key `motd` whose jsonb value is
--   { message, severity, enabled, startsAt, endsAt, updatedBy }.
-- The ONLY schema change is a CHECK relax: app_settings.key is CHECK-constrained to APP_SETTING_KEYS
-- (built from the const array), so admitting 'motd' rebuilds that constraint — drop + re-add with the
-- full ARRAY incl. the new value, mirroring the 0018 CHECK rebuilds. Additive: existing rows keep
-- validating; no new table, column, or FK. A down-migration reverts to the prior two-value CHECK
-- (harmless — any stored `motd` row would then fail the narrower check, so drop it first if reverting).
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd']));
