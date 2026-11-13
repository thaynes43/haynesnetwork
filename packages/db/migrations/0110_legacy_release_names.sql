-- ADR-117 / DESIGN-052 D-29 (story 838; owner ruling 2026-11-13: a release that was grabbed is never grabbed again,
-- so Trash deletes a title only when the release on disk has a verified posted name). ADDITIVE, three parts:
-- (1) legacy_release_names: the release names the Radarr and Sonarr databases from before the 2026-07-03 move
--     recorded, keyed by the title's own id (TMDB on Radarr, TVDB on Sonarr): grabbed, imported and failed history
--     events and each file record's original release name with its exact byte size. Loaded once by the one-off
--     loader (packages/sync/src/scripts/legacy-release-names-load.ts); a second load adds nothing (dedupe_key).
-- (2) legacy_download_jobs: the two old SABnzbd histories (name, bytes, completion, category, status), a secondary
--     source with no title id.
--     Neither table ever stores a URL (the CHECKs refuse a name containing "://"), an indexer, a download id, a
--     setting or a path.
-- (3) trash_batch_items.keep_reason admits `release_unverified` (the file on disk has no verified posted name) and
--     `release_block_full` (the delete's terms would not fit under the Release Block's cap).
-- (4) trash_deleted_releases.identity_source admits `legacy_arr` (a name from legacy_release_names).
-- The previous image never reads the new tables and never writes the new values, so it runs unchanged against this
-- schema. A down-migration drops the two tables and restores the 0088 and 0081 CHECKs (after rewriting any row that
-- carries a new keep reason to `release_unrecorded` and any `legacy_arr` source to `legacy_sab`).
CREATE TABLE "legacy_release_names" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arr_kind" text NOT NULL,
	"external_id" integer NOT NULL,
	"record_kind" text NOT NULL,
	"release_name" text NOT NULL,
	"size_bytes" bigint,
	"occurred_at" timestamp with time zone,
	"release_group" text,
	"season" integer,
	"quality" text,
	"title" text,
	"dedupe_key" text NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_release_names_arr_kind_enum" CHECK ("legacy_release_names"."arr_kind" = ANY (ARRAY['radarr','sonarr'])),
	CONSTRAINT "legacy_release_names_record_kind_enum" CHECK ("legacy_release_names"."record_kind" = ANY (ARRAY['grabbed','imported','failed','file'])),
	CONSTRAINT "legacy_release_names_external_id_positive" CHECK ("legacy_release_names"."external_id" > 0),
	CONSTRAINT "legacy_release_names_name_not_url" CHECK (length(btrim("legacy_release_names"."release_name")) > 0 AND position('://' in "legacy_release_names"."release_name") = 0),
	CONSTRAINT "legacy_release_names_file_has_size" CHECK ("legacy_release_names"."record_kind" <> 'file' OR ("legacy_release_names"."size_bytes" IS NOT NULL AND "legacy_release_names"."size_bytes" > 0))
);--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_release_names_dedupe_uq" ON "legacy_release_names" ("dedupe_key");--> statement-breakpoint
CREATE INDEX "legacy_release_names_title_idx" ON "legacy_release_names" ("arr_kind","external_id");--> statement-breakpoint
CREATE TABLE "legacy_download_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"bytes" bigint NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"category" text,
	"status" text,
	"dedupe_key" text NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_download_jobs_name_not_url" CHECK (length(btrim("legacy_download_jobs"."name")) > 0 AND position('://' in "legacy_download_jobs"."name") = 0),
	CONSTRAINT "legacy_download_jobs_bytes_positive" CHECK ("legacy_download_jobs"."bytes" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_download_jobs_dedupe_uq" ON "legacy_download_jobs" ("dedupe_key");--> statement-breakpoint
CREATE INDEX "legacy_download_jobs_bytes_idx" ON "legacy_download_jobs" ("bytes");--> statement-breakpoint
ALTER TABLE "trash_batch_items" DROP CONSTRAINT "trash_batch_items_keep_reason_enum";--> statement-breakpoint
ALTER TABLE "trash_batch_items" ADD CONSTRAINT "trash_batch_items_keep_reason_enum" CHECK ("trash_batch_items"."keep_reason" IS NULL OR "trash_batch_items"."keep_reason" = ANY (ARRAY['tag','recently_watched','watchlisted','unevaluable','not_in_pool','live_excluded','release_unrecorded','recently_added','saved','release_unverified','release_block_full']));--> statement-breakpoint
ALTER TABLE "trash_deleted_releases" DROP CONSTRAINT "trash_deleted_releases_identity_source_enum";--> statement-breakpoint
ALTER TABLE "trash_deleted_releases" ADD CONSTRAINT "trash_deleted_releases_identity_source_enum" CHECK ("trash_deleted_releases"."identity_source" = ANY (ARRAY['arr_grab_history','arr_file','ledger_grab','legacy_sab','none','legacy_arr']));
