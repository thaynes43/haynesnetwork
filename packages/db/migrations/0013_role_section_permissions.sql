-- ADR-021 / DESIGN-009 D-03 — Section-level Role Permissions. A role carries one access
-- LEVEL (edit | read_only | disabled) per top-level section (ledger | trash). One row per
-- (role, section); a missing row means the section's documented default (Ledger = read_only,
-- Trash = disabled). An is_admin role stores NO rows and implies Edit everywhere. Written
-- only by the @hnet/domain setSectionPermission single-writer, which co-writes a
-- permission_audit 'update_section_permission' row in the SAME transaction (hard rule 6) —
-- so the audit action CHECK is rebuilt below to admit the new value. Additive: no
-- role_section_permissions rows exist yet, so every role resolves to its default.
CREATE TABLE "role_section_permissions" (
	"role_id" uuid NOT NULL,
	"section_id" text NOT NULL,
	"level" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_section_permissions_role_id_section_id_pk" PRIMARY KEY("role_id","section_id"),
	CONSTRAINT "role_section_permissions_section_enum" CHECK ("role_section_permissions"."section_id" = ANY (ARRAY['ledger','trash'])),
	CONSTRAINT "role_section_permissions_level_enum" CHECK ("role_section_permissions"."level" = ANY (ARRAY['edit','read_only','disabled']))
);
--> statement-breakpoint
ALTER TABLE "role_section_permissions" ADD CONSTRAINT "role_section_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission']));
