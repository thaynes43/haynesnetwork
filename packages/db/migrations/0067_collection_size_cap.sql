-- DESIGN-035 D-17 (2026-07-18) — the collection SIZE CAP + the over-cap admin-override ticket.
-- Acquisition is now ON for collections (Wanted-tiles), so an unbounded collection could dump
-- hundreds of monitored+searched items. Two additive CHECK relaxations:
--
--   1. app_settings.key admits `collection_size_cap` (int; default 25, admin-mutated via setAppSetting)
--      — the max resolved membership a NON-ADMIN may create/add. LISTS are the admin-only exception.
--   2. tickets.category admits `collection_override` — the ticket a non-admin mints (via the over-cap
--      Modal) to ask an admin to approve the larger bound (reuses the ADR-050 helpdesk board).
--
-- Both are pure CHECK widenings (drop + re-add the expanded enum), no data change. A down-migration
-- restores the narrower enums (safe only if no rows use the new values).
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd','space_targets','space_policy','notify_window','pool_refresh_after_save','final_warning','upload_capacity_mbps','download_capacity_mbps','authentik_owned_groups','authentik_group_map','collection_size_cap']));--> statement-breakpoint
ALTER TABLE "tickets" DROP CONSTRAINT "tickets_category_enum";--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_category_enum" CHECK ("tickets"."category" = ANY (ARRAY['playback','audio','subtitles','quality','missing','other','collection_override']));
