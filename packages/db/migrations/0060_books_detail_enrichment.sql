-- Books detail-page PARITY enrichment (owner directive 2026-07-17 — "get books/comics/audiobooks
-- closer to matching the movie detail page"). ADDITIVE only; every column NULLABLE (older Kavita/ABS
-- versions, and un-enriched rows, degrade to null — the empty-section-collapses idiom).
--
-- DESIGN-024 D-01 amendment. The enrichment feeds the detail page's About + Details sections:
--   • summary          — the About blurb (Kavita /api/Series/metadata `summary`, HTML-stripped; ABS
--                        `media.metadata.description`). NULL until enriched / when the source has none.
--   • publisher        — Kavita metadata `publishers[0].name` / ABS `media.metadata.publisher`.
--   • language         — stays in `attrs.language` (unchanged — the facet reads it there); NOT a column.
--   • isbn             — ABS `media.metadata.isbn` (Kavita series ISBNs are usually absent — the M2
--                        caveat — and live in the heavier series-detail call we deliberately skip, so
--                        Kavita rows keep isbn NULL: an honest gap, populated-value-gated in the UI).
--   • file_count       — ABS `media.numAudioFiles` (the audiobook's part count). Kavita NULL (same
--                        series-detail gap). size_bytes already exists (ABS `media.size`).
--   • metadata_synced_at — enrichment bookkeeping: the instant the per-series Kavita metadata call last
--                        ran for this row. The books-sync change-gate enriches a Kavita series only when
--                        it is NEW (this is NULL) or its source updated-stamp changed since the last run,
--                        so the hourly sync stays cheap for ~1,400 unchanged series (per-series metadata
--                        is the only extra Kavita request; ABS enrichment rides the existing list read).
--                        ABS rows set it every run (their enrichment is free/inline).
--
-- genres (jsonb, already present) + year now get POPULATED for Kavita from the metadata call
-- (releaseYear); no schema change for those. A down-migration drops the five columns below.
ALTER TABLE "books_items" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "books_items" ADD COLUMN "publisher" text;--> statement-breakpoint
ALTER TABLE "books_items" ADD COLUMN "isbn" text;--> statement-breakpoint
ALTER TABLE "books_items" ADD COLUMN "file_count" integer;--> statement-breakpoint
ALTER TABLE "books_items" ADD COLUMN "metadata_synced_at" timestamp with time zone;
