# ADR-031: Space-driven batch policy (PROPOSE-only) + skip-gate graduation criteria

- **Status:** Accepted
- **Date:** 2026-07-07
- **Deciders:** Tom Haynes (owner) · authored AND ratified by Fable 5 (PLAN-014 build run, the owner's
  2026-07-07 rulings — conservative-first)
- **Relates:** [ADR-025](025-trash-curation-pipeline.md) / [DESIGN-011](../designs/011-trash-curation-pipeline.md)
  (the curation pipeline this drives — batches, the admin gate, the audited skip-gate, the
  `trash_batch_saves` tuning dataset, the `trash-batch-sweep` orchestrator), [ADR-030](030-disk-and-reclaim-metrics-surface.md)
  / [DESIGN-013](../designs/013-disk-and-reclaim-metrics.md) (`getUtilization`, `space_targets`, the
  `STORAGE_ARRAYS` slug→array map — the substrate this consumes). Realized by
  [DESIGN-014](../designs/014-rules-tuning-space-policy.md). Implements PRD **R-112..R-114**; glossary
  **T-98..T-99**.

## Context and problem statement

PLAN-013 (ADR-030) made the space story **measurable** — utilization vs a per-server **space target**,
and reclaim attribution. It deliberately **stored + displayed** the target but did not act on it (the
Q-03 split: "013 stores, 014 enforces"). PLAN-014 closes that loop with the owner's vision
(2026-07-06): **space is what matters — keep HaynesTower below its target — but the rules are
imperfect, so a human gate stays the check.** Two questions:

1. **What should the system DO when an array is over its space target?** The tempting answer —
   "delete until it's under" — is exactly the autonomous-deletion the whole ADR-023/025 safety machine
   exists to avoid. The owner's instruction is conservative-first: the system may **propose**, never
   dispose.
2. **When has the pipeline earned hands-off operation?** ADR-025 C-07 shipped the audited
   skip-admin-gate MECHANISM but explicitly deferred the DECISION to flip it (the graduation criteria)
   to this plan. Flipping it is the one place the human gate is removed, so the bar must be explicit and
   evidence-backed.

This ADR records the binding decisions; DESIGN-014 realizes them.

## Decision drivers

1. **Propose, never dispose (the load-bearing safety instruction).** Space pressure may CREATE work
   for the admin; it must never bypass the admin gate or the windowed sweep's per-item guardian.
2. **Reuse the pipeline, don't fork it.** A proposal is an ordinary `createBatchFromPending` — the same
   state machine, the same audited skip-gate semantics, the same Leaving-Soon + windowed-sweep path. No
   new deletion code path exists to review.
3. **The save-data is the tuning signal, not an auto-tuner.** Every human rescue is a labelled false
   positive; the report surfaces where the rules are too aggressive so the OWNER edits Maintainerr
   rules by hand. This estate optimizes for trust — no automated rule mutation (PLAN-014 Q-03 default).
4. **Graduation is explicit, evidence-backed, and owner-ratified.** The criteria are recorded here and
   surfaced as live numbers; the flip itself stays an owner action.
5. Consistency with the existing discipline: const-array enums, `setAppSetting` single-writer + same-tx
   audit, import-confined write clients, propose-time idempotence via the existing one-open-per-kind index.

## Considered options

1. **Autonomous drain-to-target** (delete oldest/coldest until under the ceiling). **Rejected** — it is
   precisely the unscopeable autonomous deletion ADR-023 C-07a and ADR-025 forbid; it removes the human
   gate the owner made a structural invariant.
2. **Auto-tune the Maintainerr rules** from the save-data (widen/tighten predicates automatically).
   **Rejected for v1** (PLAN-014 Q-03) — this estate optimizes for trust; a rule edit that changes WHAT
   is proposed is exactly where a human should stay in the loop. The report gives the owner the numbers;
   the edit stays manual.
3. **Propose-only space policy + a rules-tuning REPORT (chosen).** A scheduled, opt-in, DEFAULT-OFF job
   that proposes a draft batch when an array is over target; a read-only report that turns the pipeline
   outcomes into tuning evidence + a graduation readiness readout. The owner ratified this 2026-07-07.

## Decision outcome

Chosen option: **3 (propose-only policy + tuning report)**.

