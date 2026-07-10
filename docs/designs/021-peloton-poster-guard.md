# DESIGN-021: Peloton poster guard

- **Status:** Accepted
- **Last updated:** 2026-07-10
- **Satisfies:** PRD-001 R-137, R-138, R-139, R-140; governed by ADR-043 (and ADR-017 write confinement,
  ADR-038 direct-Plex reads, ADR-040/DESIGN-020 sync-mode shape)

## Overview

A new `poster-guard` sync mode restores the owner's durable Peloton override posters on k8plex whenever
they drift (a `peloton-config-manager` re-download or Plex re-scan reverts them). The override PNGs are
baked into the image; the mode reads the live library, re-applies **only** drifted targets via a new
confined Plex write, and appends an audit/baseline row per re-apply. It ships alongside a one-time restore
(PLAN-024 Part A) that seeded every current show/season.

## Detailed design

### D-01 — Durable assets in the image (ADR-043 C-01)
`packages/sync/assets/peloton-posters/*.png` — 23 PNGs (13 series + 5/10/15/20/30/45/60/90/120-minute +
the unused `60+-minutes.png`, kept versioned). Filenames normalized from the owner's source
(`60-minuites-02.png`→`60-minutes.png`, `90-minuites.png`→`90-minutes.png`). No `files` field on
`@hnet/sync`, so `pnpm --filter @hnet/sync deploy` packs the dir into `/sync/assets/…` in the image.

### D-02 — Mapping resolves by live title/index (ADR-043 C-02)
`PELOTON_POSTER_MAPPING` (`@hnet/sync peloton-poster-map.ts`): `series: Record<showTitle, file>` +
`duration: Record<seasonIndex, file>`. Seeded from the Part-A inventory (12 shows; indices
5/10/15/20/30/45/60/90/120). **Index 60 → the clean `60-minutes.png`** ("60 MINUTES") because the library
uses a distinct Season 60 alongside 75/90/120 — the "60+ MINUTES" bucket art does not apply. Indices with
no asset (`0` Specials, `75`) are **absent** → reported unmapped, never guessed. `Outdoor` is pre-mapped
(asset exists) in case that class type appears. `createFilePosterAssetSource` loads a file + its sha256,
with a per-process cache and a path-traversal guard; a missing file → `null` (reported, non-fatal).

### D-03 — The confined poster write (ADR-043 C-07, ADR-017 C-10)
`PlexWriteClient.uploadPoster({ ratingKey, body })` → `POST {baseUrl}/library/metadata/{ratingKey}/posters`
with the raw PNG bytes (token header-only, never the URL). Adds a `rawBody: Uint8Array` path to
`PlexHttp` (verbatim body, no `JSON.stringify`). The write client now stores `baseUrl` (the upload targets
the PMS itself, not plex.tv). Import-confined to `packages/domain` (arr-write-import-guard extended — the
literal module path never appears outside the allowed dirs).

