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
| 011 | Authentik hardening (native-account MFA + haynesnetwork sign-in rebrand) | owner 2026-07-06 | — (runs after 012 per owner order) | **branding DONE** (applied live: option C rebrand + Plex-primary login card + RP-initiated SSO logout, v0.18.0/v0.18.1); **MFA = NEXT SESSION** — owner will do MFA hardening while migrating Authentik to blueprints/GitOps (seed = `../../docs/ops/001-authentik-provisioning.md` + `scratchpad/ux-011/APPLY.md`). Only non-completed/ plan; kept active for the MFA tail. |
| 009 | Bulletin — notification Feed + Messages board | stretch | 004, 006 | ✅ completed/ (v0.13.0) |
| 010 | MOTD dashboard banner | stretch | — | ✅ completed/ (v0.14.0) |
| 008 | haynesnetwork public cutover (Cloudflare tunnel) | — | 002–006, 012 done | ✅ completed/ (**EXECUTED 2026-07-07** — `haynesnetwork.com` + `www` publicly live; see `../../docs/ops/005-root-domain-cutover.md`) |
| 013 | Disk utilization + reclaim metrics | owner 2026-07-06 | 012 (deletion snapshots) + 008 | ✅ completed/ (v0.17.0) |
| 014 | Rules tuning + space policy (skip-gate graduation) | owner 2026-07-06 | 013 + accumulated 012 save-data | ✅ completed/ (v0.18.0) |
| 015 | Downstream *arr action feedback (live Fix/Force-Search status) | owner 2026-07-07 | — (extends the on-`main` Fix/Force-Search vertical) | ✅ completed/ (v0.15.0) |
| 016 | Pushover batch notifications (outbox + delivery window) | owner 2026-07-08 | 012 (batch lifecycle) + 014 (space policy reuses `createBatchFromPending`) | ✅ completed/ (v0.22.0) |

**Owner-ordered sequence (2026-07-06):** 006 → 012 → 011 → 009 → 010 → 008 → 013 → 014, with 015
(owner 2026-07-07) and 016 (owner 2026-07-08) landed alongside. **THE BOARD IS COMPLETE:** every
buildable plan **002–016 is in `completed/`**, shipped and live-validated on the public origin.
**008 cut over to the public root domain 2026-07-07** (`haynesnetwork.com` + `www` live).

**Session-2 (v0.14.1 → v0.29.0, latest = v0.29.0):** no new plans — the session ran as owner-feedback
hardening that turned the trash automation loop into a **proven production pipeline** (first real
sweep 2026-07-09: 14/15 deleted, 90.7 GiB reclaimed). Full narrative + per-release notes in
`../context/2026-07-10-session-wrap.md`; cold-start state in `../HANDOFF.md`.

**011 is the only non-`completed/` plan:** its **branding is DONE** (option C rebrand + Plex-primary
login + RP-initiated SSO logout, applied live); its remaining piece — **MFA hardening** — is the
**owner's NEXT-SESSION agenda**, to be done alongside migrating Authentik to blueprints/GitOps. It
stays active for that tail (`011-authentik-hardening.md`).

Source brain dump: `TODO.md`. Consolidated backlog + Restore explanation:
`../context/2026-07-05-backlog-recon.md`. Deleted-items snapshot to import into the Ledger:
`radarr-fileless-backlog.md`.

## Round 2 queue (2026-07-10)

Second wave, drafted from the owner backlog `../../../haynes-ops/zprompt.md`. Two tracks:
**Authentik hardening** (011 rescope) and a **Metrics section** (017 foundation + sub-tabs
018–020), plus **AI** (021), **ytdl-sub Library** (022), and **Books/Audiobooks** (023). All
`Status: Draft`; take next-free IDs at authoring (see reconciliation note below — these siblings
consume numbers tonight). One plan = one release, lowest active number first, as always.

