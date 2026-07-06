# KICKOFF — Fable 5, you are building haynesnetwork today

*Owner: Tom Haynes. Prepared 2026-07-05 for a hands-off run on Monday 2026-07-06. Paste-in
entry prompt: read this top-to-bottom, then start.*

## Your mandate

You have **full autonomy** and the whole day. The owner is away and reachable only by remote
control; **do not wait on him**. Work the plan queue in `.agents/plans/` from the lowest active
number, take each plan all the way to **live-validated on staging**, then move to the next.
Optimize for correctness and completeness, not speed — but keep moving; a finished, validated,
deployed plan is the unit of progress.

You may author **and ratify** architecture: write the PRD/ADR/DDD/DESIGN a plan calls for and
**Accept** your own ADRs. You may **deploy** and you have **full live access** — real Plex
shares, real *arr writes, real staging deploys, live Playwright against real servers. With that
power: be careful with anything destructive (see Safety), and report faithfully.

## What haynesnetwork is

The SSO front door for the Haynes Plex ecosystem: users sign in via **Authentik (Plex)** and get
a permissioned dashboard of self-hosted apps, self-service Plex library management, and *arr-backed
media "fix"/ledger tooling. pnpm monorepo — `apps/web` (Next.js App Router + tRPC) and
`packages/@hnet/{db,domain,arr,sync,auth,api,ui,test-utils}`. Postgres 16 only (embedded PG16 in
tests, no Docker). Phases 1 + 2 shipped through v0.4.0; you are building Phase 3 and the new
feature set. Full orientation: `docs/README.md`, `.agents/HANDOFF.md`,
`.agents/context/2026-07-05-backlog-recon.md`.

## How you work — docs-first, one plan per release

The process is **PRD → ADR → DDD → design → plan → code → tests** (`docs/PROCESS.md`): **no code
before docs**, and docs change in the **same PR** as the behavior. Each plan in `.agents/plans/`
is one release. The full per-plan loop is in **`.agents/plans/README.md`** — follow it exactly.
In short, for every plan:

**read (via subagents) → author+ratify its docs → build the vertical → local merge gate →
branch → PR → checks green → squash-merge → deploy to staging → live Playwright validation →
mark Completed + `git mv` to `completed/` + update HANDOFF → next plan.**

**Before authoring any doc, read the "Cross-plan reconciliation" note in
`.agents/plans/README.md`.** The plans were drafted in parallel: the ADR/DESIGN/R-/T-/migration
numbers written inside them are **placeholders** — allocate the next free ID at authoring time
(current ceilings: ADR-015, DESIGN-006, migration 0008, R-66, T-49), and honor the canonical
names for the pieces two plans share (the `role_section_permissions` model, the ported filter
engine, the Restore-into-Ledger re-home).

Mirror the existing **Restore/Fix vertical slice** for every new feature: db pgTable (enums from
`enums.ts`) → domain single-writers (audit row in the **same transaction**) → import-confined
write client → tRPC router → `'use client'` page. Add new tables to the `no-direct-state-writes`
guard; import-confine any new write client; add an e2e **stub** for any new external system.

## The queue

| # | Plan | Depends on |
|---|------|-----------|
| 002 | Bazarr subtitle Fix | — |
| 003 | Plex library self-service (Phase 3) | — |
| 004 | Library metadata enrichment + posters + **shared filter engine** | — |
| 005 | Ledger section (native restore + export) | 004 |
| 006 | Trash section (Maintainerr) | 004 + Maintainerr (deployed for you) |
| 007 | Cosign image signing | — (any time) |
| 008 | haynesnetwork public cutover | **runs LAST** — after 002–006 |
| 009 | Bulletin — notification Feed + Messages (stretch) | 004, 006 |
| 010 | MOTD dashboard banner (stretch) | — |

`004` builds the ported demo-console filter/table engine that `005` and `006` reuse — so `004`
before `005`/`006`. `005` before `006` (the Ledger carries the retired Restore page's re-add
power; Trash then removes the Restore nav). `008` is the public go-live and must not start until
every feature plan is complete and validated. **`009` (Bulletin) and `010` (MOTD) are stretch** —
build them only after the core queue (`002`–`008`) is done and budget/time remains; `010` is small
and independent enough to pull forward as a quick win if you're ahead.

## haynes-ops — how to deploy and test

The app deploys via the **sibling Flux GitOps repo** `../../haynes-ops` (cluster context
`haynes-ops`). There is **no image automation** — deploying is a **manual image-tag bump**:

