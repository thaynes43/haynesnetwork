-- ADR-066 / DESIGN-038 (PLAN-051 — books collections mirror). ADDITIVE only.
--   • books_collections — one row per mirrored BOOK collection per source per kind (identity
--     (source, external_id, kind) — a Kavita reading list is a distinct id space from Kavita
--     collections, so kind is part of the identity; keys, never names). External software
--     (Kavita/ABS) is ALWAYS the collections source of truth (owner doctrine R1, the ADR-064 model
--     applied to books): the app only mirrors; @hnet/books keeps NO write surface. `ordered`
--     records whether the SOURCE carries an explicit member order (Kavita reading lists + ABS
--     collections: yes, verified against the deployed versions' sources; Kavita collections: no).
--     `item_count` is the RAW source member count (diagnostics only — the walls show the resolved
--     live-member count of the wall's kind). `library_id` is the source library scope where one
--     exists (ABS); Kavita concepts are server-wide (null). A rebuildable DERIVED CACHE (the
--     plex_collections class): written ONLY by the @hnet/domain syncBooksCollections single-writer
--     (guard-listed), driven by the books-collections-sync mode; no per-row audit event.
--   • books_collection_members — the RAW membership (a member whose series/item has no books_items
--     mirror row still mirrors), one row per (collection, external_ref) with the source position
--     (DESIGN-038 D-09 semantics) and an OPPORTUNISTICALLY resolved books_item_id (refreshed every
--     sync; ON DELETE SET NULL so the raw ref survives an item hard-delete). Reads join
--     books_item_id → books_items under the books-section gate.
--   • sync_runs.run_kind CHECK grows 'books-collections-sync' — parity only (the mode writes NO
--     sync_runs row; its trail is the mirror tables), so the CLI --mode parser (validated against
--     SYNC_RUN_KINDS) accepts it.
-- A down-migration drops both tables (members first or via the collection cascade) and reverts the
-- sync_runs.run_kind CHECK.
CREATE TABLE "books_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"kind" text NOT NULL,
	"library_id" text,
	"title" text NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"ordered" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_collections_source_external_kind_unique" UNIQUE("source","external_id","kind"),
	CONSTRAINT "books_collections_source_enum" CHECK ("books_collections"."source" = ANY (ARRAY['kavita','audiobookshelf'])),
	CONSTRAINT "books_collections_kind_enum" CHECK ("books_collections"."kind" = ANY (ARRAY['collection','reading_list']))
);--> statement-breakpoint
CREATE TABLE "books_collection_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"collection_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"books_item_id" uuid,
	"position" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_collection_members_collection_external_ref_unique" UNIQUE("collection_id","external_ref")
);--> statement-breakpoint
ALTER TABLE "books_collection_members" ADD CONSTRAINT "books_collection_members_collection_id_books_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."books_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books_collection_members" ADD CONSTRAINT "books_collection_members_books_item_id_books_items_id_fk" FOREIGN KEY ("books_item_id") REFERENCES "public"."books_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The drill-in predicate + group counts join members by their resolved books item.
CREATE INDEX "books_collection_members_books_item_idx" ON "books_collection_members" USING btree ("books_item_id");--> statement-breakpoint
-- sync_runs.run_kind admits 'books-collections-sync' — kept in lockstep with SYNC_RUN_KINDS + the
-- CLI --mode parser. Parity only: the mode writes no sync_runs row (its trail is the mirror tables).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync','activity-scan','failure-digest','collections-sync','format-pairing','books-collections-sync']));
