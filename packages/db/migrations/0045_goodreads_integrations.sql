-- ADR-055 / DESIGN-028 (PLAN-044 — Goodreads requests MVP). ADDITIVE only.
--   • user_integrations — one row per (app user, external provider). The user LINKS a PUBLIC Goodreads
--     profile (no OAuth, no secret); stores the provider user id + profile ref + link lifecycle + the
--     last-sync marker. Single-writer (@hnet/domain, guard-listed); link/unlink co-write a permission_audit
--     row; sync bookkeeping (last_synced_at/last_sync_error) is not audited (synced-content exemption).
--   • integration_shelf_items — the synced shelf-RSS MIRROR: one row per (integration, shelf, book id).
--     A rebuildable read-model (books_items class): the goodreads-sync mode upserts the snapshot + tombstones
--     rows a fully-read shelf no longer serves. No per-row audit.
--   • book_requests — the request/Missing LEDGER: one row per unmatched shelf want, per-format status
--     (ebook + audiobook × requested|wanted|grabbed|landed|missing), the matched books_items id (nullable),
--     and the LazyLibrarian book id. ADR-046 STANDS: books_items stays a pure mirror — request/Missing state
--     lives here. Sync mint/reconcile is unaudited; the user's manual "Search again" writes a permission_audit
--     row (request_book_search).
--   • role_section_permissions.section_id CHECK grows 'integrations' — the new Integrations tab's visibility
--     knob (default `disabled` in code = ships Admin-only; a role row opts a role in after screenshot review).
--   • sync_runs.run_kind CHECK grows 'goodreads-sync' — parity only (the mode writes NO sync_runs row; its
--     trail is the integration tables), so the CLI --mode parser (validated against SYNC_RUN_KINDS) accepts it.
--   • permission_audit.action CHECK grows link_integration / unlink_integration / request_book_search.
-- A down-migration drops the three tables (book_requests, then integration_shelf_items, then
-- user_integrations — FK order) and reverts the three CHECKs.
CREATE TABLE "user_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_user_id" text NOT NULL,
	"profile_ref" text,
	"status" text NOT NULL,
	"shelves" jsonb DEFAULT '["to-read"]'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_integrations_user_provider_unique" UNIQUE("user_id","provider"),
	CONSTRAINT "user_integrations_provider_enum" CHECK ("user_integrations"."provider" = ANY (ARRAY['goodreads'])),
	CONSTRAINT "user_integrations_status_enum" CHECK ("user_integrations"."status" = ANY (ARRAY['linked','unlinked','error']))
);
--> statement-breakpoint
ALTER TABLE "user_integrations" ADD CONSTRAINT "user_integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_integrations_provider_status_idx" ON "user_integrations" USING btree ("provider","status");--> statement-breakpoint
CREATE TABLE "integration_shelf_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"shelf" text NOT NULL,
	"external_book_id" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"isbn" text,
	"gb_volume_id" text,
	"cover_url" text,
	"shelved_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_shelf_items_unique" UNIQUE("integration_id","shelf","external_book_id")
);
--> statement-breakpoint
ALTER TABLE "integration_shelf_items" ADD CONSTRAINT "integration_shelf_items_integration_id_user_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."user_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_shelf_items_integration_live_idx" ON "integration_shelf_items" USING btree ("integration_id","deleted_at");--> statement-breakpoint
CREATE TABLE "book_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"shelf_item_id" uuid NOT NULL,
	"matched_books_item_id" uuid,
	"ll_book_id" text,
	"title" text NOT NULL,
	"author" text,
	"ebook_status" text DEFAULT 'requested' NOT NULL,
	"audio_status" text DEFAULT 'requested' NOT NULL,
	"unroutable_reason" text,
	"last_searched_at" timestamp with time zone,
	"last_reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_requests_shelf_item_unique" UNIQUE("shelf_item_id"),
	CONSTRAINT "book_requests_ebook_status_enum" CHECK ("book_requests"."ebook_status" = ANY (ARRAY['requested','wanted','grabbed','landed','missing'])),
	CONSTRAINT "book_requests_audio_status_enum" CHECK ("book_requests"."audio_status" = ANY (ARRAY['requested','wanted','grabbed','landed','missing']))
);
--> statement-breakpoint
ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_integration_id_user_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."user_integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_shelf_item_id_integration_shelf_items_id_fk" FOREIGN KEY ("shelf_item_id") REFERENCES "public"."integration_shelf_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_matched_books_item_id_books_items_id_fk" FOREIGN KEY ("matched_books_item_id") REFERENCES "public"."books_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_requests_integration_idx" ON "book_requests" USING btree ("integration_id");--> statement-breakpoint
-- role_section_permissions.section_id admits 'integrations' — the Integrations tab's visibility knob, kept
-- in lockstep with the SECTION_IDS const array. Ships `disabled` in code (Admin-only) — no SQL default row.
ALTER TABLE "role_section_permissions" DROP CONSTRAINT "role_section_permissions_section_enum";--> statement-breakpoint
ALTER TABLE "role_section_permissions" ADD CONSTRAINT "role_section_permissions_section_enum" CHECK ("role_section_permissions"."section_id" = ANY (ARRAY['ledger','trash','bulletin','metrics','ytdlsub','books','integrations']));--> statement-breakpoint
-- sync_runs.run_kind admits 'goodreads-sync' — kept in lockstep with SYNC_RUN_KINDS + the CLI --mode parser.
-- Parity only: the mode writes no sync_runs row (its trail is the integration tables).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync']));--> statement-breakpoint
-- permission_audit.action admits the three USER-initiated Integration actions (mirrors the CHECK-relax
-- pattern — drop + re-add with the full ARRAY from the const source-of-truth).
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level','assign_pending_role','update_bulletin_views','link_integration','unlink_integration','request_book_search']));
