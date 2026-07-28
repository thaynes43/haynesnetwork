# PLAN-062: Migrator advisory lock — serialize concurrent migrate init-containers

- **Status:** ✅ Completed — merged PR #499, released **v0.90.4**, deployed; the lock held in
  production the same day (three concurrent migrate init-containers serialized cleanly at the
  replicas-3 rollout). App-side leg of the **haynes-ops saga `haynesnetwork-ha`**,
  [backlog plan 01](../../../haynes-ops/.agents/sagas/haynesnetwork-ha/backlog/01-migrator-advisory-lock.md)
  (saga Decision 5).
- **No ADR / DESIGN.** This is a one-function safety hardening, not a new decision — the saga
  README already records the approach (`pg_advisory_lock` in the app's migrate script, not a
  Flux-ordered migration Job). No PRD/glossary term is introduced.
- **Number note:** 062 is assigned by the coordinator; plan numbers are stable and never reused
  (this folder's README).
- **Depends on:** nothing. **Unblocks (soft):** saga plan 02 (app replicas 2 + spread + PDB).

## Goal

Make the per-pod `migrate` init-container safe under ANY multi-pod scheduling event, so replica
count is purely a scheduling decision. Today `packages/db/src/migrate.ts` runs drizzle's
node-postgres migrator with no cross-process lock and the migrations are non-idempotent (bare
`CREATE TABLE`). Rolling updates serialize via `maxSurge=1` and are safe, but a cold multi-replica
start or a simultaneous reschedule after node loss races two migrators: the loser exits
`Init:Error` and retries into success (hash-guarded, no corruption) — a self-healing crashloop we
should not ship as a design once replicas > 1.

## Approach

Wrap the `migrate()` call in a **session-level `pg_advisory_lock`** on a fixed app-scoped key,
acquired on the SAME `pg.Client` session that runs the migrator and released with
`pg_advisory_unlock` in a `finally` (session death frees it automatically on crash). Losers block
until the winner commits, then see the migrations hash table already satisfied and no-op. One small
change in `packages/db/src/migrate.ts` (fixed key = ASCII "hnet" = `0x686e6574`); no change to the
init-container command, the Dockerfile, or the GitOps surface. Runbook rollout-order note amended
to state the lock now serializes concurrent/parallel migrators.

## Acceptance

- Two concurrent `runMigrations` runs against a fresh DB both exit 0, no `relation already exists`,
  schema applied exactly once (migrations ledger has each hash once; core table exists once; the
  0002 catalog seed did not double-apply). — `packages/db/__tests__/migrator-concurrency.test.ts`.
- The migrator script carries a comment stating why the lock exists (this saga, plan 01).

## Verification results

- `pnpm --filter @hnet/db test` — green, including the new concurrency test.
- `pnpm typecheck && pnpm lint` — green (touched packages + workspace).
- `pnpm build` — unaffected (migrate path is not bundled into `apps/web`); run as a guard.
- Live in-cluster verification of the multi-replica cold-start race is deferred to saga plan 02
  (haynes-ops), which raises replicas and is where the drill runs; this plan lands the code + test
  guard the saga depends on.
