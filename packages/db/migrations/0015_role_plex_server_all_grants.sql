-- ADR-024 — role-scoped "all libraries on server X" self-service. A new grant table sits
-- ALONGSIDE role_library_grants: a row means the role grants ALL libraries (incl. future ones)
-- on that Plex server, so a member may self-toggle their own account between the plex.tv
-- all-libraries state and an explicit per-section list (seeded with their current full set — no
-- access loss). Written only by the @hnet/domain setRoleLibraries single-writer (co-writes an
-- update_role_libraries permission_audit row in the same tx). An is_admin role stores NO rows and
-- implies all-libraries everywhere. Additive: no rows exist yet, so every role keeps its current
-- explicit-only behaviour until an admin grants an all-server flag.
CREATE TABLE "role_plex_server_all_grants" (
	"role_id" uuid NOT NULL,
	"plex_server_id" uuid NOT NULL,
	CONSTRAINT "role_plex_server_all_grants_role_id_plex_server_id_pk" PRIMARY KEY("role_id","plex_server_id")
);
--> statement-breakpoint
ALTER TABLE "role_plex_server_all_grants" ADD CONSTRAINT "role_plex_server_all_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_plex_server_all_grants" ADD CONSTRAINT "role_plex_server_all_grants_plex_server_id_plex_servers_id_fk" FOREIGN KEY ("plex_server_id") REFERENCES "public"."plex_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Rebuild the plex_share_audit event CHECK to admit the two new server-scoped all events
-- (share_all_enabled / share_all_disabled) written by setServerAllShare.
ALTER TABLE "plex_share_audit" DROP CONSTRAINT "plex_share_audit_event_enum";--> statement-breakpoint
ALTER TABLE "plex_share_audit" ADD CONSTRAINT "plex_share_audit_event_enum" CHECK ("plex_share_audit"."event" = ANY (ARRAY['share_added','share_removed','share_all_enabled','share_all_disabled']));
