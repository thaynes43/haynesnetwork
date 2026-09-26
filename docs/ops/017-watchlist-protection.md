# OPS-017 — Watchlist protection: the registry CronJob, the paused sweep, the Release Block and its scripts

- **Status:** Draft (2026-09-26) — written with PLAN-072 S2 (PR #595); it becomes the operating record once PLAN-072
  S4 deploys the CronJob and the Loki alerts, and S6..S9 fill in the live evidence.
- **Scope:** operating the Watchlist Registry (`--mode=watchlist-registry` and its CronJob), the Registry Gate and the
  paused sweep, the Release Block (the app-owned Radarr / Sonarr release profile), the re-add page, and the three
  operator scripts: the S6(e) pool report, the S8 seed and the S9 Seerr enrollment.
- **Normative basis:** ADR-093, DESIGN-052 (D-07, D-13, D-14, D-15, D-17, D-20, D-21, D-25), PLAN-072.
- **Repos:** this app; haynes-ops (`kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`: the CronJobs
  and the image tag; the Loki alert rules).

Never paste a token, a uuid, a username, an email or a person's titles into a log, a PR or this file. The logs carry
accounts only as their class and `acct:<8 hex>` (D-21).

---

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| Registry refresh | CronJob `haynesnetwork-sync-watchlist-registry`, `14,29,44,59 * * * *`, `concurrencyPolicy: Forbid` | `tsx /sync/src/scripts/sync.ts --mode=watchlist-registry`; exit 0 for a clean `failed` run and for `busy` (D-25t) |
| Sweep | CronJob `haynesnetwork-sync-trash-batch-sweep` (hourly at `:45`) | refreshes the registry inline, then the gate, then the two-phase delete (D-14) |
| Gate on the web paths | `trash.expediteItem`, `trash.expediteAll`, `trash.batches.expire` | the CronJob's newest run, never an inline refresh; a refusal is `PRECONDITION_FAILED` |
| Release Block | one profile per *arr, `haynesnetwork: deleted releases (managed, do not edit)` | written and read back before any delete; never edit it by hand while an image that reconciles it runs |
| Status | `trash_sweep_status` (one row) | the banner reads it; `paused_since` is the first non-ok outcome's time |

## 2. Is it healthy?

```bash
kubectl get jobs -n frontend -l app.kubernetes.io/controller=sync-watchlist-registry \
  --sort-by=.status.startTime | tail -3
kubectl logs -n frontend job/<the newest> | grep -E 'run_complete|run_failed|gate'
```

A healthy run logs `[watchlist-registry] run_complete {status: ok, roster, byClass, byStatus, …}`. The gate's own
line, `[watchlist-registry] gate {purpose, verified, reason, ageMin, blocking, filtered}`, is logged by every sweep and
Expedite: `blocking` counts the sources that keep it closed (a `carried` source past 24 hours).

Run it now: `kubectl create job -n frontend --from=cronjob/haynesnetwork-sync-watchlist-registry wlr-manual-$(date +%s)`.
A run that finds another holding the lock answers `busy` and exits 0.

The admin view is the Watchlists card (Settings, Trash, General): when watchlists were last checked, accounts read and
not, the blocked-release counts per *arr, the import-list exclusions and the re-adds.

## 3. `sweep_paused` pages (6 hours or more, any reason)

The sweep logs `[trash] sweep_paused {reason, step, pausedForH}` on every run with a batch due while paused, and the
Trash page shows the banner once the pause is 6 hours old. Nothing was deleted: the batch waits in `leaving_soon`. The
pause ends with the next ok sweep, or as soon as no batch is due (a cancelled or expired batch, D-25bf), which logs
`[trash] sweep_pause_cleared {via}`.

| reason | step | What it means | Remedy |
|---|---|---|---|
| `gate` | `stale` | No registry run that read the roster and the owner's whole list finished in the last 30 minutes. | Read the newest CronJob run: `run_failed {failure}` names the roster or owner read that failed (plex.tv down, the owner token rejected). Fix that, then run the CronJob by hand (section 2). |
| `gate` | `account_unverified` | A readable source (a friend's community list, a Seerr user) has not read for 24 hours; `blocking` counts them. | `account_failed {class, source, errorClass, acct}` names the class and error (`seerr_users` or `seerr_unconfigured`: Seerr's user list or key; `inconsistent`: Seerr's paging, DESIGN-052 Q-03). A source freezes `unreadable` by itself at 72 hours and stops blocking (its titles still protect), so waiting is a valid answer; fixing the read is better. |
| `release_block` | `validate` | A term failed the D-12 grammar before any write. | A code defect: nothing was written. Find the record (`[release-block] failed {arrKind, step}` and the `recorded` lines before it) and fix the derivation in a PR. |
| `release_block` | `put` | Radarr or Sonarr refused the profile write, or did not answer. | Check the *arr is up and its key valid (`RADARR_API_KEY` / `SONARR_API_KEY` in `haynesnetwork-secret`). The next hourly sweep retries. |
| `release_block` | `read_back` | The write answered but the profile read back without every term, or disabled. | Someone or something edited the profile. Look at it (`GET /api/v3/releaseprofile`); the next sweep rewrites it. If it keeps drifting, find the writer before resuming. |
| `release_block` | `duplicate_profile` | Two profiles carry the managed name (a copy, or a restore). | In the *arr, delete the one that is not the older (lower id) profile, or merge their terms into it first if the copy holds terms the other lacks. The next sweep reconciles the survivor. |
| `media_apps` | `unsafe` | The Maintainerr safety audit failed (`paused_audit_unsafe`; the job also fails, as before ADR-093). | The Trash page's safety banner names the integration or the flag (`listExclusions`, `forceSeerr`, `arrAction`, the aging horizon). Fix it in Maintainerr through the app's rule editor, never by hand. |
| `media_apps` | `handle_breaker` | Three Maintainerr handles in a row failed (`aborted_arr`). | Maintainerr is down or its executor is stuck. Items already handled carry `[trash] deleted {…, records}` lines; the rest wait. |
| `media_apps` | `arr_identity` | Three *arr identity reads in a row failed before Phase A (`aborted_arr`); nothing was written. | Radarr or Sonarr is down. The next hourly sweep retries. |

To re-run the sweep once the cause is fixed rather than wait for `:45`:
`kubectl create job -n frontend --from=cronjob/haynesnetwork-sync-trash-batch-sweep sweep-manual-$(date +%s)`
(`declare-activity` first: it deletes). A manual Expire now in the web app runs the same gate without an inline
refresh.

## 4. The `readd` page (`sameRelease=true`)

`[release-block] readd {arrKind, recordId, title, grabs, sameRelease: true}` at error level means a title deleted
from Trash was re-added and grabbed a release the block should have rejected (ruling 2 breached). Look at the title's
*arr history (`sourceTitle` of the grab) against the record's term (`trash_deleted_releases.term` for `recordId`): a
term that does not match the grabbed name is a derivation gap (a PR to the D-12 rules, and blocklist the grab by hand);
a matching term that did not reject means the profile was not in place (look for `release_block` pauses or a
`read_back` failure around the grab). The Watchlists card's re-add line counts titles over 30 days (D-25bh).

## 5. The operator scripts (in-cluster)

All three run in the web pod, which holds the same secret and the `/sync` tree (OPS-004 §4). Each prints counts and
library titles only.

```bash
POD=deploy/haynesnetwork-main
# PLAN-072 S6(e) — read-only: what the Release Block would record for the pending pool (writes nothing)
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/release-block-seed.ts --pool
# PLAN-072 S8 — the seed: always --dry-run first, then --apply with the same files
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/release-block-seed.ts --dry-run
# PLAN-072 S9 — Seerr enrollment and the anime tags
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/seerr-watchlist.ts --show
```

- **`--pool`** prints, per kind, the pool size, the items recordable and their records by shape (`group` / `exact` /
  `none`), confidence and identity source, the records with no release group (Q-12), and the items D-11 would keep
  `release_unrecorded` with their reasons and share (`unrecordedShare`, Q-13). It needs `MAINTAINERR_API_KEY` too.
- **The legacy SAB file** (`--legacy-sab`) holds release names from the HaynesTower SABnzbd histories. It is never
  committed. Copy it into the pod for the run and delete it after:
  `kubectl -n frontend cp ./sab.tsv <pod>:/tmp/sab.tsv -c app`, run with `--legacy-sab=/tmp/sab.tsv`, then
  `kubectl -n frontend exec <pod> -c app -- rm /tmp/sab.tsv`. The same holds for a `--manual` file.
- **`seerr-watchlist.ts`**: `--enroll=<id>` for the canary, `--enroll=all` after it, `--enroll=off` to stop new
  enrollments (it never turns a user's sync off); `--anime-tags=<serverId>:<tagIds>` once, read back. Every
  `--enroll` is an audited setting write.

## 6. Rollback

PLAN-072's Rollback section is the order. In short: suspend the sweep CronJob first; turn enrollment off if S9 ran;
then, in the haynes-ops change that reverts the image tag, also remove (or first suspend) the
`haynesnetwork-sync-watchlist-registry` CronJob, since the older image rejects `--mode=watchlist-registry` (exit 2) and
would fail a Job every 15 minutes, and remove the D-21 Loki alerts, which go silent with the older image. Leave the
release profiles in place unless the block itself is the problem, and delete them only once no running image
reconciles them.