### D-04 — Append-only apply ledger (ADR-043 C-05) — migration 0034
`poster_guard_applications` (guard-listed, `@hnet/domain` sole writer): `id`, `run_id` (per-run
correlation uuid — **no `sync_runs` row**, smart-alerts precedent), `rating_key`, `target_kind`
(`show`|`season`, CHECK), `show_title`, `season_index` (null for shows), `asset_name`, `asset_sha256`,
`reason` (`initial`|`drift`|`asset-updated`, CHECK), `previous_thumb` (nullable), `applied_thumb`
(nullable — the post-upload thumb, the next run's baseline), `created_at`. Index `(rating_key, created_at
DESC)` — drift detection reads the newest row per target. `SYNC_RUN_KINDS += 'poster-guard'` (CHECK rebuild,
parity-only, so the CLI `--mode` parser accepts it).

### D-05 — The guard flow (`runPelotonPosterGuard`, `@hnet/domain poster-guard.ts`)
1. Resolve the Peloton section by title (`/peloton/i`); absent ⇒ `found:false`, no writes.
2. `listSectionContents` → shows; per show `listMetadataChildren` → seasons. Build targets (map by
   title/index); collect `unmapped`.
3. Load the newest ledger row per target ratingKey (one `inArray` select, reduced to first-per-key).
4. **`decidePosterAction`** (pure, unit-tested): no prior row → `initial`; asset name/sha changed →
   `asset-updated`; live thumb ≠ recorded `applied_thumb` → `drift`; else `null` (in sync, skip).
5. For each drifted target: `uploadPoster` (outside the tx), read back the new thumb, then **insert** the
   ledger row same-tx (`inTransaction`). Returns `PosterGuardReport { found, sectionKey, runId, checked,
   inSync, reapplied[], unmapped[], missingAssets[] }`.

### D-06 — Sync wiring (`@hnet/sync`)
`orchestrator.ts` gains a `mode === 'poster-guard'` early-return block (mirrors smart-alerts): it takes an
opaque `PlexClientBundle` (built in `@hnet/domain plexClientBundleFromEnv`, so the confined write surface
stays domain-only), the image asset source, and `PELOTON_POSTER_MAPPING`. `scripts/sync.ts` accepts
`--mode=poster-guard` (no `--source`), builds the bundle (needs `PLEX_HAYNESKUBE_TOKEN`), and logs the
report. `RunSyncOptions.plex` + `SyncReport.posterGuard`/`posterGuardError` added.

### D-07 — Deploy (haynes-ops, OPS-010)
One CronJob `sync-poster-guard` in the haynesnetwork HelmRelease, mirroring `sync-smart-alerts`
(`command: [tsx, /sync/src/scripts/sync.ts, --mode=poster-guard]`, `envFrom: haynesnetwork-secret`,
`concurrencyPolicy: Forbid`). Schedule `37 * * * *` (hourly, off-phase from the other sync jobs). The
first run has no baseline ⇒ re-applies all mapped targets once (idempotent); steady state is drift-gated.

## Alternatives considered

- **DB `bytea` assets table (owner lean) / NFS share** — rejected in ADR-043 (bytea anti-pattern; NFS
  coupling + no review). The asset source is a one-file seam if that changes later.
- **A `sync_runs`-bracketed run** — rejected: `sync_runs.source` is the *arr-source enum with no
  system/plex value; the append-only ledger is the audit trail (smart-alerts precedent).
- **Serve the override through the app proxy instead of writing Plex** — rejected: the owner wants the art
  fixed **on the server** (native Plex clients, not just this app, see it). The ADR-041 proxy already
  self-invalidates once the server art changes.

## Test strategy

- Unit: `decidePosterAction` (initial/asset-updated×2/drift/in-sync); `uploadPoster` (URL/host/Content-Type/
  header-only token); mapping (every mapped file exists on disk, index-60 = clean art, 0/75 absent, loader
  + traversal guard).
- Embedded-Postgres (`@hnet/domain`): initial run applies+records; a no-drift re-run is a no-op; an
  external thumb overwrite is detected + restored as `drift`; a PNG-bytes swap re-applies as `asset-updated`;
  a missing mapped asset is reported not fatal; an absent library degrades to `found:false`.
- e2e stub: `stub-plex.ts` records `POST …/posters` so a guard integration proves the write surface.
- LIVE (PLAN-024 Part B): reset one season to a prior gallery image, run once, assert drift detected +
  asset restored + a `poster_guard_applications` `drift` row exists.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Durable asset home — DB vs git-in-image vs NFS? | **Resolved (ADR-043):** git-in-image + DB ledger; diverged from the owner's DB-bytea lean (flagged for review). |
| Q-02 | Should the app also serve the override in-proxy (belt-and-braces) before the guard runs? | Deferred — restoring on the server is sufficient; the ADR-041 C-07 seam remains available if wanted later. |
