-- DESIGN-001 Phase 1 schema (docs/designs/001-database-schema.md D-02..D-11).
-- Hand-audited against the Drizzle declarations in packages/db/src/schema/.
-- gen_random_uuid() is built into Postgres >= 13 — no pgcrypto extension needed (D-01.2).
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'Member' NOT NULL,
	"is_family" boolean DEFAULT false NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_enum" CHECK ("users"."role" = ANY (ARRAY['Member','Admin']))
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"account_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_provider_account_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_role_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"from_role" text,
	"to_role" text NOT NULL,
	"initiator_id" uuid,
	"initiator_kind" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_role_transitions_initiator_kind_enum" CHECK ("user_role_transitions"."initiator_kind" = ANY (ARRAY['system','admin']))
);
--> statement-breakpoint
CREATE TABLE "app_catalog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"icon" text,
	"default_visible" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_catalog_slug_unique" UNIQUE("slug"),
	CONSTRAINT "app_catalog_url_haynesnetwork_only" CHECK ("app_catalog"."url" ~ '^https://[a-z0-9.-]+\.haynesnetwork\.com(/.*)?$')
);
--> statement-breakpoint
CREATE TABLE "user_app_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_app_grants_user_app_unique" UNIQUE("user_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_family" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "tag_app_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tag_app_grants_tag_app_unique" UNIQUE("tag_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "user_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"applied_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tags_user_tag_unique" UNIQUE("user_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "permission_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"subject_user_id" uuid,
	"app_id" uuid,
	"tag_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['grant_app','revoke_app','create_tag','update_tag','delete_tag','apply_tag','remove_tag','set_family','unset_family','create_app','update_app','delete_app']))
);
--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_role_transitions" ADD CONSTRAINT "user_role_transitions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_role_transitions" ADD CONSTRAINT "user_role_transitions_initiator_id_users_id_fk" FOREIGN KEY ("initiator_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_app_grants" ADD CONSTRAINT "user_app_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_app_grants" ADD CONSTRAINT "user_app_grants_app_id_app_catalog_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app_catalog"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_app_grants" ADD CONSTRAINT "user_app_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tag_app_grants" ADD CONSTRAINT "tag_app_grants_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tag_app_grants" ADD CONSTRAINT "tag_app_grants_app_id_app_catalog_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app_catalog"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_tags" ADD CONSTRAINT "user_tags_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_app_id_app_catalog_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."app_catalog"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" ("user_id");
--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" ("user_id");
--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
--> statement-breakpoint
CREATE INDEX "user_role_transitions_user_created_idx" ON "user_role_transitions" ("user_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "user_app_grants_user_id_idx" ON "user_app_grants" ("user_id");
--> statement-breakpoint
CREATE INDEX "user_tags_user_id_idx" ON "user_tags" ("user_id");
--> statement-breakpoint
CREATE INDEX "permission_audit_created_idx" ON "permission_audit" ("created_at" DESC);
--> statement-breakpoint
CREATE INDEX "permission_audit_subject_created_idx" ON "permission_audit" ("subject_user_id","created_at" DESC);
--> statement-breakpoint
-- DESIGN-001 D-11: effective permissions derivation (R-22, AC-06). UNION ALL keeps one
-- row per provenance; removing a tag removes exactly its rows.
CREATE VIEW "effective_app_grants" AS
  SELECT uag.user_id,
         uag.app_id,
         'direct'::text AS source,
         NULL::uuid     AS tag_id
    FROM user_app_grants uag
  UNION ALL
  SELECT ut.user_id,
         tag_grant.app_id,
         'tag'::text    AS source,
         ut.tag_id
    FROM user_tags ut
    JOIN tag_app_grants tag_grant ON tag_grant.tag_id = ut.tag_id;
