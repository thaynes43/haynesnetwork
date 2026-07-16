-- ADR-062 / DESIGN-033 (PLAN-041 — books/audiobooks/comics Fix). ADDITIVE:
--   • book_fix_requests — the audited landed-bad-copy fix aggregate (identity SNAPSHOT + reason
--     taxonomy + ordered raw responses; RESTRICT on books_items so history never vanishes; the
--     row + its request_book_fix audit commit BEFORE any external call — fix-flow crash-safety).
--   • role_books_action_grants — the fine-grained fix_book grant (ADR-023/059 idiom; a ROW is the
--     grant; ships EMPTY ⇒ Admin-only for the owner's test window, then the Q-01 all-roles flip).
--   • PERMISSION_AUDIT_ACTIONS grows request_book_fix + update_book_actions — parity CHECK rebuild
--     (the 0045/0048 pattern).
-- A down-migration drops the two tables and reverts the CHECK (delete book-fix audit rows first).
CREATE TABLE "book_fix_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid,
	"books_item_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"media_kind" text NOT NULL,
	"title_snapshot" text NOT NULL,
	"route" text NOT NULL,
	"reason" text NOT NULL,
	"reason_text" text,
	"language_pref" text,
	"stale_file_action" text DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"actions_taken" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ll_book_id" text,
	"kapowarr_volume_id" integer,
	"book_request_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "book_fix_requests_reason_enum" CHECK ("book_fix_requests"."reason" = ANY (ARRAY['wrong_language','corrupt_file','wrong_edition','bad_quality','other'])),
	CONSTRAINT "book_fix_requests_route_enum" CHECK ("book_fix_requests"."route" = ANY (ARRAY['lazylibrarian','kapowarr'])),
	CONSTRAINT "book_fix_requests_status_enum" CHECK ("book_fix_requests"."status" = ANY (ARRAY['pending','search_triggered','failed','completed'])),
	CONSTRAINT "book_fix_requests_stale_enum" CHECK ("book_fix_requests"."stale_file_action" = ANY (ARRAY['none','owner_quarantine'])),
	CONSTRAINT "book_fix_requests_reason_text_iff_other" CHECK (("book_fix_requests"."reason" = 'other') = ("book_fix_requests"."reason_text" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "book_fix_requests" ADD CONSTRAINT "book_fix_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_fix_requests" ADD CONSTRAINT "book_fix_requests_books_item_id_books_items_id_fk" FOREIGN KEY ("books_item_id") REFERENCES "public"."books_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_fix_requests" ADD CONSTRAINT "book_fix_requests_book_request_id_book_requests_id_fk" FOREIGN KEY ("book_request_id") REFERENCES "public"."book_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "book_fix_requests_requester_idx" ON "book_fix_requests" USING btree ("requester_id","created_at");--> statement-breakpoint
CREATE INDEX "book_fix_requests_item_idx" ON "book_fix_requests" USING btree ("books_item_id");--> statement-breakpoint
CREATE INDEX "book_fix_requests_status_idx" ON "book_fix_requests" USING btree ("status");--> statement-breakpoint
CREATE TABLE "role_books_action_grants" (
	"role_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_books_action_grants_role_id_action_pk" PRIMARY KEY("role_id","action"),
	CONSTRAINT "role_books_action_grants_action_enum" CHECK ("role_books_action_grants"."action" = ANY (ARRAY['fix_book']))
);--> statement-breakpoint
ALTER TABLE "role_books_action_grants" ADD CONSTRAINT "role_books_action_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level','assign_pending_role','update_bulletin_views','link_integration','unlink_integration','request_book_search','activity_retry_import','activity_force_search','update_activity_actions','request_book_fix','update_book_actions']));
