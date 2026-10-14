# PLAN-083: Periodic proactive reconciliation feasibility

- **Status: Draft / UNGROOMED EPIC-LEVEL SPIKE / PAUSED.**
- **Saga:** [PLAN-078](078-repair-agent-saga.md). This phase is an epic, not an execution order.
- **Depends on:** PLAN-082 evidence/playbooks and the accepted repair outcome contract
- **Authorization:** documentation only. Grooming and an explicit owner decision
  are required before any story executes. No automatic transition to another phase.

## Questions and hypotheses

- Q-01: Can periodic reconciliation find useful defects with manageable false positives?
- Q-02: Which signals and verifiers differ across movies, TV, books, audiobooks and bad metadata?
- Q-03: What cadence, sampling and per-run limits would produce value within an approved budget?
- Hypothesis: a small observe-only pass can identify trustworthy candidate cases before any automatic repair schedule.

## Scope and usable deliverable

Investigate periodic checks across all five named categories without sweeping the
estate. Deliver a bounded findings report and proposed scheduling policy. Begin
observe-only; any repair prototype uses a separately authorized fixture or case and
the existing verified-outcome contract. Metadata disagreements are candidates, not
proof of corrupt or wrong content. Do not create a schedule in this spike by default.

## Proposed one-agent, one-session stories

These are grooming candidates, not assigned work. Each produces its own evidence
and can be accepted independently once its declared inputs are ready.

| Story | Input and bounded work | Usable output / acceptance | Proposed session cap |
|---|---|---|---|
| 083-S1 | KB/verifiers; select a tiny sample covering all five categories | Coverage map, case-specific verifier and proposed cadence/cost policy | 30 min |
| 083-S2 | S1 sample; run an approved read-only reconciliation prototype | Evidence-linked findings with false-positive review, exclusions and bounded next actions | 45 min |
| 083-S3 | One verified finding and explicit repair permission if granted | Demonstrate reuse of repair/escalation flow, or a useful no-write handoff if permission is absent | 30 min |

**Dependency graph:** 083-S1 -> 083-S2 -> 083-S3; read-only category sampling may parallelize only within a groomed total cap No parallel execution is authorized now. Any future
parallelism needs a groomed graph and disjoint mutable resources.

## Acceptance steps and exit criteria

1. Inspect at most two selected records per category; record movies, TV, books, audiobooks and metadata coverage explicitly.
2. Verify each proposed defect independently and show a known benign disagreement is not repaired automatically.
3. Report actionable findings, false positives, missed/unknown cases, scan time and cost; do not extrapolate estate-wide reliability from the sample.
4. Show deduplication against open reports/repairs, an allowlist, per-run limits and a stop switch in the proposed design.
5. Produce a concrete cadence proposal with bounded cost and an owner gate; confirm no live schedule was enabled without separate approval.

**Expected end state:** a useful small reconciliation report and a scheduling/repair feasibility decision; no automatic estate-wide changes

## Proposed budget, stop rules, and next gate

Propose 20 min grooming plus 105 min across three sessions; ten read-only sample records maximum and at most one separately authorized repair case. All numbers are proposals, not approved time or spending. Incremental paid
API/training cap is **$0** until separately approved. Record actual subscription
usage/time and any unavailable cost fields under the saga's shared evidence contract.

Stop on unexpected load, ambiguous identity, active conflicting repair, missing category verifier, or a need to touch protected files without permission. At a cap or blocker, save the partial artifact and safe state, then stop.
No automatic rerun, review loop, expanded case set, or model/access substitution.

**Gate:** owner decides whether any periodic pilot is worth grooming; PLAN-084 remains separately gated on hardware and budget readiness Record the owner's accept / refine / defer / stop decision with
evidence. This phase and every next phase remain paused without fresh authorization.
