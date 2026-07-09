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
| 002 | Bazarr subtitle Fix | #1 | — | ✅ completed/ (v0.5.0) |
| 003 | Plex library self-service (Phase 3) | #2 | — | ✅ completed/ (v0.6.0/v0.6.1 + ADR-024 v0.10.0) |
| 004 | Library metadata enrichment + posters + shared filter engine | #3 | — | ✅ completed/ (v0.8.0/v0.8.1) |
| 005 | Ledger section (native restore + export) | #5 | 004 | ✅ completed/ (v0.9.0) |
| 006 | Trash section (Maintainerr) | #4 | 004 + Maintainerr | ✅ completed/ (v0.11.0 + v0.11.1/v0.11.2) |
| 007 | Cosign image signing | — | — | ✅ completed/ (v0.7.0) |
| 012 | Trash curation pipeline (batches → poster review → Leaving Soon → windowed deletion) | owner 2026-07-06 | 006 (incl. its test-rule collections) | ✅ completed/ (v0.12.0) |
| 011 | Authentik hardening (native-account MFA + haynesnetwork sign-in rebrand) | owner 2026-07-06 | — (runs after 012 per owner order) | **branding COMPLETE** (2026-07-07, applied live: option C rebrand + Plex-primary login card + RP-initiated SSO logout); **remaining = owner MFA enrollment + `mfa-exempt` policy** (tracked in the active plan) |
| 009 | Bulletin — notification Feed + Messages board | stretch | 004, 006 | ✅ completed/ (v0.13.0) |
| 010 | MOTD dashboard banner | stretch | — | ✅ completed/ (v0.14.0) |
| 008 | haynesnetwork public cutover (Cloudflare tunnel) | — | 002–006, 012 done | ✅ completed/ (**EXECUTED 2026-07-07** — `haynesnetwork.com` + `www` publicly live; see `../../docs/ops/005-root-domain-cutover.md`) |
| 013 | Disk utilization + reclaim metrics | owner 2026-07-06 | 012 (deletion snapshots) + 008 | ✅ completed/ (v0.17.0) |
| 014 | Rules tuning + space policy (skip-gate graduation) | owner 2026-07-06 | 013 + accumulated 012 save-data | ✅ completed/ (v0.18.0) |
| 015 | Downstream *arr action feedback (live Fix/Force-Search status) | owner 2026-07-07 | — (extends the on-`main` Fix/Force-Search vertical) | ✅ completed/ (v0.15.0) |
| 016 | Pushover batch notifications (outbox + delivery window) | owner 2026-07-08 | 012 (batch lifecycle) + 014 (space policy reuses `createBatchFromPending`) | ✅ completed/ (v0.22.0) |

**Owner-ordered sequence (2026-07-06):** 006 → 012 → 011 → 009 → 010 → 008 → 013 → 014, with 015
(owner 2026-07-07) landed alongside. **THE BOARD IS COMPLETE:** every buildable plan **002–015**
is shipped and live-validated on the public origin (latest **v0.18.0** = 014 rules tuning + space
policy, delivered **OFF** by default). **008 cut over to the public root domain 2026-07-07**
(`haynesnetwork.com` + `www` live). **011 branding is COMPLETE** (option C rebrand + Plex-primary
login + RP-initiated SSO logout, applied live 2026-07-07); its **only remaining piece is owner MFA
enrollment + the `mfa-exempt` policy**, tracked in the active `011-authentik-hardening.md`.

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
- **2026-07-06 — plans 011–014 authored:** as with the original seven, every plan-internal
  ADR/DESIGN/OPS/R-/T-/migration/D- number inside 011–014 is an **indicative placeholder**, not a
  reservation — assign the next free number at authoring time, in the owner-ordered execution
  sequence (012 before 011). Ceilings when they were written: ADR-024 on `main` **plus ADR-023 /
  DESIGN-010 / R-87 / T-74 / migration 0016 on the pending `feat/trash-section` branch** — re-grep
  all of them (including anything 006's remaining work consumes) before authoring any 011–014 doc.

## Tonight's prerequisite (owner + assistant, not Fable 5)

**Maintainerr** is being deployed to `haynes-ops/kubernetes/main/apps/media/maintainerr` tonight
so plan 006 has an instance to integrate. The owner will place its API key
(`MAINTAINERR_API_KEY`) in 1Password after it boots. Plan 006 begins by **auditing** that
install, **verifying** its integrations, and **verifying nothing will be deleted** before wiring
any destructive action.
