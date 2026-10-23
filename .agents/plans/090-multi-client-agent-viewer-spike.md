# PLAN-090: Provider-neutral multi-client agent viewer (Haynes OS)

- **Status: Draft / UNGROOMED SPIKE / PAUSED.** Excluded from automatic dispatch (see README).
- **Context:** [Haynes OS vision](../context/2026-10-14-haynes-os-vision.md). The execution
  foundation is dev-env v2; the matching requirement is `thaynes43/dev-env`
  `.agents/sagas/distributed-dev-env/requirements/2026-10-14-multi-client-viewer.md`.
- **Depends on:** grooming only. It does not depend on or unblock PLAN-078 to PLAN-089.
- **Authorization:** documentation only. No viewer code, service, deployment,
  network/RBAC/credential change, benchmark, agent kickoff or paid run. No pause
  (PLAN-077, PLAN-078 phases, dev-env Chapters) is lifted.

## Owner request

October 14, 2026, relayed by Meatball (the original turn was not directly observed here):
"OK let's bake that into dev-env-v2 and haynes-os, we can create a multi-client viewer
for me instead of using all these different vendor apps."

## Why it matters for Haynes OS

Support and repair work (PLAN-077/078) runs across providers. Today Tom watches it
through separate vendor apps (claude.ai, Codex, Cursor web/iOS). An interactive Cursor
CLI session in dev-env has no inspected web/mobile mirror. The director and humans in
the vision need one consistent place to observe an incident's agent sessions, take
over input, and audit what happened.

## Requirements to groom

- Common session inventory across providers; live output; reconnect and history.
- Coordinated input ownership (single writer: Tom, Meatball or the agent), lifecycle
  actions and an audit trail.
- The same CLI/MCP capabilities and guardrails whichever client is used; usage/cost
  visibility per session.
- Authenticated access through existing identities, with no vendor-app or
  unlocked-Mac dependency; no public access or secret display.
- Native provider apps remain available.

## Smallest usable first checkpoint

Read-only viewing of existing tmux-hosted sessions for two providers in one dev-env
pod: inventory, live output, reconnect and scroll-back. Tom must be able to view it on
a phone and Meatball programmatically, through existing authenticated access. Input
ownership is the next checkpoint and is not part of the first.

## Questions

- Q-01: Is this purely a dev-env v2 capability, with HaynesNetwork only a consumer?
- Q-02: How should incident records (PLAN-087/088) link to viewer sessions without copying transcripts?
