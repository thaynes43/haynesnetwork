# PLAN-081: Comparable model-family baseline feasibility

- **Status: Draft / UNGROOMED EPIC-LEVEL SPIKE / PAUSED.**
- **Saga:** [PLAN-078](078-repair-agent-saga.md). This phase is an epic, not an execution order.
- **Depends on:** PLAN-079 first usable loop accepted; include PLAN-080 cases only when available
- **Authorization:** documentation only. Grooming and an explicit owner decision
  are required before any story executes. No automatic transition to another phase.

## Questions and hypotheses

- Q-01: Which accessible family of models/variants can perform the same bounded repair task?
- Q-02: Can we compare verified outcomes fairly under identical case, tool and budget constraints?
- Hypothesis: a small reproducible baseline exposes capability/cost tradeoffs without a large benchmark campaign.

## Scope and usable deliverable

Deliver a versioned case manifest, runner contract and small comparison report for
multiple named models/variants, with the working Sonnet 5.5 loop as the reference.
Select the family during grooming; do not silently replace it with one favorite model.
Use the same initial case state, visible evidence, tool versions/permissions, per-case
time/action/token policy, retry limits and verification rules. Record incompatibilities
rather than quietly giving a model extra tools or easier cases. No real-world repair
side effects merely to benchmark. New releases become candidates for an explicitly
groomed rerun, never an automatically scheduled model promotion.

## Proposed one-agent, one-session stories

These are grooming candidates, not assigned work. Each produces its own evidence
and can be accepted independently once its declared inputs are ready.

| Story | Input and bounded work | Usable output / acceptance | Proposed session cap |
|---|---|---|---|
| 081-S1 | Verified loop receipts; select and freeze representative cases and model roster | Case manifest, expected outcomes and identical tool/budget contract | 30 min |
| 081-S2 | Frozen S1 inputs; run only the approved small matrix in isolated fixtures | Complete raw receipts, including failures/timeouts, and independently adjudicated outcomes | 45 min |
| 081-S3 | S2 receipts; compare without retuning on evaluation cases | Reproducible report and keep/change/defer recommendation; no runtime switch | 30 min |

**Dependency graph:** 081-S1 -> 081-S2 -> 081-S3; isolated runs could be parallel only after explicit resource/budget grooming No parallel execution is authorized now. Any future
parallelism needs a groomed graph and disjoint mutable resources.

## Acceptance steps and exit criteria

1. Version case split, source evidence, model identifiers/settings, prompts/skills, tool schemas, harness and budget policy before running.
2. Proposed first matrix: three models/variants on the same four frozen cases (12 runs maximum), including success, ambiguity, unsupported action and safe escalation. Groom a smaller matrix if it cannot fit the cap.
3. Report diagnosis correctness against verified root cause; verified repair rate over all attempted cases; unnecessary/unauthorized changes; appropriate escalation and missed escalation; end-to-end latency; observed cost/usage. Keep timeouts and failures in the denominator.
4. Audit before/after state and action traces independently of model self-report. Preserve raw case-level results; small samples get ranges/limitations, not unsupported reliability claims.
5. Separate subscription consumption, measured cash cost, and explicitly sourced estimates. Unknown costs stay unknown. Reproduce one selected result without changing case or settings.
6. Publish a bounded decision and a versioned rerun recipe for future releases. No model is promoted automatically from a score.

**Expected end state:** a credible small family baseline with evidence, limitations and a repeatable comparison protocol, not a production model decision

## Proposed budget, stop rules, and next gate

Propose 20 min grooming plus 105 min across three sessions; 12 runs maximum, one attempt per case/model unless an explicit harness fault invalidates it. All numbers are proposals, not approved time or spending. Incremental paid
API/training cap is **$0** until separately approved. Record actual subscription
usage/time and any unavailable cost fields under the saga's shared evidence contract.

Stop if verified truth is missing, evaluation leaks into tuning, budgets differ, a provider needs unapproved spend/access, or a model cannot use the common tool contract. Record failure instead of expanding the experiment. At a cap or blocker, save the partial artifact and safe state, then stop.
No automatic rerun, review loop, expanded case set, or model/access substitution.

**Gate:** owner reviews the evidence before PLAN-082 or any later adoption; every new model-release rebenchmark requires a scoped decision Record the owner's accept / refine / defer / stop decision with
evidence. This phase and every next phase remain paused without fresh authorization.
