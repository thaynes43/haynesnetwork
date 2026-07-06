# PRD-001: haynesnetwork — SSO front door and media service hub

- **Status:** Accepted
- **Owner:** Tom Haynes
- **Last updated:** 2026-07-03

## Summary

Users of the Haynes Plex ecosystem have no single place to discover the self-hosted apps
they may use, no self-service control over their Plex libraries, and no way to act on
broken media without asking the admin. haynesnetwork is a responsive web app at
`haynesnetwork.com` where users sign in once through Authentik (authenticating with their
Plex account) and get: a permissioned dashboard of `*.haynesnetwork.com` apps, self-service
Plex library management across the three Plex servers, media lookup with a one-click "fix"
that forces the right *arr to re-pull broken content, and a durable ledger of the media
estate (requests, deletions, wants) that doubles as a disaster-recovery source for
rebuilding a lost *arr instance.

## Goals

- One login (Authentik/Plex) → one personal hub for everything on `*.haynesnetwork.com`.
- Give the admin lightweight, centralized control over who sees/uses what.
- Let users help themselves: fix broken content, manage their Plex libraries.
- Keep an independent, queryable record of the media estate and its history.

## Non-goals

- Replacing Seerr for content requests (we link to it and read from it).
- Enforcing app access inside Authentik — follow-on (R-30); hiding links is the accepted start.
- Being a media player, download client, or *arr configuration UI.
- The *arr/Seerr k8s migration itself (owner handles in haynes-ops, in parallel).

## Actors & roles

> **Amended by ADR-012 (2026-07-05):** roles are now **DB-backed, admin-managed rows**
> (`roles` table), not a fixed `Member`/`Admin` enum, and each user has **exactly one**.
> Migration 0007 seeds **three** roles: the **Admin** (superuser) and **Default** (new-user)
> system roles, plus a normal, editable/deletable **`Family`** starter role (every app except
> Tautulli). "Family" is no longer a built-in designation — it is just a seeded example role,
> and its Phase-3 family-library meaning (R-26/R-27) will attach to a **role attribute** rather
> than the removed `users.is_family` flag. A role may instead grant **all apps** via
> `roles.grants_all` ("All apps") without admin access. See ADR-012 and DDD-001 T-02..T-05, T-49.

| Role | Description |
|------|-------------|
| Admin | Superuser role (`roles.is_admin`): full control of catalog, users, roles, restore; **implicitly sees every app**. Immutable (no rename/edit/delete). First login by an allowlisted email is assigned this role. |
| Default | The role assigned to every successful Authentik login (`roles.is_default`). Its editable app set is what basic users see; manages own Plex libraries within allowed set; can report fixes. Cannot be renamed or deleted (app set is editable). |
| Family (seeded example) | A `Family` role is now **seeded by migration 0007** — a normal, editable/deletable role granting every catalog app **except Tautulli**. It ships as the starter example and the intended home for the Phase-3 family-library grant (R-26/R-27, ADR-012 C-09/C-12). |
| _(other admin-created roles)_ | Admins create additional roles with their own editable app sets (or the "All apps" grant, `roles.grants_all` — every app, incl. future ones, without admin access; ADR-012 C-11) and assign users. |

## Requirements

### Identity & access

| ID | Requirement | Priority |
|----|-------------|----------|
| R-01 | Sign-in exclusively via Authentik OIDC (`authentik.haynesnetwork.com`); Plex is offered as the credential inside Authentik. No local passwords or invite tokens. | Must |
| R-02 | First login whose email (case-insensitive) is on the `BOOTSTRAP_ADMIN_EMAILS` allowlist is idempotently promoted to Admin, with an audit row. | Must |
| R-03 | Every other first login auto-creates an account with default permissions — no approval gate. _(Amended by ADR-012: the new user lands in the **Default role**, DB-defaulted on `users.role_id`; "Member" is no longer a role.)_ | Must |
| R-04 | All role/permission changes write audit rows (who, what, when, initiator kind) in the same transaction. | Must |

### Dashboard & app catalog

