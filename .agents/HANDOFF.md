# HANDOFF — current build state

> The single resume point for agents. Update this in the same change as any milestone.
> Derive current state from this file's top; you should not have to reconcile anything.

- **Last updated:** 2026-07-06 (Fable 5 autonomous run, in progress)
- **Workflow mode:** PR flow (GATE A executed — see
  `.agents/plans/completed/001-gate-a-pr-cutover.md`).
  `main` is branch-protected: branch → PR → required checks `lint-and-typecheck`, `test`,
  `build` green → squash-merge. `e2e` advisory. Conventional-commit titles drive release-please.
- **Latest release: v0.5.0 (#47) — PLAN-002 Bazarr subtitle Fix (ADR-016), deployed to staging
  + live-validated 2026-07-06.** `missing_subtitles` fixes route to Bazarr's async
  `search-missing` (movie: per-movie; sonarr episode/season: series-level — no per-episode async
  action in Bazarr 1.5.6), rest at `search_triggered`, excluded from `completeFixRequests`;
  Music no longer offers the reason. Migration 0009; `BazarrClient`/`BazarrWriteClient` in
  `@hnet/arr`; `BAZARR_API_KEY` wired via the existing media-stack ExternalSecret.
- **The autonomous Fable 5 run (Mon 2026-07-06) is IN PROGRESS.** Entry prompt
  `.agents/KICKOFF.md`; queue in `.agents/plans/` (see `.agents/plans/README.md`). 002 is
  complete; 003 (Plex self-service) is being built on `feat/plex-library-self-service`.
  v0.4.0 recap: unified roles (ADR-012), arbitrary catalog URLs (ADR-013), two-step
  `ConfirmButton`, drag-drop catalog reorder, Library sub-tabs.

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

1. ~~**002 — Bazarr subtitle Fix**~~ ✅ **DONE** (v0.5.0, `completed/002-bazarr-subtitle-fix.md`).
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

- **Learned during the 2026-07-06 run:** (1) The 1Password `AUTHENTIK_BOOTSTRAP_PASSWORD` is
  STALE — it authenticates no Authentik user (akadmin unchanged since 2024-10). Live staging
  validation logs in as the dedicated local Authentik member **`hnet-e2e`** (created via
  `ak shell` in the authentik-server pod; Default-role member in the app). (2) Bot-authored
  release-please PRs sit in an `action_required` CI gate — an admin must re-run the gated
  workflow run before the required checks report and the release PR can merge. (3) The `57P01`
  embedded-PG teardown flake also hits `packages/sync` (`incremental-sync.test.ts`), not just
  `packages/auth`. (4) Live-validation UX finding: at 390px the header wordmark collides with
  the "Home" nav link — fix during plan 004's UI pass.

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
- **overseerr.haynesnetwork.com** catalog tile still points at the legacy Unraid URL — an
  owner-driven one-field admin edit to flip. The owner's *arr/Seerr stack **has migrated
  in-cluster**: Seerr + Sonarr/Radarr/Lidarr are reachable at `*.media.svc.cluster.local` (the
  plans call these directly); legacy HaynesTower (Unraid) stays up as a NAS only. Catalog links
  are DB data.
- **Three Plex servers, 1Password key collision:** the `plexops` item's Plex key is *also*
  named `HAYNESKUBE_PLEX_API_KEY` — do not confuse it with the `homepage` item's key of the
  same name (see the haynes-ops `frontend/homepage/app/externalsecret.yaml` comment).
- **Kyverno cosign** policy for `ghcr.io/thaynes43/*` is AUDIT-mode — plan a signing step
  before enforcement expands.

## History

Bootstrap → v0.3.1 wave-by-wave build log (waves 1–11) + full historical gotcha list:
`.agents/context/2026-07-04-waves-1-11-archive.md`. Kickoff decisions of record:
`.agents/context/2026-07-03-kickoff.md`.
