# HANDOFF — current build state

> The single resume point for agents. Update this in the same change as any milestone.
> Derive current state from this file's top; you should not have to reconcile anything.

- **Last updated:** 2026-07-05
- **Workflow mode:** PR flow (GATE A executed — see
  `.agents/plans/completed/001-gate-a-pr-cutover.md`).
  `main` is branch-protected: branch → PR → required checks `lint-and-typecheck`, `test`,
  `build` green → squash-merge. `e2e` advisory. Conventional-commit titles drive release-please.
- **Latest release:** v0.4.0 (#36) — unified roles (ADR-012), arbitrary catalog URLs (ADR-013),
  inline two-step `ConfirmButton` + drag-drop catalog reorder, Library sub-tabs, settings-only
  user menu. All the UX-backlog items in `context/2026-07-05-ux-backlog.md` are DONE.
- **NEXT: an autonomous Fable 5 build run (Mon 2026-07-06).** The entry prompt is
  `.agents/KICKOFF.md`; the release queue is `.agents/plans/` (see `.agents/plans/README.md`).
  Plans 002–008 cover Bazarr subtitle Fix, Plex self-service (Phase 3), metadata enrichment,
  the Ledger + Trash sections, cosign, and the public cutover.

## Current state

- **Unified Role model (ADR-012) SHIPPED — code complete, all tests pass, docs updated.**
  One role per user (`users.role_id`), roles-only (no per-user grants/tags/family flag);
  two seeded system roles — **Admin** (superuser, implicit all-apps, immutable) and
  **Default** (new-user role, editable app set). Migration
  **0007_unified_roles** is a clean cut (drops the Member/Admin enum, tags, `user_app_grants`,
  `is_family`, `default_visible`, the `effective_app_grants` view). `/admin/roles` replaces
  `/admin/tags`; `users.setRole` replaces grant/revoke/setFamily; session carries
  `role = { id, name, isAdmin }`. **Shipped-after refinements (docs synced 2026-07-05):**
  (1) `roles.grants_all` "All apps" — a non-admin role grants every app incl. future ones,
  no `role_app_grants` rows; effective apps = all when `is_admin OR grants_all`; "All apps"
  checkbox on `/admin/roles`. (2) Default now seeds **seerr/plex/k8plex/plexops** (PlexOps
  added). (3) Migration 0007 seeds a **third, normal role `Family`** (editable/deletable) =
  every app except Tautulli. **Shipped in v0.4.0 (#36).**
- **Catalog URLs are now arbitrary (ADR-013) — shipped in v0.4.0.** R-14 is
  reversed: the catalog accepts **any well-formed, normalized `http(s)` URL** (including
  `*.haynesops.com` and external hosts) — no host allow-list. A shared `normalizeCatalogUrl`
  (authoritative in `packages/domain`, mirror in the web client) canonicalizes; the domain
  writer stores the canonical form. `ForbiddenHostError`→`InvalidCatalogUrlError` /
  `CATALOG_URL_INVALID`. DB CHECK relaxed to scheme-only `app_catalog_url_scheme`
  (migration 0008). Docs synced 2026-07-05.
- **Phase 1 + Phase 2 COMPLETE and DEPLOYED.** Phase 2 = media ledger + fix / force-search /
  restore + *arr→ledger sync, all shipped through v0.4.0.
- **Sync CronJobs + ExternalSecret media keys are LIVE since v0.2.0** (sync-incremental every
  15 min, sync-full 04:30) — confirmed in the haynes-ops `externalsecret.yaml` + `helmrelease.yaml`.
- **Live staging:** https://haynesnetwork.haynesops.com (traefik-internal).
- **Root-domain cutover** (staging → public root + www) is still PENDING Phase-1 e2e (R-64) —
  a manifest swap in haynes-ops; see `docs/ops/005-root-domain-cutover.md`.

## Genuinely next

The **Fable 5 autonomous run** works the release queue in `.agents/plans/` (start at
`.agents/KICKOFF.md`). In order:

1. **002 — Bazarr subtitle Fix**: route the "missing subtitles" Fix to Bazarr; drop that reason
   for Music.
2. **003 — Plex library self-service (BC-04, Phase 3)**: entirely UNBUILT (no `plex_*` tables, no
   Plex domain code; glossary T-17..T-21 are placeholders). Per-**role** allowed library sets
   across the three servers (k8plex, plexops, legacy haynestower); family libs = libraries granted
   only to the Family role.
3. **004 — Library metadata enrichment + posters + shared filter engine** (foundation for 005/006).
4. **005 — Ledger section** (native restore via filter→*arr + export; imports
   `radarr-fileless-backlog.md`).
5. **006 — Trash section** (integrates the Maintainerr instance; replaces the Restore nav).
6. **007 — cosign signing**; **008 — public cutover (LAST)**.
7. **Stretch (owner ideas, post-core):** 009 **Bulletin** (aggregated notification Feed +
   user Messages board), 010 **MOTD** dashboard banner — build only if time/budget remains
   after 002–008; 010 is small enough to pull forward as a quick win.

The full consolidated backlog (with what is deferred beyond this run) is in
`context/2026-07-05-backlog-recon.md`.

## Key gotchas / where to look

- **Orientation:** `docs/README.md` is the docs index. Per-package READMEs
  (`packages/{db,domain,sync,arr,api,ui}/README.md`, `apps/web/README.md`) orient by area;
  `packages/domain/README.md` is the canonical list of the invariants (single-writer,
  audit-in-same-tx, arr-write import confinement).
- **Local verify (no Docker):** `docs/ops/003-local-verification.md`. Merge gate = `pnpm lint`
  + `pnpm lint:css` + `pnpm typecheck` + `pnpm test` + `pnpm build`. Tests run embedded PG16 —
  never SQLite/MySQL; `@embedded-postgres/linux-x64` MUST stay in `pnpm-workspace.yaml`
  `allowBuilds` or the PG binary is non-functional. `pnpm dev:local` on :3000, e2e on :3100.
- **Deploy (manual):** `docs/ops/004-deploy-runbook.md`. There is NO Flux image automation —
  going live = MANUAL edit of the image tag in the SIBLING haynes-ops repo
  (`kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`, currently v0.4.0).
  Also holds the 1Password `haynesnetwork` secret contract.
- **overseerr.haynesnetwork.com** still routes to the legacy Unraid box; in-cluster Seerr is
  LAN-only pending the owner's parallel *arr/Seerr k8s migration. Catalog links are DB data.
- **Three Plex servers, 1Password key collision:** the `plexops` item's Plex key is *also*
  named `HAYNESKUBE_PLEX_API_KEY` — do not confuse it with the `homepage` item's key of the
  same name (see the haynes-ops `frontend/homepage/app/externalsecret.yaml` comment).
- **Kyverno cosign** policy for `ghcr.io/thaynes43/*` is AUDIT-mode — plan a signing step
  before enforcement expands.

## History

Bootstrap → v0.3.1 wave-by-wave build log (waves 1–11) + full historical gotcha list:
`.agents/context/2026-07-04-waves-1-11-archive.md`. Kickoff decisions of record:
`.agents/context/2026-07-03-kickoff.md`.
