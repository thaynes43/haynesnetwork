-- ADR-122 / DESIGN-052 D-33: expiry is historical metadata; new records use NULL.
-- Additive compatibility: only relax NOT NULL. Existing values, states, CHECKs and
-- journal entries are untouched. The previous image still inserts finite dates,
-- and its reads/expiry predicates work unchanged against those existing rows.
-- This migration creates no NULL rows and does not reset a historical delete clock.
ALTER TABLE "trash_deleted_releases" ALTER COLUMN "expires_at" DROP NOT NULL;
