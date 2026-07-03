-- DESIGN-005 Phase 2 media ledger (docs/designs/005-arr-ledger-and-fix.md D-05..D-13).
-- Hand-audited against the Drizzle declarations in packages/db/src/schema/.
-- No seed data — every row arrives via sync (D-13).
CREATE TABLE "media_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arr_kind" text NOT NULL,
	"arr_instance_id" text DEFAULT 'main' NOT NULL,
	"arr_item_id" integer NOT NULL,
	"tvdb_id" integer,
	"tmdb_id" integer,
	"imdb_id" text,
	"musicbrainz_artist_id" text,
	"title" text NOT NULL,
	"sort_title" text NOT NULL,
	"year" integer,
	"monitored" boolean NOT NULL,
	"quality_profile_id" integer NOT NULL,
	"quality_profile_name" text NOT NULL,
	"metadata_profile_id" integer,
	"metadata_profile_name" text,
	"root_folder" text NOT NULL,
	"arr_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"on_disk_file_count" integer DEFAULT 0 NOT NULL,
	"expected_file_count" integer DEFAULT 0 NOT NULL,
	"size_on_disk" bigint DEFAULT 0 NOT NULL,
	"arr_attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_from_arr_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_items_arr_identity_unique" UNIQUE("arr_kind","arr_instance_id","arr_item_id"),
	CONSTRAINT "media_items_arr_kind_enum" CHECK ("media_items"."arr_kind" = ANY (ARRAY['sonarr','radarr','lidarr'])),
	CONSTRAINT "media_items_external_id_for_kind" CHECK (
		("media_items"."arr_kind" = 'sonarr' AND "media_items"."tvdb_id" IS NOT NULL) OR
		("media_items"."arr_kind" = 'radarr' AND "media_items"."tmdb_id" IS NOT NULL) OR
		("media_items"."arr_kind" = 'lidarr' AND "media_items"."musicbrainz_artist_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_item_id" uuid,
	"event_type" text NOT NULL,
	"source" text NOT NULL,
	"source_event_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requested_by_user_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_events_event_type_enum" CHECK ("ledger_events"."event_type" = ANY (ARRAY['grabbed','imported','deleted','download_failed','requested','fix_requested','fix_actioned','fix_completed','fix_failed','restored'])),
	CONSTRAINT "ledger_events_source_enum" CHECK ("ledger_events"."source" = ANY (ARRAY['sonarr','radarr','lidarr','seerr','app']))
);
--> statement-breakpoint
CREATE TABLE "fix_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid,
	"media_item_id" uuid NOT NULL,
	"target_arr_child_id" integer,
	"target_label" text,
	"reason" text NOT NULL,
	"reason_text" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"path_taken" text,
	"actions_taken" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completed_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fix_requests_reason_enum" CHECK ("fix_requests"."reason" = ANY (ARRAY['wont_play_corrupt','wrong_language','wrong_version_quality','missing_subtitles','wrong_content','other'])),
	CONSTRAINT "fix_requests_status_enum" CHECK ("fix_requests"."status" = ANY (ARRAY['pending','actioned','search_triggered','failed','completed'])),
	CONSTRAINT "fix_requests_path_enum" CHECK ("fix_requests"."path_taken" IS NULL OR "fix_requests"."path_taken" = ANY (ARRAY['blocklist_search','delete_search'])),
	CONSTRAINT "fix_requests_reason_text_iff_other" CHECK (
		("fix_requests"."reason" = 'other' AND "fix_requests"."reason_text" IS NOT NULL AND btrim("fix_requests"."reason_text") <> '')
		OR ("fix_requests"."reason" <> 'other' AND "fix_requests"."reason_text" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "restore_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arr_kind" text NOT NULL,
	"arr_instance_id" text NOT NULL,
	"initiated_by" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"preview" jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"item_count" integer NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "restore_runs_arr_kind_enum" CHECK ("restore_runs"."arr_kind" = ANY (ARRAY['sonarr','radarr','lidarr'])),
	CONSTRAINT "restore_runs_status_enum" CHECK ("restore_runs"."status" = ANY (ARRAY['running','completed','completed_with_errors','failed']))
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"run_kind" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "sync_runs_source_enum" CHECK ("sync_runs"."source" = ANY (ARRAY['sonarr','radarr','lidarr','seerr'])),
	CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental'])),
	CONSTRAINT "sync_runs_status_enum" CHECK ("sync_runs"."status" = ANY (ARRAY['running','succeeded','failed','aborted']))
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"history_cursor" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_state_source_unique" UNIQUE("source"),
	CONSTRAINT "sync_state_source_enum" CHECK ("sync_state"."source" = ANY (ARRAY['sonarr','radarr','lidarr','seerr']))
);
--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fix_requests" ADD CONSTRAINT "fix_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fix_requests" ADD CONSTRAINT "fix_requests_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fix_requests" ADD CONSTRAINT "fix_requests_completed_event_id_ledger_events_id_fk" FOREIGN KEY ("completed_event_id") REFERENCES "public"."ledger_events"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "restore_runs" ADD CONSTRAINT "restore_runs_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "media_items_kind_tvdb_idx" ON "media_items" ("arr_kind","tvdb_id");
--> statement-breakpoint
CREATE INDEX "media_items_kind_tmdb_idx" ON "media_items" ("arr_kind","tmdb_id");
--> statement-breakpoint
CREATE INDEX "media_items_kind_mbid_idx" ON "media_items" ("arr_kind","musicbrainz_artist_id");
--> statement-breakpoint
CREATE INDEX "media_items_sort_title_idx" ON "media_items" ("sort_title");
--> statement-breakpoint
-- D-07: idempotent re-ingestion — overlapping history polls upsert-skip on conflict.
CREATE UNIQUE INDEX "ledger_events_source_event_unique" ON "ledger_events" ("source","source_event_id") WHERE "ledger_events"."source_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "ledger_events_item_occurred_idx" ON "ledger_events" ("media_item_id","occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX "ledger_events_type_occurred_idx" ON "ledger_events" ("event_type","occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX "fix_requests_requester_created_idx" ON "fix_requests" ("requester_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX "fix_requests_item_idx" ON "fix_requests" ("media_item_id");
--> statement-breakpoint
CREATE INDEX "fix_requests_status_idx" ON "fix_requests" ("status");
--> statement-breakpoint
CREATE INDEX "restore_runs_started_idx" ON "restore_runs" ("started_at" DESC);
--> statement-breakpoint
-- DESIGN-005 D-08: Wanted = a view, not a table (DDD-001 T-27 — a Wanted Item is a
-- Monitored Media Item with nothing on disk). Claims the DESIGN-001 D-15 reserved name.
CREATE VIEW "wanted_items" AS
  SELECT id AS media_item_id,
         arr_kind,
         title,
         sort_title,
         year,
         expected_file_count,
         on_disk_file_count,
         size_on_disk,
         last_seen_at
    FROM media_items
   WHERE monitored
     AND deleted_from_arr_at IS NULL
     AND on_disk_file_count = 0;
