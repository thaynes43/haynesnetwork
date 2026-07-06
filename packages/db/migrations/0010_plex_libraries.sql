-- ADR-017 / DESIGN-007 — Plex library self-service (Phase 3). Adds the BC-04 registry
-- (plex_servers, plex_libraries), the positive role→library allow-list (role_library_grants,
-- exact mirror of role_app_grants), and the BC-04 share ledger (plex_share_audit). The three
-- servers ARE infrastructure facts (OPS-002; machine identifiers verified live 2026-07-06),
-- so they are seeded here; LIBRARIES arrive via the admin registry refresh (no grant seeding
-- — ADR-017 D-05). Family libraries are ordinary rows granted only to the Family role
-- (ADR-017 D-10 — there is NO is_family_only column).

-- Role-library-grant edits are audited (ADR-017 D-07): relax the permission_audit action
-- CHECK to admit 'update_role_libraries'. Replaces (drops + re-adds) the constraint in place;
-- existing rows are unaffected (additive — no such rows exist yet).
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries']));--> statement-breakpoint

CREATE TABLE "plex_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"machine_identifier" text NOT NULL,
	"token_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plex_servers_slug_unique" UNIQUE("slug"),
	CONSTRAINT "plex_servers_slug_enum" CHECK ("plex_servers"."slug" = ANY (ARRAY['haynestower','haynesops','hayneskube']))
);
--> statement-breakpoint
CREATE TABLE "plex_libraries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"section_key" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"available" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plex_libraries_media_type_enum" CHECK ("plex_libraries"."media_type" = ANY (ARRAY['movie','show','artist','photo']))
);
--> statement-breakpoint
CREATE TABLE "role_library_grants" (
	"role_id" uuid NOT NULL,
	"plex_library_id" uuid NOT NULL,
	CONSTRAINT "role_library_grants_role_id_plex_library_id_pk" PRIMARY KEY("role_id","plex_library_id")
);
--> statement-breakpoint
CREATE TABLE "plex_share_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"plex_library_id" uuid,
	"event" text NOT NULL,
	"actor_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plex_share_audit_event_enum" CHECK ("plex_share_audit"."event" = ANY (ARRAY['share_added','share_removed']))
);
--> statement-breakpoint
ALTER TABLE "plex_libraries" ADD CONSTRAINT "plex_libraries_server_id_plex_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."plex_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_library_grants" ADD CONSTRAINT "role_library_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_library_grants" ADD CONSTRAINT "role_library_grants_plex_library_id_plex_libraries_id_fk" FOREIGN KEY ("plex_library_id") REFERENCES "public"."plex_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plex_share_audit" ADD CONSTRAINT "plex_share_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plex_share_audit" ADD CONSTRAINT "plex_share_audit_plex_library_id_plex_libraries_id_fk" FOREIGN KEY ("plex_library_id") REFERENCES "public"."plex_libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plex_share_audit" ADD CONSTRAINT "plex_share_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plex_libraries_server_section_idx" ON "plex_libraries" ("server_id","section_key");--> statement-breakpoint
CREATE INDEX "plex_share_audit_created_idx" ON "plex_share_audit" ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "plex_share_audit_user_created_idx" ON "plex_share_audit" ("user_id","created_at" DESC);--> statement-breakpoint
-- Seed the three servers of record with FIXED ids (SEEDED_PLEX_SERVER_IDS) + the machine
-- identifiers verified live 2026-07-06 (all PMS 1.43.2.10687). base_url is the in-cluster
-- Service DNS (server-side, EXEMPT from the catalog http(s) rule); token_ref names the env
-- var carrying the owner token (never the token — CLAUDE.md rule 7). Libraries are NOT
-- seeded — an admin runs the registry refresh to populate plex_libraries (ADR-017 D-04/D-05).
INSERT INTO "plex_servers" ("id", "slug", "name", "base_url", "machine_identifier", "token_ref") VALUES
	('a5ec8cb2-0000-4000-8000-000000000001', 'haynestower', 'HaynesTower', 'http://haynestower.media.svc.cluster.local:32400', 'a5ec8cb29c425667637eabdb6a0615d6ccf68cc3', 'PLEX_HAYNESTOWER_TOKEN'),
	('80b33acb-0000-4000-8000-000000000002', 'haynesops', 'HaynesOps', 'http://plexops.media.svc.cluster.local:32400', '80b33acb1d207508990637ec151fe9abad8d3d7a', 'PLEX_HAYNESOPS_TOKEN'),
	('c1b23d68-0000-4000-8000-000000000003', 'hayneskube', 'HaynesKube', 'http://plex.media.svc.cluster.local:32400', 'c1b23d688afea4a39ec2c214776832c16be6504d', 'PLEX_HAYNESKUBE_TOKEN');
