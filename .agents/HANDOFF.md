# HANDOFF — current build state

> The single resume point for agents. Update this in the same change as any milestone.
> Derive current state from this file's top; you should not have to reconcile anything.

- **Last updated:** 2026-07-06 (Fable 5 autonomous run, in progress)
- **Workflow mode:** PR flow (GATE A executed — see
  `.agents/plans/completed/001-gate-a-pr-cutover.md`).
  `main` is branch-protected: branch → PR → required checks `lint-and-typecheck`, `test`,
  `build` green → squash-merge. `e2e` advisory. Conventional-commit titles drive release-please.
- **Latest release: v0.8.1 (signed) — PLAN-004 library metadata + posters + filter engine
  (v0.8.0 feature + v0.8.1 resolution/rating fix; every release signed since v0.7.0).** Prior:
  **v0.7.0 — first *signed* release (PLAN-007: keyless cosign, Rekor-logged, in-run verified,
  `.sig` on GHCR; Kyverno dedicated Enforce policy live-validated).** Earlier
  today: **v0.5.0 (#47) — PLAN-002 Bazarr subtitle Fix (ADR-016), deployed to staging +
  live-validated 2026-07-06:** `missing_subtitles` fixes route to Bazarr's async
  `search-missing` (movie: per-movie; sonarr episode/season: series-level — no per-episode async
  action in Bazarr 1.5.6), rest at `search_triggered`, excluded from `completeFixRequests`;
  Music no longer offers the reason. Migration 0009; `BazarrClient`/`BazarrWriteClient` in
  `@hnet/arr`; `BAZARR_API_KEY` wired via the existing media-stack ExternalSecret.
- **The autonomous Fable 5 run (Mon 2026-07-06) is IN PROGRESS.** Entry prompt
  `.agents/KICKOFF.md`; queue in `.agents/plans/` (see `.agents/plans/README.md`). **Plans done
  so far today:** 002 ✓ (v0.5.0); 003 validated on v0.6.1 (one deferred live share-write, owner
  input pending); 004 ✓ (v0.8.0/v0.8.1); 007 ✓ (v0.7.0); 005 backend built (Fable review in
  progress, UX next); 006/008 pending.
  v0.4.0 recap: unified roles (ADR-012), arbitrary catalog URLs (ADR-013), two-step
  `ConfirmButton`, drag-drop catalog reorder, Library sub-tabs.
- **PLAN-007 (cosign image signing) COMPLETE** (`.agents/plans/completed/007-cosign-image-signing.md`).
  `release-please.yml` keyless-cosign-signs every published `haynesnetwork` image by digest and
  verifies it in-run (ADR-020); v0.7.0 is the first signed release. Admission is **enforced** by a
  **dedicated** Kyverno ClusterPolicy `verify-haynesnetwork-images` in `haynes-ops` (spec-level
  `validationFailureAction: Enforce`) — live-validated: signed admitted (probe + prod rollout),
  unsigned denied (pod + Deployment). **Gotcha of the day:** on Kyverno v1.18.1 a shared policy's
  server-defaulted spec-level `validationFailureAction: Audit` **overrides** a per-`verifyImages`
  entry `failureAction: Enforce`, so a nested rule admitted an unsigned image with only a warning —
  hence the dedicated Enforce policy. Full detail + validation evidence in **OPS-006**
  (`docs/ops/006-image-signing.md`).
- **PLAN-004 (library metadata + posters + filter engine) COMPLETE**
  (`.agents/plans/completed/004-library-metadata-enrichment.md`; shipped v0.8.0 + fix v0.8.1,
  live-validated on staging). The `media_metadata` harvest runs as a **6h CronJob — LIVE, first
  harvests already run**: *arr ratings/genres/runtime + real per-file resolution tiers
  (1080p×3385/2160p×2711 live), Tautulli watch-stats, cached poster thumbnails. Library renders
  those posters through an **authed poster proxy** (no hot-linking); zero/absent rating badges are
  suppressed. The **filter/table engine now lives in `@hnet/ui`** (ported from demo-console,
  mechanism-shared / look-per-app) — **PLAN-005 (Ledger) + PLAN-006 (Trash) reuse it**, and the
  **D-09 `ledger.search` sort/filter query contract is the shared substrate** those plans build on.

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
3. ~~**004 — Library metadata enrichment + posters + shared filter engine**~~ ✅ **DONE**
   (v0.8.0/v0.8.1, `completed/004-library-metadata-enrichment.md`; filter engine + D-09 search
   contract now in `@hnet/ui`, reused by 005/006).
4. **005 — Ledger section** (native restore via filter→*arr + export; imports
   `radarr-fileless-backlog.md`) — **backend built; Fable review in progress, UX next**.
5. **006 — Trash section** (integrates the Maintainerr instance; replaces the Restore nav).
6. ~~**007 — cosign signing**~~ ✅ **DONE** (v0.7.0, `completed/007-cosign-image-signing.md`);
   **008 — public cutover (LAST)**.
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
- **Kyverno cosign / image signing (PLAN-007 COMPLETE, both sides shipped):** `release-please.yml`
  **keyless-cosign-signs** every published `haynesnetwork` image by digest and verifies it in-run
  (ADR-020). Admission is now **enforced** in `haynes-ops` by a **dedicated** ClusterPolicy
  `verify-haynesnetwork-images` (spec-level `validationFailureAction: Enforce`) — *not* a rule on
  the shared `verify-thaynes43-images` policy (that stays Audit for upgrade-agent/shepherd),
  because a shared policy's server-defaulted spec-level `Audit` overrode a per-entry
  `failureAction: Enforce` on Kyverno v1.18.1. Rollbacks must target **signed** tags (v0.7.0+);
  pre-signing tags (≤v0.6.1) are now denied. Break-glass + full validation evidence in **OPS-006**
  (`docs/ops/006-image-signing.md`).

## History

Bootstrap → v0.3.1 wave-by-wave build log (waves 1–11) + full historical gotcha list:
`.agents/context/2026-07-04-waves-1-11-archive.md`. Kickoff decisions of record:
`.agents/context/2026-07-03-kickoff.md`.