| # | Plan | Scope (one line) | Depends on | Owner-gated |
|---|------|------------------|-----------|-------------|
| 011 | Authentik hardening (rescope) | Blueprints/GitOps migration (Phase 1, agent-safe, no live writes) then native-account MFA | — | **Phase 2** — apply + enroll + akadmin repair are owner-present |
| 017 | Metrics section foundation | Top-level Metrics tab (after Bulletin) + Full/Limited access model + Overview (up/down vs ~300 Mbps cap) | — | Owner flips Default→`limited` after morning screenshot review |
| 018 | Metrics — Apps/*arr sub-tab | exportarr dashboards + gap-fill (per 017 out-of-scope) — **planned slot, not yet drafted** | 017 | — |
| 019 | Metrics — Hardware sub-tab | SMART health + alerting, node load/temps, Proxmox host→VM showcase; both levels see all | 017 | **Partial** — pve-exporter needs the 1P `proxmox` item; SMART thresholds + which Proxmox nodes await owner |
| 020 | Metrics — Network sub-tab | WAN up/down usage-vs-capacity (`limited`) + infra performance grain (`full`); no client identities at ANY level | 017 | — (privacy invariant is a hard verification, not owner-gated) |
| 021 | AI — Open WebUI | GPU repair runbook, Ollama models + budget, RBAC via admin API, ComfyUI image-gen, catalog advertise; Q&A POC stretch | — (soft: catalog, role model) | **GPU repair owner-present; model pulls owner-run; needs 1P `openwebui` key** |
| 022 | ytdl-sub Library | Surface Peloton + YouTube libraries read direct from Plex via `@hnet/plex`; ships admin-gated | rebase onto 017's sub-tab/nav after it merges | **Posters** — durable-poster sink awaits owner (Q-01); admin-gated at ship for screenshot review |
| 023 | Books & Audiobooks | **Phases 1–2 DEPLOYED & LIVE (2026-07-10, `haynes-ops`):** Kavita+ABS serving + LazyLibrarian+Kapowarr acquiring, on **gasha01** (libraries migrated off the tower, originals untouched); Prowlarr↔LL + SABnzbd + qBittorrent wired; **usenet grab proven end-to-end for ebook AND audiobook**. Phase 3 (OIDC, `*.haynesops.com`→`*.haynesnetwork.com`) gated on 011; Phase 4 (catalog cards) not started. See plan's "Owner rulings + as-built". | 011 (Phase 3 only) | **Owner TODOs:** ComicVine key (Kapowarr grab); Google-Books key OR LL-build swap (LL `version-40a389ea` OpenLibrary metadata bug blocks auto-grab); private-tracker accounts (book torrents); 1P items for the 4 apps' keys |

**Owner-present / gated tonight+morning:** 011 Phase 2 (Authentik apply), 019 (pve-exporter 1P
`proxmox` item), 021 (GPU repair + models + 1P `openwebui` key), 022 (poster durable store). The
owner is adding the 1Password `proxmox` and `openwebui` items tonight, unblocking 019/021.

## Phase-3 queue (as of 2026-07-11 board audit)

**Shipped this session (v0.43.1 → v0.44.1), all in `completed/`:** PLAN-036 (history contract,
v0.43.1) · PLAN-034 (Helpdesk tickets, v0.44.0) · PLAN-031 (MAM books acquisition Phase B, live) ·
PLAN-029 **design docs** (ADR-051/052/053 + DESIGN-026 — the plan itself stays ACTIVE for the build)
· HP-01 Helpdesk state-filter polish (v0.44.1). PLAN-021 (AI/Open WebUI) filed to `completed/` in the
audit (shipped earlier). The books/comics/audiobooks acquisition pipeline is **live and seeding**.

**Budget + model-switch (READ):** Fable weekly usage was ~73% (all-models ~76%) at last check,
**resets Mon 2026-07-13 ~07:59**. A Fable→Opus safeguard flipped the coordinator session repeatedly
2026-07-11 — the owner caught each; the probe cadence only checks SUBAGENT models before dispatch and
does NOT catch a coordinator flip mid-conversation. Keep prompt phrasing neutral, probe before every
dispatch, and expect the owner to be the backstop. **Discuss agent type with the owner before every
dispatch** (standing rule).

### Active build queue (forward-looking)

| # | Plan | Status | Next action |
|---|------|--------|-------------|
| 029 | Library views/grouping + Sorting & Filtering | **DESIGN COMPLETE — ready to build** | The biggest queued value. Docs done (ADR-051/052/053, DESIGN-026, R-165..R-171, T-149..T-155); build-phase steps in the plan. Owner rulings locked (server-side per-user prefs, per-view registries, per-user watch-state IN scope, URL-synced views). **Blocked only on:** owner agent-type call (rec: Opus data/domain + Fable sort/filter UX) + Fable budget (post Monday reset). |
| 032 | List-driven book automation (Kometa/lists analog) | **RESEARCH DONE — design next** | Research merged (#221: `2026-07-11-books-list-sources-research.md` + the plan's "Proposed v1 shape"). Rec = hybrid: LL-native for Goodreads-shelf-RSS/Hardcover; a small `@hnet/sync` list mode for the official NYT Books API (ISBN-keyed `addbookbyisbn` + rating floor). **Owner decisions pending:** curation home (Goodreads vs Hardcover), ebook/audio defaults, the BLOCKING Q-06 supervised metadata-path test. |
| 033 | Book requests + wanted-not-on-disk view | **PARKED (owner 2026-07-11)** | Too large to take on now; when revisited, START by evaluating existing "Seerr-for-books" solutions before any in-app build. Near-term content need covered by 032+039. |
| 039 | MAM compliance governor (cap-aware pacing) | **SHIPPED v0.45.0 (2026-07-11 eve)** | ADR-054/DESIGN-027/migration 0041 + the confined `@hnet/downloads` package. Seam = the Prowlarr indexer `enable` toggle (fullSync propagates to LL; LL-side toggle rejected as non-durable). Deploying: haynes-ops `726e2b9e` (bump + `sync-mam-governor` CronJob `4,19,34,49 * * * *` + PROWLARR_API_KEY line). Live validation + the Matilda re-grab test = the wrap items. |
| 040 | MAM governor admin tool (rank knob in-app) | Placeholder | Owner 2026-07-11: strategy = seed MAM enough that rank rises until the cap stops binding; he'll manually request knob bumps at each promotion UNTIL this ships. Moves `MAM_UNSATISFIED_LIMIT`/buffer to an audited DB-backed admin setting + governor-state visibility. After 039. |
| 041 | Library Fix for books/audiobooks/comics + Fix-everywhere parity goal | Intake — **owner wants this** | Trigger: *Matilda* on-disk but NOT IN ENGLISH; zero in-app remediation (ADR-046 no-write-back). Part 1 = Fix on books detail pages via a confined LL/Kapowarr ACQUISITION-layer write (ADR first; *arr Fix UX idiom + PLAN-015 live feedback; language-preference lever). Part 2 = standing parity goal: the same Fix on EVERY Library kind — the ytdl leg is registered as a PLAN-025 Q-01 driver. |
| 038 | Ticket media precision (exact episode/file linking) | Scoped (all Qs ruled) | Progressive drill-down in the ticket linker (TV season→episode, music album→track, etc.); leaf-or-scope choice; every-level-ticketable with parent-art inheritance. Build post-MAM; Fable UX post-reset. |
| 035 | Ticket email notifications | Backlogged | BLOCKED by SMTP (F-04). Admin-on-create + user opt-in status emails; rides the existing `notification_outbox` as a second channel. |
| 037 | Collections (mirrored + logical) | Backlogged | Split out of 029 by owner ruling. Scope after 029 ships (reading-order series is the flagship). |
| 025 | ytdl config-manager platform | Roadmap | Own scoping session; spans 3 repos; hinges on the pure-manager-vs-"arr-for-ytdl" fork. |

### Unplanned intake (owner-gated)

- **SMTP relay (F-04)** — Google Workspace + `noreply@haynesnetwork.com` alias + shared relay; unblocks
  035 and estate-wide email. Needs the owner in 1Password (app-password/OAuth) → then draftable.
- **Feed attribution** — the "unattributed" Feed events. Its hard part (app-user↔Plex-account mapping)
  now ships INSIDE PLAN-029 (ADR-053); the Feed-side consumption is a small follow-up after 029.
- **Small polish (no scoping):** F-06 book-cover latency (investigate the books cover-proxy vs the
  cached *arr harvest); F-09 bad-epub parse failures (Kavita). F-08 comic re-grabs = first MAM content
  workload (24 series + 4 issues, list in `.agents/context/2026-07-11-polish-loop.md`).

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
