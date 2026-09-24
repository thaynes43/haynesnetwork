-- ADR-091 / DESIGN-050 D-03 (PLAN-069 — public OAuth connectors for the MCP surface). Journal idx 77. ADDITIVE:
--   • oauth_clients — RFC 7591 dynamically registered clients (ChatGPT registers one per connector). client_id is
--     the public 32-hex handle; client_secret_hash exists only for a confidential client and is SHA-256 hex. The
--     D-04 input bounds are schema invariants: client_name 1–80 characters, 1–5 redirect URIs, grant types ⊆
--     {authorization_code, refresh_token}, response types ⊆ {code}, the auth method ∈ OAUTH_TOKEN_ENDPOINT_AUTH_METHODS
--     and "has a secret" ⇔ "is confidential". registered_ip (abuse forensics) and last_used_at (the Connected apps
--     page and the dormant-client pruner) are new against the cigar-journal port.
--   • oauth_authorizations — the pending consent transaction a SIGNED-IN user's /oauth/authorize created (10 min).
--     state is NOT NULL (DESIGN-050 D-05: state is required).
--   • oauth_authorization_codes — single-use PKCE codes (60 s), consumed once by a conditional UPDATE.
--   • oauth_refresh_tokens — rotating refresh families (60 days, re-issued per rotation); parent_id is a self-FK
--     (ON DELETE SET NULL, so the pruner may drop an old ancestor).
--   • oauth_access_tokens — 1 h access tokens bound to the canonical resource; last_used_at stamped by /mcp.
-- Every token, code and secret is stored ONLY as its SHA-256 hex digest — a format CHECK refuses anything else, so
-- plaintext can never land at rest. Every expires_at is NOT NULL (no never-expiring token: ADR-091 option 5).
-- Every scopes column is a non-empty jsonb array ⊆ OAUTH_SCOPES (jsonb containment, built from enums.ts). All four
-- dependent tables reference oauth_clients(client_id) — the unique public handle, as the port does — and users(id),
-- both ON DELETE CASCADE: deleting a user or a client removes every transaction, code and token it owns.
--   • oauth_audit — the APPEND-ONLY connector audit trail (hard rule 6): event ∈ OAUTH_AUDIT_EVENTS (consent_granted,
--     consent_denied, client_disconnected, family_revoked_on_reuse), each inserted by its @hnet/domain writer in the
--     same transaction as the state change. user_id cascades with the user; client_id is TEXT with no FK on purpose —
--     the inline pruner deletes dormant DCR clients, and the audit trail must outlive them.
-- All six tables are written ONLY by the @hnet/domain oauth single-writers (@hnet/oauth is pure: it decides, the
-- domain writes); the no-direct-state-writes guard lists all six in every family, and the state tables are deleted
-- only by the domain's audited transitions and its inline pruner (pruneExpired).
-- A down-migration drops the six tables (oauth_audit and the token/code/transaction tables first, oauth_clients last).
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"grant_types" jsonb NOT NULL,
	"response_types" jsonb NOT NULL,
	"scope" text,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"registered_ip" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "oauth_clients_client_id_format" CHECK ("oauth_clients"."client_id" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "oauth_clients_secret_hash_format" CHECK ("oauth_clients"."client_secret_hash" IS NULL OR "oauth_clients"."client_secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_clients_secret_matches_method" CHECK (("oauth_clients"."token_endpoint_auth_method" = 'none') = ("oauth_clients"."client_secret_hash" IS NULL)),
	CONSTRAINT "oauth_clients_name_length" CHECK (char_length("oauth_clients"."client_name") BETWEEN 1 AND 80),
	CONSTRAINT "oauth_clients_redirect_uris_shape" CHECK (jsonb_typeof("oauth_clients"."redirect_uris") = 'array' AND jsonb_array_length("oauth_clients"."redirect_uris") BETWEEN 1 AND 5),
	CONSTRAINT "oauth_clients_grant_types_subset" CHECK (jsonb_typeof("oauth_clients"."grant_types") = 'array' AND jsonb_array_length("oauth_clients"."grant_types") >= 1 AND "oauth_clients"."grant_types" <@ '["authorization_code","refresh_token"]'::jsonb),
	CONSTRAINT "oauth_clients_response_types_subset" CHECK (jsonb_typeof("oauth_clients"."response_types") = 'array' AND jsonb_array_length("oauth_clients"."response_types") >= 1 AND "oauth_clients"."response_types" <@ '["code"]'::jsonb),
	CONSTRAINT "oauth_clients_auth_method_enum" CHECK ("oauth_clients"."token_endpoint_auth_method" = ANY (ARRAY['none','client_secret_post','client_secret_basic']))
);
--> statement-breakpoint
CREATE TABLE "oauth_authorizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"resource" text NOT NULL,
	"state" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorizations_scopes_subset" CHECK (jsonb_typeof("oauth_authorizations"."scopes") = 'array' AND jsonb_array_length("oauth_authorizations"."scopes") >= 1 AND "oauth_authorizations"."scopes" <@ '["watch:read","watch:write","offline_access"]'::jsonb),
	CONSTRAINT "oauth_authorizations_challenge_method_enum" CHECK ("oauth_authorizations"."code_challenge_method" = ANY (ARRAY['S256']))
);
--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_authorizations_expires_idx" ON "oauth_authorizations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_authorizations_client_user_idx" ON "oauth_authorizations" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"resource" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorization_codes_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "oauth_authorization_codes_hash_format" CHECK ("oauth_authorization_codes"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_authorization_codes_scopes_subset" CHECK (jsonb_typeof("oauth_authorization_codes"."scopes") = 'array' AND jsonb_array_length("oauth_authorization_codes"."scopes") >= 1 AND "oauth_authorization_codes"."scopes" <@ '["watch:read","watch:write","offline_access"]'::jsonb),
	CONSTRAINT "oauth_authorization_codes_challenge_method_enum" CHECK ("oauth_authorization_codes"."code_challenge_method" = ANY (ARRAY['S256']))
);
--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_authorization_codes_expires_idx" ON "oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "oauth_authorization_codes_client_user_idx" ON "oauth_authorization_codes" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid NOT NULL,
	"parent_id" uuid,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scopes" jsonb NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "oauth_refresh_tokens_hash_format" CHECK ("oauth_refresh_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_refresh_tokens_scopes_subset" CHECK (jsonb_typeof("oauth_refresh_tokens"."scopes") = 'array' AND jsonb_array_length("oauth_refresh_tokens"."scopes") >= 1 AND "oauth_refresh_tokens"."scopes" <@ '["watch:read","watch:write","offline_access"]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_parent_id_oauth_refresh_tokens_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."oauth_refresh_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_family_idx" ON "oauth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_client_user_idx" ON "oauth_refresh_tokens" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_expires_idx" ON "oauth_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"family_id" uuid,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"scopes" jsonb NOT NULL,
	"resource" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_access_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "oauth_access_tokens_hash_format" CHECK ("oauth_access_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "oauth_access_tokens_scopes_subset" CHECK (jsonb_typeof("oauth_access_tokens"."scopes") = 'array' AND jsonb_array_length("oauth_access_tokens"."scopes") >= 1 AND "oauth_access_tokens"."scopes" <@ '["watch:read","watch:write","offline_access"]'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_oauth_clients_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("client_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_family_idx" ON "oauth_access_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_client_user_idx" ON "oauth_access_tokens" USING btree ("client_id","user_id");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_expires_idx" ON "oauth_access_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE TABLE "oauth_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" text NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"family_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_audit_event_enum" CHECK ("oauth_audit"."event" = ANY (ARRAY['consent_granted','consent_denied','client_disconnected','family_revoked_on_reuse']))
);
--> statement-breakpoint
ALTER TABLE "oauth_audit" ADD CONSTRAINT "oauth_audit_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_audit_user_at_idx" ON "oauth_audit" USING btree ("user_id","at" DESC);--> statement-breakpoint
CREATE INDEX "oauth_audit_client_idx" ON "oauth_audit" USING btree ("client_id");
