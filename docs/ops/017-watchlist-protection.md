# OPS-017 — Watchlist protection: the registry CronJob, the paused sweep, the Release Block and its scripts

- **Status:** Active (2026-09-26) — the operating record from PLAN-072 S4 on (haynesnetwork v0.101.0, haynes-ops
  #3223: the registry CronJob, the held sweep and web delete paths, the Loki alerts); S6..S9 fill in the live
  evidence. Written with PLAN-072 S2 (PR #595).
- **Scope:** operating the Watchlist Registry (`--mode=watchlist-registry` and its CronJob), the Registry Gate and the
  paused sweep, the Release Block (the app-owned Radarr / Sonarr release profile), the re-add page, and the three
  operator scripts: the S6(e) pool report, the S8 seed and the S9 Seerr enrollment.
- **Normative basis:** ADR-093, DESIGN-052 (D-04, D-07, D-13, D-14, D-15, D-17, D-20, D-21, D-23, D-25), PLAN-072.
- **Repos:** this app; haynes-ops (`kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`: the CronJobs
  and the image tag; the Loki alert rules).

Never paste a token, a uuid, a username, an email or a person's titles into a log, a PR or this file. The logs carry
accounts only as their class and `acct:<8 hex>` (D-21).

---

## 1. What runs where

| Piece | Where | Notes |
|---|---|---|
| Registry refresh | CronJob `haynesnetwork-sync-watchlist-registry`, `14,29,44,59 * * * *`, `concurrencyPolicy: Forbid`, `backoffLimit: 0` | `tsx /sync/src/scripts/sync.ts --mode=watchlist-registry`; exit 0 for a clean `failed` run and for `busy` (D-25t); a run that throws exits 1 and is not retried in its slot, so each slot logs at most one scheduled `run_failed` (D-25dc); then, best effort, the Release Block upkeep (D-25cf: it keeps running while the sweep CronJob is suspended; without `RADARR_API_KEY` / `SONARR_API_KEY` it logs `[release-block] upkeep_skipped`) |
| Sweep | CronJob `haynesnetwork-sync-trash-batch-sweep` (hourly at `:45`) | refreshes the registry inline, then the gate, then the two-phase delete (D-14); then, every hour whether or not a batch was due, the Release Block upkeep (the stranded in-flight settle, the 365-day expiry and the profile drift check, D-25br, D-25ce) and the re-add check (D-23). Suspending it stops the re-add check too; nothing is deleted meanwhile, so nothing new can be re-added. Its `suspend` lives in haynes-ops git (`cronjob.suspend` on `sync-trash-batch-sweep`): suspend and resume it only there, never with `kubectl`. The chart renders `suspend` on every CronJob, so each Helm upgrade puts a hand-set value back to git's; a hand resume is re-suspended by the next release without a sound (no alert watches a suspended CronJob), and a hand suspend is lifted by the next upgrade (D-25db) |
| Gate on the web paths | `trash.expediteItem`, `trash.expediteAll`, `trash.batches.expire` | the CronJob's newest run, never an inline refresh; a refusal is `PRECONDITION_FAILED` |
| Web delete hold | env `TRASH_WEB_DELETES_HELD` on the web pod (`1`, `true` or `yes`) | while set (PLAN-072 S4 until S6 is green, and the rollback), the three web paths above refuse before reading anything: `PRECONDITION_FAILED`, appCode `TRASH_WEB_DELETES_HELD`, "Deleting from Trash is on hold while watchlist protection is being verified. Nothing was deleted." (D-25cc). Set and removed through haynes-ops, never by hand |
| Release Block | one profile per *arr, `haynesnetwork: deleted releases (managed, do not edit)` | written and read back before any delete; never edit it by hand while an image that reconciles it runs: the upkeep reads it every run and puts back a disabled, deleted or edited profile within 15 minutes (`[release-block] drift`, D-25ce) |
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

The Release Block upkeep (both CronJobs) reads each profile once per run (two GETs) and logs
`[release-block] reconciled {…, expired, settled}` when it had something to do; `[release-block] drift {arrKind,
reason, missingTerms, extraTerms}` (warn) when the profile no longer matched the records (`missing`, `duplicate`,
`disabled`, `edited`, or `terms`: a term left behind by an abandoned record, or one deleted by hand) and it was put
back; and `[release-block] upkeep_failed {arrKind, stranded, expiring, drift, error}` (warn) when Radarr or Sonarr
did not answer. It tries again on the next run and never fails either job (D-25br, D-25ce, D-25cf). A `drift` line
that keeps coming back means something else writes the profile: find it before it matters.

## 3. `sweep_paused` pages (6 hours or more, any reason)

The sweep logs `[trash] sweep_paused {reason, step, pausedForH}` on every run with a batch due while paused, and the
Trash page shows the banner once the pause is 6 hours old. Nothing was deleted: the batch waits in `leaving_soon`. The
pause ends with the next ok sweep, or as soon as no batch is due (a cancelled or expired batch, D-25bf), which logs
`[trash] sweep_pause_cleared {via}`.

`reason` in the log is one of `gate`, `release_block`, `audit_unsafe` or `arr` (`sweep_outcome` carries the outcome:
`paused_gate`, `paused_release_block`, `paused_audit_unsafe`, `aborted_arr`). The banner groups `audit_unsafe` and
`arr` as one line, "until the media apps respond normally"; the table below uses the log's values, which are what
the alert rule (PLAN-072 S4) matches.

| reason | step | What it means | Remedy |
|---|---|---|---|
| `gate` | `stale` | No registry run that read the roster and the owner's whole list finished in the last 30 minutes. | Read the newest CronJob run: `run_failed {failure}` names the roster or owner read that failed (plex.tv down, the owner token rejected). Fix that, then run the CronJob by hand (section 2). |
| `gate` | `account_unverified` | A readable source (a friend's community list, a Seerr user) has not read for 24 hours; `blocking` counts them. | `account_failed {class, source, errorClass, acct}` names the class and error (`seerr_users` or `seerr_unconfigured`: Seerr's user list or key; `inconsistent`: Seerr's paging, DESIGN-052 Q-03). A source freezes `unreadable` by itself at 72 hours and stops blocking (its titles still protect), so waiting is a valid answer; fixing the read is better. |
| `release_block` | `validate` | A term failed the D-12 grammar before any write. | A code defect: nothing was written. Find the record (`[release-block] failed {arrKind, step}` and the `recorded` lines before it) and fix the derivation in a PR. |
| `release_block` | `put` | Radarr or Sonarr refused the profile write, or did not answer. | Check the *arr is up and its key valid (`RADARR_API_KEY` / `SONARR_API_KEY` in `haynesnetwork-secret`). The next hourly sweep retries. |
| `release_block` | `read_back` | The write answered but the profile read back without every term, or disabled. | Someone or something edited the profile. Look at it (`GET /api/v3/releaseprofile`); the next sweep rewrites it. If it keeps drifting, find the writer before resuming. |
| `release_block` | `duplicate_profile` | Two profiles carry the managed name (a copy, or a restore). | In the *arr, delete the one that is not the older (lower id) profile, or merge their terms into it first if the copy holds terms the other lacks. The next sweep reconciles the survivor. |
| `audit_unsafe` | `unsafe` | The Maintainerr safety audit failed (`paused_audit_unsafe`; the job also fails, as before ADR-093). | The Trash page's safety banner names the integration or the pool and its setting. For a rule pool's setting (`listExclusions`, `forceSeerr`, `arrAction` Delete, or the delete-after horizon), turn that setting back on in Maintainerr's own rule editor for that pool (its UI saves the whole rule), then re-run the sweep. The app's Rules tab only arms, disarms or deletes a rule and carries these settings over unchanged, so it cannot fix them. That holds only while an ADR-093 image runs: the older image's toggle drops `listExclusions` and `forceSeerr` (section 8). An episode pool is not held to `forceSeerr` (Maintainerr never stores it there, D-25bt). |
| `arr` | `handle_breaker` | Three Maintainerr handles in a row failed (`aborted_arr`). | Maintainerr is down or its executor is stuck. Items already handled carry `[trash] deleted {…, records}` lines; the rest wait. |
| `arr` | `arr_identity` | Three *arr identity reads in a row failed before Phase A (`aborted_arr`); nothing was written. | Radarr or Sonarr is down. The next hourly sweep retries. A manual Expire now reports "Nothing was deleted: Radarr or Sonarr did not answer." and Expedite refuses with the same cause (`RELEASE_BLOCK_ARR_UNAVAILABLE`, D-25bu). |
| `arr` | `error` | The sweep threw for another reason with a batch due (Maintainerr's pending read failing, a database error); the job fails too (D-25cg). | Read the job's `[trash] sweep_failed {error}` line and the `trash batch sweep failed` line: a Maintainerr error means Maintainerr is down or answering errors (check its pod and logs); a database error means the app's Postgres. The next ok sweep clears the pause. |

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

## 5. The `account_unreadable` notice (once per source)

`[watchlist-registry] account_unreadable {class, source, acct, failingSinceH}` (warn, logged once per source when it
happens) means one account's source (`community`: the friend's plex.tv list; `seerr`: that user's Seerr watchlist)
has failed for 72 hours, or its community list went empty or hidden while its Seerr list still read titles (settled at
once, D-04). The source is frozen `unreadable`: its last-read titles **still protect** (they stay in the registry), but
it no longer blocks the gate, so deletions go on without its newer additions. Coverage is lost, not safety; this is a
notice, not a page.

Tell the cause apart from the source's earlier `account_failed {class, source, errorClass, acct}` lines (same `acct`):

| `errorClass` | Likely cause | What fixes it |
|---|---|---|
| `empty_after_titles`, `not_found_after_titles` (community; also an `account_hidden` line) | The friend hid their watchlist, emptied it, or left the Plex share; indistinguishable (ADR-093 C-05). | Nothing on our side. If Seerr still reads them, their Seerr list keeps protecting. Ask them to share the list again if it matters. |
| `http_401`, `http_403` (seerr) | That user's stored Plex token in Seerr no longer reads their watchlist. | Nothing on our side; it clears when the user signs in to Seerr again. |
| `seerr_users` (seerr) | Seerr's user list failed, so every Seerr source fails together. A rotated or revoked Seerr API key shows this way: the user list is the first call. | Read the run's `[watchlist-registry] seerr_users_failed {errorClass}` line (D-25ck): `http_401` or `http_403` means the Seerr API key was rotated or revoked, so update `SEERR_API_KEY` in 1Password (`haynesnetwork-secret`), let the ExternalSecret refresh and let the next CronJob run read it; `timeout`, `network` or `http_5xx` means Seerr is down. |
| `seerr_unconfigured` (seerr) | Seerr is not configured for the job. | Check `SEERR_URL` / `SEERR_API_KEY` are set; every Seerr source fails together in this case. |
| `inconsistent`, `empty_after_titles` (seerr) | Seerr's paging answered differently between pages, or it answered empty after titles (its watchlist fetch from plex.tv failed, DESIGN-052 Q-03). | Usually passes; if it persists, read the Seerr log for `Failed to retrieve watchlist items` at the same time. |
| `http_429`, `http_5xx`, `timeout`, `network` | plex.tv or Seerr was down or throttled for 72 hours. | Check the upstream and the pod's egress; one ok read later turns the source back to `read`. |

A source leaves `unreadable` by itself on its next ok read with titles; nothing needs clearing.

## 6. The `run_failed` streak (8 runs in a row, 2 hours)

`[watchlist-registry] run_failed {trigger, failure}` means a whole registry run failed before it wrote any account:
the job still exits 0 (a clean failed run is not a job failure, D-25t), so only this alert says so. A run that throws
(`failure: error`) exits 1, and the CronJob's `backoffLimit: 0` keeps it to one line per slot (D-25dc), so eight in a
row is 2 hours of no fresh check (a Job run by hand, section 2, counts as one more); the sweep's gate pauses once the
newest ok run is 30 minutes old, and the `sweep_paused` page follows at 6 hours, so this notice is the early warning.

| `failure` | What failed | What fixes it |
|---|---|---|
| `roster` | plex.tv's user lists (`/api/v2/user`, `/api/users`, `/api/home/users`) with the owner token. | The run's `[watchlist-registry] roster_read_failed {server, errorClass}` lines name each server's cause (D-25ck): `http_401` means that owner token (`PLEX_HAYNESOPS_TOKEN` or `PLEX_HAYNESTOWER_TOKEN` in `haynesnetwork-secret`) was revoked; `timeout`, `network` or `http_5xx` means plex.tv is down or unreachable. |
| `owner` | The owner's discover watchlist read failed on every server's token. | Same as `roster`, from the `owner_read_failed {server, errorClass}` lines, for `discover.provider.plex.tv`; check the pod can reach it (egress). |
| `owner_truncated` | The owner's list could not be read to a proven end: the page cap, a page that contradicted the total, or a list that changed between pages twice in a row (D-25bn). | Usually the owner was editing the list during the read; the next run succeeds. If it persists, the list is past the 20-page cap (2,000 titles) or the provider is misbehaving. |
| `error` | Anything else thrown during the run (a database error). | Read the job's log around the `run_failed` line. |

Run it by hand once fixed (section 2); a `busy` answer means another run holds the lock.

## 7. The operator scripts (in-cluster)

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
  `none`), confidence and identity source, the records with no release group (Q-12), the fold-only terms (`foldOnly`
  and `foldOnlyShare`: a real release name with an apostrophe, an accent or `&` that the term matches only when folded,
  which Radarr and Sonarr will not block, D-25bq), the renamed-only terms whose widened year window left out a year
  another title of the same name holds (`namesakeNarrowed` and `namesakes`, titles and years: The Killer 2024 next to
  The Killer 2023, D-25cr), and the items D-11 would keep `release_unrecorded` with their reasons and share
  (`unrecordedShare`, Q-13). It needs `MAINTAINERR_API_KEY` too.
- **The legacy SAB file** (`--legacy-sab`) holds release names from the HaynesTower SABnzbd histories. It is never
  committed. Copy it into the pod for the run and delete it after:
  `kubectl -n frontend cp ./sab.tsv <pod>:/tmp/sab.tsv -c app`, run with `--legacy-sab=/tmp/sab.tsv`, then
  `kubectl -n frontend exec <pod> -c app -- rm /tmp/sab.tsv`. The same holds for a `--manual` file.
- **`seerr-watchlist.ts`**: `--enroll=<id>` for the canary, `--enroll=all` after it, `--enroll=off` to stop new
  enrollments (it never turns a user's sync off); `--anime-tags=<serverId>:<tagIds>` once, read back. Every
  `--enroll` is an audited setting write. `--show` prints `enrolled`, `alreadyOn`, `optedOut` and `pending` (a write
  whose answer was lost; the next registry run confirms it by reading the flags, D-25bs).

## 8. Rollback

PLAN-072's Rollback section is the order. Every CronJob suspend and resume in it goes through haynes-ops git, never
`kubectl` (section 1: a Helm upgrade puts a hand-set `suspend` back to git's, D-25db). In short: first, in one
haynes-ops PR, set `suspend: true` on the sweep CronJob and `TRASH_WEB_DELETES_HELD` on the web pod (the older image
ignores the env, so after the revert nobody uses Expedite or Expire now until the guard is back); it lands before the
image revert, or at the latest in the same change. A `kubectl` suspend instead would be undone by that PR's or the
revert's Helm upgrade once git says `suspend: false`, and the older image would then delete watchlisted titles without
recording or blocking the release. Turn enrollment off if S9 ran (the users the app turned on are the
`seerr_watchlist_enrollments` rows with `already_on` false, pending rows included; restoring a user means their own
`movies_before` / `tv_before`, never both off, D-25cj);
then, in the haynes-ops change that reverts the image tag, keep the sweep's `suspend: true` (edit the tag, never a
wholesale `git revert` of the S4 change), remove the `haynesnetwork-sync-watchlist-registry` CronJob (or set its
`suspend: true` in an earlier change), since the older image rejects `--mode=watchlist-registry` (exit 2) and would
fail a Job every 15 minutes, and remove the D-21 Loki alerts, which go silent with the older image. Leave the
release profiles in place unless the block itself is the problem, and delete them only once no running image
reconciles them. Resume the sweep, when PLAN-072 step 6 allows it, with a haynes-ops PR that sets its
`suspend: false`.

While the older image runs, arm or disarm a Trash rule only in Maintainerr's own rule editor, never from the app's
Rules tab: the older toggle saves the rule without `listExclusions`, `forceSeerr` and `arrAction`, so Maintainerr
turns the first two off, and the older safety audit does not check them, so nothing warns (DESIGN-052 D-25cu). Before
the sweep resumes, read `GET /api/collections` on Maintainerr: every active rule pool needs `listExclusions: true`,
`arrAction` 0 and, unless it is an episode pool, `forceSeerr: true`; Leaving Soon needs `arrAction` 4. Fix any that
is off in Maintainerr's rule editor first.
