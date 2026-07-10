# OPS-010: Peloton poster guard — runbook

- **Status:** Active (PLAN-024, v-next). Part-A one-time restore executed 2026-07-10.
- **Decision:** ADR-043. **Design:** DESIGN-021. **Requirements:** PRD R-137..R-140. **Glossary:** T-124..T-125.
- **Depends on:** `PLEX_HAYNESKUBE_TOKEN` (k8plex owner token, already in `frontend/haynesnetwork-secret`);
  the k8plex **HOps Peloton** library (section key 4).

The guard keeps the owner's durable override posters applied to the HOps Peloton shows/seasons. It re-applies
**only** drifted targets and records every re-apply. This is the operator's guide.

## Where the pieces live

- **Override PNGs (source of truth):** `packages/sync/assets/peloton-posters/*.png` (git-versioned, baked
  into the image at `/sync/assets/peloton-posters`). 13 series + 10 duration + `60+-minutes.png` (unused).
- **Mapping:** `packages/sync/src/peloton-poster-map.ts` (`PELOTON_POSTER_MAPPING`: show title → series art,
  season index → duration art). Index 60 → the clean `60-minutes.png`. Indices 0/75 are intentionally unmapped.
- **Guard logic:** `@hnet/domain runPelotonPosterGuard` (`packages/domain/src/poster-guard.ts`).
- **Apply ledger (audit + drift baseline):** `poster_guard_applications` (append-only; migration 0034).
- **Mode:** `tsx /sync/src/scripts/sync.ts --mode=poster-guard`.
- **Schedule:** haynes-ops CronJob `sync-poster-guard`, `37 * * * *` (hourly, off-phase).

## Run it manually

Against the live server, from a pod that has the secret (or `kubectl create job --from=cronjob/…`):

```
kubectl -n frontend create job poster-guard-adhoc --from=cronjob/haynesnetwork-sync-poster-guard
kubectl -n frontend logs job/poster-guard-adhoc -f
```

The log line `poster-guard evaluated { found, checked, inSync, reapplied, unmapped, missingAssets }` is the
result. `reapplied: 0` in steady state; the **first** run after deploy re-applies all mapped targets once
(no baseline yet) — expected and idempotent (same bytes; Plex keeps prior art in the gallery).

## Add or change a poster

1. Drop the PNG into `packages/sync/assets/peloton-posters/` (normalized name, e.g. `75-minutes.png`).
2. Add/verify its entry in `PELOTON_POSTER_MAPPING` (series title, or duration index).
3. Ship a release (the assets ride the image). The next hourly run re-applies it (reason
   `initial`/`asset-updated`). Swapping bytes under an existing filename re-applies as `asset-updated`.

To find the current library shape (shows + season indices) when adding a mapping, list the section:
`GET {k8plex}/library/sections/4/all` and per-show `/library/metadata/{ratingKey}/children` (token in the
`X-Plex-Token` header). Unmapped shows/seasons appear in the guard's `unmapped` report — never guess.

## Reversibility + the drift test (LIVE validation)

Poster upload is **non-destructive**: `POST /library/metadata/{id}/posters` selects the new art but Plex
keeps the previous poster in the item's **gallery** (`GET /library/metadata/{id}/posters` lists them,
each with a `key`). To validate drift-restore (or to roll back one target):

1. Pick a season, read its poster gallery, and **select a prior gallery image**:
   `PUT /library/metadata/{ratingKey}/poster?url={galleryKey}` (X-Plex-Token header). Its thumb path changes.
2. Run the guard once (ad-hoc job above). It detects the thumb no longer matches the recorded baseline →
   re-applies the override → appends a `poster_guard_applications` row with `reason='drift'`.
3. Confirm: `SELECT rating_key, reason, previous_thumb, applied_thumb FROM poster_guard_applications
   ORDER BY created_at DESC LIMIT 5;` shows the drift row; the season's thumb is the override again.

## Failure modes

- **`PlexConfigError: PLEX_HAYNESKUBE_TOKEN`** — the secret is missing/renamed; the job exits non-zero, no
  writes. Fix the secret; no partial state (the guard is idempotent).
- **Library absent / renamed** (`found:false`) — no writes; the guard degrades cleanly. Re-check the title
  matcher (`/peloton/i`) if the library was renamed.
- **`missingAssets: [name]`** — a mapping entry points at a file not in the image; that target is skipped
  (not fatal). Add the PNG + release.
- **k8plex unreachable** — the read throws; the run exits non-zero and pages via normal job-failure alerting;
  nothing is half-applied (uploads are per-target, drift-gated).
