-- ADR-022 C-01 — generalize restore_runs into arr-add runs. A run now records HOW it was
-- initiated: 'restore' (the admin-only diff-driven failsafe, searches OFF, skip-if-present)
-- or 'ledger_add' (the Ledger section's bulk Add-&-search, searches ON, monitors
-- present-but-unmonitored items). The table name is kept (no rename migration — ADR-022 C-02);
-- only a `reason` column is added, NOT NULL DEFAULT 'restore' so every existing row backfills
-- to the failsafe meaning. A CHECK constrains it to ARR_ADD_REASONS.
ALTER TABLE "restore_runs" ADD COLUMN "reason" text DEFAULT 'restore' NOT NULL;--> statement-breakpoint
ALTER TABLE "restore_runs" ADD CONSTRAINT "restore_runs_reason_enum" CHECK ("restore_runs"."reason" = ANY (ARRAY['restore','ledger_add']));
