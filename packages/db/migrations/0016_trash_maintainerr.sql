-- ADR-023 / DESIGN-010 — Trash section (Maintainerr) backend. All ADDITIVE:
--   • role_trash_action_grants — the FINE-GRAINED per-action Trash grants layered on top of the
--     coarse role_section_permissions `trash` level. A ROW = the action is granted (no boolean;
--     presence is the grant). Written only by the @hnet/domain setRoleTrashActions single-writer,
--     which co-writes a permission_audit 'update_trash_actions' row in the SAME transaction (hard
--     rule 6) — so the audit action CHECK is rebuilt below to admit the new value.
--   • notifications — the generic in-app notification store (addendum c). PLAN-006 ships it with
--     Maintainerr as source #1; PLAN-009 (Bulletin) extends the source set. Written only by the
--     @hnet/domain recordNotification single-writer.
--   • ledger_events CHECKs rebuilt to admit the Trash attribution markers (trash_excluded,
--     trash_expedited, trash_restored) and the 'maintainerr' source.
-- No existing table is altered destructively; a down-migration drops the two tables and reverts
-- the three CHECKs.
CREATE TABLE "role_trash_action_grants" (
	"role_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_trash_action_grants_role_id_action_pk" PRIMARY KEY("role_id","action"),
	CONSTRAINT "role_trash_action_grants_action_enum" CHECK ("role_trash_action_grants"."action" = ANY (ARRAY['save_exclude','remove_exclude','expedite_item','expedite_all','edit_rules','restore_deleted']))
);
--> statement-breakpoint
ALTER TABLE "role_trash_action_grants" ADD CONSTRAINT "role_trash_action_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	CONSTRAINT "notifications_source_enum" CHECK ("notifications"."source" = ANY (ARRAY['maintainerr']))
);
--> statement-breakpoint
CREATE INDEX "notifications_source_created_idx" ON "notifications" USING btree ("source","created_at" DESC);--> statement-breakpoint
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions']));--> statement-breakpoint
ALTER TABLE "ledger_events" DROP CONSTRAINT "ledger_events_event_type_enum";--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_event_type_enum" CHECK ("ledger_events"."event_type" = ANY (ARRAY['grabbed','imported','deleted','download_failed','requested','fix_requested','fix_actioned','fix_completed','fix_failed','restored','search_requested','trash_excluded','trash_expedited','trash_restored']));--> statement-breakpoint
ALTER TABLE "ledger_events" DROP CONSTRAINT "ledger_events_source_enum";--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_source_enum" CHECK ("ledger_events"."source" = ANY (ARRAY['sonarr','radarr','lidarr','seerr','app','maintainerr']));
