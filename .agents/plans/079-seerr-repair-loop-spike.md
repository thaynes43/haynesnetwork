# PLAN-079: Seerr closed-loop repair feasibility

- **Status: Draft / UNGROOMED EPIC-LEVEL SPIKE / PAUSED.**
- **Saga:** [PLAN-078](078-repair-agent-saga.md). This phase is an epic, not an execution order.
- **Depends on:** fresh grooming; inspect pause issues #991/#992 without resuming their work
- **Authorization:** documentation only. Grooming and an explicit owner decision
  are required before any story executes. No automatic transition to another phase.

## Questions and hypotheses

- Q-01: Can the proven Sonnet 5.5 / dev-env-ops pattern complete one useful report using existing site MCP/API actions?
- Q-02: Which verified outcome can P7 safely own, and how are retry/restart duplicates prevented?
- Q-03: Which manual fallback is actually authorized, and which gaps require escalation instead?
- Hypothesis: a small closed loop can deliver a verified fix and accurate DIY guidance before any model comparison.

## Scope and usable deliverable

Investigate one Seerr report class, one runtime owner, and the smallest end-to-end
prototype. Use Sonnet 5.5 with the existing supported subscription pattern; verify
the actual identifier/settings during grooming, without changing current runtimes.
Start with historical/synthetic evidence and draft outputs. A usable live loop is
only claimed after an explicitly authorized scoped live case passes verification.
Do not build a generic autonomous repair platform first.

Flow: report -> supported site MCP/API action -> independent verification -> comment
with the actual site DIY steps -> closure. For a site limitation, only an authorized
manual fallback may fix it; then produce a rich GitHub limitation issue and a truthful
manual-fix comment before closure. Otherwise leave the report unresolved. Reuse the
P7 single-writer/deduplication path; do not add a second side-effect owner.

## Proposed one-agent, one-session stories

These are grooming candidates, not assigned work. Each produces its own evidence
and can be accepted independently once its declared inputs are ready.

| Story | Input and bounded work | Usable output / acceptance | Proposed session cap |
|---|---|---|---|
| 079-S1 | Existing site/P7 docs and one selected report; map the allowed operations and side-effect owner | One case contract, permission boundary and duplicate/restart test plan; unknowns named | 30 min |
| 079-S2 | Accepted S1 contract; build or exercise one bounded fixture prototype after authorization | Reproducible report-to-verified-outcome receipt with draft response; no unsupported DIY claims | 45 min |
| 079-S3 | S2 evidence and separate live-side-effect permission if needed; exercise the selected loop and failure paths | Verified outcome, comment-before-close order, dedupe evidence, safe unresolved/manual-fallback behavior | 45 min |

**Dependency graph:** 079-S1 -> 079-S2 -> 079-S3; one external writer, serial No parallel execution is authorized now. Any future
parallelism needs a groomed graph and disjoint mutable resources.

## Acceptance steps and exit criteria

1. Freeze one success case and one site-gap/uncertain case, with independent expected outcomes and explicit write permissions.
2. Demonstrate the supported site action and appropriate content/playback/language/history checks. An API/import success alone must not pass.
3. Replay a duplicate report and an interrupted response; show at most one intended comment/resolution and no uncertain command replay.
4. Show actual DIY instructions for site success. For the manual path, show the authorized manual receipt, actionable GitHub issue, and truthful linked response; if manual action is unauthorized, show escalation without closure.
5. Confirm comment receipt precedes closure and unresolved linked work prevents closure. Capture actual time/usage and an operator pause/resume receipt.
6. Owner accepts a usable bounded loop, or explicitly records that only a draft prototype/negative feasibility result was delivered. Prototype-only evidence cannot pass the live-loop gate for model benchmarking.

**Expected end state:** one useful, evidenced Seerr loop or a clearly bounded feasibility blocker, with safe failure and pause behavior; no general production rollout

## Proposed budget, stop rules, and next gate

Propose 20 min grooming plus 120 min across the three sessions; at most two selected cases and one scoped live pilot, if separately authorized. All numbers are proposals, not approved time or spending. Incremental paid
API/training cap is **$0** until separately approved. Record actual subscription
usage/time and any unavailable cost fields under the saga's shared evidence contract.

Stop on ambiguous media identity, missing verifier, conflicting P7 ownership, unsafe marks/files, unapproved manual action, or unsupported runtime access. Preserve v1 and require a separate v2 readiness decision. At a cap or blocker, save the partial artifact and safe state, then stop.
No automatic rerun, review loop, expanded case set, or model/access substitution.

**Gate:** accept the usable loop before considering PLAN-080 or PLAN-081; groom their stories separately Record the owner's accept / refine / defer / stop decision with
evidence. This phase and every next phase remain paused without fresh authorization.
