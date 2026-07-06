# Backlog recon — consolidated from the docs at v0.4.0

*Generated 2026-07-05 by a fan-out read over the PRD, all 15 ADRs, all 6 designs, the DDD
glossary + bounded contexts, the ops docs, the codebase, and `.agents/`. This is a **map of
work already documented somewhere**, pulled into one cited place — not new scope. Source
citations are `file:line` or `DOC ID`. Sizes are rough (S/M/L/XL).*

> Companion to `.agents/plans/` (the executable queue) and `.agents/HANDOFF.md` (resume point).
> As each item becomes a plan, link it here.

## What the "Restore" page is (`/admin/restore`)

The Phase-2 **failsafe restore** console — admin-only disaster recovery, **not** user-facing.
It reconstitutes a Sonarr/Radarr/Lidarr instance from the app's ledger after that *arr's DB is
lost or a fresh instance is stood up (PRD R-50..R-52 / US-07 / AC-09; glossary T-35; BC-03).

Flow: **pick the *arr kind → live diff** (monitored ledger rows whose external id is absent
from the live instance; tombstoned ones badged) **→ prune the selection → Modal confirm →
execute** (re-adds each item **monitored**, with its recorded quality profile / root folder /
tags, mapped **by name**, **searches OFF** so it doesn't hammer indexers) **→ per-item report +
`restore_runs` audit row.** It re-derives a fresh diff at execute time (TOCTOU guard) and writes
the ledger `restored` event in the same transaction as the mutation.

Deliberate boundaries: admin-only; no auto-search; item-granularity only (not per-episode);
name-based profile/folder/tag mapping (a renamed target profile → per-item failure, surfaced in
the report). It is the **only bulk write-back** — sync is otherwise strictly one-way *arr → app.

## Master backlog

### The one large feature — Phase 3 (Plex library self-service, BC-04)

| # | Item | Size | Source |
|---|------|------|--------|
| P3-1 | **Plex library self-service** — users self-add/remove Plex libraries per server across all three servers (k8plex, plexops, legacy haynestower), within an admin-allowed set; applied via each server's owner token, audit-logged. **Entirely unbuilt** — no `plex_*` tables, no Plex domain module, no `plex` router (only a reserved name comment), no web route. | XL | PRD R-25..R-28 (`docs/prds/001-haynesnetwork.md:87-94`); DDD-002 BC-04:90-102; DDD-001 T-17..T-21:56-60; DESIGN-001 Appendix A (non-normative sketch) |
| P3-2 | **Family-library gating on a role attribute** — default allowed set = all libraries except `HNet Home Videos` + `HNet Photos` (family-only). ADR-012 C-09 says "Family" must attach to a **role attribute**, not the removed `users.is_family`. Needs the allowed-library data model + admin UI on the roles surface. | L | PRD R-26/R-27; ADR-012 C-09; DDD-001 T-20/T-21 |

Phase 3 is docs-gated: it needs a PRD refinement, at least one new ADR (Plex sharing +
token handling; family-gating role attribute), DDD finalization of T-17..T-21, and a new DESIGN
doc (superseding DESIGN-001 Appendix A) **before code**. Open modeling question: allow-list vs
deny-list-of-exceptions for the allowed set (DESIGN-001:674).

### Ops / deploy

| # | Item | Size | Source |
|---|------|------|--------|
| O-1 | **Root-domain cutover** to public `haynesnetwork.com` + `www` — coupled two-file swap in haynes-ops (ingressroute + externalsecret `BETTER_AUTH_URL`). Gated on Phase-1 e2e green + public DNS/Cloudflare tunnel + cert Ready + Authentik redirect-URI. | M | PRD R-64; OPS-005 |
| O-2 | **Catalog tile URL flip for overseerr.haynesnetwork.com** — the *arr/Seerr stack has migrated in-cluster (reachable at `*.media.svc.cluster.local`); only the user-facing catalog tile still points at the legacy Unraid URL — a one-field admin edit. Owner-driven. | S | PRD Q-02 |
| O-3 | **Cosign image signing** before Kyverno enforcement expands (policy is AUDIT-mode today). | M | HANDOFF:71-72 |
| O-4 | **Promote Playwright e2e from advisory → required CI check** once hardening closes. | S | ADR-009; ADR-010 |
| O-5 | **Rate-limit storage in-memory → database** if the app ever scales past one replica. | M | DESIGN-002 D-14 |

### UX / small features

| # | Item | Size | Source |
|---|------|------|--------|
| U-1 | **Role-reassignment confirm guard** on `/admin/users/[id]` — the role `<select>` applies on change with no confirm; explicitly deferred out of ADR-014. | S | ADR-014 C-05; DESIGN-004 D-13 |
| U-2 | **User Settings page** — deliberately omitted (owner decision 2026-07-05); user menu is settings-only (Admin settings + Sign out). Donor SettingsDrawer port waits for a 2nd preference beyond theme. | M | ux-backlog:13-16; DESIGN-004 |
| U-3 | **Admin-supplied catalog icons** (upload/URL) vs the fixed code-shipped `ICON_KEYS` registry — open owner question. | M | DESIGN-003 Q-02; DESIGN-001 Q-01 |
| U-4 | **Admin table → card screen-reader semantics** (<760px) — the CSS `data-label` transform drops table semantics; accepted at household scale. | M | DESIGN-004 D-06 |
| U-5 | **Ongoing bug-fix / UX-smoothing pass** driven by owner staging testing (dialog layout, action consistency, search behaviour). Open-ended. | ? | HANDOFF:45-46 |

### Deferred features / follow-ons

| # | Item | Size | Source |
|---|------|------|--------|
| F-1 | **Radarr file-less backfill** — 4,008 Radarr DB entries with no file on disk (folders swept at cutover), tiered by votes; bulk re-monitor/search tooling. Ties into ledger Wanted Items (R-42). | ? | `.agents/plans/radarr-fileless-backlog.md` (data snapshot) |
| F-2 | **Maintainerr integration** for richer deletion attribution, once it runs in k8s. | M | PRD R-41/Q-04; ADR-008 |
| F-3 | **Authentik permission sync (R-30)** — push app perms into Authentik once server-side enforcement is wanted (today = link hide/show). | L | PRD R-30; DDD-002 BC-02 |
| F-4 | **Admin fix rate-limit → configurable** — currently a hardcoded constant (5/user/hr, admins bypass). | S | PRD R-47/Q-05 |
| F-5 | **Queue read surface** — show a fix's live download progress; no queue read method in `@hnet/arr` today. | M | DESIGN-005 |
| F-6 | **Per-episode wanted browsing** — R-42 is item-granular; per-episode would proxy live, not sync. Build only if wanted. | M | DESIGN-005 Q-05 |
| F-7 | **Enable PKCE** on the OIDC flow — hardening follow-up, not required for a confidential client. | S | DESIGN-002 Q-04 |
| F-8 | **Admin "link Seerr user" override UI** — deferred until real Seerr↔app email mismatches appear. | M | DESIGN-005 Q-01 |
| F-9 | **Admin confirmation flow for the mass-tombstone sync guard** (today: 20%/10-row guard + CLI `--force-tombstones`). | S | DESIGN-005 Q-03 |

### Tech-debt / verify-then-simplify

| # | Item | Size | Source |
|---|------|------|--------|
| T-1 | **Extend hex-color guard** to inline `style=` strings / TSX color literals (CSS-only today). | S | DESIGN-004 D-04 |
| T-2 | **`unaccent` search functional index** — seq scan is cheap at ~17k rows; add if the ledger grows. | S | DESIGN-005 |
| T-3 | **Catalog delete: soft-delete vs hard DELETE** — open modeling question; current lean is hard delete + audit snapshot. | S | DESIGN-001 Q-03 |
| T-4 | **Confirm auth identity claims at first real login** — which owner email Authentik emits, verified flag, claim set. | S | DESIGN-002; PRD Q-01 |
| T-5 | **Verify Lidarr album-fix semantics** against a live instance (one blocklisted grab dislodging a bad album). | S | DESIGN-005 Q-08 |
| T-6 | **Confirm Open WebUI tile URL** (`ai.haynesnetwork.com`) long-term vs a rename. | S | DESIGN-001 Q-02 |
| T-7 | **`packages/auth` test teardown race** — `bootstrap-admin.test.ts` intermittently exits 1 with `57P01` (embedded PG stopped while a pooled connection is open); all tests pass. Fix: `await pool.end()` before stopping embedded PG. | S | CI run 28764595270 (PR #40) |
| T-8 | **Catalog keyboard-reorder e2e flake** — `apps/web/e2e/admin.spec.ts:79` (ADR-015) intermittently fails (focus/timing: `order.b=-1` / dialog not dismissed); passed on #38–#43, failed on docs-only #44. Stabilize the test, or check whether it's a real intermittent race in the drag-handle focus/persist. `e2e` is advisory so it doesn't block. | S | CI run 28766326033 (PR #44) |

## Cross-cutting decisions the owner must settle for an unattended run

These shape every plan's "driver contract" (see the pending grill / `.agents/plans/README.md`):

1. **Autonomy ceiling** — build→PR only, auto-merge on green, or also run the manual haynes-ops deploy?
2. **Docs-first authorship** — may the agent author + Accept ADRs overnight (immutable once
   Accepted), or leave them Proposed for morning ratification?
3. **Live systems** — may unattended verification touch real Plex/*arr/cluster/haynes-ops, or
   stubs + `dev:local`/e2e only?

## Note on staleness (fix during prep)

`.agents/HANDOFF.md` says "Latest release: v0.3.1" and the ux-backlog doc lists the username
dropdown → settings + Library sub-tabs as *not started* — but **v0.4.0 shipped** (#36) and the
owner confirms those UX items are **done**. HANDOFF + ux-backlog should be refreshed to v0.4.0
reality as part of this prep.
