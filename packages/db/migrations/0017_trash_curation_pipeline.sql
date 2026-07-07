-- ADR-025 / DESIGN-011 — Trash CURATION PIPELINE (batches, poster review, Leaving Soon, windowed
-- deletion, skip-gate, deletion snapshots). All ADDITIVE:
--   • app_settings — the generic audited key/value store (Q-06). Written only by the @hnet/domain
--     setAppSetting single-writer, which co-writes an `update_app_setting` permission_audit row in
--     the SAME transaction (hard rule 6) — so the audit action CHECK is rebuilt below.
--   • trash_batches / trash_batch_items / trash_batch_saves — the batch state machine + the frozen
--     item snapshots + the save/unsave tuning dataset. Written only by the @hnet/domain
--     trash-batches single-writers; every status change appends a `trash_batch_transition` ledger
--     event, so the ledger_events event_type CHECK is rebuilt below.
--   • TRASH_ACTIONS grows `save_leaving_soon` + `manage_batches` (role_trash_action_grants CHECK).
--   • SYNC_RUN_KINDS grows `trash-batch-sweep` (sync_runs run_kind CHECK) — the expiry sweep mode.
-- No existing table is altered destructively; a down-migration drops the four tables and reverts the
-- four CHECKs.
CREATE TABLE "app_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days']))
);
--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "trash_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_kind" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"window_days" integer DEFAULT 21 NOT NULL,
	"gate_skipped" boolean DEFAULT false NOT NULL,
	"greenlit_at" timestamp with time zone,
	"greenlit_by" uuid,
	"expires_at" timestamp with time zone,
	"maintainerr_collection_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"cancelled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "trash_batches_media_kind_enum" CHECK ("trash_batches"."media_kind" = ANY (ARRAY['movie','tv'])),
	CONSTRAINT "trash_batches_state_enum" CHECK ("trash_batches"."state" = ANY (ARRAY['draft','admin_review','leaving_soon','deleted','cancelled']))
);
--> statement-breakpoint
ALTER TABLE "trash_batches" ADD CONSTRAINT "trash_batches_greenlit_by_users_id_fk" FOREIGN KEY ("greenlit_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_batches" ADD CONSTRAINT "trash_batches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trash_batches_one_open_per_kind" ON "trash_batches" USING btree ("media_kind") WHERE "trash_batches"."state" = ANY (ARRAY['draft','admin_review','leaving_soon']);--> statement-breakpoint
CREATE INDEX "trash_batches_state_idx" ON "trash_batches" USING btree ("state","created_at" DESC);--> statement-breakpoint
CREATE TABLE "trash_batch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"maintainerr_media_id" text NOT NULL,
	"collection_id" integer,
	"media_item_id" uuid,
	"title" text NOT NULL,
	"year" integer,
	"tmdb_id" integer,
	"tvdb_id" integer,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"poster_source" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"saved_by" uuid,
	"saved_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"deleted_size_bytes" bigint,
	"deleted_resolution" text,
	"deleted_imdb_rating" numeric,
	"deleted_tmdb_rating" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trash_batch_items_state_enum" CHECK ("trash_batch_items"."state" = ANY (ARRAY['pending','saved','deleted','skipped','protected']))
);
--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD CONSTRAINT "trash_batch_items_batch_id_trash_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."trash_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD CONSTRAINT "trash_batch_items_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trash_batch_items_batch_media_unique" ON "trash_batch_items" USING btree ("batch_id","maintainerr_media_id");--> statement-breakpoint
CREATE INDEX "trash_batch_items_batch_state_idx" ON "trash_batch_items" USING btree ("batch_id","state");--> statement-breakpoint
CREATE TABLE "trash_batch_saves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_item_id" uuid NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trash_batch_saves_action_enum" CHECK ("trash_batch_saves"."action" = ANY (ARRAY['save','unsave']))
);
--> statement-breakpoint
ALTER TABLE "trash_batch_saves" ADD CONSTRAINT "trash_batch_saves_batch_item_id_trash_batch_items_id_fk" FOREIGN KEY ("batch_item_id") REFERENCES "public"."trash_batch_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_batch_saves" ADD CONSTRAINT "trash_batch_saves_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trash_batch_saves_item_idx" ON "trash_batch_saves" USING btree ("batch_item_id","created_at" DESC);--> statement-breakpoint
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting']));--> statement-breakpoint
ALTER TABLE "ledger_events" DROP CONSTRAINT "ledger_events_event_type_enum";--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_event_type_enum" CHECK ("ledger_events"."event_type" = ANY (ARRAY['grabbed','imported','deleted','download_failed','requested','fix_requested','fix_actioned','fix_completed','fix_failed','restored','search_requested','trash_excluded','trash_expedited','trash_restored','trash_batch_transition']));--> statement-breakpoint
ALTER TABLE "role_trash_action_grants" DROP CONSTRAINT "role_trash_action_grants_action_enum";--> statement-breakpoint
ALTER TABLE "role_trash_action_grants" ADD CONSTRAINT "role_trash_action_grants_action_enum" CHECK ("role_trash_action_grants"."action" = ANY (ARRAY['save_exclude','remove_exclude','expedite_item','expedite_all','edit_rules','restore_deleted','save_leaving_soon','manage_batches']));--> statement-breakpoint
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep']));
