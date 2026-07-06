# The plan queue — how Fable 5 works it

This folder is a **queue of release-sized plans**. Each `NNN-<slug>.md` is one plan ≈ one
release. Fable 5 (the autonomous orchestrator) works the queue **lowest active number first**,
takes each plan end-to-end as its own release, then moves it to `completed/` and picks up the
next. Read `../KICKOFF.md` first — it is the entry prompt and explains autonomy, the project,
deploy/test, and when to spin Opus subagents.

## Rules of the queue

- **One plan = one release.** Don't batch plans into a single PR. Each plan is its own
  branch → PR → squash-merge → deploy → validate cycle.
- **Numbers are stable and never renumbered** (like every other ID in this repo). A completed
  plan keeps its number when it moves to `completed/`.
- **Active plans live here; finished plans move to `completed/`.** `001-gate-a-pr-cutover.md`
  is already in `completed/` as the worked example.
- **Dependencies are honored.** A plan's header lists `Depends on:`. Do not start a plan whose
  dependency is still active. `008` is gated to run **last** (after all feature plans).
- **Docs-first, always** (`../../docs/PROCESS.md`). Author/ratify the PRD/ADR/DDD/DESIGN a plan
  names **before** its code, in the same PR as the behavior.

## The per-plan loop (the "driver contract")

For each plan, in order:

1. **Read** the plan doc + its cited files. Delegate the reading/exploration to **Opus
   subagents** (see KICKOFF) — you are scarce.
2. **Author the docs-first artifacts** the plan enumerates (PRD edits, new ADR(s), DDD/glossary
   terms, new DESIGN). You may **Accept** your own ADRs (owner granted authority).
3. **Implement the full vertical** (db → domain → client → api → ui), mirroring the Restore/Fix
   slice. Add new tables to the `no-direct-state-writes` guard; import-confine any new write
   client. Add an e2e **stub** for any new external system.
4. **Local merge gate** — all five green, matching CI:
   `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`.
5. **Branch → PR → required checks green → squash-merge** (`main` is branch-protected; required
   checks are `lint-and-typecheck`, `test`, `build`; conventional-commit PR titles).
6. **Deploy to staging** — bump the image tag in the sibling `haynes-ops` repo and reconcile
   Flux (see `../../docs/ops/004-deploy-runbook.md`).
7. **LIVE-validate** — run the plan's Playwright journeys against real staging
   (`haynesnetwork.haynesops.com`) **and the real backing servers**. A plan is not done until its
   live journeys pass.
8. **Mark Completed** — set the plan's Status to Completed with a one-line result, then
   `git mv .agents/plans/NNN-*.md .agents/plans/completed/`, and update `../HANDOFF.md`.
9. **Next** lowest-numbered active plan.

## Current queue

| # | Plan | TODO | Depends on | Status |
|---|------|------|-----------|--------|
| 001 | GATE A — PR-flow cutover | — | — | ✅ completed/ |
| 002 | Bazarr subtitle Fix | #1 | — | queued |
| 003 | Plex library self-service (Phase 3) | #2 | — | queued |
| 004 | Library metadata enrichment + posters + shared filter engine | #3 | — | queued |
| 005 | Ledger section (native restore + export) | #5 | 004 | queued |
| 006 | Trash section (Maintainerr) | #4 | 004 + Maintainerr | queued |
| 007 | Cosign image signing | — | — | queued (any time) |
| 008 | haynesnetwork public cutover (Cloudflare tunnel) | — | 002–006 done | queued **LAST** |

Source brain dump: `TODO.md`. Consolidated backlog + Restore explanation:
`../context/2026-07-05-backlog-recon.md`. Deleted-items snapshot to import into the Ledger:
`radarr-fileless-backlog.md`.

## Cross-plan reconciliation — READ before authoring any doc

The seven plans were drafted in parallel, so they could not coordinate shared identifiers or
shared building blocks. Reconcile these before you act on any plan:

- **The ADR / DESIGN / R- / T- / D- / migration numbers written inside the plans are INDICATIVE
  placeholders, not reservations.** Multiple plans independently wrote `ADR-016`, `ADR-017`,
  `DESIGN-007`. Assign the **next free number at authoring time**, in queue order — IDs here are
  sequential and never reused. Ceilings at v0.4.0: **ADR-015, DESIGN-006, migration 0008,
  PRD R-66, glossary T-49, BC-04**. Re-grep `docs/adrs/`, `docs/designs/`, the PRD, the glossary,
  and the DB migrations before each plan, because earlier plans in the same run will have already
  consumed numbers above those ceilings (e.g. 002 takes ADR-016, then 003 takes the next, …).
- **Shared Section-Permission model — canonical names (PLAN-005 owns it, PLAN-006 extends it):**
  table **`role_section_permissions`**; enums **`SECTION_IDS`** + **`SECTION_PERMISSION_LEVELS`**
  (`edit | read_only | disabled`); Admin implies Edit. Plan 006's draft calls the base table
  `role_section_grants` — that is the SAME table under the canonical name; 006 must NOT create a
  second base table. 006 adds only its finer **`role_trash_action_grants`** + **`TRASH_ACTIONS`**
  on top.
- **Shared filter/table engine:** ported ONCE in PLAN-004 (demo-console `packages/shared/filters`
  → `@hnet/ui`, mechanism only — keep our own look). PLAN-005, PLAN-006, and Library reuse it
  verbatim; do not re-port it.
- **Restore retirement ordering:** PLAN-005 re-homes the failsafe re-add into the Ledger
  (generalizing `executeRestore` + `restore_runs`); PLAN-006 removes the `/admin/restore` nav
  (redirect → `/trash`) but keeps `restoreRouter` callable. **005 runs before 006** so the
  failsafe is never absent — keep that order.
- **Shared `enums.ts` + guard list:** most plans append to `packages/db/src/schema/enums.ts` and
  the `no-direct-state-writes` guard list. Re-read both before each plan; append, never rewrite.

## Tonight's prerequisite (owner + assistant, not Fable 5)

**Maintainerr** is being deployed to `haynes-ops/kubernetes/main/apps/media/maintainerr` tonight
so plan 006 has an instance to integrate. The owner will place its API key
(`MAINTAINERR_API_KEY`) in 1Password after it boots. Plan 006 begins by **auditing** that
install, **verifying** its integrations, and **verifying nothing will be deleted** before wiring
any destructive action.
