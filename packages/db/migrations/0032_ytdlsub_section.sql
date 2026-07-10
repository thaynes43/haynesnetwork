-- ADR-038 / DESIGN-017 (PLAN-022) — ytdl-sub Library sub-tabs. ONE additive change: rebuild the
-- role_section_permissions section CHECK to admit the new 'ytdlsub' section id (visibility; ships
-- Admin-only via the SECTION_DEFAULT_LEVELS.ytdlsub = 'disabled' no-row default). No new column, no new
-- table, no new permission_audit action — the per-role flip reuses the existing setSectionPermission
-- single-writer + its update_section_permission audit row. No no-direct-state-writes guard edit
-- (role_section_permissions is already covered; nothing new to guard).

ALTER TABLE "role_section_permissions" DROP CONSTRAINT "role_section_permissions_section_enum";--> statement-breakpoint
ALTER TABLE "role_section_permissions" ADD CONSTRAINT "role_section_permissions_section_enum" CHECK ("role_section_permissions"."section_id" = ANY (ARRAY['ledger','trash','bulletin','metrics','ytdlsub']));
