-- ADR-031 / DESIGN-014 (PLAN-014 rules tuning + space-driven policy) — THREE CHECK rebuilds, all
-- additive (existing rows keep validating; no new table, column, FK, or index). Each mirrors the
-- 0019 (motd) / 0020 (notifications 'trash') / 0021 (space_targets) CHECK-rebuild pattern: drop the
-- named constraint and re-add it with the full ARRAY built from the const source-of-truth array,
-- now including the new value. A down-migration reverts to the prior list (drop any row/value using
-- the new member first).
--
-- 1. app_settings.key admits 'space_policy' — the space-driven-policy CONFIG jsonb (DEFAULT OFF).
--    Owned + written through the audited setAppSetting single-writer (same store as space_targets).
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_key_enum";--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_key_enum" CHECK ("app_settings"."key" = ANY (ARRAY['trash_skip_admin_gate','trash_default_window_days','motd','space_targets','space_policy']));--> statement-breakpoint
-- 2. ledger_events.event_type admits 'trash_space_policy' — the batch-scoped event the space-policy
--    mode appends when it PROPOSES a batch (explaining array/usedPct/target/candidate counts). It is
--    the durable record the tuning report + Bulletin/Activity read; the proposal itself is a normal
--    createBatchFromPending (its own trash_batch_transition events are unchanged).
ALTER TABLE "ledger_events" DROP CONSTRAINT "ledger_events_event_type_enum";--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_event_type_enum" CHECK ("ledger_events"."event_type" = ANY (ARRAY['grabbed','imported','deleted','download_failed','requested','fix_requested','fix_actioned','fix_completed','fix_failed','restored','search_requested','trash_excluded','trash_expedited','trash_restored','trash_batch_transition','trash_space_policy']));--> statement-breakpoint
-- 3. sync_runs.run_kind admits 'space-policy' — the new PROPOSAL sync mode. Parity only: like
--    trash-batch-sweep the mode writes NO sync_runs row (it touches no *arr source), but the CHECK is
--    kept in lockstep with the const array so a stray row would validate and the CLI --mode parser is
--    consistent.
ALTER TABLE "sync_runs" DROP CONSTRAINT "sync_runs_run_kind_enum";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_run_kind_enum" CHECK ("sync_runs"."run_kind" = ANY (ARRAY['full','incremental','metadata-refresh','trash-batch-sweep','space-policy']));
