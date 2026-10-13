-- ADR-109 C-04, C-06 / DESIGN-055 D-02, D-06 (PLAN-077 P5). Journal idx 102. ADDITIVE, two parts:
-- (1) release_pick_lists (T-319): the Release Pick's list as one person was shown it, for one missing episode or movie,
--     with what a grab needs kept server-side (the *arr's guid and indexer id never reach a browser). Single writer
--     packages/domain/src/release-pick.ts, in the transaction of its ledger event.
-- (2) ledger_events.event_type admits `release_list_requested` (built from LEDGER_EVENT_TYPES, enums.ts): opening the list
--     is one unit of the arr pool's hourly budget.
-- The grab itself needs no schema: repair_requests already admits kind 'release_pick' (0099), and the kill switch is a
-- key of the repair_guide_remedies jsonb setting. The previous image never writes the new event type and never reads
-- the new table, so it runs unchanged against this schema. A down-migration drops the table, deletes ledger rows with
-- the new event type, then restores the 0099 CHECK.
CREATE TABLE "release_pick_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid,
	"media_item_id" uuid NOT NULL,
	"arr_kind" text NOT NULL,
	"target_child_id" integer,
	"season_number" integer,
	"target_label" text NOT NULL,
	"searched_at" timestamp with time zone NOT NULL,
	"reasons_version" integer NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"offers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_pick_lists_arr_kind_enum" CHECK ("release_pick_lists"."arr_kind" = ANY (ARRAY['sonarr','radarr'])),
	CONSTRAINT "release_pick_lists_target_iff_tv" CHECK (("release_pick_lists"."arr_kind" = 'radarr' AND "release_pick_lists"."target_child_id" IS NULL AND "release_pick_lists"."season_number" IS NULL) OR ("release_pick_lists"."arr_kind" = 'sonarr' AND "release_pick_lists"."target_child_id" IS NOT NULL AND "release_pick_lists"."season_number" IS NOT NULL))
);--> statement-breakpoint
ALTER TABLE "release_pick_lists" ADD CONSTRAINT "release_pick_lists_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "release_pick_lists" ADD CONSTRAINT "release_pick_lists_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "release_pick_lists_requester_target_idx" ON "release_pick_lists" ("requester_id","media_item_id","target_child_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "release_pick_lists_created_idx" ON "release_pick_lists" ("created_at");--> statement-breakpoint
-- ledger_events.event_type admits 'release_list_requested' (ADR-109 C-04: opening the Release Pick's list is one unit).
ALTER TABLE "ledger_events" DROP CONSTRAINT "ledger_events_event_type_enum";--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_event_type_enum" CHECK ("ledger_events"."event_type" = ANY (ARRAY['grabbed','imported','deleted','download_failed','requested','fix_requested','fix_actioned','fix_completed','fix_failed','restored','search_requested','trash_excluded','trash_expedited','trash_restored','trash_batch_transition','trash_space_policy','repair_requested','repair_completed','repair_failed','release_list_requested']));
