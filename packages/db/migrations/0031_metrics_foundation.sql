-- ADR-037 / DESIGN-016 (PLAN-017) — Metrics section foundation. Four additive changes, each a CHECK
-- rebuild copying the current full array verbatim + appending. No new state table (roles + app_settings
-- are already covered by the no-direct-state-writes guard).

-- 1) roles.metrics_level (T-107) — single value per role (full | limited), mirrors grants_all. NOT NULL
--    with a 'limited' default so every existing role validates. Written ONLY by the @hnet/domain
--    setRoleMetricsLevel single-writer, which co-writes a permission_audit 'update_role_metrics_level'
--    row in the SAME transaction (hard rule 6). Admin implies 'full' via the session short-circuit; we
--    seed is_admin roles to 'full' for clarity (cosmetic).
ALTER TABLE "roles" ADD COLUMN "metrics_level" text DEFAULT 'limited' NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_metrics_level_enum" CHECK ("roles"."metrics_level" = ANY (ARRAY['full','limited']));--> statement-breakpoint
UPDATE "roles" SET "metrics_level" = 'full' WHERE "is_admin" = true;--> statement-breakpoint

-- 2) permission_audit action CHECK — admit 'update_role_metrics_level' (the audited level flip).
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level']));--> statement-breakpoint

-- 3) role_section_permissions section CHECK — admit the 'metrics' section (visibility; ships Admin-only
--    via the SECTION_DEFAULT_LEVELS.metrics = 'disabled' no-row default).
ALTER TABLE "role_section_permissions" DROP CONSTRAINT "role_section_permissions_section_enum";--> statement-breakpoint
ALTER TABLE "role_section_permissions" ADD CONSTRAINT "role_section_permissions_section_enum" CHECK ("role_section_permissions"."section_id" = ANY (ARRAY['ledger','trash','bulletin','metrics']));--> statement-breakpoint

-- 4) app_settings key CHECK — admit the two WAN capacity keys (Overview meter denominators; absent key
--    ⇒ code default 300 / 2256, so no seed row is written).
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd','space_targets','space_policy','notify_window','pool_refresh_after_save','final_warning','upload_capacity_mbps','download_capacity_mbps']));
