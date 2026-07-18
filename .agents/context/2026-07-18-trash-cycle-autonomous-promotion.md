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

## ADDENDUM (2026-07-18, post-merge) — verified UTC timeline; recovery claim corrected

The owner corrected the report: he lived "reclaimed last night → nothing for many hours → notified only
after complaining (~16:30Z)". Ground-truth re-pull (psql with explicit `AT TIME ZONE 'UTC'` casts +
Loki cron logs; the earlier probe pod displayed **ET** via k8tz, timestamps above are ET-unlabeled):

**Verified timeline (UTC | ET):**

| UTC | ET | Event |
|---|---|---|
| 07-11 15:22:12Z | 07-11 11:22 | Owner greenlit 455442a0 (7-day window → expires 07-18 15:22Z) |
| 07-17 04:00:04Z | 07-17 00:00 | `batch_leaving_soon_reminder` push SENT ("leaves tomorrow") — **the "last night" push the owner received** |
| 07-18 13:26:03Z | 07-18 09:26 | `batch_final_warning` push sent (2h before close) |
| 07-18 15:22:12Z | 07-18 11:22 | Save window closed |
| 07-18 15:45:12–36Z | 11:45 | Sweep reclaimed: 25 deletions, batch → deleted 15:45:36Z |
| 07-18 15:52:03Z | 11:52 | `batch_swept` push sent |
| 07-18 16:17:02Z | 12:17 | Next policy tick proposed caa73511 → admin_review (**32 min after reclaim**, the very next scheduled run) |
| 07-18 16:26:03Z | 12:26 | `batch_created` push sent (outbox drainer cadence, not complaint-triggered) |
| 07-18 16:39:36Z | 12:39 | **Owner greenlit caa73511 HIMSELF** (transition actor Tom Haynes, 7 days → expires 07-25 16:39:36Z) |

**Tick-by-tick (Loki, `space policy evaluated` lines):** every hourly tick 07-17 18:17Z → 07-18 15:17Z:
movie `skipped_open_batch` (455442a0 leaving_soon held the slot — the save window itself), tv
`skipped_min_candidates` (8 < 10). 16:17Z: movie `proposed`. **`skipped_cooldown` never appears** — the
cooldown never fired. Sweep logs: every :45Z tick `batchesSwept:0` until the 15:45Z sweep. Candidates
pool healthy throughout (614 movie actionable; usedPct 79.4–79.5 vs 75 all night — no stale reading, no
starvation, no slot residue after deletion).

**Corrected conclusions:**
- The reclaim was 07-18 11:45 ET (late morning), not last night. What the owner received last night was
  the midnight (00:00 ET) "leaves tomorrow" reminder — the "hours of nothing" that followed were the tail
  of the still-open 7-day save window he set on 07-11, i.e. the wanted delay, not a stall.
- Reclaim → proposal was 32 minutes (next hourly tick) — compliant with the ruling as-is.
- The ONLY ruling-violating gate was proposal → window-open requiring a human green-light
  (admin_review), which is exactly what ADR-073 / PR #408 removed. No second gate exists; no further fix
  was needed.
- **The recovery claim above is superseded:** caa73511 did NOT need the self-heal — the owner promoted it
  himself at 16:39:36Z (leaving_soon, expires 07-25 16:39:36Z, `created_by` NULL/system,
  `greenlit_by` = owner). Post-deploy (v0.81.0 carries the fix), the self-heal finds a healthy
  leaving_soon batch and correctly leaves it alone; the first fully autonomous propose-and-promote will
  be the cycle after the 07-25 sweep. Prod needs nothing.
