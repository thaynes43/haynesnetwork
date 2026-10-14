# Shared agentic platform vision: tentative “Haynes OS”

- **Status: Draft / UNGROOMED / PAUSED.** Owner brainstorming, 2026-10-14.
- **Name:** “Haynes OS” is tentative, not a final product or architecture decision.
- **Authority:** documentation only. No implementation, runtime/model change,
  deployment, paid invocation, agent kickoff, device action or monitoring is authorized.

## Shared platform and proving ground

The proposed shared agentic OS/suite builds on **dev-env v2 as the execution and
coordination foundation across providers**. This is a direction to investigate,
not a claim that v2 is accepted or complete. Do not change dev-env from this note.

HaynesNetwork is the owner's high-activity, noncritical experimentation platform
for the framework. Its [media/support saga](../plans/078-repair-agent-saga.md) aims
at full **local-first user support across the Plex, books and audiobooks suite**.
First prove a reliable media-item repair loop; then broaden support and adopt local
models from verified evidence. Local-first is a goal, not a guarantee that every
case can be solved locally or that a paid model always succeeds. “Noncritical” does
not waive protection of users, files, watch history, privacy or permissions.

The framework should be domain-extensible through connectors, case contracts,
evidence/verifiers, skills/playbooks, knowledge bases, benchmarks, routing,
escalation, feedback, permissions and budgets. Reuse these contracts rather than
hard-coding media assumptions into the shared execution layer. Grooming must decide
which responsibilities belong in dev-env, the framework, and each domain application;
no new repository/service layout is committed here.

## Local-first support and improvement loop

The [tiered-support spike](../plans/088-support-escalation-director-spike.md) retains
local model -> paid current supervisor -> **one persistent HaynesNetwork director
dot**, with the same director identity across incidents. Two initial tiers remain
an option to groom. Preserve evidence and conversation history so users need not
repeat themselves, and keep one mutation/closure owner per incident. The director
can supervise the conversation, validate resolution, and interview the local failure
and paid model's observations. Tom is not the expected real-time final support tier.

Following paid escalation, the intended director should **promptly dispatch bounded
improvement stories**, not merely accumulate a backlog, when there is no usage hold
and the work is within approved scope, permissions, concurrency and budgets. Candidate
improvements span incident benchmarks/regressions, skills, playbooks, KB, platform and
models. Regression-validate the incident and relevant protected behaviors before any
deployment, using authorized release controls. If a hold or missing authorization
blocks dispatch, save the evidence and exact blocker instead. There is no recursive
agent/review loop, unlimited standing spend, or automatic activation from this note.

## Separate future smart-home saga

[PLAN-089](../plans/089-smart-home-saga.md) is a **separate lightweight future saga**,
not another media epic. It explores the same framework for local voice/chat (Muse
is an example to evaluate), domain-specific benchmarks, and cases such as Zigbee
failure diagnosis or a dongle reset. These examples are hypotheses, not instructions
to reset hardware. No deep design, connector installation, device access expansion,
automation or implementation is authorized.

## Grooming questions and durable checkpoint

- Q-01: Which contracts are truly shared, and which verifiers/permissions remain domain-specific?
- Q-02: What evidence justifies local routing, escalation or a promptly dispatched improvement?
- Q-03: What bounded dispatch policy respects usage holds, concurrency, user privacy and release controls?
- Q-04: Which smart-home fixture can safely evaluate usefulness without touching live devices?

All project work remains ungroomed/paused. Use the saga -> epic -> one-agent,
one-session story hierarchy and explicit dependency/grooming gates. The existing
pause records [#991](https://github.com/thaynes43/haynesnetwork/issues/991) and
[#992](https://github.com/thaynes43/haynesnetwork/issues/992) remain in force.
