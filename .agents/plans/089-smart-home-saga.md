# PLAN-089: Smart-home support saga (future placeholder)

- **Status: Draft / UNGROOMED FUTURE SAGA / PAUSED.** Documentation only.
- **Relationship:** separate from [the media/support saga](078-repair-agent-saga.md);
  shares the tentative [Haynes OS vision](../context/2026-10-14-haynes-os-vision.md)
  and dev-env v2 execution/coordination foundation, without assuming v2 acceptance.
- **Authority:** no implementation, device actions, model changes, paid access,
  voice integration, monitoring or agent launch. This is intentionally a small stub.

## Direction and questions

Explore local voice/chat support, with Muse as an example rather than a selected
integration. Reuse domain-extensible connectors, cases, evidence, skills/playbooks,
KB, benchmarks, routing/escalation, feedback, permissions and budgets. Domain-specific
verifiers and device safety cannot be inherited from successful media repairs.

- Q-01: Which local voice/chat path and actual hardware/access are suitable?
- Q-02: What can reliably distinguish a Zigbee network/device failure from a coordinator/dongle problem?
- Q-03: When could a dongle reset help, and what evidence, affected-device inventory,
  explicit authorization and recovery plan would make any future action acceptable?
- Q-04: Which domain benchmarks measure verified resolution, unnecessary device
  changes, uncertainty/no-answer, escalation, latency and cost?

## First possible epic-level spike, not yet groomed

Hypothesis: one simulated Zigbee support case can show whether the shared framework
is useful in this domain. Usable output would be a fixture case contract and a small
voice/chat transcript with verified diagnosis or an honest escalation. A dongle reset
is a case to evaluate on paper/in a fixture, never an action authorized by this stub.

| Proposed story | Input / bounded output and acceptance | Proposed one-session cap |
|---|---|---|
| 089-S1 | Select one sanitized/synthetic case; write its tool/permission boundary, expected evidence and verifier | 30 min |
| 089-S2 | Use accepted S1 inputs for a fixture-only dialogue/benchmark sketch; show useful guidance and safe unknown-answer/reset refusal | 30 min |

Dependency: 089-S1 -> 089-S2. No agent fleet or parallel device work is implied.
Grooming must confirm one owner per story and create separate epic phase files before
execution; this stub does not commit to an architecture or detailed project sequence.

Acceptance/exit: independently verify the fixture outcome, record domain-specific
limits and permission boundaries, and save a go/no-go decision with evidence. A
negative feasibility result is acceptable if labeled honestly. Expected end state
would be a useful domain case/benchmark artifact, with live devices unchanged.

**Proposed budget, not approved:** 20 minutes grooming plus two 30-minute sessions;
$0 incremental paid spend. Stop at the cap, on uncertain device impact, missing
verification, access expansion or any usage hold. Save the partial result and stop;
no automatic retry, hardware reset or new schedule.

**Gate:** fresh owner grooming/authorization is required before either story and
before any later epic. All future device experiments need their own exact controls.
The current expected result is only this durable, cross-linked placeholder on main.