1. Merge your feature PR → release-please opens a `chore(main): release X.Y.Z` PR → merge it →
   tag `vX.Y.Z` + image `ghcr.io/thaynes43/haynesnetwork:vX.Y.Z`. Since **#37** the image
   **builds + pushes automatically in that release-please run** (`release_created`, `GITHUB_TOKEN`,
   `packages:write`) — no PAT, no tag re-push. Confirm it exists
   (`gh api .../packages/container/haynesnetwork/versions`); if it's missing, **re-run the
   release-please workflow run** (`gh run rerun <run-id>`) — do NOT re-push the tag (`ci.yml`'s
   tag build is `IMAGE_PUSH=false`, build-only, and won't publish). See
   `docs/ops/004-deploy-runbook.md`.
2. In `haynes-ops`, bump the `tag:` at
   `kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml` (the `&mainImage` anchor
   moves app + migrate init-container + both sync CronJobs together). Commit + push.
3. `flux reconcile source git haynes-ops -n flux-system` then
   `flux reconcile kustomization haynesnetwork -n flux-system --with-source`.
4. Verify: `kubectl -n frontend rollout status deploy/haynesnetwork`; health at `/api/health`.

**Local merge gate (matches CI — run before every PR):**
`pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`. Iterate one package
with `pnpm --filter @hnet/<pkg> test`. Boot the whole app locally with **`pnpm dev:local`**
(embedded PG16 + stub OIDC + stub *arr, on :3000).

**Known flake:** `packages/auth` (`bootstrap-admin.test.ts`) occasionally exits 1 on an
embedded-Postgres teardown race (`57P01: terminating connection due to administrator command`) —
every test passes; PG is just shut down with a pooled connection still open. If `test` fails **only**
with that `57P01` error, re-run the job (`gh run rerun <run-id> --failed`) — it's a flake, not a
regression. (Backlog has a real fix: `await pool.end()` before stopping embedded PG.)

**Second known flake:** the `e2e` job's catalog keyboard-reorder test
(`apps/web/e2e/admin.spec.ts:79`, ADR-015) is intermittently red (focus/timing race — `order.b=-1`
/ a dialog that doesn't dismiss). `e2e` is **advisory** (not a merge gate), so it never blocks a
merge — re-run if you want it green. If it recurs during real UI work, check the catalog
drag-handle focus/persist handling; it may be a genuine intermittent race, not just a test flake.

**Testing — live Playwright is the sign-off.** Beyond unit + hermetic e2e stubs (`pnpm --filter
web e2e`, :3100), each plan lists the **live journeys** to run against real staging
`https://haynesnetwork.haynesops.com` and the real backing servers. A plan is **not done** until
its live journeys pass. Secrets come from 1Password via the existing env/ExternalSecret contract
— reference names only, never commit values.

## When to spin Opus subagents (you are scarce — default to Opus)

**Finishing the whole queue before your Fable usage limit is hit is a first-class goal — as
important as the code quality.** Your Fable budget is a hard, scarce resource and **you cannot
see how much of it remains**, so treat it as always nearly-exhausted: **default every unit of
work to an Opus subagent, and keep a task for yourself ONLY when a Fable-level mind is genuinely
required** — the architecture, the ADR call you ratify, the subtle domain/algorithm code,
cross-plan coherence, and the final review. When you are unsure whether a task needs you, it does
not — hand it to Opus. A plan finished by Opus subagents under your direction counts fully; a plan
left half-done because you spent Fable budget on exploration, boilerplate, or running the test
suite does not. Concretely, delegate to Opus:

- **Exploration / research** — "map how the roles vertical is wired," "find every call site of X,"
  reading a subsystem or a sibling repo.
- **Testing** — writing unit/e2e specs, building stubs, running the merge gate and reporting
  failures, driving live Playwright journeys.
- **Mechanical / easy edits** — enum additions, boilerplate CRUD, wiring a router, porting a
  component you've specified, doc scaffolding from a template.
- **Verification** — auditing a deploy, checking an integration is connected, confirming a guard
  test still passes.

Give each subagent a crisp, self-contained task and have it return findings/results, not a pile
of file dumps. Fan out independent work in parallel. Keep the design decisions and the final
review for yourself.

## Hard rules (never violate)

PG16 only · no raw hex outside `packages/ui` `tokens.css` (`pnpm lint:css`) · user-facing catalog
links are arbitrary `http(s)` (server-side base URLs like Plex/`*.svc.cluster.local` are exempt) ·
*arrs are the source of truth, sync one-way, only write-backs are explicit actions · Authentik
OIDC only · every guarded-state mutation writes its audit row in the **same transaction** via
`packages/domain` single-writers (guard test enforces it) · `@hnet/arr/write` (and any new write
client) import-confined to `packages/domain` · destructive actions use `@hnet/ui` `ConfirmButton`
(never `window.confirm`), explanatory/multi-field use `Modal` · **no layout reorientation on
interaction** (ADR-015) · enum const arrays in `enums.ts` are the single source of truth for TS
types **and** SQL CHECK.

## Safety

- **Maintainerr (plan 006):** an instance is deployed for you at
  `maintainerr.haynesops.com`. Before wiring ANY destructive action, **audit the install, verify
  its integrations are connected (Plex, Tautulli, the three *arrs, Seerr), and verify nothing
  will be deleted** (no active destructive rules). Live validation for Trash is **non-destructive**
  — reads + adding an exclusion; never trigger a real deletion to "test."
- **Full live access is real.** Prefer the safest way to prove a thing works; never exercise a
  destructive path against real media just to validate. Music is never deleted.
- **Report faithfully.** If a live journey fails, say so with the output; if you deferred
  something, say so; don't mark a plan Completed unless its gate is green, it's deployed, and its
  live journeys passed.

## Reference map

- `.agents/plans/README.md` — the queue mechanics + per-plan loop.
- `.agents/plans/NNN-*.md` — the plans themselves (each self-contained + executable).
- `.agents/HANDOFF.md` — current build state / resume point (keep it current as you finish plans).
- `.agents/context/2026-07-05-backlog-recon.md` — consolidated backlog + the Restore explanation.
- `.agents/plans/TODO.md` — the owner's original brain dump (source of 002–006).
- `.agents/plans/radarr-fileless-backlog.md` — 4,008 deleted items to import into the Ledger (005).
- `docs/` — PRD, ADRs, designs, DDD glossary/contexts, ops runbooks.
- `../todos-for-dues`, `../demo-console`, `../../haynes-ops` — the sibling reference/donor repos.

## First move

Open `.agents/plans/002-bazarr-subtitle-fix.md` and begin the per-plan loop. Delegate the initial
read of it + its cited files to an Opus subagent, confirm the docs-first artifacts you'll author,
then go.
