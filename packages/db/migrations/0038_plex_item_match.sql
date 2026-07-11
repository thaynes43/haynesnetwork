-- ADR-047 / DESIGN-025 (PLAN-028 — Library "Watch/Listen/Read here" access-aware deep links). ADDITIVE only.
--   • media_plex_matches — the *arr → Plex match: one row per (media_item, plex_library) pair a shared-GUID
--     match resolved (a title can live in SEVERAL Plex libraries at once — e.g. a movie mirrored across two
--     servers — so the detail view can render one gated "Watch on Plex — <library>" button per library).
--     Carries the two facts media_items lacks: `plex_library_id` (the Plex library the title lives in — the
--     authoritative PER-ITEM access key the availability resolver gates on) and `rating_key` (the Plex
--     ratingKey, used to build the app.plex.tv "Watch on Plex" deep link; the machineIdentifier is joined
--     off plex_servers, never denormalized). A rebuildable READ-MODEL (the
--     books_items / ai_usage_chats class): the *arrs + Plex are the sources of truth; written ONLY by the
--     @hnet/domain syncPlexMatches single-writer (guard-listed), which the `plex-match` sync mode drives.
--     No per-row audit event (synced/derived data). One match per item (media_item_id UNIQUE); a title Plex
--     has not imported yet simply has no row (unmatched → no deep link; hidden ONLY by access, never by
--     match state — PLAN-028 THE INVARIANT).
--   • sync_runs.run_kind CHECK grows 'plex-match' — parity only (the mode writes NO sync_runs row; its trail
--     is media_plex_matches), so the CLI --mode parser (validated against SYNC_RUN_KINDS) accepts it.
-- A down-migration drops media_plex_matches and reverts the sync_runs.run_kind CHECK (drop any plex-match
-- run first, though the mode writes none).
CREATE TABLE "media_plex_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"media_item_id" uuid NOT NULL,
	"plex_library_id" uuid NOT NULL,
	"rating_key" text NOT NULL,
	"matched_via" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_plex_matches_item_library_unique" UNIQUE("media_item_id","plex_library_id"),
	CONSTRAINT "media_plex_matches_via_enum" CHECK ("media_plex_matches"."matched_via" = ANY (ARRAY['tmdb','imdb','tvdb','musicbrainz']))
);
--> statement-breakpoint
ALTER TABLE "media_plex_matches" ADD CONSTRAINT "media_plex_matches_media_item_id_media_items_id_fk" FOREIGN KEY ("media_item_id") REFERENCES "public"."media_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_plex_matches" ADD CONSTRAINT "media_plex_matches_plex_library_id_plex_libraries_id_fk" FOREIGN KEY ("plex_library_id") REFERENCES "public"."plex_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The access resolver filters by the Plex library (per-item gate) and groups by it (home-library derive).
CREATE INDEX "media_plex_matches_library_idx" ON "media_plex_matches" USING btree ("plex_library_id");--> statement-breakpoint
-- The detail view + per-item gate fetch all rows for one item.
CREATE INDEX "media_plex_matches_item_idx" ON "media_plex_matches" USING btree ("media_item_id");--> statement-breakpoint
-- sync_runs.run_kind admits 'plex-match' — kept in lockstep with SYNC_RUN_KINDS + the CLI --mode parser.
-- Parity only: the mode writes no sync_runs row (its trail is media_plex_matches).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match']));
