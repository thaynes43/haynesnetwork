# PLAN-082: Verified case knowledge, skills and playbooks

- **Status: Draft / UNGROOMED EPIC-LEVEL SPIKE / PAUSED.**
- **Saga:** [PLAN-078](078-repair-agent-saga.md). This phase is an epic, not an execution order.
- **Depends on:** PLAN-079 case receipts and PLAN-081 evidence
- **Authorization:** documentation only. Grooming and an explicit owner decision
  are required before any story executes. No automatic transition to another phase.

## Questions and hypotheses

- Q-01: Which verified case fields make a repair reusable without copying stale state or secrets?
- Q-02: Do a small KB and explicit playbooks improve outcomes over the unchanged baseline?
- Hypothesis: reusable verified cases and bounded skills reduce repeated discovery before training is considered.

## Scope and usable deliverable

Deliver a small searchable case KB and one or two actionable skills/playbooks.
Capture evidence from phase 1 onward; this phase tests the reusable structure, not a
large data platform. Separate observed facts, inferred diagnosis and proposed actions.
Record provenance, permissions, failure conditions, verification, tool versions and
expiry/revalidation needs. Exclude secrets and raw private media/user data.

## Proposed one-agent, one-session stories

These are grooming candidates, not assigned work. Each produces its own evidence
and can be accepted independently once its declared inputs are ready.

| Story | Input and bounded work | Usable output / acceptance | Proposed session cap |
|---|---|---|---|
| 082-S1 | Existing verified receipts; curate a small case schema and index | Five or fewer evidence-linked cases with redaction, provenance and outcome fields | 30 min |
| 082-S2 | S1 cases and frozen evaluation split; draft/test one or two playbooks | Retrieval/skill prototype plus before/after results on cases not copied into the playbook | 45 min |

**Dependency graph:** 082-S1 -> 082-S2; independent redaction review may be parallel only if groomed No parallel execution is authorized now. Any future
parallelism needs a groomed graph and disjoint mutable resources.

## Acceptance steps and exit criteria

1. Trace each factual claim in the selected cases to a verifier or mark it uncertain; rejected or ambiguous repairs cannot become success examples.
2. Retrieve an appropriate case for a new fixture and show why it applies, including when it must not be reused.
3. Exercise a playbook's success and stop/escalation conditions with no secret exposure or widened permission.
4. Compare against the frozen baseline on held-out examples and record changed actions, outcomes, time and usage.
5. Version the KB/skill set and show how a stale tool or model version invalidates/revalidates an entry.

**Expected end state:** a small useful KB and tested playbook, or evidence that the proposed structure does not help; no mass ingestion

## Proposed budget, stop rules, and next gate

Propose 20 min grooming plus 75 min across two sessions; at most five cases and two playbooks. All numbers are proposals, not approved time or spending. Incremental paid
API/training cap is **$0** until separately approved. Record actual subscription
usage/time and any unavailable cost fields under the saga's shared evidence contract.

Stop on unverifiable examples, privacy uncertainty, stale operational instructions or evaluation contamination; do not invent training labels. At a cap or blocker, save the partial artifact and safe state, then stop.
No automatic rerun, review loop, expanded case set, or model/access substitution.

**Gate:** accept or revise the reusable evidence contract before grooming PLAN-083/084/085 Record the owner's accept / refine / defer / stop decision with
evidence. This phase and every next phase remain paused without fresh authorization.
