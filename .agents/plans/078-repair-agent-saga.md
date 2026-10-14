# PLAN-078: Repair Agent Saga

- **Status: Draft / UNGROOMED SPIKES / PAUSED. Documentation only.**
- **Owner direction:** 2026-10-14 voice brainstorming and subsequent corrections.
- **Hierarchy:** SAGA = this full project. Each phase below is an EPIC-level spike
  aimed at a usable, value-delivering result. Its proposed STORIES are independent,
  bounded work for one agent in one session, with explicit input/output dependencies.
- **Authorization:** capture and merge these documents only. No story, prototype,
  benchmark, repair, model change, scheduled run, or implementation is authorized.
- **Pause records:** [bot scope #991](https://github.com/thaynes43/haynesnetwork/issues/991)
  and [repair checkpoint #992](https://github.com/thaynes43/haynesnetwork/issues/992).
  The latter supersedes earlier live-worker observations in HANDOFF. Do not resume
  PLAN-077 or the existing Seerr Repair Bot session from this saga.

## Full support goal and shared platform

The goal is full **local-first user support across the HaynesNetwork Plex, books
and audiobooks suite**, with reliable media-item repair proven before general
support. It is not a promise that every case can be solved locally.

The tentative [Haynes OS vision](../context/2026-10-14-haynes-os-vision.md) describes
dev-env v2 as the shared multiprovider execution/coordination foundation and
HaynesNetwork as the high-activity, noncritical proving ground. The name is not final;
framework contracts remain exploratory and domain-extensible. The separate future
[smart-home saga](089-smart-home-saga.md) is not a phase of this media/support saga.
All ten media phases below remain ungroomed and paused.

## Purpose and sequence

First investigate a usable closed loop for reported media problems using the
Sonnet 5.5 / dev-env-ops pattern identified by the owner: Seerr first, then reports
on haynesnetwork.com. Try supported site MCP/API actions, verify the actual result,
explain the real DIY steps, and only then resolve the report. If a supported action
is insufficient, distinguish an authorized manual repair from DIY and preserve the
gap in a rich GitHub issue. An unverified result stays unresolved.

Only after the first usable loop should we compare a family of models on the same
cases, tools, and budgets. Verified outcomes are the truth; a plausible explanation
or model self-score is not. Future ideas remain phases of this same saga, not a
separate backlog: reusable knowledge, proactive reconciliation, local models,
optional training, and other repeatable support escalations.

| Phase / epic-level spike | Usable result being investigated | Depends on |
|---|---|---|
| [1 / PLAN-079: Seerr loop](079-seerr-repair-loop-spike.md) | One bounded report-to-verified-outcome loop, including truthful response and safe failure | Fresh grooming and execution decision |
| [2 / PLAN-080: Website reports](080-website-repair-intake-spike.md) | Website intake using the same repair/outcome contract | 079 usable loop accepted |
| [3 / PLAN-081: Model family baseline](081-repair-model-family-spike.md) | Reproducible comparison on verified real cases | 079 usable loop accepted; 080 supplies website cases if accepted |
| [4 / PLAN-082: Verified knowledge](082-verified-repair-knowledge-spike.md) | Small searchable case KB and tested skills/playbooks | 079 and 081 evidence |
| [5 / PLAN-083: Proactive reconciliation](083-proactive-media-reconciliation-spike.md) | Reviewable movie/TV/book/audiobook/metadata findings and bounded repair feasibility | 082; same outcome contract as 079/080 |
| [6 / PLAN-084: Local model adoption](084-local-repair-models-spike.md) | Evidence for gradual Qwen/other local use, with controlled fallback | 081/082; suitable new GPUs verified ready |
| [7 / PLAN-085: Optional adaptation](085-repair-model-adaptation-spike.md) | Evidence whether training beats prompts/retrieval on held-out real cases | 081/082; 084 if targeting local hardware |
| [8 / PLAN-086: Other support escalations](086-repeatable-support-spike.md) | One bounded non-media support prototype with a verified outcome | Accepted repair loop and relevant earlier evidence |
| [9 / PLAN-087: AI support chat](087-ai-support-chat-spike.md) | Clearly identified AI chat for broader support, search and guided troubleshooting | 084 local capability and 086 basic escalations demonstrated |
| [10 / PLAN-088: Escalation and director](088-support-escalation-director-spike.md) | Evidence-preserving local/paid/persistent-director support and bounded improvement | Reliable 079 item repair, 084 local capability, 087 conversation contract |

All ten phases are **ungroomed exploratory spikes**, not implementation promises.
Default conceptual order is 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10. The dependency
column is authoritative when grooming changes scheduling: 081 may follow 079
without waiting for website expansion, but never precedes the first usable loop.
Skipping or deferring a phase is an explicit owner decision, not permission to start
the next one. No number in this directory makes a spike dispatchable.

## Grooming and execution gates

Before executing **each epic**, record a decision here and in its phase file:

1. The hypothesis, smallest useful output, selected cases, evidence needed, and
   explicit exclusions. Resolve or retain each Q-NN as an identified blocker.
2. Proposed stories with stable IDs, one owner/session each, exact input/output
   contracts, acceptance checks, dependency graph, and conflict domains.
3. Allowed tools, environments, mutations, data access, model/settings, and budget.
   Existing subscription access does not imply paid API or production permission.
4. The owner's choice: groom further / approve the named story only / defer / stop.
   Record who decided, when, and the exact scope. A merged document is not approval.

Before starting a **story**, verify its inputs and explicit execution authorization.
Stories may run in parallel only if the groomed dependency graph says their inputs
are ready and their mutable resources do not overlap. Default is one active story;
never infer an agent fleet from the diagram. A shared external writer remains serial.
If a story cannot fit one session, split or reduce it during grooming, not mid-run.

Every story ends with a durable artifact, evidence, actual time/usage, remaining
unknowns, safe resource state, and a stop. A partial result or negative feasibility
finding is useful when labeled honestly; it is not a successful repair or accepted
epic. Epic acceptance requires the stated usable result and an owner decision.
**The next epic stays paused until separately groomed and authorized.**

## Proposed budgets and burn controls (none approved)

All caps below are proposals for grooming, not commitments or spending authority.
Each epic proposes at most 20 minutes of grooming plus its story caps. First evidence
checkpoint is halfway through each story; stop at its cap, including reasoning,
tool waits, retries, and review time. Do not extend an agent deadline silently.

- One session per story; no overnight continuation or automatic retry/review loop.
- Every phase currently proposes **$0 incremental paid API/training spend**. Existing
  subscription usage is finite: record tokens/requests and time where available.
  Do not report missing cost data as zero. Cash charges, estimated allocation, and
  subscription usage must be separate. Any nonzero spend needs a fresh approved cap.
- A blocked case gets one bounded diagnostic attempt, then an evidence-backed
  escalation; no repeated repair/download while the result is uncertain.
- Budget expiry, unavailable tools/model, unexpected paid routing, unsafe outcome,
  unclear ownership, or a required access expansion means stop and checkpoint.
- Any authorized mutation needs a safe boundary and an explicit rollback or
  observe-only recovery path. Never abandon a partial operation without recording it.
- No new credentials, grants, production activation, live comments/closures, broad
  remediation, or schedules without exact additional authorization. Preserve v1;
  evaluate v2 readiness separately. This saga does not accept the v2 MVP.

## Shared evidence and safety contract

Use repository domain single-writers and audits. Preserve watch history and protected
files. The existing P7 bridge owns comment/resolution writes through its confined
writer; grooming must select one owner and deduplication path for any new workflow.
No competing bot/bridge closure, uncertain-command replay, or copied user credentials.

A case receipt links input, diagnosis, permitted actions, actual before/after state,
independent verification, user-visible response, and outcome. Content evidence must
be appropriate to the failure: filename, metadata, import status, and HTTP success
alone do not establish a correct episode, language, book, or playable file.

The manual-fallback limitation issue must include sanitized report/media identifiers,
expected/actual behavior, exact site action and errors, reproducible steps, audit IDs,
authorized manual steps, verification, relevant code/docs, proposed bounded remedy,
acceptance cases, and unresolved risks. Link it from the truthful user response;
avoid duplicates and secrets. Failure to verify means no closure.

## Low-usage grooming preference

The owner reports roughly $200 each for Claude and OpenAI subscriptions and wants
low-usage periods to be useful for bounded grooming. These are owner-reported context,
not a pricing claim or a new spend allowance. Low usage does not authorize a watcher,
schedule, background fleet, quota-burning task, or execution of a spike. An explicitly
requested grooming session should end with a small saved decision/artifact and stop;
never spend unused capacity merely because it is available.

## Questions and current end state

- Q-01: Which smallest Seerr case and environment are suitable for the first groomed story?
- Q-02: Which supported site actions and P7 boundaries already meet that case?
- Q-03: What actual v2 runtime, model availability, and subscription limits apply?
- Q-04: What explicit acceptance decision would justify one next story or phase?

Expected state after this documentation change: one linked saga and ten separate
epic-level spike files on main, all ungroomed and paused; zero runtime or model
changes. No prototype, benchmark, training, or operational success is claimed.

References: [PLAN-077](077-self-service-media-repair.md),
[DESIGN-055](../../docs/designs/055-self-service-media-repair.md),
[process](../../docs/PROCESS.md), and the owner pause issues above. The repo's existing
[PLAN-043](043-integration-tab-saga.md) supplies the master-plus-numbered-phase convention.
