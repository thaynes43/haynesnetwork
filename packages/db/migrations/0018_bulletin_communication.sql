-- ADR-026 / DESIGN-012 (PLAN-009 Bulletin) — the Communication hub backend. All ADDITIVE:
--   • notifications WIDENED into the durable Feed store — new columns (media_item_id, tmdb_id,
--     tvdb_id, actor_user_id, occurred_at, source_event_id) + a partial-unique dedupe index +
--     two Feed indexes; the source CHECK is rebuilt to admit 'seerr' + 'tautulli' (Overseerr =
--     one source name, 'seerr'). No column is dropped or renamed — the shipped type/title/body
--     columns are kept stable. Existing rows backfill occurred_at = created_at.
--   • messages — the user-posted Bulletin board (flat v1). Written only by the @hnet/domain
--     message single-writers.
--   • role_message_action_grants — the FINE-GRAINED per-action (post/moderate) Bulletin grants
--     layered on the coarse role_section_permissions `bulletin` level. A ROW = the action is
--     granted (no boolean). Written only by the @hnet/domain setRoleMessageActions single-writer,
--     which co-writes a permission_audit 'update_message_actions' row in the SAME transaction
--     (hard rule 6) — so the audit action CHECK is rebuilt below to admit the new value.
--   • role_section_permissions section CHECK rebuilt to admit the 'bulletin' section id.
-- A down-migration drops the two new tables, the widened columns/indexes, and reverts the CHECKs.

--> statement-breakpoint
-- notifications: WIDEN (additive columns; source CHECK rebuild; dedupe + Feed indexes).
ALTER TABLE "notifications" ADD COLUMN "media_item_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "tmdb_id" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "tvdb_id" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "source_event_id" text;--> statement-breakpoint
-- Backfill occurred_at for any pre-existing rows, then pin the NOT NULL + default now().
UPDATE "notifications" SET "occurred_at" = "created_at" WHERE "occurred_at" IS NULL;--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "occurred_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "notifications" ALTER COLUMN "occurred_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_source_event_uidx" ON "notifications" USING btree ("source","source_event_id") WHERE "notifications"."source_event_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notifications_occurred_idx" ON "notifications" USING btree ("occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "notifications_media_item_idx" ON "notifications" USING btree ("media_item_id");--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_source_enum";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_source_enum" CHECK ("notifications"."source" = ANY (ARRAY['maintainerr','seerr','tautulli']));--> statement-breakpoint

-- messages: the user-posted Bulletin board (flat v1).
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_user_id" uuid NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"media_item_id" uuid,
	"status" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	"moderated_by" uuid,
	"moderated_at" timestamp with time zone,
	"moderation_note" text,
	CONSTRAINT "messages_status_enum" CHECK ("messages"."status" = ANY (ARRAY['visible','hidden','deleted']))
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_moderated_by_users_id_fk" FOREIGN KEY ("moderated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_created_idx" ON "messages" USING btree ("created_at" DESC);--> statement-breakpoint
CREATE INDEX "messages_author_idx" ON "messages" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "messages_media_item_idx" ON "messages" USING btree ("media_item_id");--> statement-breakpoint

-- role_message_action_grants: fine-grained post/moderate grants (a row = granted).
CREATE TABLE "role_message_action_grants" (
	"role_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_message_action_grants_role_id_action_pk" PRIMARY KEY("role_id","action"),
	CONSTRAINT "role_message_action_grants_action_enum" CHECK ("role_message_action_grants"."action" = ANY (ARRAY['post','moderate']))
);
--> statement-breakpoint
ALTER TABLE "role_message_action_grants" ADD CONSTRAINT "role_message_action_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- CHECK rebuilds for the widened enums.
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions']));--> statement-breakpoint
ALTER TABLE "role_section_permissions" DROP CONSTRAINT "role_section_permissions_section_enum";--> statement-breakpoint
ALTER TABLE "role_section_permissions" ADD CONSTRAINT "role_section_permissions_section_enum" CHECK ("role_section_permissions"."section_id" = ANY (ARRAY['ledger','trash','bulletin']));
