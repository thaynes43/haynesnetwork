# HANDOFF — current build state

> The single resume point for agents. Update this in the same change as any milestone.
> Derive current state from this file's top; you should not have to reconcile anything.

- **Last updated:** 2026-07-04
- **Workflow mode:** PR flow (GATE A executed — see `.agents/plans/001-gate-a-pr-cutover.md`).
  `main` is branch-protected: branch → PR → required checks `lint-and-typecheck`, `test`,
  `build` green → squash-merge. `e2e` advisory. Conventional-commit titles drive release-please.
- **Latest release:** v0.3.1.

## Current state

- **Phase 1 + Phase 2 COMPLETE and DEPLOYED.** Phase 2 = media ledger + fix / force-search /
  restore + *arr→ledger sync, all shipped through v0.3.1.
- **Sync CronJobs + ExternalSecret media keys are LIVE since v0.2.0** (sync-incremental every
  15 min, sync-full 04:30) — confirmed in the haynes-ops `externalsecret.yaml` + `helmrelease.yaml`.
- **Live staging:** https://haynesnetwork.haynesops.com (traefik-internal).
- **Root-domain cutover** (staging → public root + www) is still PENDING Phase-1 e2e (R-64) —
  a manifest swap in haynes-ops; see `docs/ops/005-root-domain-cutover.md`.

## Genuinely next

1. **Bug-fix / UX-smoothing pass** now underway (the v0.2.x–v0.3.x fix stream continues:
   dialog layout, action consistency, search behaviour — driven by owner testing on staging).
2. **Phase 3 — Plex library self-service (BC-04)**: entirely UNBUILT. No `plex_*` tables, no
   Plex domain code; glossary T-17..T-21 are placeholders. Three Plex servers to support
   (k8plex, plexops, legacy haynestower).
3. DESIGN-006 (visual identity) is SHIPPED — being flipped Draft → Accepted in this change.

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
  (`kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`, currently v0.3.1).
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
