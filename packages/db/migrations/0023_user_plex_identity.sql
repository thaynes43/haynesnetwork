-- fix/plex-identity-mapping — the app must resolve a user's REAL Plex identity, not the OIDC
-- email. When a pre-existing Authentik user is LINKED to the Plex source, the OIDC id_token still
-- carries the Authentik email (e.g. admin@haynesnetwork.com), NOT the Plex account email
-- (manofoz@gmail.com), so owner/friend email-matching in My Plex structurally misses. Two nullable
-- text columns hold the admin-set Plex identity OVERRIDE (the /admin/users "Plex identity" field),
-- the fallback used when the OIDC token carries no plex_email/plex_username claim (@hnet/auth
-- resolvePlexIdentity: claim wins, override next, app email last). Additive only — existing rows
-- default to NULL (claim/app-email path unchanged). Down-migration drops both columns.
ALTER TABLE "users" ADD COLUMN "plex_email" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plex_username" text;