| ID | Consequence |
|----|-------------|
| C-01 | **The `space-policy` sync mode PROPOSES, never deletes.** A new scheduled `@hnet/sync` mode reads `getUtilization()`; for each physical array that (a) is **opted in** (per-array `enabled`), (b) has a `space_targets` ceiling, and (c) is **over** it (`usedPct > target`), it creates a **draft batch** for each Trash kind that array backs — via `createBatchFromPending` (the ORDINARY admin_review path). It **never** calls `greenlightBatch`, **never** runs the sweep. The array→kind map is the ADR-030 `STORAGE_ARRAYS` sources: `haynestower` backs `movie` (Radarr) + `tv` (Sonarr); music/CephFS backs nothing (never batchable, R-87). Like the sweep it writes **no `sync_runs` row** (it touches no *arr source). |
| C-02 | **The admin gate stays the human check; the skip-gate is not special-cased.** A proposed batch lands in `admin_review` exactly like a manual create. If the audited `trash_skip_admin_gate` is ON, the proposal flows through THAT setting's existing audited `gate_skipped` semantics (ADR-025 C-07) — the policy does not add a second bypass or branch. The policy is **DEFAULT OFF** (`space_policy.enabled=false`) and each array is **opt-in** (`perArray.<key>.enabled`), so enabling the policy globally can't surprise-propose on an array the owner didn't intend. |
| C-03 | **Idempotence + anti-spam.** ADR-025's **one-open-per-kind** partial-unique index already blocks a duplicate; the policy handles the refusal gracefully (skip, log, no error). A per-kind **cooldown** (default 7 days) blocks re-proposing within N days of the last policy-created batch for that kind (prevents proposal spam while a batch is mid-window), and a **minCandidates** floor (default 1) skips a proposal when too little is pending to be worth a batch. Both have per-array overrides. |
| C-04 | **Every proposal records WHY.** On a successful propose the policy writes a `trash_space_policy` **ledger event** (batch-scoped, `mediaItemId` null; payload `{ batchId, mediaKind, array, usedPct, target, candidateCount, candidateBytes, gateSkipped }`) AND a `space_policy` **notification** (source `trash`) so the Bulletin/Activity feed shows "policy proposed a batch". The ledger event is also the durable marker the tuning report joins on to identify policy-proposed batches. |
| C-05 | **Skip-gate graduation criteria (resolves ADR-025 C-07 — where PLAN-014 was deferred).** The owner MAY flip the audited `trash_skip_admin_gate` once the pipeline has earned it. The suggested bar (indicative — the owner ratifies the actual flip): **≥ 3 policy-proposed batches COMPLETED** (reached `deleted`) with an **aggregate save-rate ≤ 10%** AND **zero restores of swept items**. `save-rate = rescued / (rescued + deleted)` over those batches (guardian-`skipped` items excluded from the ratio). The **rules-tuning report** surfaces these exact numbers as a "graduation readiness" block; the flip itself stays the owner action (in Trash → Batches settings, ADR-025 C-07). |
| C-06 | **Rules tuning is a REPORT, not an auto-tuner (PLAN-014 Q-03).** `trash.tuning` (adminProcedure) turns the pipeline's outcomes (`trash_batch_items` states ⊕ `media_metadata` ⊕ the policy/restore ledger events) into per-resolution / per-rating-band / per-collection rescue-vs-delete stats — the labelled-false-positive signal the owner reads to tune the Maintainerr rules BY HAND. It never mutates a rule. Rule-attribution fidelity (PLAN-014 Q-02) is **collection-grain** — a batch item traces to its source collection id, not always the exact proposing rule-group; documented. |

## Consequences

- **Positive:** the human gate remains a structural invariant — the ONLY new automated action is
  creating a draft batch an admin still reviews; no new deletion code path exists; the policy is a thin
  scheduler over the existing, well-tested `createBatchFromPending`; DEFAULT-OFF + per-array opt-in +
  cooldown make it safe to enable incrementally; the graduation bar is explicit and live-visible so the
  owner flips the skip-gate on evidence, not vibes; the tuning report closes the "why did the rules
  propose this" loop without ever auto-editing a rule.
- **Negative / trade-offs:** the policy only proposes — an array can sit over target between the admin
  reviewing/green-lighting proposed batches and the window elapsing (accepted: that latency is the human
  gate, working as intended). "Last run" is not persisted in-app (the CronJob log is the run record,
  like the sweep) — the card shows the live over/under readout + the last PROPOSAL + next-eligible
  instead. Rule-attribution is collection-grain, not rule-group-exact (Q-02). No auto-tuning ships (Q-03
  — deliberate).
- **Follow-ups:** if the owner later wants finer rule attribution, a collection↔rule-group map would
  lift `byCollection` to `byRule`. The CronJob ships **suspended** (owner arms it by unsuspending) —
  DESIGN-014 D-08 records the manifest; it is NOT committed to `haynes-ops` here.

## Open questions resolved

| Q (PLAN-014) | Decision |
|---|----------|
| Q-01 Graduation thresholds | ≥ 3 completed policy batches, ≤ 10% aggregate save-rate, 0 restores of swept items (C-05). Indicative; owner ratifies the flip. |
| Q-02 Rule-attribution fidelity | Collection-grain (`trash_batch_items.collection_id`). A rule-group-exact map is a future follow-up (C-06). |
| Q-03 Tuning automation | **None** — human-driven report only (C-06). This estate optimizes for trust. |
| Q-04 Space-target ownership handshake with PLAN-013 | Resolved by ADR-030 C-05 (013 stores/displays `space_targets`; 014 acts on it). The policy READS `getUtilization()`'s merged `target`; it never writes `space_targets`. |
| (new) Space-driven action | PROPOSE-only (`space-policy` sync mode → `createBatchFromPending`), never autonomous deletion (C-01/C-02). |

## References

- Drives ADR-025 (C-01 state machine, C-02 `createBatchFromPending`, C-06 `app_settings`/`setAppSetting`,
  C-07 audited skip-gate + its deferred-to-here graduation criteria) / DESIGN-011. Consumes ADR-030 (C-03
  `getUtilization`, C-05 `space_targets` + `STORAGE_ARRAYS`) / DESIGN-013. Relates ADR-014/015 (confirm +
  no-reorient — the UI card). Realized by DESIGN-014. Migration 0022 (CHECK relaxes for `space_policy`,
  `trash_space_policy`, `space-policy`).
