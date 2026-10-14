# PLAN-085: Optional training and synthetic-case feasibility

- **Status: Draft / UNGROOMED EPIC-LEVEL SPIKE / PAUSED.**
- **Saga:** [PLAN-078](078-repair-agent-saga.md). This phase is an epic, not an execution order.
- **Depends on:** PLAN-081 frozen evaluation protocol and PLAN-082 verified cases; PLAN-084 if using local GPUs
- **Authorization:** documentation only. Grooming and an explicit owner decision
  are required before any story executes. No automatic transition to another phase.

## Questions and hypotheses

- Q-01: Is there a repeatable gap that prompts, skills and retrieval cannot address?
- Q-02: Is the verified dataset sufficient and suitable for fine-tuning without leakage?
- Q-03: Can synthetic/contrived cases improve coverage without manufacturing apparent real-world quality?
- Hypothesis: adaptation may help a narrow failure class, but should be rejected if simpler methods perform as well.

## Scope and usable deliverable

Investigate optional fine-tuning and synthetic/contrived cases within this saga.
Deliver a versioned dataset manifest and a small comparative feasibility result only
if grooming authorizes an experiment. Preserve a held-out real-case evaluation set
that is never used for training, prompt tuning or synthetic generation. Synthetic
examples must be visibly labeled and separately reported; they do not establish
real-world success. Training is not a prerequisite to the earlier usable loops.

## Proposed one-agent, one-session stories

These are grooming candidates, not assigned work. Each produces its own evidence
and can be accepted independently once its declared inputs are ready.

| Story | Input and bounded work | Usable output / acceptance | Proposed session cap |
|---|---|---|---|
| 085-S1 | Verified KB and baseline failures; assess data suitability and splits | Versioned manifest, provenance/license/redaction checks and leakage audit | 30 min |
| 085-S2 | Approved S1 split; compare simplest intervention before optional training | Small prompt/retrieval vs adaptation proposal or explicitly approved bounded experiment | 45 min |
| 085-S3 | Frozen intervention and untouched real holdout | Real-case outcome report, synthetic-only results separated, reproducibility and rollback record | 30 min |

**Dependency graph:** 085-S1 -> 085-S2 -> 085-S3; holdout adjudication must remain independent of tuning No parallel execution is authorized now. Any future
parallelism needs a groomed graph and disjoint mutable resources.

## Acceptance steps and exit criteria

1. Hash/version datasets, splits, labeling rules, prompts/skills, model weights/revision, training/evaluation settings and tool versions.
2. Demonstrate no real holdout example, derivative or answer leaked into training, retrieval tuning or generated examples.
3. Compare the unchanged baseline and simpler prompt/KB alternative before claiming a training benefit.
4. Evaluate only on the frozen held-out real cases for real-world claims; report synthetic/contrived stress tests separately with verified labels.
5. Record resource use, failures and uncertainty. Provide a replay/rebenchmark recipe for new model releases, with explicit approval before each rerun.
6. If no sufficient data, approved compute or measured benefit exists, publish a no-training recommendation and stop.

**Expected end state:** a reproducible adaptation go/no-go result or dataset feasibility artifact, never an implied training/deployment commitment

## Proposed budget, stop rules, and next gate

Propose 20 min grooming plus 105 min across three sessions; one narrow intervention maximum. No training job launches without a separately approved compute/time cap. All numbers are proposals, not approved time or spending. Incremental paid
API/training cap is **$0** until separately approved. Record actual subscription
usage/time and any unavailable cost fields under the saga's shared evidence contract.

Stop on leakage, uncertain labels, licensing/privacy gaps, inadequate held-out data, resource contention or an experiment that cannot finish within one story session. At a cap or blocker, save the partial artifact and safe state, then stop.
No automatic rerun, review loop, expanded case set, or model/access substitution.

**Gate:** owner accepts evidence before any training extension, adoption or new-release rebenchmark; PLAN-086 remains separately groomed Record the owner's accept / refine / defer / stop decision with
evidence. This phase and every next phase remain paused without fresh authorization.