| ID | Requirement | Priority |
|----|-------------|----------|
| R-10 | Authenticated users see a tile dashboard of apps they're permitted to open; tiles link out to their configured URL. | Must |
| R-11 | The catalog is DB-backed and admin-editable (name, description, icon, URL, default-visible flag, display order) — no redeploy to change a link. | Must |
| R-12 | Default-visible tiles: Seerr (`overseerr.haynesnetwork.com` until the owner's Seerr cutover), Plex (`plex.haynesnetwork.com`), K8Plex (`k8plex.haynesnetwork.com`). _(Amended by ADR-012: "default-visible" is now the **Default role's app set** (`role_app_grants`), seeded by migration 0007 to **Seerr, Plex, K8Plex, and PlexOps** (`plexops` — basic users get PlexOps too); the per-app `app_catalog.default_visible` flag is gone. Admins change what basic users see by editing the Default role.)_ | Must |
| R-13 | Admin-grantable tiles (seeded hidden): plexops, Immich, Open WebUI, Paperless, Tautulli — extensible via R-11. | Must |
| R-14 | ~~**User-facing links must never point at `*.haynesops.com`** (LAN-only ingresses). Enforced by validation on catalog writes.~~ _(Amended by ADR-013: the host restriction is retired — the catalog is admin-curated and accepts **any normalized `http(s)` URL** entered as a plain string; the only floor is http(s)-only, no embedded credentials. No host allow/deny list.)_ | Must |
| R-15 | ~~Admins can grant/revoke individual apps per user.~~ **SUPERSEDED by ADR-012:** there are no per-user app grants. Access is **role-based** — an app is granted to a *role* (`role_app_grants`), and a user gets it by being assigned that role. To give one user a bespoke app set, an admin creates or reuses a role. | ~~Must~~ |

### Tags & permission bundles

> **Amended by ADR-012 (2026-07-05):** "tags" as a distinct mechanism are gone —
> the permission-bundle concept **collapsed into the Role**. A Role *is* the bundle (a named,
> admin-managed app set); assigning a user a role is how bundled permissions are applied.
> Read "tag" as "role" below. The Phase-3 allowed-library / family part of the bundle will
> attach to a role attribute (R-26/R-27, ADR-012 C-09).

| ID | Requirement | Priority |
|----|-------------|----------|
| R-20 | Admins can create/edit/delete **roles**; a role bundles a set of permissions (app grants; Phase-3: allowed Plex libraries, family designation). _(Amended by ADR-012: role replaces tag; `roles` + `role_app_grants`. Admin/Default are system roles — see Actors table.)_ | Must |
| R-21 | Assigning/changing a user's **role** applies its bundled permissions; a user has exactly one role. _(Amended by ADR-012: "per-user permissions without tags" is removed with R-15 — bespoke access = a dedicated role.)_ | Must |
| R-22 | Effective permissions = **the user's role's apps** (or all apps if the role is the Admin superuser). Provenance is simply the role — there is no multi-source union to attribute. _(Amended by ADR-012: the `effective_app_grants` view and per-source provenance are gone; computed by `effectiveAppsForUser`.)_ | Should |

### Plex library self-service (Phase 3)

| ID | Requirement | Priority |
|----|-------------|----------|
| R-25 | Users can add/remove Plex libraries on their own account, per server, across all three servers (k8plex, plexops, legacy haynestower), within the set an admin allows them. | Must |
| R-26 | Default allowed set = all libraries except `HNet Home Videos` and `HNet Photos`; those are visible/addable only to Family users. | Must |
| R-27 | Admins can set per-user (or per-tag) allowed-library sets and designate Family. | Must |
| R-28 | Library changes are applied through the Plex sharing API using each server's owner token (1Password) and are audit-logged. | Must |
| R-30 | Follow-on: sync app permissions into Authentik via its API once Authentik-side enforcement is wanted. | Later |

### Media ledger & fix (Phase 2)

