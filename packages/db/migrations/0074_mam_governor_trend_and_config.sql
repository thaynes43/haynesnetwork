-- ADR-082 / DESIGN-027 D-09+D-10 (PLAN-040 — MAM governor trend-aware dead band + DB-backed audited
-- config). Journal idx 73. TWO additive changes, no destructive alter:
--   • mam_gate_state gains three NULLABLE columns the trend override (C-01/C-02) reads/writes:
--     last_observed_count + last_observed_at persist the last GOOD unsatisfied sample (updated only on a
--     successful count) so the single-interval delta is computed against the PRIOR RUN's sample and
--     survives process restarts; last_delta persists that computed delta for the /admin governor panel
--     (C-05). All three are NULL on the existing row until the next successful tick populates them — first
--     sight / a NULL or > 2-interval-stale sample disables the override for that tick (never a delta
--     against ancient data). Written ONLY by @hnet/domain evaluateMamGovernor (guard-listed).
--   • app_settings.key admits 'mam_governor_config' — the DB-backed audited governor knobs
--     (jsonb { limit, buffer, resumeFloor, trendPauseDelta }) written through the setAppSetting
--     single-writer (audit row same-tx, hard rule 6; setMamGovernorConfig validates the invariants first).
--     No row ⇒ the governor resolves exactly today's env/default config (C-03, zero-change deploy). Same
--     CHECK-rebuild pattern as 0019/0021/0024/0030/0031/0036/0067 (drop + re-add the full ARRAY from the
--     APP_SETTING_KEYS source of truth, now including the new key).
-- A down-migration drops the three columns and reverts the CHECK (delete any mam_governor_config row first).
ALTER TABLE "mam_gate_state" ADD COLUMN "last_observed_count" integer;--> statement-breakpoint
ALTER TABLE "mam_gate_state" ADD COLUMN "last_observed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mam_gate_state" ADD COLUMN "last_delta" integer;--> statement-breakpoint
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd','space_targets','space_policy','notify_window','pool_refresh_after_save','final_warning','upload_capacity_mbps','download_capacity_mbps','authentik_owned_groups','authentik_group_map','collection_size_cap','mam_governor_config']));
