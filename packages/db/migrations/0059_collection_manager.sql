-- ADR-069 / DESIGN-042 (PLAN-052 — collection manager + member contributions). ADDITIVE only.
--   • role_collection_action_grants — a role's fine-grained collection-manager action grants (the
--     role_books_action_grants idiom, ADR-062): a ROW is the grant (presence, no boolean); an
--     is_admin role stores NO rows and implies EVERY action; ships with NO rows ⇒ Admin-only until
--     the owner opens each per role. Actions: suggest / manage / acquire (the content-pulling knob,
--     a distinct grant). Written ONLY by the @hnet/domain setRoleCollectionActions single-writer,
--     which co-writes an update_collection_actions permission_audit row in the SAME tx (guard-listed).
--   • collection_suggestions — the member contribution aggregate: a suggest-granted member proposes a
--     collection (status pending; applies nothing); a manage admin approves (recipe materialized via
--     the confined @hnet/libretto writer — created_recipe_id stamped) or declines with a reason.
--     Provider-shaped (provider column, 'libretto' now) so the Kometa leg needs no schema change.
--     Guarded single-writer table (createCollectionSuggestion + approve/decline; audited same-tx).
--   • permission_audit.action CHECK grows update_collection_actions / create_collection_suggestion /
--     review_collection_suggestion — kept in lockstep with PERMISSION_AUDIT_ACTIONS.
-- Libretto's recipes + produced collections are NOT mirrored (Libretto is stateless — its API is the
-- read model; ADR-064 doctrine). A down-migration drops both tables and reverts the CHECK.
CREATE TABLE "role_collection_action_grants" (
	"role_id" uuid NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_collection_action_grants_role_id_action_pk" PRIMARY KEY("role_id","action"),
	CONSTRAINT "role_collection_action_grants_action_enum" CHECK ("role_collection_action_grants"."action" = ANY (ARRAY['suggest','manage','acquire']))
);--> statement-breakpoint
CREATE TABLE "collection_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"suggester_id" uuid NOT NULL,
	"provider" text DEFAULT 'libretto' NOT NULL,
	"name" text NOT NULL,
	"builder_type" text NOT NULL,
	"builder_ref" text NOT NULL,
	"target_library" text,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_note" text,
	"created_recipe_id" text,
	"reviewed_by_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collection_suggestions_provider_enum" CHECK ("collection_suggestions"."provider" = ANY (ARRAY['libretto'])),
	CONSTRAINT "collection_suggestions_builder_type_enum" CHECK ("collection_suggestions"."builder_type" = ANY (ARRAY['static_ids','hardcover_series','nyt_list','wikidata_award'])),
	CONSTRAINT "collection_suggestions_status_enum" CHECK ("collection_suggestions"."status" = ANY (ARRAY['pending','approved','declined']))
);--> statement-breakpoint
ALTER TABLE "role_collection_action_grants" ADD CONSTRAINT "role_collection_action_grants_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_suggestions" ADD CONSTRAINT "collection_suggestions_suggester_id_users_id_fk" FOREIGN KEY ("suggester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_suggestions" ADD CONSTRAINT "collection_suggestions_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The manager's review queue reads pending suggestions newest-first; the wall affordance reads a
-- member's own suggestions. Both filter on status / suggester_id.
CREATE INDEX "collection_suggestions_status_idx" ON "collection_suggestions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "collection_suggestions_suggester_idx" ON "collection_suggestions" USING btree ("suggester_id");--> statement-breakpoint
-- permission_audit.action admits the three collection actions — kept in lockstep with PERMISSION_AUDIT_ACTIONS.
ALTER TABLE "permission_audit" DROP CONSTRAINT "permission_audit_action_enum";--> statement-breakpoint
ALTER TABLE "permission_audit" ADD CONSTRAINT "permission_audit_action_enum" CHECK ("permission_audit"."action" = ANY (ARRAY['create_role','update_role','delete_role','create_app','update_app','delete_app','update_role_libraries','update_section_permission','update_trash_actions','update_app_setting','update_message_actions','update_role_metrics_level','assign_pending_role','update_bulletin_views','link_integration','unlink_integration','request_book_search','request_book_fix','update_book_actions','activity_retry_import','activity_force_search','update_activity_actions','update_collection_actions','create_collection_suggestion','review_collection_suggestion']));
