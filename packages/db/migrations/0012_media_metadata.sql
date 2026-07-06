-- ADR-018 / DESIGN-008 D-01/D-11 — Library metadata enrichment.
-- media_metadata: the harvested descriptive/quality metadata for a Media Item, held 1:1 in a
-- SEPARATE sibling table (ADR-018 — not columns on media_items, which is the volatile-free
-- Sync/Restore aggregate). Keyed by media_item_id (unique FK, cascade); tombstone-survivable.
-- Also relaxes the sync_runs run_kind CHECK to admit the new 'metadata-refresh' harvest mode
-- (D-03) — a DISTINCT run from full/incremental sync.
CREATE TABLE "media_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_item_id" uuid NOT NULL,
	"imdb_rating" numeric(3, 1),
	"imdb_votes" integer,
	"tmdb_rating" numeric(4, 1),
	"tmdb_votes" integer,
	"rt_tomatometer" integer,
	"rt_popcorn" integer,
	"runtime_minutes" integer,
	"resolution" text,
	"genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"arr_added_at" timestamp with time zone,
	"play_count" integer,
	"last_viewed_at" timestamp with time zone,
	"requesters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_collections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"poster_source" text,
	"poster_ref" text,
	"sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_metadata_media_item_unique" UNIQUE("media_item_id"),
	CONSTRAINT "media_metadata_resolution_enum" CHECK ("media_metadata"."resolution" IS NULL OR "media_metadata"."resolution" = ANY (ARRAY['2160p','1080p','720p','576p','480p','sd','unknown'])),
	CONSTRAINT "media_metadata_poster_source_enum" CHECK ("media_metadata"."poster_source" IS NULL OR "media_metadata"."poster_source" = ANY (ARRAY['arr','tmdb']))
);
--> statement-breakpoint
ALTER TABLE "media_metadata" ADD CONSTRAINT "media_metadata_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_metadata_fetched_at_idx" ON "media_metadata" ("fetched_at");--> statement-breakpoint
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh']));
