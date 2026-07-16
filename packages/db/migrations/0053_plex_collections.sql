-- ADR-064 / DESIGN-035 (PLAN-037 — mirrored Plex collections). ADDITIVE only.
--   • plex_collections — one row per Plex collection per library (identity (plex_library_id,
--     rating_key) — keys, never names). External software (Plex/Kometa) is ALWAYS the collections
--     source of truth (owner doctrine R1, extending hard rule 4): the app only mirrors. child_count
--     is the RAW Plex member count (diagnostics only — the walls show the ACCESSIBLE ledger-member
--     count, ADR-064 C-03). A rebuildable DERIVED CACHE (the media_plex_matches class): written ONLY
--     by the @hnet/domain syncPlexCollections single-writer (guard-listed), driven by the
--     collections-sync mode; no per-row audit event (synced/derived data).
--   • plex_collection_members — the RAW membership (owner R3 mirror-everything: a member with no
--     ledger match still mirrors), one row per (collection, member rating_key) with the source-read
--     sort_order (stored, unconsumed in v1 — DESIGN-035 D-07). Reads join members →
--     media_plex_matches (plex_library_id, rating_key) → media_items under the ADR-047 gate.
--   • sync_runs.run_kind CHECK grows 'collections-sync' — parity only (the mode writes NO sync_runs
--     row; its trail is the mirror tables), so the CLI --mode parser (validated against
--     SYNC_RUN_KINDS) accepts it.
-- A down-migration drops both tables (members first or via the collection cascade) and reverts the
-- sync_runs.run_kind CHECK.
CREATE TABLE "plex_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plex_library_id" uuid NOT NULL,
	"rating_key" text NOT NULL,
	"title" text NOT NULL,
	"child_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plex_collections_library_rating_key_unique" UNIQUE("plex_library_id","rating_key")
);--> statement-breakpoint
ALTER TABLE "plex_collections" ADD CONSTRAINT "plex_collections_plex_library_id_plex_libraries_id_fk" FOREIGN KEY ("plex_library_id") REFERENCES "public"."plex_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "plex_collection_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"rating_key" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plex_collection_members_collection_rating_key_unique" UNIQUE("collection_id","rating_key")
);--> statement-breakpoint
ALTER TABLE "plex_collection_members" ADD CONSTRAINT "plex_collection_members_collection_id_plex_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."plex_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The drill-in predicate + group counts join members by rating_key (within the collection's library).
CREATE INDEX "plex_collection_members_rating_key_idx" ON "plex_collection_members" USING btree ("rating_key");--> statement-breakpoint
-- sync_runs.run_kind admits 'collections-sync' — kept in lockstep with SYNC_RUN_KINDS + the CLI
-- --mode parser. Parity only: the mode writes no sync_runs row (its trail is the mirror tables).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync','activity-scan','failure-digest','collections-sync']));
