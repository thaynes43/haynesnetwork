-- ADR-012 — unified Role model. Clean cut (owner decision, 2026-07-05): the Member/Admin
-- enum, tags, per-user grants, the family flag, and app_catalog.default_visible all
-- collapse into one admin-managed `roles` table + `role_app_grants`. Every user has exactly
-- one role. Two system roles are seeded: Admin (superuser, all apps implicitly, locked) and
-- Default (new-user role; its app set = the old default_visible set; editable, undeletable).
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"grants_all" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_name_unique" UNIQUE("name"),
	CONSTRAINT "roles_not_admin_and_default" CHECK (NOT ("roles"."is_admin" AND "roles"."is_default"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_single_admin_idx" ON "roles" ("is_admin") WHERE "roles"."is_admin";
--> statement-breakpoint
CREATE UNIQUE INDEX "roles_single_default_idx" ON "roles" ("is_default") WHERE "roles"."is_default";
--> statement-breakpoint
CREATE TABLE "role_app_grants" (
	"role_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	CONSTRAINT "role_app_grants_role_id_app_id_pk" PRIMARY KEY("role_id","app_id")
);
--> statement-breakpoint
ALTER TABLE "role_app_grants" ADD CONSTRAINT "role_app_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_app_grants" ADD CONSTRAINT "role_app_grants_app_id_app_catalog_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app_catalog"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- Seed the system roles with FIXED ids so users.role_id can default to Default (a Postgres
-- column DEFAULT can't be a subquery). Better Auth inserts new user rows without a role_id,
-- so that default is what lands every new user in the Default role. Admin (superuser) and
-- Default are system-locked; Family is a normal role the owner can edit/delete.
INSERT INTO "roles" ("id", "name", "description", "is_admin", "is_default", "grants_all", "sort_order") VALUES
	('22222222-2222-4222-8222-222222222222', 'Admin', 'Superuser — full access to every app and the admin console. Cannot be edited or deleted.', true, false, false, 0),
	('11111111-1111-4111-8111-111111111111', 'Default', 'Assigned to every new user. Edit its apps to change what new/basic users see.', false, true, false, 1),
	('33333333-3333-4333-8333-333333333333', 'Family', 'Extended family — access to every app except Tautulli.', false, false, false, 2);
--> statement-breakpoint
-- Default role: the old default-visible set (seerr/plex/k8plex) plus plexops (owner: basic
-- users get PlexOps too). Explicit slugs — runs before the default_visible column is dropped.
INSERT INTO "role_app_grants" ("role_id", "app_id")
	SELECT '11111111-1111-4111-8111-111111111111', "id"
	FROM "app_catalog"
	WHERE "slug" IN ('seerr', 'plex', 'k8plex', 'plexops');
--> statement-breakpoint
-- Family role: every catalog app EXCEPT tautulli.
INSERT INTO "role_app_grants" ("role_id", "app_id")
	SELECT '33333333-3333-4333-8333-333333333333', "id"
	FROM "app_catalog"
	WHERE "slug" <> 'tautulli';
--> statement-breakpoint
-- users.role_id defaults to Default; existing Admins are switched, then the FK is added.
ALTER TABLE "users" ADD COLUMN "role_id" uuid NOT NULL DEFAULT '11111111-1111-4111-8111-111111111111';
--> statement-breakpoint
UPDATE "users" SET "role_id" = '22222222-2222-4222-8222-222222222222' WHERE "role" = 'Admin';
--> statement-breakpoint
-- Non-admin family members carry over to the seeded Family role (their broad access is
-- preserved) rather than collapsing to Default.
UPDATE "users" SET "role_id" = '33333333-3333-4333-8333-333333333333' WHERE "is_family" = true AND "role" <> 'Admin';
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- permission_audit: swap the tag reference for a role reference and update the action set.
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_tag_id_tags_id_fk";
--> statement-breakpoint
ALTER TABLE "permission_audit" DROP COLUMN "tag_id";
--> statement-breakpoint
ALTER TABLE "permission_audit" ADD COLUMN "role_id" uuid;
--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";
--> statement-breakpoint
-- Clean cut: drop audit rows whose action referenced the removed model (grant_app, apply_tag,
-- set_family, create_tag, …). Otherwise the tightened CHECK below validates against existing
-- rows and ABORTS the whole migration on any DB that ever recorded one of those actions.
DELETE FROM "permission_audit" WHERE "action" NOT IN ('create_role', 'update_role', 'delete_role', 'create_app', 'update_app', 'delete_app');
--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app']));
--> statement-breakpoint
-- user_role_transitions: recreate keyed on role_id (clean cut — staging audit history is disposable).
DROP TABLE "user_role_transitions";
--> statement-breakpoint
CREATE TABLE "user_role_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_role_id" uuid,
	"to_role_id" uuid,
	"initiator_id" uuid,
	"initiator_kind" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_transitions_initiator_kind_enum" CHECK ("user_role_transitions"."initiator_kind" = ANY (ARRAY['system','admin']))
);
--> statement-breakpoint
ALTER TABLE "user_role_transitions" ADD CONSTRAINT "user_role_transitions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_role_transitions" ADD CONSTRAINT "user_role_transitions_from_role_id_roles_id_fk" FOREIGN KEY ("from_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_role_transitions" ADD CONSTRAINT "user_role_transitions_to_role_id_roles_id_fk" FOREIGN KEY ("to_role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_role_transitions" ADD CONSTRAINT "user_role_transitions_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "user_role_transitions_user_created_idx" ON "user_role_transitions" ("user_id","created_at" DESC);
--> statement-breakpoint
-- Drop the superseded tag / grant / family surface.
DROP VIEW "effective_app_grants";
--> statement-breakpoint
DROP TABLE "user_tags";
--> statement-breakpoint
DROP TABLE "tag_app_grants";
--> statement-breakpoint
DROP TABLE "user_app_grants";
--> statement-breakpoint
DROP TABLE "tags";
--> statement-breakpoint
ALTER TABLE "app_catalog" DROP COLUMN "default_visible";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_role_enum";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";
--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_family";
