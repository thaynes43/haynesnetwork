-- DESIGN-010/014 amendment (2026-07-09, build D) — POOL REFRESH AFTER SAVE. Two changes for the
-- debounced post-save Maintainerr rule re-execution:
--   1. Admit the new `pool_refresh_after_save` app_settings key (jsonb { enabled, delayMinutes }) by
--      relaxing the app_settings.key CHECK (the standard drop + re-add — see migrations 0019/0021/0024).
--   2. Add the `pending_pool_refresh` debounce marker table: one row per batchable kind with a future
--      `due_at`; drained (POST /api/rules/execute, then delete) by an in-process web timer AND the
--      incremental-sync backstop. Ephemeral, derived state — no ledger audit row of its own.
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd','space_targets','space_policy','notify_window','pool_refresh_after_save']));--> statement-breakpoint
CREATE TABLE "pending_pool_refresh" (
  "media_kind" text PRIMARY KEY NOT NULL,
  "due_at" timestamp with time zone NOT NULL,
  "requested_at" timestamp with time zone NOT NULL DEFAULT now(),
  "requested_by" uuid,
  CONSTRAINT "pending_pool_refresh_kind_check" CHECK (media_kind IN ('movie','tv'))
);--> statement-breakpoint
ALTER TABLE "pending_pool_refresh" ADD CONSTRAINT "pending_pool_refresh_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_pool_refresh_due_idx" ON "pending_pool_refresh" ("due_at");
