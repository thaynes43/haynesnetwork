-- ADR-046 / DESIGN-024 (PLAN-023 — Books & Audiobooks Library ledger). ADDITIVE only.
--   • books_items — the app-owned, one-way SYNCED MIRROR of the two book servers (Kavita Books+Comics,
--     Audiobookshelf Audio Books): one row per Kavita series / ABS library item, the substrate the
--     Library Books/Audiobooks/Comics poster walls read. A dedicated, leaner table (NOT media_items —
--     books have no monitored/quality/root-folder/Fix semantics; ADR-046 rejects overloading the
--     *arr-shaped ledger). Rebuildable READ-MODEL (the ai_usage_chats / smart_drive_state class): the
--     data of record lives in Kavita/ABS; written ONLY by the @hnet/domain syncBooks single-writer
--     (guard-listed), which upserts the snapshot + tombstones vanished rows. No per-row audit event.
--   • role_section_permissions.section_id CHECK grows 'books' — the new Library sub-tabs' visibility knob
--     (default `disabled` in code = ships Admin-only; a role row opts a role in after screenshot review).
--   • sync_runs.run_kind CHECK grows 'books-sync' — parity only (the mode writes NO sync_runs row; its
--     trail is books_items), so the CLI --mode parser (validated against SYNC_RUN_KINDS) accepts it.
--   • Seed the two book-server catalog cards (Kavita, Audiobookshelf). Admin sees them implicitly (sees
--     ALL apps); NO role grants are seeded — the owner opens them to Default/Family via /admin/roles after
--     his screenshot review (the ship-Admin-only discipline; "which roles see it" is an owner decision).
--     Idempotent per-slug — an admin's later edits/deletes win forever (R-11). No schema change (ADR-012).
-- A down-migration drops books_items, reverts the two CHECKs, and removes the two catalog rows; drop any
-- books-sync run first, though the mode writes none.
CREATE TABLE "books_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"media_kind" text NOT NULL,
	"external_id" text NOT NULL,
	"library_id" text NOT NULL,
	"library_name" text NOT NULL,
	"title" text NOT NULL,
	"sort_title" text NOT NULL,
	"author" text,
	"narrator" text,
	"series_name" text,
	"year" integer,
	"genres" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cover_ref" text,
	"deep_link_url" text NOT NULL,
	"page_count" integer,
	"word_count" integer,
	"duration_seconds" integer,
	"size_bytes" bigint,
	"attrs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_added_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "books_items_source_external_unique" UNIQUE("source","external_id"),
	CONSTRAINT "books_items_source_enum" CHECK ("books_items"."source" = ANY (ARRAY['kavita','audiobookshelf'])),
	CONSTRAINT "books_items_media_kind_enum" CHECK ("books_items"."media_kind" = ANY (ARRAY['book','comic','audiobook']))
);
--> statement-breakpoint
-- The Books/Audiobooks/Comics walls read one media_kind, sorted by title (keyset), live rows only.
CREATE INDEX "books_items_kind_sort_idx" ON "books_items" USING btree ("media_kind","sort_title");--> statement-breakpoint
CREATE INDEX "books_items_kind_live_idx" ON "books_items" USING btree ("media_kind","deleted_at");--> statement-breakpoint
-- role_section_permissions.section_id admits 'books' — the new Library sub-tabs' visibility knob, kept in
-- lockstep with the SECTION_IDS const array. Ships `disabled` in code (Admin-only) — no SQL default row.
ALTER TABLE "role_section_permissions" DROP CONSTRAINT "role_section_permissions_section_enum";--> statement-breakpoint
ALTER TABLE "role_section_permissions" ADD CONSTRAINT "role_section_permissions_section_enum" CHECK ("role_section_permissions"."section_id" = ANY (ARRAY['ledger','trash','bulletin','metrics','ytdlsub','books']));--> statement-breakpoint
-- sync_runs.run_kind admits 'books-sync' — kept in lockstep with SYNC_RUN_KINDS + the CLI --mode parser.
-- Parity only: the mode writes no sync_runs row (its trail is books_items).
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy','notify-outbox','smart-alerts','poster-guard','ai-usage-sync','authentik-users','books-sync']));--> statement-breakpoint
-- Seed the two user-facing book-server catalog cards (ADR-013 arbitrary http(s) URLs). Per-slug
-- idempotent so an admin's later edits/deletes win (R-11); the public URLs go live via the Phase-3 OIDC
-- train. icon keys are code-shipped (packages/ui/src/icons/registry.ts).
INSERT INTO app_catalog (slug, name, description, url, icon, sort_order)
SELECT * FROM (VALUES
  ('kavita',         'Kavita',         'Read — ebooks & comics', 'https://kavita.haynesnetwork.com',        'kavita',         90),
  ('audiobookshelf', 'Audiobookshelf', 'Listen — audiobooks',    'https://audiobookshelf.haynesnetwork.com', 'audiobookshelf', 100)
) AS seed(slug, name, description, url, icon, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM app_catalog WHERE app_catalog.slug = seed.slug);
