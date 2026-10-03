-- ADR-096 / DESIGN-052 D-26 (owner ruling 2026-10-03, "Block automation only"): a title deleted through Trash gets a
-- Radarr or Sonarr import-list exclusion, written by the app before the delete, so Kometa and the *arrs' own import
-- lists never add it again. Journal idx 85. ADDITIVE, one part: the append-only audit of every exclusion the app wrote,
-- trash_title_exclusions (one row per confirmed write; a title already excluded gets no row). The previous image never
-- reads or writes the table, so it runs unchanged against this schema. A down-migration drops the table.
CREATE TABLE "trash_title_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"arr_kind" text NOT NULL,
	"tmdb_id" integer,
	"tvdb_id" integer,
	"title" text NOT NULL,
	"year" integer,
	"arr_exclusion_id" integer NOT NULL,
	"origin" text NOT NULL,
	"media_item_id" uuid,
	"batch_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trash_title_exclusions_arr_kind_enum" CHECK ("trash_title_exclusions"."arr_kind" = ANY (ARRAY['radarr','sonarr'])),
	CONSTRAINT "trash_title_exclusions_origin_enum" CHECK ("trash_title_exclusions"."origin" = ANY (ARRAY['sweep','expedite','backfill'])),
	CONSTRAINT "trash_title_exclusions_key" CHECK (("trash_title_exclusions"."arr_kind" = 'radarr' AND COALESCE("trash_title_exclusions"."tmdb_id", 0) > 0) OR ("trash_title_exclusions"."arr_kind" = 'sonarr' AND COALESCE("trash_title_exclusions"."tvdb_id", 0) > 0))
);--> statement-breakpoint
ALTER TABLE "trash_title_exclusions" ADD CONSTRAINT "trash_title_exclusions_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trash_title_exclusions" ADD CONSTRAINT "trash_title_exclusions_batch_item_id_trash_batch_items_id_fk" FOREIGN KEY ("batch_item_id") REFERENCES "public"."trash_batch_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "trash_title_exclusions_kind_created_idx" ON "trash_title_exclusions" USING btree ("arr_kind","created_at");
