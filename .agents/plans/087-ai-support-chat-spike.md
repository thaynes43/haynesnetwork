# PLAN-087: Local AI customer-support chat feasibility

- **Status: Draft / UNGROOMED EPIC-LEVEL SPIKE / PAUSED.**
- **Saga:** [PLAN-078](078-repair-agent-saga.md). This phase is an epic, not an execution order.
- **Depends on:** PLAN-079 reliable media-item repair loop, PLAN-084 local candidate and PLAN-086 basic support escalations independently demonstrated and accepted
- **Authorization:** documentation only. Grooming and an explicit owner decision
  are required before any story executes. No automatic transition to another phase.

The tiered escalation and persistent director questions are captured in the next
phase, [PLAN-088](088-support-escalation-director-spike.md); chat work must not invent
a competing escalation owner or assume Tom is the real-time final tier.

## Questions and hypotheses

- Q-01: Can a local model handle basic support safely enough to justify a clearly identified AI chat entry point?
- Q-02: Which general/media queries and operational details are permitted for this signed-in user?
- Q-03: Can guided troubleshooting ask for missing evidence instead of inventing the client, subtitle type or cause?
- Hypothesis: an AI support bubble can help with broader support after local basic escalations are proven.

## Scope and usable deliverable

Investigate a haynesnetwork.com customer-support chat bubble that is explicitly
identified as AI. Scope includes general questions, media search, permitted
operational visibility, Plex setup/configuration tips, and guided playback/subtitle
troubleshooting, beyond individual report or metadata repair. Reuse accepted site
API/tool contracts and verified playbooks. This document authorizes no UI build or
runtime change; any future prototype requires grooming and explicit execution scope.

Respect per-user data and access throughout retrieval, tool calls and responses.
Never disclose another user's data, private operational details, credentials or
secrets. When subtitle behavior matters, ask for the actual subtitle type/format,
embedded/external source and relevant client/playback evidence rather than assuming
text, image-based, forced, or burned-in subtitles.

## Proposed one-agent, one-session stories

These are grooming candidates, not assigned work. Each produces its own evidence
and can be accepted independently once its declared inputs are ready.

| Story | Input and bounded work | Usable output / acceptance | Proposed session cap |
|---|---|---|---|
| 087-S1 | Accepted local basic-support evidence and site permissions; define one chat journey | AI disclosure, privacy/tool contract and bounded interaction sketch | 30 min |
| 087-S2 | S1 contract; exercise permitted search and guided playback/subtitle fixture cases | Useful conversation prototype with actual clarifying questions, evidence and safe escalation | 45 min |
| 087-S3 | Frozen actual-support evaluation cases; assess the prototype | Verified outcomes, privacy/uncertainty findings and reusable playbook/benchmark updates | 30 min |

**Dependency graph:** 084 accepted local capability + 086 accepted basic escalations -> 087-S1 -> 087-S2 -> 087-S3 No parallel execution is authorized now. Any future
parallelism needs a groomed graph and disjoint mutable resources.

## Acceptance steps and exit criteria

1. Show the AI identity before interaction and explain the supported scope; do not impersonate a person or imply access the tool contract lacks.
2. Exercise permitted general/media search and operational questions with two distinct user fixtures. Prove cross-user data, private operations and secrets remain inaccessible, including through follow-up prompts.
3. Walk a Plex setup case and a playback/subtitle case. Ask for the actual subtitle type and relevant playback/client evidence; verify advice against the case rather than assuming a cause.
4. Exercise uncertain, unknown-answer and unsupported-action cases. Measure calibrated uncertainty, correct no-answer behavior, appropriate/missed escalation, verified resolution, unnecessary changes, latency and cost/usage.
5. Add sanitized actual support cases to the versioned KB/playbooks and held-out benchmark split without leakage. Training remains optional and separately gated under PLAN-085.
6. Confirm no repair side effects, production chat rollout, new data access or model routing change occurred without separate authorization.

**Expected end state:** a bounded AI support conversation feasibility result and permission-tested prototype specification, or a no-go decision; no production UI rollout

## Proposed budget, stop rules, and next gate

Propose 20 min grooming plus 105 min across three sessions; at most four conversation scenarios and two user fixtures. All numbers are proposals, not approved time or spending. Incremental paid
API/training cap is **$0** until separately approved. Record actual subscription
usage/time and any unavailable cost fields under the saga's shared evidence contract.

Stop on privacy leakage, invented diagnostic facts, inability to identify AI clearly, insufficient local basic-support evidence, unsafe repair advice or unapproved operational access. At a cap or blocker, save the partial artifact and safe state, then stop.
No automatic rerun, review loop, expanded case set, or model/access substitution.

**Gate:** owner separately decides whether to groom a chat implementation/pilot; no UI or runtime activation follows automatically Record the owner's accept / refine / defer / stop decision with
evidence. This phase and every next phase remain paused without fresh authorization.
