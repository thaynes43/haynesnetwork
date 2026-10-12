-- ADR-109 / DESIGN-055 D-01, D-09 (PLAN-077 P1) — two audited app settings for the Repair Guide's Fix guards:
--   • app_settings.key admits 'repair_guide_remedies' (the per-remedy kill switch; absent ⇒ every remedy off) and
--     'playback_known_issue_servers' (the Known-Issue Servers, T-314; absent ⇒ none).
-- No table, no data: both keys stay absent until an admin (or the coordinator, audited) writes them.
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','trash_relink_enabled','motd','space_targets','space_policy','notify_window','pool_refresh_after_save','final_warning','upload_capacity_mbps','download_capacity_mbps','authentik_owned_groups','authentik_group_map','collection_size_cap','mam_governor_config','arr_queue_cleanup_config','seerr_watchlist_enroll','repair_guide_remedies','playback_known_issue_servers']));
