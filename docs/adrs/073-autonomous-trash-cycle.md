# ADR-073: Autonomous Trash cycle — space policy promotes its own batches, no cooldown

- **Status:** Accepted
- **Date:** 2026-07-18
- **Deciders:** Tom Haynes (owner ruling 2026-07-18) · executed by an Opus autonomous run
- **Supersedes:** [ADR-031](031-space-driven-batch-policy.md) consequences **C-02** (admin gate stays
  the human check; skip-gate not special-cased) and **C-03** (per-kind cooldown). ADR-031 C-01
  (propose from utilization), C-04 (record WHY), C-05 (graduation criteria — now advisory only), and
  C-06 (tuning report) stand.
- **Relates:** [ADR-025](025-trash-curation-pipeline.md) / [DESIGN-011](../designs/011-trash-curation-pipeline.md)
  (the curation pipeline — state machine, the audited skip-gate `gate_skipped`, `promoteToLeavingSoon`,
  the windowed sweep), [ADR-034](034-pushover-batch-notifications.md) (the same-tx outbox pushes fired on
  create + leaving-soon). Realized in `packages/domain/space-policy.ts` + `trash-batches.ts`. Glossary
  **T-98** amended.

## Context and problem statement

ADR-031 shipped the space policy as **propose-only**: an over-target array causes a draft batch that
lands in `admin_review` and waits for a human green-light before the save window opens (T-98). A per-kind
**cooldown** (default 7 days) additionally blocked re-proposing.

In production (2026-07-18) this stalled the cycle. A policy batch was reclaimed (swept to `deleted`) on
its 7-day window closing; the next `space-policy` tick proposed a fresh batch — but it sat in
`admin_review` forever, because promotion to `leaving_soon` (which opens the save window) required a human
green-light that never came. The owner also set the per-array cooldown to `0` believing it was the
blocker; it was not (a `0`-day cooldown correctly never gates), but the cooldown is nonetheless an
artificial delay between reclaim and the next batch.

The owner ruling (2026-07-18, verbatim intent): **"I don't want any artificial delays or gates before
the batch goes up — I want the machine to keep moving after I am gone, on its own, catering to the unknown
for all eternity."** The cycle is: reclaim → the next batch promotes immediately (same run or the very
next scheduled run, no cooldown, no waiting gate) → 7-day save window → reclaim → …, perpetually,
unattended. The 7-day save window IS the wanted delay — between promotion and reclaim, never between
reclaim and promotion.

## Decision drivers

1. **Unattended perpetual motion is now the product ruling.** The space policy is the autonomous engine;
   it must complete its own cycle without a human in the loop.
2. **Still never autonomously deletes.** Only the windowed sweep reclaims, after the full save window —
   the load-bearing ADR-023/025 safety invariant (window + per-item guardian at sweep) is untouched.
3. **The save window is the only intended delay.** One-open-per-kind plus the save window are sufficient
   pacing; a cooldown between reclaim and promotion is exactly the artificial delay the ruling forbids.
4. **Self-healing for eternity.** A run that dies mid-cycle, or a batch left stuck by the old flow, must
   converge on the next tick — no duplicate batches, no permanent "no batch" state.
5. **Manual creation is unchanged.** An admin who starts a batch by hand still gets the `admin_review`
   gate (unless they turn on the global `trash_skip_admin_gate`). Only the autonomous engine self-promotes.
6. Reuse the pipeline: promotion goes through the existing `promoteToLeavingSoon` (Leaving-Soon collection
   drive, save window, the same-tx ADR-034 outbox pushes) with `gate_skipped=true` + system attribution —
   no new deletion path, and the audit trail still distinguishes a system auto-promote from a human
   green-light.

## Decision outcome

| ID | Consequence |
|----|-------------|
| C-01 | **The space policy PROPOSES AND PROMOTES.** `createBatchFromPending` grows an `autoPromote` flag; the `space-policy` mode always passes it. A proposed batch is driven straight `draft → leaving_soon` with the save window open, `gate_skipped=true`, system attribution (`createdBy`/`greenlitBy` null) — REGARDLESS of the global `trash_skip_admin_gate`. It still never green-lights via a human path and never sweeps: only the windowed sweep deletes, after the full window. This supersedes ADR-031 C-02. |
| C-02 | **No cooldown.** The per-kind/per-array `cooldownDays` knob is REMOVED from `SpacePolicy`, the app-settings model, the API input, both admin UIs (General "Batch policy" + Storage "Space policy" cards), the `lib/space-policy` helpers, and the status read. Pacing is one-open-per-kind + the save window alone. A stale `cooldownDays` key on an old stored `space_policy` jsonb row is harmlessly ignored on read (no migration required). This supersedes ADR-031 C-03. |
| C-03 | **Self-heal (idempotent convergence).** On every run, for each opted-in array's backing kinds, a batch a prior run left stuck in `draft`/`admin_review` that is SYSTEM-created (`created_by IS NULL`) is promoted to `leaving_soon` (`promoteOpenPolicyBatch`, `gate_skipped=true`) — independent of the over/under-target gate, so a mid-cycle death under target still converges. A healthy `leaving_soon` batch is left alone (its window is running); a MANUAL batch (`created_by` set) is never auto-promoted — it stays the admin's to curate. One-open-per-kind guarantees no duplicate. |
| C-04 | **Over-target vs continuous unchanged for NEW proposals.** `over-target` mode still proposes a new batch only while `usedPct > target`; `continuous` mode proposes whenever there are ≥ `minCandidates` with no open batch. `minCandidates` stays (a "worth a batch" floor, not a time delay). Self-heal (C-03) runs regardless of this gate. |
| C-05 | **Graduation criteria (ADR-031 C-05) become advisory only.** The autonomous engine no longer depends on `trash_skip_admin_gate`, so the graduation readiness block is informational for MANUAL green-lighting; it no longer gates the autonomous cycle. The tuning report (ADR-031 C-06) is unchanged. |

## Consequences

- **Positive:** the cycle runs unattended for eternity — reclaim → next tick proposes and promotes with
  the save window → sweep after the window → repeat. The current prod stall self-heals on the first
  post-deploy `space-policy` tick (the stuck `admin_review` batch is promoted). No new deletion path; the
  save window + per-item sweep guardian remain the safety invariant; manual batch creation still honors
  the admin gate. The dead cooldown knob is gone from every surface (no zombie control).
- **Negative / trade-offs:** an over-target array's cold items now leave without a per-batch human review
  (that IS the ruling — the save window is the review, exercised by anyone during the 7 days). The
  `gate_skipped` audit flag is now true for every policy batch (honest: the admin-review gate WAS
  bypassed, by design). A saved item still permanently excludes; the window still protects recently-watched
  / dnd at the sweep.
- **Follow-ups:** none required. `continuous` mode is the more "eternal" choice if the owner ever wants
  batches to keep flowing even when the array dips under target; `over-target` (current prod config)
  pauses the cycle only while genuinely under target, which is the desired behavior.

## References

- Supersedes ADR-031 C-02/C-03. Reuses ADR-025 C-01 (`promoteToLeavingSoon`), ADR-034 (same-tx outbox).
  No migration (the `space_policy` jsonb value simply drops `cooldownDays`; stale keys are ignored).
  Implemented in `@hnet/domain` (`space-policy.ts`, `trash-batches.ts`, `app-settings.ts`), `@hnet/api`
  (`storage.ts`), and `apps/web` (the two settings cards + `lib/space-policy.ts`).
