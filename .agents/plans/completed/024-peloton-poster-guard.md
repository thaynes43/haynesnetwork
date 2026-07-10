# PLAN-024: Peloton poster guard (durable override art + drift-restore)

- **Status:** Completed (2026-07-10) — **shipped v0.36.0** (PR #175 → release PR #174; deployed via
  haynes-ops `d5ab51d0` — image bump + `sync-poster-guard` CronJob `37 * * * *`; Flux-reconciled;
  `haynesnetwork-main` on v0.36.0). **LIVE-validated on prod k8plex:** the guard's baseline run reported
  `found · checked 88 · reapplied 88 (initial) · unmapped 6 · missingAssets []`; an immediate re-run was
  idempotent (`inSync 88 · reapplied 0`); the **drift test** clobbered Bike Bootcamp S30 (rk 448161) with
  45-minutes.png and the guard restored the correct 30-minute art (byte-identical sha256) and wrote a
  `poster_guard_applications` **`drift`** row (previous_thumb = the clobber, applied_thumb = the restore);
  ledger histogram = **88 initial + 1 drift = 89**. Part A restored all 88 posters live earlier the same
  day. Answers PLAN-022 Q-01 / PRD Q-06 / ADR-038 C-09.
- **Satisfies:** PRD R-137..R-140; new ADR-043 (durable asset home + guard design), DESIGN-021, OPS-010;
  glossary T-124..T-125; migration 0034 (`poster_guard_applications` + `SYNC_RUN_KINDS += poster-guard`).
- **Depends on:** PLAN-022 (the direct-Plex read client + ytdl-sub surface) — landed. No plan blocks this.
- **IDs consumed (re-grepped at authoring):** ADR-043, DESIGN-021, OPS-010, PRD R-137..R-140, glossary
  T-124..T-125, migration 0034. (Ceilings before: ADR-042, DESIGN-020, OPS-009, R-136, T-123, migration 0033.)

## Part A — one-time restore (DONE, live)

Inventoried HOps Peloton (k8plex section key 4): **12 shows, 82 seasons**. Built the mapping (show title →
series poster; season index → `N-minutes.png`) and uploaded via `POST /library/metadata/{ratingKey}/posters`
(X-Plex-Token header). **88 posters applied + verified** (12 series + 76 season), every thumb-path change
confirmed; 0 failures.

- **60-vs-60+ decision:** the library uses a distinct **Season 60** alongside 75/90/120, so index 60 → the
  **clean "60 MINUTES"** art (`60-minuites-02.png` → normalized `60-minutes.png`), NOT the "60+ MINUTES"
  bucket art (`60+-minutes.png`, kept versioned but unused).
- **UNMAPPED (not touched, not guessed):** 6 seasons — **index 75** on Cycling/Running/Tread Bootcamp/Walking
  (no 75-minute asset) and **index 0 "Specials"** on Running/Strength (auto-created stray-episode seasons).
- **Unused asset:** `outdoor-poster.png` (no "Outdoor" show yet — pre-mapped for if it appears).
- **Proxy self-invalidation verified:** the served thumb is byte-identical (sha256) to the source PNG; the
  ADR-041 proxy transcode of the new thumb renders the new art (ETag keyed on the thumb path, which changed).

## Part B — the durable guard (built)

**ADR-043 decision — asset home:** the durable PNGs live **git-versioned in the app image**
(`packages/sync/assets/peloton-posters/`), the mapping is a checked-in TS file, and the **DB holds only an
append-only apply ledger** (drift baseline + audit). This **diverges from the owner's DB-`bytea` lean** —
see owner notes. 51 MB rules out ConfigMaps; DB-bytea collides with ADR-019/038/041 (no poster bytes in the
DB) and the "PLAN-004 stores poster bytes" premise is false (it stores string *references*); git-in-image is
durable + reviewed + already in the CronJob's image with zero new infra. The asset source is a one-file seam,
so a later move to DB/NFS is trivial.

**Vertical:**
- `@hnet/db`: `poster_guard_applications` (append-only, guard-listed) + `SYNC_RUN_KINDS += poster-guard`
  (migration 0034; CHECK-rebuild parity-only — no `sync_runs` row, like smart-alerts).
- `@hnet/plex`: `PlexWriteClient.uploadPoster` (confined write; raw-body `PlexHttp` path; token header-only).
- `@hnet/domain`: `runPelotonPosterGuard` single-writer (drift-detect via `decidePosterAction`, re-apply +
  same-tx ledger insert) + `poster-guard` guard-list entry.
- `@hnet/sync`: `PELOTON_POSTER_MAPPING` + `createFilePosterAssetSource`, the `poster-guard` orchestrator
  block + CLI wiring (builds the Plex bundle from `@hnet/domain`, so the confined write stays domain-only).
- e2e stub: `stub-plex.ts` records `POST …/posters`.

**Verification:** merge gate green (lint, lint:css, typecheck, test, build). Unit + embedded-Postgres tests
cover the pure decision, the write surface, the mapping/asset loader, and the full guard (initial / no-drift
no-op / drift-restore / asset-updated / missing-asset / library-absent). **LIVE (done):** baseline run
reapplied 88, re-run idempotent (0), drift test detected + restored one season (byte-identical) + wrote a
`drift` ledger row — see Status.

**Deploy (done):** haynes-ops `d5ab51d0` — image bump to v0.36.0 + one `sync-poster-guard` CronJob
(`37 * * * *`, mirrors `sync-smart-alerts`, `--mode=poster-guard`, `envFrom: haynesnetwork-secret`). No
other haynes-ops change. Flux-reconciled; rollout confirmed.

## Owner notes

- **Asset-home diverges from your DB-`bytea` lean** (you delegated the final call to the ADR). I chose
  git-in-image + a DB *ledger* because three accepted ADRs reject poster bytes in the DB, and the
  "PLAN-004 already stores poster bytes" basis was inaccurate (it stores references). If you'd still prefer
  the DB (or the NAS) as the byte home, it's a one-file change (`createFilePosterAssetSource` + one ADR) —
  say the word.
- **Changing art needs a release** (the assets ride the image). Drop a PNG in the assets dir + a mapping
  entry + ship. If you want live drop-in without a release, that's the NFS/DB option above.
- **Unmapped 75-minute + Specials seasons** were left untouched by design. If you author a `75-minutes.png`,
  drop it in and add `75: '75-minutes.png'` to the mapping; the guard applies it next run.
