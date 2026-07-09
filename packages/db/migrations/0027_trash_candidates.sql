-- ADR-035 / DESIGN-010 amendment (2026-07-09) — the Trash candidate READ-MODEL. The Trash walls,
-- Overview counts, and Start-a-batch preview were re-crawling Maintainerr's paged collection API on
-- every request (measured 6–9 s cold on the live install: 15 serial 50-item pages for 742 movies,
-- with the tab firing up to four such crawls concurrently). These tables materialize that flat
-- pending set into Postgres: the sync CronJobs (and an admin on-demand refresh) rebuild the
-- snapshot; every USER-FACING read serves from here in milliseconds. Maintainerr remains the
-- deletion system of record — all destructive flows (expedite, batch create, sweep, guardian)
-- still read the LIVE pending set through the guarded seams; this is display-side derived state,
-- rebuildable at any time, written only by the @hnet/domain trash-candidates refresher.
CREATE TABLE "trash_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "media_kind" text NOT NULL,
  "collection_id" integer NOT NULL,
  "collection_title" text,
  "delete_after_days" integer,
  "maintainerr_media_id" text,
  "tmdb_id" integer,
  "tvdb_id" integer,
  "size_bytes" bigint NOT NULL DEFAULT 0,
  "add_date" text,
  "ord" integer NOT NULL DEFAULT 0,
  CONSTRAINT "trash_candidates_kind_check" CHECK (media_kind IN ('movie','tv'))
);--> statement-breakpoint
CREATE INDEX "trash_candidates_kind_idx" ON "trash_candidates" ("media_kind");--> statement-breakpoint
CREATE TABLE "trash_candidates_state" (
  "media_kind" text PRIMARY KEY NOT NULL,
  "refreshed_at" timestamp with time zone NOT NULL,
  "item_count" integer NOT NULL,
  "total_size_bytes" bigint NOT NULL,
  CONSTRAINT "trash_candidates_state_kind_check" CHECK (media_kind IN ('movie','tv'))
);
