# PLAN-088: Tiered support and persistent director feasibility

- **Status: Draft / UNGROOMED EPIC-LEVEL SPIKE / PAUSED.**
- **Saga:** [PLAN-078](078-repair-agent-saga.md). This phase is an epic, not an execution order.
- **Depends on:** PLAN-079 reliable media-item repair loop, PLAN-084 local basic capability, and PLAN-087 support conversation contract
- **Authorization:** documentation only. Grooming and an explicit owner decision
  are required before any story executes. No automatic transition to another phase.

## Questions and hypotheses

- Q-01: Which two tiers, if any, should be trialed first before the full three-tier design?
- Q-02: How can the same persistent HaynesNetwork director identity retain useful incident history without leaking users or growing context/cost without bounds?
- Q-03: What permissions, chat-join visibility, incident ownership and concurrency limits apply to each tier?
- Q-04: How should an incident become a verified improvement without recursive agent or review loops?
- Hypothesis: evidence-preserving escalation and a persistent supervisory identity can improve support without expecting Tom to be the real-time final tier.

## Scope and usable deliverable

Explore three tiers: (1) local Qwen/another qualified local model; (2) a paid,
current state-of-the-art supervisor, with Opus 5.5 as today's owner example rather
than a permanently fixed future version; (3) one **persistent HaynesNetwork director
dot**, the same logical identity across incidents. A two-tier initial experiment is
possible, but grooming must name which tiers and what remains absent. A paid model
is not guaranteed to solve a case.

The paid supervisor uses dev-env v2 with appropriate authorized tools and retained
case context, handles the issue and can join the user's chat. The director can join
the user/agents conversation in a supervisory role, validate the resolution, and
interview why the local model failed and what the paid model observed. Do not model
Tom as an always-available final support tier. Persistence means a stable identity
and bounded, versioned incident memory, not endless inference or unrestricted access.

Carry the report, questions already answered, evidence, actions, uncertain commands,
verification and current owner across escalation so the user need not repeat them.
Each incident has one mutation/closure owner; joining a chat does not create another.
Preserve per-user privacy and least privilege across tiers, histories and incidents.

Director improvement candidates include incident-derived benchmark/regression cases,
skills/playbooks/KB, and platform/model enhancements. After paid escalation, the
intended director should **promptly dispatch bounded improvement stories**, not
merely put them in a backlog, when there is **no active usage hold** and the work is
within approved scope, permissions, concurrency and budgets. A hold or missing
authorization instead produces an evidence-backed blocked receipt. Add the incident
regression and validate it plus relevant protected behaviors **before deployment**;
all validation/releases remain subject to authorized release controls. Nothing here authorizes continuous execution,
deployment, paid access, or reactivation of paused agents.

## Proposed one-agent, one-session stories

These are grooming candidates, not assigned work. Each produces its own evidence
and can be accepted independently once its declared inputs are ready.

| Story | Input and bounded work | Usable output / acceptance | Proposed session cap |
|---|---|---|---|
| 088-S1 | Accepted repair/chat contracts; map two/three-tier options and shared incident state | Groomable ownership/permission/chat-join contract and bounded identity/memory design | 30 min |
| 088-S2 | S1 contract; simulate one solved and one unsolved escalation across tiers | Transcript/history continuity, single-writer proof, director validation and local/paid debrief | 45 min |
| 088-S3 | S2 evidence; model prompt bounded improvement dispatch in a fixture | Linked regression/KB/skill or platform/model story, dispatch/blocked receipt and pre-deploy validation/release gates | 30 min |

**Dependency graph:** 079 reliable item repair + 084 local basic capability + 087 contract -> 088-S1 -> 088-S2 -> 088-S3; shared incident mutations remain serial. No parallel execution is authorized now. Any future
parallelism needs a groomed graph and disjoint mutable resources.

## Acceptance steps and exit criteria

1. Demonstrate the selected initial tier topology and label every AI participant/role. Record chat-join visibility, consent/permission questions, concurrent-incident limits and who may act/close.
2. Escalate a fixture without asking the user to repeat known facts. Confirm sanitized history, actions and pending/uncertain results arrive intact; no command is replayed to reconstruct context.
3. Show local -> paid -> director escalation with at most one visit per tier and one mutation owner. A second escalation or exhausted incident cap ends unresolved with a durable receipt, not a recursive new agent.
4. Have the same director identity review two isolated incident fixtures, validate outcomes and interview local failure/paid observations. Prove cross-user facts and private operations do not leak through persistent memory.
5. Include an unsolved paid-model case; the director must preserve uncertainty rather than promise success or require Tom to intervene live. Record appropriate/no-answer/escalation and verified-outcome metrics.
6. Convert one verified incident into a versioned regression/benchmark case and one bounded improvement story. In the fixture, show prompt dispatch when the approved scope/budget permits it and no usage hold exists, rather than backlog-only handling. Show a hold or missing authorization blocks dispatch; show regression failure blocks deployment. No real dispatch or release is authorized by this spike document.
7. Save actual time/usage and a pause receipt. No production chat join, new persistent access, paid invocation or deployment is part of a fixture-only acceptance.

**Expected end state:** a concrete, budgeted escalation/director feasibility contract and fixture evidence, or an identified blocker; no running director or new support fleet

## Proposed budget, stop rules, and next gate

Propose 20 min grooming plus 105 min across three sessions; two incident fixtures, one visit per tier and one improvement candidate. A future live incident needs its own approved total time/token/cash cap shared across all tiers; no per-agent budget reset. All numbers are proposals, not approved time or spending. Incremental paid
API/training cap is **$0** until separately approved. Record actual subscription
usage/time and any unavailable cost fields under the saga's shared evidence contract.

Stop on lost history, ambiguous ownership, cross-user leakage, unauthorized chat join/tool access, paid-spend cap exhaustion, unresolved verification or any usage hold. No recursive delegation, director self-spawning, open-ended interviews or improvement/review loops. At a cap or blocker, save the partial artifact and safe state, then stop.
No automatic rerun, review loop, expanded case set, or model/access substitution.

**Gate:** owner chooses topology and separately grooms any live support/director pilot; all improvement and release work stays paused until its own authorization. Record the owner's accept / refine / defer / stop decision with
evidence. This phase and every next phase remain paused without fresh authorization.
