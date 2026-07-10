-- DESIGN-015 amendment (2026-07-09) — the CONFIGURABLE FINAL-WARNING push + honest next-sweep copy.
-- Two additive CHECK relaxes (no table is altered destructively; both mirror the standard drop + re-add
-- pattern of migrations 0019/0021/0024/0029 — the const arrays in enums.ts are the source of truth):
--   1. Admit the `final_warning` app_settings key (jsonb { enabled, hoursBefore }) — the "last call N
--      hours before the window closes" config, read fail-safe by getFinalWarning.
--   2. Admit the `batch_final_warning` notification_outbox event_type — the last-call push enqueued at
--      green-light with earliest_send_at = expires_at − N hours (skipped when that is already past / the
--      window is shorter than N).
-- A down-migration reverts both CHECKs (drop any final_warning app_setting row / batch_final_warning
-- outbox row first).
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd','space_targets','space_policy','notify_window','pool_refresh_after_save','final_warning']));--> statement-breakpoint
ALTER TABLE "notification_outbox" DROP CONSTRAINT "notification_outbox_event_type_enum";--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_event_type_enum" CHECK ("notification_outbox"."event_type" = ANY (ARRAY['batch_created','batch_leaving_soon','batch_leaving_soon_reminder','batch_final_warning','batch_swept']));
