-- ADR-049 / DESIGN-012 amend (PLAN-027 roles-grid clarity) — Bulletin SUB-VIEW visibility grants.
-- All ADDITIVE:
--   • role_bulletin_view_grants — a role's per-VIEW (feed/messages) visibility grants for the
--     Bulletin section, layered on the coarse role_section_permissions `bulletin` level. A ROW =
--     the view is granted (no boolean). Written only by the @hnet/domain setRoleBulletinViews
--     single-writer, which co-writes a permission_audit 'update_bulletin_views' row in the SAME
--     transaction (hard rule 6) — so the audit action CHECK is rebuilt below to admit the new value.
--     RESOLUTION is default-ON: a role with NO rows resolves to BOTH views (ADR-026 C-02 "Bulletin
--     is for everyone"); present rows are the exact narrowing allowlist.
--   • The owner's Default role (the fixed seed id) is narrowed to `messages` ONLY (the Feed carries
--     Family/Friends-oriented ops chatter; owner ruling 2026-07-11). Every OTHER role (Family,
--     Friends, custom, Admin implicit) keeps BOTH views via the no-row default — no backfill needed,
--     so no one else silently loses the Feed. Idempotent (ON CONFLICT DO NOTHING) so re-runs no-op.
-- A down-migration drops the table + the seed row and reverts the permission_audit CHECK.

--> statement-breakpoint
-- role_bulletin_view_grants: per-view (feed/messages) Bulletin visibility grants (a row = granted).
CREATE TABLE "role_bulletin_view_grants" (
	"role_id" uuid NOT NULL,
	"view" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_bulletin_view_grants_role_id_view_pk" PRIMARY KEY("role_id","view"),
	CONSTRAINT "role_bulletin_view_grants_view_enum" CHECK ("role_bulletin_view_grants"."view" = ANY (ARRAY['feed','messages']))
);
--> statement-breakpoint
ALTER TABLE "role_bulletin_view_grants" ADD CONSTRAINT "role_bulletin_view_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- permission_audit CHECK rebuild: admit 'update_bulletin_views' (preserving every prior value).
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level','assign_pending_role','update_bulletin_views']));--> statement-breakpoint

-- Seed the owner's intent: the Default role sees the Messages view ONLY (Feed off). The fixed
-- Default seed id (roles.SEEDED_ROLE_IDS.default). All other roles keep the no-row default (BOTH).
INSERT INTO "role_bulletin_view_grants" ("role_id", "view")
VALUES ('11111111-1111-4111-8111-111111111111', 'messages')
ON CONFLICT ("role_id","view") DO NOTHING;
