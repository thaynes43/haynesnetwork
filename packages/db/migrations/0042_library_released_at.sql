-- ADR-051 C-05 / DESIGN-026 D-05 (PLAN-029 — Library views + S&F: the `released_at` data layer). The
-- second must-have date dimension (Date RELEASED) the walls surface alongside Date Added. Two ADDITIVE,
-- nullable columns — no existing data is altered:
--   • media_metadata.released_at — the canonical release instant for a LEDGER item. Populated by the
--     metadata-refresh harvest from the *arr list (Radarr digitalRelease ?? inCinemas ?? physicalRelease;
--     Sonarr firstAired; Lidarr artists have none → null). A null sorts NULLS-LAST like every nullable
--     sort — the D-09 keyset already handles it (no cursor change). Surfaced as SORT_SPECS.released_at + a
--     Release-Date range facet in LIBRARY_FILTER_SHAPE.
--   • books_items.released_at — the precise release instant for a BOOK item (ABS media.metadata
--     publishedDate; Kavita's series list has no date → null so Release Date stays honestly absent from
--     the Kavita registry). Surfaced as the Audiobooks Release-Date sort/facet.
-- Down: DROP COLUMN both (they carry no dependents).
ALTER TABLE "media_metadata" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "books_items" ADD COLUMN "released_at" timestamp with time zone;
