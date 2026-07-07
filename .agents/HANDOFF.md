# HANDOFF — current build state

> The single resume point for agents. Update this in the same change as any milestone.
> Derive current state from this file's top; you should not have to reconcile anything.

- **Last updated:** 2026-07-07 (Fable 5 autonomous run, in progress)
- **Workflow mode:** PR flow (GATE A executed — see
  `.agents/plans/completed/001-gate-a-pr-cutover.md`).
  `main` is branch-protected: branch → PR → required checks `lint-and-typecheck`, `test`,
  `build` green → squash-merge. `e2e` advisory. Conventional-commit titles drive release-please.
- **Latest release: v0.11.2 (signed) — PLAN-006 Trash section: Maintainerr-backed deletion UI +
  fine-grained Section/Action role permissions (ADR-023/DESIGN-010; migration 0016). v0.11.0
  feature + fixes v0.11.1 (trash rule arm/disarm round-trip; pending list reflects live
  exclusions) and v0.11.2 (rules PUT carries server selection + normalized dataType — no
  crucial-change wipes). Live-validated on staging with the owner-required non-deleting test
  rule (18 junk candidates, 60-day horizon, dnd tag-exclusions).** Prior: **v0.10.0 (signed) —
  ADR-024 role-scoped all-libraries Plex self-service:
  a role can grant all-libraries-on-a-server; users self-toggle All ↔ specific (leaving All is
  lossless, seeded with the current full set); no silent demotion (per-library ops throw
  PLEX_ALL_STATE in the All state); Migration 0015.** Prior: **v0.9.0 (signed) — PLAN-005 Ledger
  section: section-level role permissions
  (Edit/Read-Only/Disabled), bulk monitor-and-search, and emergency JSONL export (ADR-021/022);
  live-validated on staging.** Prior: **v0.8.1 (signed) — PLAN-004 library metadata + posters +
  filter engine (v0.8.0 feature + v0.8.1 resolution/rating fix; every release signed since
  v0.7.0).** Prior: **v0.7.0 — first *signed* release (PLAN-007: keyless cosign, Rekor-logged,
  in-run verified, `.sig` on GHCR; Kyverno dedicated Enforce policy live-validated).** Earlier
  today: **v0.5.0 (#47) — PLAN-002 Bazarr subtitle Fix (ADR-016), deployed to staging +
  live-validated 2026-07-06:** `missing_subtitles` fixes route to Bazarr's async
  `search-missing` (movie: per-movie; sonarr episode/season: series-level — no per-episode async
  action in Bazarr 1.5.6), rest at `search_triggered`, excluded from `completeFixRequests`;
  Music no longer offers the reason. Migration 0009; `BazarrClient`/`BazarrWriteClient` in
  `@hnet/arr`; `BAZARR_API_KEY` wired via the existing media-stack ExternalSecret.
- **The autonomous Fable 5 run is IN PROGRESS.** Entry prompt
  `.agents/KICKOFF.md`; queue in `.agents/plans/` (see `.agents/plans/README.md`). **Plans done
  so far:** 002 ✓ (v0.5.0); 003 ✓ (v0.6.0 + fix v0.6.1); 004 ✓ (v0.8.0/v0.8.1); 005 ✓
  (v0.9.0); 006 ✓ (v0.11.0 + fixes v0.11.1/v0.11.2); 007 ✓ (v0.7.0); ADR-024 ✓ (v0.10.0,
  follow-on to 003). **In flight:** 012 (Trash curation pipeline) — backend reviewed + fixed,
  poster-wall UX in progress; 011 (Authentik hardening) — branding mocks awaiting the owner's
  pick; 015 (downstream *arr action feedback) — authored, not yet built.
  **Queue extended per owner (plans 011–015 authored):** 012 (Trash
  curation pipeline: batches → poster review → Leaving Soon → windowed deletion) → 011 (Authentik
  MFA-for-native-accounts + haynesnetwork sign-in rebrand) → 009 → 010 → 008 (public cutover) →
  then post-cutover: 013 (disk/reclaim metrics) → 014 (rules tuning + space policy).
  v0.4.0 recap: unified roles (ADR-012), arbitrary catalog URLs (ADR-013), two-step
  `ConfirmButton`, drag-drop catalog reorder, Library sub-tabs.
- **PLAN-006 (Trash section) COMPLETE — shipped v0.11.0 + fixes v0.11.1/v0.11.2, live-validated
  on staging** (`.agents/plans/completed/006-trash-section.md`). Maintainerr-backed deletion UI
  wrapping the live `maintainerr.media.svc.cluster.local` instance behind a friendly `/trash`
  section: pending Movies/TV tables over the shared filter engine + reclaim footer, Save shield
  (save/unsave with real `dnd` *arr tagging round-trip), Expedite modals (cancel-only in
  validation + the filters-can't-scope-expedite-all refusal), the Rules list with wipe-free
  arm/disarm, the `/library/[id]` protect-in-context guard, `/admin/roles` Section/Action grid,
  and the webhook → **Activity** feed. ADR-023 + DESIGN-010; migration 0016. The preflight
  `auditMaintainerr` recorded **SAFE** before any destructive surface was enabled; three
  adversarial review passes closed every destructive-surface finding (estate-wide collection
  handle never used, live exclusions always consulted, snapshots pinned, in-band failures fail
  closed). **Operational notes:** (1) Maintainerr's memory limit was raised to **2Gi** in
  haynes-ops so rule evaluation doesn't OOM. (2) The Maintainerr **webhook notification agent**
  is configured with the **Bearer-secret** form (`MAINTAINERR_WEBHOOK_SECRET`) — the receiver
  contract for `POST /api/webhooks/maintainerr` is documented in the **DESIGN-010 D-07** runbook.
  (3) The owner-required **non-deleting test rule** is armed with a **60-day** `deleteAfterDays`
  horizon (18 junk candidates) — **PLAN-012's curation gate must land, or the owner must rearm,
  before that horizon elapses** so nothing reaches its delete date unattended.
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

- **ADR-024 all-libraries Plex self-service SHIPPED (v0.10.0)** — a role can grant
  all-libraries-on-a-server; users self-toggle All ↔ specific (leaving All is lossless, seeded
  with the current full set); no silent demotion (per-library ops throw `PLEX_ALL_STATE` in the
  All state). Migration 0015. **Open live-validation:** the ENTER-All plex.tv API key
  (`all_libraries:true`) is inferred, not verified — needs a supervised real-write test with a
  revert path (leave-All is verified; the KAH517 demote cycle proved the explicit-list PUT).
  KAH517 is currently in the post-003-test demoted explicit 3-lib state and would be restored to
  All by that validation.
- **PLAN-005 (Ledger section) COMPLETE — shipped v0.9.0, live-validated**
  (`.agents/plans/completed/005-ledger-section.md`). ADR-021 section-level role permissions
  (`role_section_permissions`, session-carried levels, `sectionProcedure`) — the **base
  Section-Permission model PLAN-006 (Trash) extends**; ADR-022 `executeArrAdd` **generalizes
  `executeRestore`** (add / monitor-flip / skip + best-effort search, same-tx `restored` +
  `search_requested` ledger events, 1000 cap); `ledgerAdmin` browse/bulkAddAndSearch/run/runs;
  streaming JSONL `/api/ledger/export`. UX: the `/ledger` top-level section (topbar gated on the
  session's ledger level; Disabled → clean "not available" page), Movies/TV/Music frozen-pane
  spreadsheet, `?mon`/`?file` chips, sortable Title/Rating/Added headers, actions bar
  (Export filtered · Monitor & search), ADR-014 Modal confirm → per-item run report,
  `/admin/roles` Ledger access select (Admin implicit Edit). **Live evidence:** two-item
  monitor-and-search landed monitored + MoviesSearch in the real Radarr (API-verified), 600-row
  JSONL export byte-exact vs DB, read_only/disabled gating enforced server-side with audited
  flips. **Fileless import dropped** on live evidence (all 4,008 backlog ids were already live
  unmonitored rows) → reframed to filter + bulk monitor-and-search (ADR-022 C-04). **Process
  note:** an adversarial pre-ship review found + fixed one confirmed defect before ship.
  As-built record: DESIGN-009 D-01/D-08.
- **PLAN-003 (Plex library self-service, Phase 3) COMPLETE — shipped v0.6.0 + fix v0.6.1, fully
  live-validated** (`.agents/plans/completed/003-plex-library-self-service.md`). ADR-017 Plex
  sharing + role-library-grant model (family = a role grant, not a flag), migration 0010; registry
  refresh across all three servers (k8plex/plexops/legacy haynestower — family libraries
  populated) plus role grants + member isolation with same-tx `plex_share_audit` audited flips.
  **Q-06 RESOLVED:** the real plex.tv share cycle ran against production on an owner-designated
  friend account (**KAH517**, owner-sanctioned allLibraries demotion) — remove + re-add with
  read-merge-write preserving every other shared library, `plex_share_audit` trail written in the
  same transaction, ConfirmButton two-step against production. The invite / friend-account
  *creation* flow stays **out of scope**. **Follow-on:** the owner-directed (2026-07-06)
  role-scoped all-libraries self-service model shipped **separately as ADR-024 (v0.10.0)** — see
  the ADR-024 bullet at the top of Current state (open enter-All live-validation).
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
2. ~~**003 — Plex library self-service (BC-04, Phase 3)**~~ ✅ **DONE** (v0.6.0 + fix v0.6.1,
   `completed/003-plex-library-self-service.md`; ADR-017 Plex sharing + role-library-grant model,
   family = a role grant; the real plex.tv share cycle live-validated against production, Q-06
   resolved). **Follow-on:** ADR-024 role-scoped all-libraries self-service ✅ **SHIPPED** (v0.10.0;
   open enter-All live-validation — see Current state).
3. ~~**004 — Library metadata enrichment + posters + shared filter engine**~~ ✅ **DONE**
   (v0.8.0/v0.8.1, `completed/004-library-metadata-enrichment.md`; filter engine + D-09 search
   contract now in `@hnet/ui`, reused by 005/006).
4. ~~**005 — Ledger section**~~ ✅ **DONE** (v0.9.0, `completed/005-ledger-section.md`; native
   restore via filter→*arr + JSONL export; fileless import dropped per ADR-022 C-04).
5. ~~**006 — Trash section**~~ ✅ **DONE** (v0.11.0 + fixes v0.11.1/v0.11.2,
   `completed/006-trash-section.md`; integrates the live Maintainerr instance, replaces the
   Restore nav, reuses the ADR-021 Section-Permission base 005 shipped). Live-validated with the
   owner-required NON-DELETING test rule (18 candidates, 60-day `deleteAfterDays`, `dnd` tag
   settings) whose collections seed plan 012.
6. **012 — Trash curation pipeline** (`012-trash-curation-pipeline.md`, owner vision 2026-07-06)
   — **NEXT UP;** backend reviewed + fixed, poster-wall UX in progress: batches
   (`draft → admin_review → leaving_soon → deleted|cancelled`) → admin
   poster-grid review (X ⇄ lock) → green-light → "Leaving Soon" Plex collection + role-gated
   user save window → per-item guardian-checked expiry deletion; every save/unsave durably
   recorded as rules-tuning data; deletion snapshots recorded for 013.
7. **011 — Authentik hardening** (`011-authentik-hardening.md`, owner-scoped 2026-07-06): MFA
   for NATIVE Authentik accounts only (Plex-source logins exempt; `mfa-exempt` group keeps the
   `hnet-e2e` accounts automating) + rebrand the login as "haynesnetwork sign-in" (owner picks
   from 2–3 screenshot mocks). App-by-app SSO verification = owner task in 008's HARD GATE.
8. **Stretch (owner ideas):** 009 **Bulletin** (aggregated notification Feed + user Messages
   board), 010 **MOTD** dashboard banner — slotted after 011, before the 008 cutover; 010 is
   small enough to pull forward as a quick win.
9. ~~**007 — cosign signing**~~ ✅ **DONE** (v0.7.0, `completed/007-cosign-image-signing.md`).
10. **008 — public cutover** (LAST of the pre-cutover queue; HARD GATE incl. the owner's
    app-by-app SSO check from 011).
11. **Post-cutover (banked, owner 2026-07-06):** **013 — disk utilization + reclaim metrics**
    (`013-disk-and-reclaim-metrics.md`; consumes 012's deletion snapshots; core open decision:
    Grafana embed vs native — owner decides) → **014 — rules tuning + space policy**
    (`014-rules-tuning-space-policy.md`; save-data + metrics → tune rules toward the space
    target; skip-admin-gate graduation criteria).

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
- **PLAN-015 authored (owner backlog 2026-07-07):** live downstream-*arr **action feedback** — Fix/
  Force-Search buttons must report status back (wire-ack "searching" → download progress → complete /
  nothing_found / stalled; roll-ups cascade per-child). Design = a **read-only, poll-on-demand** tRPC
  progress query over the *arrs' `/queue` + recent history, **derived** phases (no `FIX_STATUSES`
  growth, no new table), **no server-side poller v1**. The one-open-fix lock already exists server-side
  (`FixAlreadyOpenError`) — v1 just surfaces it in the UI. New: `@hnet/arr` `getQueue` read client +
  stub `/queue` route. See `.agents/plans/015-arr-action-feedback.md` (Draft; ADR/DESIGN/R/T numbers
  are next-free placeholders — re-grep after 012/011/009/010 land).

## History

Bootstrap → v0.3.1 wave-by-wave build log (waves 1–11) + full historical gotcha list:
`.agents/context/2026-07-04-waves-1-11-archive.md`. Kickoff decisions of record:
`.agents/context/2026-07-03-kickoff.md`.
