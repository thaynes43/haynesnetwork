-- DESIGN-035 D-10' follow-up (live-verified defect, 2026-07-17). Migration 0062 renamed
-- `collection_type` -> `category` PRESERVING values on the assumption the next sync would
-- overwrite them all. That holds for every collection that derives a category from its labels,
-- but a NULL-deriving collection (no owner/section label — e.g. the schedule-pending Audio
-- collections, the Plex/Maintainerr operational collections, the Kometa section hub) is
-- COALESCE-preserved by the writer, so its stale title-classifier bucket ('other' in the live
-- estate) would survive forever and surface as an unwanted "other" chip.
--
-- Clear every legacy six-bucket value to NULL. Label-derived categories (already overwritten
-- with 'Universe' / 'Sequels' / 'List' / ... display-case values) are untouched — the legacy
-- vocabulary is all-lowercase and disjoint from the owner labels. NULL = no chip, shows only
-- under "All", and the next sync re-derives normally when a label appears.
UPDATE "plex_collections" SET "category" = NULL
 WHERE "category" IN ('trilogy','franchise_universe','director','actor','list','other');
