-- ADR-122 / DESIGN-052 D-33: expiry is historical metadata; new records use NULL.
-- Additive schema compatibility: only relax NOT NULL. Existing values, states,
-- CHECKs and journal entries are untouched. Previous finite-date inserts and the
-- ordinary app/delete/reconcile SQL remain valid. This migration creates no NULL
-- rows and does not reset a historical delete clock.
-- Rollback limitation (Q-39): once the new writer has inserted NULL expiry, the
-- previous image's one-off posted-name backfill cannot run unchanged: it calls
-- expiresAt.getTime(). Use the corrected backfill/forward fix for maintenance;
-- do not rewrite permanent rows to finite deadlines to make that old CLI work.
ALTER TABLE "trash_deleted_releases" ALTER COLUMN "expires_at" DROP NOT NULL;
