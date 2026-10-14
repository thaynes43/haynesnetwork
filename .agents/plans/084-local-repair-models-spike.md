# PLAN-084: Gradual local-model and fallback feasibility

- **Status: Draft / UNGROOMED EPIC-LEVEL SPIKE / PAUSED.**
- **Saga:** [PLAN-078](078-repair-agent-saga.md). This phase is an epic, not an execution order.
- **Depends on:** PLAN-081 common baseline and PLAN-082 verified knowledge; new GPUs confirmed ready
- **Authorization:** documentation only. Grooming and an explicit owner decision
  are required before any story executes. No automatic transition to another phase.

## Questions and hypotheses

- Q-01: Which Qwen or other local models fit the actual new GPU resources and tool contract?
- Q-02: Which case classes can move locally without losing verified outcomes or safe escalation?
- Q-03: When is fallback useful, and what explicit paid budget and data policy would it require?
- Hypothesis: narrow local routing can reduce hosted usage while retaining a proven fallback.

## Scope and usable deliverable

Deliver an evidence-based local candidate comparison and a reversible routing
prototype. Hardware readiness is a gate, not an assumed purchase or deployment.
Compare Qwen and other eligible local candidates using the frozen cases/tools/budgets;
record model revision, quantization, serving settings and resource envelope. Adopt
gradually by evidenced case class. Paid fallback is a future option requiring an
explicit cap; do not equate existing subscription access with paid API authority.

## Proposed one-agent, one-session stories

These are grooming candidates, not assigned work. Each produces its own evidence
and can be accepted independently once its declared inputs are ready.

| Story | Input and bounded work | Usable output / acceptance | Proposed session cap |
|---|---|---|---|
| 084-S1 | Actual GPU inventory and baseline contract; assess candidates | Bounded fit/capacity report and selected candidates, or a hardware-blocked exit | 30 min |
| 084-S2 | S1 ready hardware and approval; compare at most two local candidates | Comparable verified case receipts with memory/latency/usage evidence | 45 min |
| 084-S3 | S2 evidence; exercise routing/fallback in a fixture | Reversible local/hosted routing decision, stop switch and no-double-repair proof | 30 min |

**Dependency graph:** 084-S1 -> 084-S2 -> 084-S3; no provisioning/training implied by hardware readiness No parallel execution is authorized now. Any future
parallelism needs a groomed graph and disjoint mutable resources.

## Acceptance steps and exit criteria

1. Verify actual hardware capacity and access before any inference; stop if unavailable rather than borrowing production resources or buying access.
2. Run at most two local models on the same four baseline cases; report the same verified metrics and failed/tool-incompatible cases.
3. Trigger uncertainty/tool failure in a fixture; demonstrate one bounded fallback or explicit escalation, no repeated mutation and no ping-pong routing.
4. Demonstrate a hard paid-spend denial at the default zero cap. Any real paid fallback test requires separately approved amount, provider, data scope and case.
5. Version settings and show rollback to the prior routing choice; produce a narrow adoption recommendation, not an automatic runtime change.

**Expected end state:** a local feasibility/routing artifact with verified tradeoffs, or a clear hardware/capability blocker; no production model switch

## Proposed budget, stop rules, and next gate

Propose 20 min grooming plus 105 min across three sessions; eight local evaluation runs maximum. Paid fallback stays simulated at the proposed $0 cap. All numbers are proposals, not approved time or spending. Incremental paid
API/training cap is **$0** until separately approved. Record actual subscription
usage/time and any unavailable cost fields under the saga's shared evidence contract.

Stop on GPU contention, thermal/memory pressure, incompatible tools, unverified repair regression, unapproved model download/license or unexpected external billing. At a cap or blocker, save the partial artifact and safe state, then stop.
No automatic rerun, review loop, expanded case set, or model/access substitution.

**Gate:** owner decides whether to groom a limited adoption pilot; optional PLAN-085 training still needs a separate feasibility and spend decision Record the owner's accept / refine / defer / stop decision with
evidence. This phase and every next phase remain paused without fresh authorization.
