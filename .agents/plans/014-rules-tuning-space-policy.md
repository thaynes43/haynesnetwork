# PLAN-014: Rules tuning + space policy (banked — analysis/config, decisions deferred by design)

- **Status:** Draft — **BANKED**: runs after PLAN-013 (owner ordering 2026-07-06). Deliberately
  lean — this is mostly an **analysis + Maintainerr-config** plan, not a build plan; its
  decisions are EXPECTED to be deferred until the data exists.
- **Satisfies:** likely a new **ADR-NN** (the skip-admin-gate graduation criteria + the tuning
  policy of record) and dated as-built notes on the PLAN-012 ADR/DESIGN; little to no PRD/schema
  surface expected. Numbers indicative per `.agents/plans/README.md` — re-grep at slot time.
- **Depends on:** **PLAN-013** (fill/drain + reclaim metrics) and an accumulated body of
  PLAN-012 save-data (several completed batch cycles).
- **TODO source:** owner vision 2026-07-06.

## Goal

Close the loop the owner described: **consume the save-data + the metrics to tune the
Maintainerr rules toward the space target**, and decide when the system has earned hands-off
operation.

1. **Save-data = labeled false positives.** Every human rescue (PLAN-012's
   `trash_batch_saved` events joined to item snapshots and, where derivable, to the rule/
   collection that proposed the item) marks a proposal the rules got WRONG. Analyze rescues by
   rule, by attribute (rating/votes/watch recency/requester/age/quality), and by phase
   (admin vs user) → concrete rule edits (tighten a predicate, add an exclusion dimension,
   retire a rule whose precision is poor).
2. **Iterate aggressiveness against the fill/drain steady state.** If PLAN-013 shows the
   estate still filling toward the space target, loosen deleteAfterDays / widen rule scope
   **stepwise**, one change per batch cycle, watching the save-rate: rising rescues = too
   aggressive; near-zero rescues with drain on target = candidate for graduation.
3. **Skip-admin-gate graduation criteria** (the PLAN-012 setting this plan gives teeth):
   define and record the bar — e.g. N consecutive batches with a save-rate below X% and zero
   guardian near-misses — after which the owner may flip the audited skip-gate. The criteria
   land in the ADR; the flip remains an owner action.

## Shape of the work (expand at slot time)

- Queries/notebook-grade analysis over the 012 event + snapshot rows (a small read-only
  reporting query or two MAY graduate into the 013 surface; no new write path).
- Maintainerr rule edits via the existing confined write client (`upsert/deleteTrashRule`,
  006) or its UI — each edit recorded with its rationale + the batch-cycle evidence.
- The graduation ADR (author when the evidence exists; owner ratifies the flip itself).

## Open decisions (Q-NN — deliberately deferred)

- **Q-01** — the graduation thresholds (N cycles, X% save-rate, guardian-incident tolerance).
- **Q-02** — rule-attribution fidelity: can a batch item be traced to the exact proposing rule
  (collection ↔ rule-group mapping) or only to the collection? Affects analysis grain.
- **Q-03** — whether any tuning automation ships (auto-suggested rule edits) or it stays a
  human-driven analysis loop. Default: human-driven; this estate optimizes for trust.
- **Q-04** — space-target ownership handshake with PLAN-013 (its Q-03).

## Verification + DoD (sketch)

Each tuning iteration is validated by the NEXT batch cycle's save-rate + drain trend (the
pipeline itself is the test harness). DoD: the graduation ADR exists with owner-agreed
criteria; at least one full evidence-backed tuning iteration is recorded; skip-gate flipped
only if the criteria are met (flipping is NOT required for this plan to complete); plan moved
to `completed/`.

## Out of scope

New UI/schema (012/013 own those); any bypass of the 012 state machine, guardian, or audit
trail — tuning changes WHAT is proposed, never HOW deletion is gated.

## Rollback

Rule edits are Maintainerr config — revert to the previous recorded rule definitions; flip the
skip-gate off (audited). Nothing structural to roll back.
