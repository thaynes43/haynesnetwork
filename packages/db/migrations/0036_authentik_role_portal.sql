-- ADR-045 / DESIGN-023 (PLAN-026 — haynesnetwork as the Authentik user/role portal). ADDITIVE only.
--   • roles.synced_tier — opt-in: when true a role PROJECTS to an Authentik group (the cross-app role
--     primitive). Backfill: the seeded Family role becomes a synced tier (it projects to the pre-existing
--     `family` group); Admin/Default stay app-local (false).
--   • authentik_users — the synced MIRROR of the Authentik directory (one row per identity, incl. external
--     Plex-source + never-logged-in accounts), keyed by the Authentik user pk. Rebuildable READ-MODEL
--     (the ai_usage_chats / trash_candidates class); written ONLY by the @hnet/domain upsertAuthentikUsers
--     single-writer (authentik-users sync + on-demand refresh + post-write re-read). No per-row audit.
--   • pending_role_assignments — the parked role intent for an Authentik-only identity (no app row yet);
--     consumed LAZILY on that identity's first app login (email match — the OIDC sub is a hashed_user_id
--     the app can't pre-compute; ADR-045 C-04). Written ONLY by the domain single-writers (create co-writes
--     permission_audit 'assign_pending_role'; consume co-writes user_role_transitions via assignRole).
--   • authentik_group_audit — the append-only EXTERNAL group-write ledger (the plex_share_audit class):
--     one row per successful Authentik/OWUI write (add_member/remove_member/create_group/ensure_owui_group),
--     appended AFTER the apply (external side-effects can't co-commit with a local row). Guard-listed
--     INSERT-only.
--   • Parity CHECK rebuilds: sync_runs.run_kind grows 'authentik-users' (standalone read-sync mode, writes
--     no sync_runs row — its trail is authentik_users); permission_audit.action grows 'assign_pending_role';
--     app_settings.key grows 'authentik_owned_groups' + 'authentik_group_map' (the owned-groups guardrail
--     allowlist + the role→group map, both mutated through setAppSetting).
-- A down-migration drops the three tables + the synced_tier column and reverts the three CHECKs (drop any
-- authentik-users run first, though the mode writes none).
ALTER TABLE "roles" ADD COLUMN "synced_tier" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "roles" SET "synced_tier" = true WHERE "name" = 'Family';--> statement-breakpoint

CREATE TABLE "authentik_users" (
	"pk" integer PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"email" text,
	"user_type" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"uid" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authentik_users_type_enum" CHECK ("authentik_users"."user_type" = ANY (ARRAY['external','internal','internal_service_account']))
);
--> statement-breakpoint
CREATE INDEX "authentik_users_email_idx" ON "authentik_users" USING btree (lower("email"));--> statement-breakpoint

CREATE TABLE "pending_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"authentik_user_pk" integer NOT NULL,
	"authentik_username" text NOT NULL,
	"email" text NOT NULL,
	"authentik_uid" text,
	"role_id" uuid NOT NULL,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_user_id" uuid
);
--> statement-breakpoint
ALTER TABLE "pending_role_assignments" ADD CONSTRAINT "pending_role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_role_assignments" ADD CONSTRAINT "pending_role_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_role_assignments" ADD CONSTRAINT "pending_role_assignments_consumed_user_id_users_id_fk" FOREIGN KEY ("consumed_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_role_assignments_live_pk_idx" ON "pending_role_assignments" USING btree ("authentik_user_pk") WHERE "consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "pending_role_assignments_live_email_idx" ON "pending_role_assignments" USING btree ("email") WHERE "consumed_at" IS NULL;--> statement-breakpoint

CREATE TABLE "authentik_group_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"group_name" text NOT NULL,
	"authentik_user_pk" integer,
	"role_id" uuid,
	"subject_email" text,
	"actor_id" uuid,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "authentik_group_audit_action_enum" CHECK ("authentik_group_audit"."action" = ANY (ARRAY['add_member','remove_member','create_group','ensure_owui_group']))
);
--> statement-breakpoint
ALTER TABLE "authentik_group_audit" ADD CONSTRAINT "authentik_group_audit_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentik_group_audit" ADD CONSTRAINT "authentik_group_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authentik_group_audit_created_idx" ON "authentik_group_audit" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "authentik_group_audit_user_created_idx" ON "authentik_group_audit" USING btree ("authentik_user_pk","created_at" DESC);--> statement-breakpoint

-- sync_runs.run_kind admits 'authentik-users' — kept in lockstep with SYNC_RUN_KINDS + the CLI --mode
-- parser. Parity only: the mode writes no sync_runs row (its trail is authentik_users).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users']));--> statement-breakpoint

-- permission_audit.action admits 'assign_pending_role' (the parked-intent create for an Authentik-only identity).
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level','assign_pending_role']));--> statement-breakpoint

-- app_settings.key admits the two Authentik-portal guardrail settings (owned-groups allowlist + role→group map).
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd','space_targets','space_policy','notify_window','pool_refresh_after_save','final_warning','upload_capacity_mbps','download_capacity_mbps','authentik_owned_groups','authentik_group_map']));
