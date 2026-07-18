# 2026-07-18 — Trash lifecycle stall: autonomous promotion fix (ADR-073)

Branch `fix/trash-batch-promotion`. Opus autonomous run, owner directive 2026-07-18.

## Owner ruling (the product decision)

> "I disabled the cooldown because that config made no sense. Last night my Trash was reclaimed
> successfully but no new batch has been promoted. After trash is deleted I expect to see a new batch
> that I can have 7 days to save items for. I don't want any artificial delays or gates before the batch
> goes up — I want the machine to keep moving after I am gone, on its own, catering to the unknown for
> all eternity."

Cycle: reclaim → next batch promotes immediately (same run or next tick, no cooldown, no gate) → 7-day
save window → reclaim → …, perpetual, unattended. The 7-day window is the ONLY wanted delay (between
promotion and reclaim, never between reclaim and promotion).

## Lifecycle as-BUILT (pre-fix) + the exact gate

State machine (T-75): `createBatchFromPending` → `admin_review` → (human `greenlightBatch`) →
`leaving_soon` (save window) → (sweep on window close) → `deleted`. Two separate hourly CronJobs:
`space-policy` (:17) proposes; `trash-batch-sweep` (:45) reclaims.

**The blocker was NOT the cooldown.** The space policy (`packages/domain/src/space-policy.ts`,
`proposeForKind`) proposed a batch straight into `admin_review` and STOPPED — promotion to `leaving_soon`
(which opens the save window) required a human `greenlightBatch`. With nobody to green-light, the batch
sat in `admin_review` forever and the cycle died after one more batch. `trash_skip_admin_gate` (T-78) was
OFF/unset, so `createBatchFromPending` used `initialState = 'admin_review'` (trash-batches.ts:356 pre-fix).

The cooldown (`proposeForKind` step 2, `now < lastProposal + cooldownDays`) only gated re-PROPOSAL, and
with `cooldownDays: 0` it correctly never gated — a red herring the owner's mental model conflated with
the real blocker.

## Prod evidence (read-only psql Job, ns frontend, 2026-07-18)

- `app_settings.space_policy` = `{ mode:'over-target', enabled:true, perArray:{haynestower:{enabled:true,
  cooldownDays:0}}, cooldownDays:7, minCandidates:10, perKind:{...maxItems on} }`, updated 2026-07-11 by
  the owner (the per-array cooldownDays:0 = "disabled the cooldown").
- `trash_default_window_days` = 7.
- Batch `455442a0` (movie): policy-proposed 07-11 01:17, human-greenlit 07-11 11:22, **swept/deleted
  07-18 11:45:36** (the reclaim).
- Batch `caa73511` (movie): policy-proposed 07-18 12:17 (over-target 79.4% vs 75%), **STUCK in
  `admin_review`** — the successor that never got its save window. This is the stall.
- Confirms: cooldown=0 did not block (a new batch WAS proposed 32 min after reclaim); the admin-review
  gate blocked promotion. Prod on v0.80.0.

## The fix (ADR-073, DESIGN-014 D-14)

1. `createBatchFromPending` gains `autoPromote`; `space-policy` always passes it → batch driven straight
   `draft → leaving_soon` (`promoteToLeavingSoon`, `gate_skipped=true`, system attribution), independent
   of `trash_skip_admin_gate`. Still never sweeps — only the windowed sweep deletes.
2. Cooldown removed everywhere (`SpacePolicy`, `SpacePolicyArrayConfig`, `effectiveArrayPolicy`, API
   `SpacePolicyInput`, both settings cards, `lib/space-policy`, `SpacePolicyKindStatus`). Pacing =
   one-open-per-kind + the save window. Stale `cooldownDays` jsonb key ignored — **no migration**.
3. Self-heal: `promoteOpenPolicyBatch` promotes a SYSTEM batch (`created_by IS NULL`) stuck in
   `draft`/`admin_review` on the next tick, independent of the over/under-target gate. Manual batches
   (`created_by` set) left untouched; healthy `leaving_soon` batches left alone. New outcomes `promoted`
   / `skipped_under_target` replace `skipped_cooldown`.
4. Test `space-policy.test.ts` reproduces the prod stall (a stuck system `admin_review` batch) and proves
   the next run promotes it (`promoted` → `leaving_soon`), plus auto-promote of fresh batches and the
   manual-batch-untouched / no-duplicate invariants.

Single-writer + audit-in-same-tx preserved (promotion goes through `promoteToLeavingSoon`; the batch
transition event + outbox rows commit same-tx). `pnpm typecheck && lint && lint:css && test && build` all
green.

## Self-heal / prod recovery answer

**No manual nudge needed.** Once the fix deploys, the first post-deploy `space-policy` tick (:17) self-heals
the stuck `caa73511` (system-created, `admin_review`, over target) → `leaving_soon` with a fresh 7-day
window, and the cycle runs unattended thereafter. Release train is not this branch's job — a driver picks
up the squash-merge.
