# OPS-017 — Watchlist protection: the registry CronJob, the paused sweep, the Release Block and its scripts

- **Status:** Active (2026-09-26) — the operating record from PLAN-072 S4 on (haynesnetwork v0.101.0, haynes-ops
  #3223: the registry CronJob, the held sweep and web delete paths, the Loki alerts); S6..S9 fill in the live
  evidence (S6 (a)..(g) passed 2026-09-27, PLAN-072's log). Written with PLAN-072 S2 (PR #595).
- **Scope:** operating the Watchlist Registry (`--mode=watchlist-registry` and its CronJob), the Registry Gate and the
  paused sweep, the Release Block (the app-owned Radarr / Sonarr release profile), the Title Exclusion (ADR-097: the
  app-written import-list exclusion before every Trash delete), the re-add page, and the four operator scripts: the
  S6(e) pool report, the S8 seed, the S9 Seerr enrollment and the ADR-097 Title Exclusion backfill.
- **Normative basis:** ADR-093, ADR-097, DESIGN-052 (D-04, D-07, D-13, D-14, D-15, D-17, D-20, D-21, D-23, D-25,
  D-27, D-28), PLAN-072.
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
| `release_block` | `exclusion` | ADR-097 / D-27: the Title Exclusion could not be written and read back on Radarr or Sonarr, before Phase A; nothing was recorded, blocked or deleted. `[title-exclusion] failed {arrKind, origin, step, written}` names the *arr and the writer's step: `read` (the exclusion list GET), `write` (a POST refused or unanswered; the `written` titles before it landed and are audited), `read_back` (the list read back without a title just written), `validate` (a target without a key: a code defect). | `read` / `write`: check the *arr is up and its key valid, as for `put`; a `write` that keeps failing on one title is Radarr's or Sonarr's validator refusing it (look at the *arr's log for the POST). `read_back`: something removed the exclusion between the write and the read; look at the list (`GET /api/v3/exclusions/paged` on Radarr, `/api/v3/importlistexclusion/paged` on Sonarr). The next hourly sweep retries. |
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

These run in the web pod, which holds the same secret and the `/sync` tree (OPS-004 §4). Each prints counts.
The watch-history report names no title and no account. The others may print library titles.

```bash
POD=deploy/haynesnetwork-main
# PLAN-072 S6(e) — read-only: what the Release Block would record for the pending pool (writes nothing)
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/release-block-seed.ts --pool
# PLAN-072 S8 — the seed: always --dry-run first, then --apply with the same files
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/release-block-seed.ts --dry-run
# PLAN-072 S9 — Seerr enrollment and the anime tags
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/seerr-watchlist.ts --show
# ADR-097 / DESIGN-052 D-28 — the Title Exclusion backfill: always --dry-run first, then --apply
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/title-exclusion-backfill.ts --dry-run
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/title-exclusion-backfill.ts --apply
# DESIGN-008 D-03 (story 837) — household watch history, after the image that contains it is deployed
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/watch-history-backfill.ts --dry-run
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/watch-history-backfill.ts --apply
# ADR-117 / DESIGN-052 D-29 — the legacy release names, once, by the coordinator: --dry-run first, then --apply
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/legacy-release-names-load.ts --dry-run --dir=/tmp/legacy
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/legacy-release-names-load.ts --apply --dir=/tmp/legacy
# ADR-117 / DESIGN-052 D-29 — posted-name backfill, after the load: --dry-run first; --apply only after its counts are read
kubectl -n frontend exec $POD -c app -- tsx /sync/src/scripts/release-block-backfill.ts --dry-run
```

- **`--pool`** prints, per kind, the pool size, the items recordable and their records by shape (`group` / `exact` /
  `none`), confidence and identity source, the records with no release group (Q-12), the fold-only terms (`foldOnly`
  and `foldOnlyShare`: a real release name the term matches only when folded, which Radarr and Sonarr will not block,
  D-25bq; since D-25dd and D-25di the terms write the raw apostrophes, accents, `&` and the double-escaped `&amp;` and
  `&#39;`, so a non-zero count means a character the grammar cannot write, such as a decomposed accent inside a word
  or a doubled apostrophe), the renamed-only terms whose widened year window left out a year
  another title of the same name holds (`namesakeNarrowed` and `namesakes`, titles and years: The Killer 2024 next to
  The Killer 2023, D-25cr), and the items D-11 would keep `release_unrecorded` with their reasons and share
  (`unrecordedShare`, Q-13). It needs `MAINTAINERR_API_KEY` too.
- **The legacy SAB file** (`--legacy-sab`, the seed's flag only) holds release names from the HaynesTower SABnzbd
  histories. It is never committed. Copy it into the pod for the run and delete it after:
  `kubectl -n frontend cp ./sab.tsv <pod>:/tmp/sab.tsv -c app`, run with `--legacy-sab=/tmp/sab.tsv`, then
  `kubectl -n frontend exec <pod> -c app -- rm /tmp/sab.tsv`. The same holds for a `--manual` file.
- **`watch-history-backfill.ts`** (DESIGN-008 D-03, story 837; one-off, after the release that carries it is
  deployed) pages each configured Tautulli history and stores the household play count on live movies
  and shows that already have a metadata row. A finished read stores 0 where no play joined. `--dry-run`
  writes nothing and prints household counts plus each instance's oldest and newest instant. `--apply`
  writes, 500 rows at a time, and refuses to write when the read did not finish (exit 1). No Tautulli
  instance configured exits 2. A second `--apply` writes nothing when the stored watch columns already
  match. Expect about two minutes (the 2026-11-13 history walk was 23.0 s; the estimate adds the
  metadata lookups). It names no account and no title. The 6-hourly metadata refresh does the same
  read after this release, so a later cycle restores a zero that a failed cycle cleared.
- **`legacy-release-names-load.ts`** (ADR-117, DESIGN-052 D-29; one-off, by the coordinator, after the release that
  carries migration 0110 is deployed) loads the release names of the Radarr and Sonarr databases from before the
  2026-07-03 move, and the two old SABnzbd histories, into `legacy_release_names` and `legacy_download_jobs`. Until
  it has run, Trash keeps every title whose file the ledger cannot name (468 of 524 pool movies on 2026-11-13).
  - **The files** are the coordinator's private extract: `old-radarr-history.tsv`, `old-radarr-files.tsv`,
    `old-sonarr-history.tsv`, `old-sonarr-files.tsv`, `legacy-sab-full.tsv` (tab-separated, no header; the columns
    are in `legacy-release-load.ts`). They are never committed and never put in a PR, a log or the tracker. Copy the
    directory into the pod for the run and delete it after:
    `kubectl -n frontend cp ./legacy <pod>:/tmp/legacy -c app`, run with `--dir=/tmp/legacy`, then
    `kubectl -n frontend exec <pod> -c app -- rm -r /tmp/legacy`. A file that is not in the directory is reported
    `absent` and skipped.
  - **One of `--dry-run` and `--apply` is required.** It needs only `DATABASE_URL`, builds no Radarr or Sonarr
    client and makes no network call. `--dry-run` runs in a read-only transaction and writes nothing. `--apply`
    inserts everything in one transaction; a second `--apply` of the same files inserts 0 rows (`dedupe_key`).
  - **What it refuses and reports.** A line in which any field contains `://` is refused whole (`refusedUrl`). A
    line it cannot use is counted by reason: `columns`, `id`, `event`, `name_empty`, `file_without_name`, `size`,
    `completed`; an unreadable date is stored as null and counted (`dateUnparsed`). It prints counts and, per
    outcome, the first five line numbers; never a line's content, a name or a URL.
  - **The output** is one JSON report after a summary log line: `files.<file>` (`read`, `usable`, `refusedUrl`,
    `unusable.<reason>`, `dateUnparsed`, `duplicateInFile`, `lines`, `inserted`, `alreadyPresent`, or `"absent"`),
    `totals.legacyReleaseNames` and `totals.legacyDownloadJobs` (the same sums, with `distinct`, `rowsBefore`,
    `rowsAfter`), and `pool`. In a dry run `inserted` is what `--apply` would insert.
  - **Check `pool` before `--apply`.** `pool.movies` is computed from the files plus what the table already holds,
    against the pending movie pool: `titles`, `fileNamedByExactSize` (a legacy file record of the TMDB id whose size
    is exactly `media_items.size_on_disk`), `withGrabName`, `withAnyName`, `withNoName`. The coordinator measured the
    extract against the pool of 524 on 2026-11-13: 472 files named by exact size, 523 titles with a grab name, 524
    with any name. A dry run that differs much from those is a reason to stop and look, not to apply.
    `pool.shows` gives `titles`, `withAnyName` and `withNoName` (a series has many files; no per-file figure).
  - **After the load**, `release-block-seed.ts --pool` says what the delete path would do with the pool (it reads
    Radarr's files): `recordable`, `unrecordable.unverified_name`, `unrecordable.no_term`, `unrecordable.cap`, and
    `terms` (`live`, `added`, `cap`). Then run the backfill's dry run.
- **`release-block-backfill.ts`** (ADR-117, DESIGN-052 D-29; one-off, after the load above) gives a Deleted-Release
  Record to every posted name of a title Trash already deleted that no live term matches. Names come from the app's
  own tables: the ledger, `legacy_release_names` and, for a movie, the size-matched `legacy_download_jobs`. It reads
  no file and no download client, and does not ask Radarr or Sonarr for history. One of `--dry-run` and `--apply` is
  required. `--dry-run` reads the database only and writes nothing. `--apply` inserts the records, writes and reads
  back the profile, and only then turns them active; if the profile cannot be written it abandons them and exits
  non-zero, and a later `--apply` starts clean. It never terms a title that is back in the library (`skippedLive`),
  never restarts a term's 365 days (`expired`), and never prunes: a title whose terms would not fit under the cap is
  left out whole (`capRefused`). The report has one block per class (`lowConfidence`, `movies`, `shows`,
  `otherNames`: `titles`, `named`, `unnamed`, `noNewTerm`, `records`, `untermed`, `skipped`, `alreadyBlocked`) and
  `terms` per *arr. Do not run `--apply` until the dry-run counts have been read against D-29. A second `--apply`
  adds nothing.
- **Pool titles the Release Name Check lets go** (the database's view, no *arr read; D-29). Run it on a replica
  before and after the load; it needs migration 0110 (before that release, drop the `by_legacy` part). On
  2026-11-13, with no legacy names: 524 pool movies, 2 with no file, 54 the ledger names, 468 with no verified name;
  so 56 deletable. A domain test runs this exact statement against the check (`release-name-rule.test.ts`).

  ```sql
  WITH pool AS (
    SELECT DISTINCT m.id, m.tmdb_id, m.size_on_disk, m.on_disk_file_count
    FROM trash_candidates c
    JOIN media_items m ON m.arr_kind = 'radarr' AND m.tmdb_id = c.tmdb_id AND m.deleted_from_arr_at IS NULL
    WHERE c.media_kind = 'movie'
  ), newest AS (
    SELECT DISTINCT ON (e.media_item_id) e.media_item_id, e.payload
    FROM ledger_events e JOIN pool p ON p.id = e.media_item_id
    WHERE e.event_type = 'imported'
      AND coalesce(e.payload->>'rawEventType', '') NOT IN ('movieFolderImported', 'seriesFolderImported')
    ORDER BY e.media_item_id, e.occurred_at DESC, e.id DESC
  ), by_ledger AS (
    SELECT n.media_item_id AS id FROM newest n
    WHERE (btrim(coalesce(n.payload->>'sourceTitle', '')) <> '' AND position('://' in n.payload->>'sourceTitle') = 0)
       OR EXISTS (SELECT 1 FROM ledger_events g
                  WHERE g.media_item_id = n.media_item_id AND g.event_type = 'grabbed'
                    AND g.payload->>'downloadId' = n.payload->>'downloadId'
                    AND btrim(coalesce(g.payload->>'sourceTitle', '')) <> ''
                    AND position('://' in g.payload->>'sourceTitle') = 0)
  ), by_legacy AS (
    SELECT DISTINCT p.id FROM pool p
    JOIN legacy_release_names l ON l.arr_kind = 'radarr' AND l.record_kind = 'file'
      AND l.external_id = p.tmdb_id AND l.size_bytes = p.size_on_disk
    WHERE p.size_on_disk > 0
  )
  SELECT count(*) AS pool,
         count(*) FILTER (WHERE on_disk_file_count = 0) AS no_file,
         count(*) FILTER (WHERE on_disk_file_count > 0 AND id IN (SELECT id FROM by_ledger)) AS ledger_names_it,
         count(*) FILTER (WHERE on_disk_file_count > 0 AND id IN (SELECT id FROM by_legacy)) AS legacy_names_it,
         count(*) FILTER (WHERE on_disk_file_count = 0 OR id IN (SELECT id FROM by_ledger)
                                OR id IN (SELECT id FROM by_legacy)) AS deletable,
         count(*) FILTER (WHERE on_disk_file_count > 0 AND id NOT IN (SELECT id FROM by_ledger)
                                AND id NOT IN (SELECT id FROM by_legacy)) AS kept_no_verified_name
  FROM pool;
  ```
- **`title-exclusion-backfill.ts`** (ADR-097, D-28; one-off, after the release that carries it is deployed) adds a
  Radarr or Sonarr import-list exclusion for every title Trash deleted, so Kometa and the import lists never add it
  again. It leaves out a title the *arr has in its library now (re-added since; the owner keeps those, 2026-10-03)
  and one already excluded. `--dry-run` reads only (the database, `GET /movie`, `GET /series`, both exclusion lists)
  and prints, per *arr, `population`, `present`, `alreadyExcluded`, `noKey` and `toExclude`, plus `presentTitles`
  and `noKeyTitles` by name. Compare it with the counts of 2026-10-03 (Radarr: population 443, present 33, already
  excluded 86, to exclude 324; Sonarr: population 13, to exclude 13); a much larger `toExclude` means the library read
  came back short, so stop. Then `--apply` (it writes; `declare-activity` is not needed, nothing is deleted): 25
  titles per transaction, each read back and audited in `trash_title_exclusions` (`origin` `backfill`). It exits 1
  when a chunk failed (`failed` names the step, as in section 3's `exclusion` row); run it again once fixed, it
  picks up the rest. A second complete `--apply` writes nothing. Check after: the exclusion counts on the Watchlists
  card grow by the written totals, and `SELECT arr_kind, count(*) FROM trash_title_exclusions WHERE origin =
  'backfill' GROUP BY 1` matches the report.
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
reconciles them. Once a record holds a D-25dd or D-25di term (from PLAN-072 S7 or the S8 seed on), never revert to
v0.101.0, the only earlier image with the Release Block writer: its grammar check refuses those terms, so its writer
refuses every profile write (`ReleaseBlockError` `validate`) and the block stops updating until they are gone
(DESIGN-052 D-25di). Resume the sweep, when PLAN-072 step 6 allows it, with a haynes-ops PR that sets its
`suspend: false`.

While the older image runs, arm or disarm a Trash rule only in Maintainerr's own rule editor, never from the app's
Rules tab: the older toggle saves the rule without `listExclusions`, `forceSeerr` and `arrAction`, so Maintainerr
turns the first two off, and the older safety audit does not check them, so nothing warns (DESIGN-052 D-25cu). Before
the sweep resumes, read `GET /api/collections` on Maintainerr: every active rule pool needs `listExclusions: true`,
`arrAction` 0 and, unless it is an episode pool, `forceSeerr: true`; Leaving Soon needs `arrAction` 4. Fix any that
is off in Maintainerr's rule editor first.

**ADR-097 (the Title Exclusion).** Rolling back to an image without it stops the app writing the exclusion before a
delete; Maintainerr's own `listExclusions` still writes it after the delete (the older audit requires it too, ADR-093
C-10), so automation stays blocked from then on, with a short window between Maintainerr's delete and its exclusion.
Leave the exclusions in Radarr and Sonarr (the ruling is that automation never re-adds a Trash-deleted title); the
older image never reads `trash_title_exclusions` (migration 0087 is additive; drop the table only after no running
image writes it).

## 9. Catch-up tuning without weakening protection

When an array is over target but the space policy reports `skipped_min_candidates`, compare the
live actionable count with the raw pool before changing rules. Watchlisted titles, open Saves,
protective tags and recent Age Guard dates do not provide reclaim capacity. ADR-119's
`age_guard_ignore_library_fill` setting ships off. The one change that alters today's behaviour is a
title with no Plex match, which is kept, so it adds no reclaim. This section stays as it is until
story 823 turns the setting on. A small final pool
can remain blocked by a higher configured minimum even when the jobs and integrations are healthy.

The 2026-10-30 operating choice (OpenProject #296; execution was still pending when documented)
raises only the movie IMDb cutoff from 6.0 to 6.5, uses the largest-first movie strategy with a
50-item cap, and lowers the policy minimum from 10 to 1. It retains IMDb votes > 99, never watched,
the `mediarequests` exclusion, the 180-day rule and app Age Guard, all Save/watchlist/tag/watch
protections, the seven-day save window and the 75% ceiling. TV's rule and five-item cap stay as they
were on that date. A later ruling (2026-11-13, story 835, DESIGN-014 D-15) specifies a different TV
rule body and leaves the five-item cap as it is; that body is not applied by the design change.
Source defaults do not change. Read-only projections put the largest 50 at 3.587 nominal TB;
native rule membership and the actual batch must be checked before reporting this as selected
capacity. It is not a physical reclaim or sustained-rate guarantee. The measurements and remaining
one-title preview discrepancy are in
[the story's evidence](../../.agents/context/2026-10-30-trash-catch-up.md).

Apply a ratified rule change through `upsertTrashRule`, round-tripping the freshly read group and
changing only the intended condition. This preserves and reads back the delete flags and aging
invariant. Apply policy values through audited `setAppSetting`. Confirm the native rule results,
the actionable app count, the batch's selected nominal bytes and its save-window expiry. Do not
shorten that window or use Expedite to make a forecast look achieved.

For a recurrence report, separate currently absent deleted titles missing import-list exclusions
from titles already present. ADR-097's legacy backfill intentionally skipped present titles; their
missing exclusions alone do not prove the current delete writer failed. Explicit Seerr re-requests
remain allowed. Never use a returned-title count alone to justify a backfill or another deletion.
