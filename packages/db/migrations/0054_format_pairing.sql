-- ADR-065 / DESIGN-036 (PLAN-050 — book ⇄ audiobook format pairing). ADDITIVE:
--   • books_format_pairs — the FORMAT PAIR derived cache (one row per conservatively-matched
--     Kavita-book ⇄ ABS-audiobook pair; each side UNIQUE; rebuildable — the media_plex_matches
--     class, single-writer syncFormatPairs, no audit row).
--   • book_requests grows the SYSTEM-WANT seat: integration_id/shelf_item_id go NULLABLE, a new
--     `origin` discriminator ('goodreads' default | 'pairing'), a new `pairing_books_item_id` FK
--     (the anchor library item whose missing format the want fills), an origin↔keys coherence
--     CHECK, and a partial unique — ONE pairing want per anchor item for its lifetime (the missing
--     format is implied by the anchor's media_kind; the pair reconcile self-heals it on re-vanish).
--   • SYNC_RUN_KINDS grows 'format-pairing' — parity run-kind CHECK rebuild (the 0050 pattern; the
--     mode writes NO sync_runs row).
-- A down-migration drops the pair table + the three book_requests additions, restores the NOT
-- NULLs (delete origin='pairing' rows first), and reverts the run-kind CHECK.
CREATE TABLE "books_format_pairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_item_id" uuid NOT NULL,
	"audio_item_id" uuid NOT NULL,
	"matched_via" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_format_pairs_book_unique" UNIQUE("book_item_id"),
	CONSTRAINT "books_format_pairs_audio_unique" UNIQUE("audio_item_id"),
	CONSTRAINT "books_format_pairs_via_enum" CHECK ("books_format_pairs"."matched_via" = ANY (ARRAY['title_author']))
);--> statement-breakpoint
ALTER TABLE "books_format_pairs" ADD CONSTRAINT "books_format_pairs_book_item_id_books_items_id_fk" FOREIGN KEY ("book_item_id") REFERENCES "public"."books_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "books_format_pairs" ADD CONSTRAINT "books_format_pairs_audio_item_id_books_items_id_fk" FOREIGN KEY ("audio_item_id") REFERENCES "public"."books_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_requests" ALTER COLUMN "integration_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "book_requests" ALTER COLUMN "shelf_item_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN "origin" text DEFAULT 'goodreads' NOT NULL;--> statement-breakpoint
ALTER TABLE "book_requests" ADD COLUMN "pairing_books_item_id" uuid;--> statement-breakpoint
ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_pairing_books_item_id_books_items_id_fk" FOREIGN KEY ("pairing_books_item_id") REFERENCES "public"."books_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_origin_enum" CHECK ("book_requests"."origin" = ANY (ARRAY['goodreads','pairing']));--> statement-breakpoint
ALTER TABLE "book_requests" ADD CONSTRAINT "book_requests_origin_keys" CHECK (("book_requests"."origin" = 'goodreads' AND "book_requests"."shelf_item_id" IS NOT NULL AND "book_requests"."integration_id" IS NOT NULL) OR ("book_requests"."origin" = 'pairing' AND "book_requests"."pairing_books_item_id" IS NOT NULL));--> statement-breakpoint
CREATE UNIQUE INDEX "book_requests_pairing_item_unique" ON "book_requests" USING btree ("pairing_books_item_id") WHERE "book_requests"."pairing_books_item_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync','plex-match','mam-governor','goodreads-sync','activity-scan','failure-digest','collections-sync','format-pairing']));