| ID | Requirement | Priority |
|----|-------------|----------|
| R-40 | The app maintains a ledger synced FROM Sonarr, Radarr, and Lidarr (they are the source of truth): all monitored media, on-disk state, quality profile, root folder, and *arr tags per item. | Must |
| R-41 | The ledger records history: who requested what (attributed via Seerr API), what was deleted when, grabs/imports (from *arr history). Maintainerr integration is a follow-on once it's in k8s. | Must |
| R-42 | Wanted-but-not-on-disk items are captured and browsable. | Must |
| R-43 | Users can search/browse the ledger and trigger **Fix** on an item they believe is broken. | Must |
| R-44 | Fix = mark the offending release failed in the *arr (blocklisting it) + trigger a new search; falls back to delete-file + search when no grab history exists. | Must |
| R-45 | Every Fix requires a reason from a taxonomy (e.g. won't play / corrupt, wrong language, wrong version or quality, missing subtitles, wrong content entirely) or "Other" + free text. Reasons are stored for analysis. | Must |
| R-46 | Fix requests are tracked (requester, item, reason, *arr actions taken, outcome) and visible to admins; users see their own fix history and status. | Must |
| R-47 | Rate/abuse guard: sensible per-user limits on fix actions (admin-configurable later). | Should |

> **Note (2026-07-05) — library browse & fix-history UX (R-43/R-46):** the `/library` page presents
> browse as **Movies · TV · Music** sub-tabs (default Movies, no "All"), each scoping the search to
> that one category (movies→Radarr, TV→Sonarr, music→Lidarr). A fourth **My Fixes** sub-tab hosts
> the caller's own fix/force-search history (R-46) — **relocated out of the account/user menu** into
> Library; the old `/my-fixes` route redirects to `/library?tab=my-fixes`. See DESIGN-005 D-15/D-17
> and DESIGN-004 D-08. No change to the requirements themselves — this records how they are surfaced.

> **Note (2026-07-06) — subtitle Fix routes to Bazarr (R-44/R-45):** the Fix reason
> `missing_subtitles` does **not** take the R-44 mark-failed/blocklist or delete-file path and does
> **not** trigger an *arr re-grab — the media file is untouched. Instead it triggers a **Bazarr**
> subtitle search for the movie (Radarr) / episode (Sonarr). Because Bazarr covers movies/TV only,
> the reason is **not offered for Music** (Lidarr). No change to the requirements themselves — see
> ADR-016 / DESIGN-005 D-19.

### Failsafe restore (Phase 2)

| ID | Requirement | Priority |
|----|-------------|----------|
| R-50 | Admin can diff the ledger against a live Sonarr/Radarr/Lidarr instance and see what's missing. | Must |
| R-51 | Admin can re-add missing items to the matching *arr (monitored, with recorded quality profile/root folder/tags) to recover a lost DB or bootstrap a fresh server. | Must |
| R-52 | Restore is explicitly admin-initiated, previewed before execution, and audit-logged. Sync direction is otherwise strictly *arr → app. | Must |

### Platform & non-functional

| ID | Requirement | Priority |
|----|-------------|----------|
| R-60 | Responsive in browsers on phones, tablets, and PCs (viewport-fit layout + phone-width breakpoints; Playwright resize matrix proves it). | Must |
| R-61 | Light/dark theme via demo-console's CSS-token system (`data-theme` on `<html>`), with localStorage persistence and `prefers-color-scheme` seeding; no raw hex outside `tokens.css`. | Must |
| R-62 | Postgres 16 (CNPG in-cluster); Drizzle ORM; migrations run as init container. Real Postgres in tests (embedded binary — no Docker locally). | Must |
| R-63 | Deployed from `ghcr.io/thaynes43/haynesnetwork` via haynes-ops Flux (bjw-s app-template, namespace `frontend`); secrets via External Secrets + 1Password. | Must |
| R-64 | Staged rollout: internal `haynesnetwork.haynesops.com` first; claim `haynesnetwork.com` + `www` (traefik-external + Cloudflare tunnel) after e2e passes against staging. | Must |
| R-65 | PR flow with required CI checks (lint-and-typecheck, test, build) after the bootstrap GATE A cutover; conventional commits + release-please; squash merges. | Must |
| R-66 | UI testing with Playwright, including the login flow (stub OIDC in CI) and per-role dashboard visibility. | Must |

## User stories

| ID | Story | Acceptance criteria |
|----|-------|---------------------|
| US-01 | As a user, I sign in with my Plex account (via Authentik) and land on my dashboard. | AC-01, AC-02 |
| US-02 | As the owner, my first login makes me Admin without any manual DB step. | AC-03 |
| US-03 | As a Member, I see Seerr and the Plex tiles by default and can open them. | AC-04 |
| US-04 | As an Admin, I give a user Immich and it appears on their dashboard without their re-login. _(Amended by ADR-012: done by assigning a **role** whose app set includes Immich — or adding Immich to their current role — not a per-user grant.)_ | AC-05 |
| US-05 | As an Admin, I create a **`Family` role** (Phase 3: family designation + family libraries) and assign a user; they can now add HNet Home Videos on any Plex server. _(Amended by ADR-012: "family" is an admin-created role, not a tag/flag; library gating lands in Phase 3, C-09.)_ | AC-06 |
| US-06 | As a Member, a movie won't play; I find it in the app, hit Fix, pick "won't play / corrupt", and the *arr blocklists that release and searches for another. | AC-07, AC-08 |
| US-07 | As an Admin, Radarr's DB is lost; I diff the ledger against the fresh instance and re-add everything monitored with correct profiles. | AC-09 |
| US-08 | As a user on my phone, the dashboard and fix flow are fully usable without horizontal scrolling. | AC-10 |

## Acceptance criteria

| ID | Criterion |
|----|-----------|
| AC-01 | Unauthenticated visit → single "Sign in" → Authentik → back, session established (7-day cookie). No password form exists. |
| AC-02 | First login creates a Member row; profile shows displayName/email from OIDC claims. |
| AC-03 | Login with an email on `BOOTSTRAP_ADMIN_EMAILS` yields role Admin and a `user_role_transitions` audit row with system initiator; repeat logins are no-ops. |
| AC-04 | A fresh Member's dashboard shows exactly the default-visible catalog entries; every dashboard href is a valid http(s) URL. _(Amended by ADR-013: relaxed from `https://*.haynesnetwork.com/*` — arbitrary normalized http(s) URLs are allowed.)_ |
| AC-05 | Admin assigns a role that includes the app → user's next dashboard query (or live refresh) includes the tile; changing to a role without it removes it; role assignment is audit-logged (`user_role_transitions`). _(Amended by ADR-012: role assignment, not a per-user grant/revoke.)_ |
| AC-06 | ~~Tag application yields the union of tag + direct permissions; removing the tag removes only tag-derived permissions.~~ **Superseded by ADR-012:** a user's effective apps are exactly their role's app set (no union); editing a role's apps changes every member's effective set immediately. |
| AC-07 | Fix on an item with grab history calls the *arr's history-failed endpoint (blocklist) then a search command; the fix record stores reason + actions + *arr responses. |
| AC-08 | Fix without grab history deletes the file(s) and triggers search; outcome recorded. |
| AC-09 | Restore preview lists exactly the ledger items absent from the target *arr; execution re-adds them monitored with stored quality profile, root folder, and tags; report shows successes/failures. |
| AC-10 | Playwright resize matrix passes at 375×667, 390×844, 412×915, 768×1024, 820×1180, 1280×800, 1920×1080, 2560×1440: no page-level scrollbars, no off-screen controls, panes scroll internally. |

## Phasing

| Phase | Scope |
|-------|-------|
| 1 | R-01..R-15, R-20..R-22, R-60..R-66 — auth, dashboard, admin permissions, roles (tags→roles per ADR-012), deploy to staging. |
| 2 | R-40..R-52 — *arr ledger, fix with reasons, Seerr attribution, failsafe restore. |
| 3 | R-25..R-28 — Plex library self-service + family libraries. |
| Later | R-30 Authentik permission sync; Maintainerr integration; root-domain cutover per R-64 gates on Phase 1 e2e. |

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Which email does Authentik emit for the owner (manofoz@ vs t.haynes43@)? | Mitigated: allowlist contains both; confirm on first real login. |
| Q-02 | Seerr cutover timing (owner migrating in parallel) — when does the tile URL flip? | Owner action; catalog edit when ready. |
| Q-03 | Do plexops/k8plex share library names with legacy Plex (affects per-server allowed-set UX)? | Partially resolved 2026-07-03: names differ (HAYNESOPS mirrors Movies/TV as `Movies`/`TV Shows` vs `HNet *`); registry keys on (server, library), mirror modeled explicitly — see docs/ops/002-plex-topology.md. |
| Q-04 | Maintainerr deployment timing (for deletion attribution enrichment). | Follow-on when it lands in k8s. |
| Q-05 | Per-user fix rate limits — fixed default or admin-configurable? | Default constant in Phase 2; revisit (R-47). |
