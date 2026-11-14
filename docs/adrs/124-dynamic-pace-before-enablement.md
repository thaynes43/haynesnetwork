# ADR-124: Bound and record Dynamic Pace before enablement

- **Status:** Proposed
- **Date:** 2026-11-14
- **Deciders:** the coordinator for the implementation directions in story 820 comment 8175 and
  story 852; the owner has yet to confirm DESIGN-014 Q-12, Q-13 and Q-15.
- **Amends:** [ADR-120](120-dynamic-trash-pace.md), only its sizing, bounds and read contract.
  The Accepted record is unchanged. ADR-031's propose-only rule and every deletion guard stand.
- **Design:** [DESIGN-014 D-17 and D-18](../designs/014-rules-tuning-space-policy.md#d-17--amendment-2026-11-14-adr-124--bounded-dynamic-pace).

## Context and problem statement

The adversarial review of PR 1071 (story 820 comment 8168, measured 2026-11-13) found that an
array far under target still received a batch, title counts lost their caps, one crossing title
could exceed the byte ceiling, and the job did not store its reasoning. Status recomputed a
possibly different decision. This amendment builds story 852; it grants no enablement authority.

## Decision drivers

- Preserve today's behavior and ledger payloads when both pace modes are off.
- Preserve the save window, eligibility, one-open-batch rule, self-heal and minimum pool size.
- Keep the measured byte ceiling and current title caps until story 823 settles Q-14.
- Make observation possible before any batch uses the computed ask.
- Distinguish a measured rate, a projection, a job decision and production acceptance.

## Considered options

1. Keep ADR-120's switched-off implementation without an observation step.
2. Add bounded sizing, observation and durable reasoning behind modes that ship off.
3. Enable the new sizing as part of deployment.

## Decision outcome

Chosen option: **2**. D-17 defines the formula, the bounds and their provenance. D-18 defines
observation, stored reasoning, failures, and a database-only status read. A rolling horizon is a
time constant, not a deadline. The default is 30 days, the coordinator's Q-13 decision awaiting
the owner, not a disk measurement. The coordinator's under-target and TV decisions are likewise
awaiting the owner. Q-14 stays open for story 823.

The byte ceiling remains 3,591,025,375,575, the largest completed batch's proposed bytes measured
by the 2026-11-13 replica SELECT in story 820. It becomes a hard cap; a title that would cross its
kind's allocation is skipped, and later fitting titles may be selected. Movies retain today's
per-kind title cap as the new audited title cap's default. TV retains its per-kind maxItems.
The replica read of 2026-11-14 measured those caps as 50 and 5. No mode is enabled by this change.

### Consequences

| ID | Consequence |
| --- | --- |
| C-01 | Off preserves the existing batch, gate, notification and policy-ledger payload. Status never reads Prometheus or an *arr. |
| C-02 | Observe-only computes and stores the ask but uses the existing gate and caps for real proposals. |
| C-03 | Applied sizing retains title caps and enforces the hard byte limit against the fresh batch snapshot. A cap may leave a larger shortfall. |
| C-04 | Missing, stale or unusable history and preload failures retain today's caps, with the reason stored. Invalid active settings read as off. |
| C-05 | Each active-mode evaluation records its outcome and explanation, including skips. The status read returns that record with its time; it does not claim a fresh computation. |
| C-06 | The defaults do not promise recovery within the horizon. The projection and its limitations are recorded with the measured inputs in the evidence note. |

## More information

Story 852, story 823 (enablement and Q-14), story 853 (display), and
[the evidence note](../../.agents/context/2026-11-14-852-dynamic-pace.md).
The independent adversarial review is a coordinator-owned merge gate; this worker opens the PR
and does not merge or deploy it.
