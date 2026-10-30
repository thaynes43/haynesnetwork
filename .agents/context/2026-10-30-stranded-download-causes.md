# 2026-10-30 — Why retained Usenet downloads accumulate

Canonical work: OpenProject Story **#299**, Epic **#293**, following accepted inventory
**#297**. This bounded investigation is read-only. **No cleanup, import, retry, search,
configuration change or runtime restart occurred. #298's retention/purge hold remains.**

## Findings

The current completed tree has three supported retention mechanisms: blocked imports,
downloads explicitly ignored by Sonarr, and older downloads outside Sonarr's limited
SAB history window. SAB keeps successful downloads; the daily scratch cleanup never
sweeps this completed tree. The legacy trees have a separate ownership gap and cannot
be explained entirely from today's Kubernetes applications.

Fresh native settings, queues, SAB histories and representative paths were read around
15:49–15:56 UTC. Byte amounts below reuse the complete **14:57 UTC** allocated-file
manifest from [the accepted inventory](2026-10-30-tower-storage-inventory.md); they are
not a fresh filesystem census or reclaimable-space estimate. Counts of queue rows,
download GUIDs and retained child entries differ; season packs repeat queue rows.
Private titles, exact job paths and GUID lists are excluded from this public note.

| Retained cohort | Entries | Allocated GB | Supported explanation |
| --- | ---: | ---: | --- |
| Current native queue | 33 | 115.468 | Imports blocked or pending; preserve |
| Current SAB Completed, native history has grab events only | 442 | 881.358 | All outside the newest 60 jobs of their SAB category; no current import record |
| Current SAB Completed, native history has grab and ignored events | 110 | 151.553 | Explicitly ignored in Sonarr on August 20; automatic import skips ignored downloads |
| Current completed, no current SAB/queue reference | 128 | 697.461 | Current ownership/history gap; original cause unproved |
| Legacy completed | 2,033 | 1,867.367 | Outside current clients' paths/history; legacy ownership unverified |
| Legacy incomplete | 19 | 63.298 | Current SAB incomplete directories are elsewhere; legacy ownership unverified |

The first three rows partition the inventory's 585 referenced retained entries. The
442 and 110 rows partition its 552 Completed-without-import-proof class. These are
retention explanations, not proof of unwanted content or safe deletion.

## Current settings and cleanup scope

Both SAB instances have `download_dir=/incomplete` and
`complete_dir=/data/haynestower/usenet/complete-k8s`. `sonarrtv` writes `tv` and
`radarrmovies` writes `movies`, relative to that completed root. Both categories use
`unpack-archives.sh`. The default postprocessing is 3, unpacking and PAR cleanup are
enabled, `safe_postproc=1`, `cleanup_list=[]`, and `history_retention_option=all`.
The obsolete combined `history_retention` field is blank; the split retention option
is the meaningful setting. Extension/PAR cleanup is distinct from removal of the
successful completed download directory.

Main SAB's Lidarr and LazyLibrarian categories point to absolute **CephFS** paths.
Those jobs and current qBittorrent book seeds are excluded from Tower byte sums.
Fast has a relative `lidarr` category, but its current 281 history jobs are all TV.
Main has 351 history jobs: 317 TV, one movie, two uncategorized, 24 Lidarr and seven
LazyLibrarian. Both active SAB queues are empty; every history job is Completed.
Completed means downloader success, not a verified library import.

Sonarr and Radarr both have completed-download handling **enabled**. Their main and
fast SAB client definitions have `removeCompletedDownloads=true` and
`removeFailedDownloads=true`, using the matching categories above. A disabled
completed-removal switch does not explain this backlog. Both apps mount the same
Tower export at `/data/haynestower`; their remote-path-mapping lists are empty.
The eight representative retained directories were present through that mount.
There is no evidence of a current blanket path-translation or access failure.
This does not establish mappings used by predecessor applications.

The GitOps scratch CronJobs run daily at 04:30 and 04:40 America/New_York
(08:30/08:40 UTC on this date). Each only:

1. Deletes failed SAB history with its files.
2. Invokes SAB's orphaned-incomplete-folder cleanup.

Both finished successfully on October 30. Loki retained each job's two operation
messages and a successful failed-history response; Kubernetes records completion at
08:30:05/08:40:05 UTC. They do not target successful completed jobs, ignored jobs or
the old Tower `usenet/incomplete` directory. Their success therefore does not imply
this retained backlog was examined. Sources are the live CronJob specs and
`haynes-ops/kubernetes/main/apps/downloads/sabnzbd/{app,fast}/cleanup-cronjob.yaml`.

## Sonarr's history window and ignored downloads

The installed Sonarr reports **4.0.20.3012**. Its
[version-matched SAB adapter](https://github.com/Sonarr/Sonarr/blob/v4.0.20.3012/src/NzbDrone.Core/Download/Clients/Sabnzbd/Sabnzbd.cs#L98)
requests one history page, starting at zero, with `DownloadClientHistoryLimit`.
Its [configuration service](https://github.com/Sonarr/Sonarr/blob/v4.0.20.3012/src/NzbDrone.Core/Configuration/ConfigService.cs#L168)
defaults that hidden setting to **60**. No matching override key was found in the
current Sonarr database or WAL. An exact read-only SAB request with
`start=0&limit=60&category=sonarrtv` confirmed a 60-TV-job result.

The fresh full histories and native queue match this boundary precisely:

- Main's newest 60 TV jobs contain **14 visible queue GUIDs, 35 ignored jobs and
  11 jobs with import plus ignored records whose source directories were already
  absent in #297**.
- Fast's newest 60 TV jobs contain **18 visible queue GUIDs and 42 ignored jobs**.
- All **442 retained grab-only jobs** are outside those slices: 232 main
  (484.441 GB) and 210 fast (396.917 GB). None appears in the current native queue.

This is strong evidence of why those old downloads are no longer being revisited:
newer completed/ignored history occupies the client's bounded view. It does **not**
establish the original import rejection for every old job. Those jobs' surviving
grab events span July 30 to August 20; an individual file's download is not proved
never to have been handled by another app or manual workflow.

The **110 retained ignored jobs** split into 60 main (51.598 GB) and 50 fast
(99.955 GB). Every corresponding ignored event is timestamped
**2026-08-20 11:48:05–06 UTC**, evidence of a concentrated ignore operation rather
than continuing downloader failures. Its actor, reason and retention intent are
not recorded in those native event payloads and were not inferred.
[Sonarr's tracker](https://github.com/Sonarr/Sonarr/blob/v4.0.20.3012/src/NzbDrone.Core/Download/TrackedDownloads/TrackedDownloadService.cs#L228)
restores ignored state from history;
[its importer](https://github.com/Sonarr/Sonarr/blob/v4.0.20.3012/src/NzbDrone.Core/Download/CompletedDownloadService.cs#L61)
only advances downloading or import-blocked states. Ignoring in Sonarr while keeping
the SAB job leaves completed data and a history-window slot occupied.

Seven representative Sonarr histories were freshly re-read by exact GUID, covering
active holds and both main/fast old and ignored cohorts. They agreed with #297.
Eight targeted directory probes, including Radarr's hold, all succeeded without
errors. The full native-history join was reused from #297 rather than repeated.

## Why today's imports remain blocked

The fresh Sonarr queue has **76 rows / 32 GUIDs**; Radarr has **one row / one GUID**.
Matching their output paths to the measured retained parent directories gives:

| Native reason | GUIDs | Allocated GB |
| --- | ---: | ---: |
| Sonarr: release matched by ID; automatic import refused | 29 | 50.882 |
| Sonarr: existing file covers more episodes than incoming file | 2 season packs / 46 rows | 49.920 |
| Sonarr: unable to determine whether file is a sample | 1 | 0.422 |
| Radarr: release matched by ID; manual import required | 1 | 14.245 |

These sum to 115.468 GB; client-reported nominal download sizes are not substituted
for measured allocated bytes. Identity warnings are protective, not permission to
force an import. The two packs conflict with existing multi-episode files; that
does not prove the incoming content dispensable.

The application's **15:25 UTC** queue janitor completed with zero actions and zero
errors. It checked all 29 qualifying Sonarr identity cases: **28 `title_mismatch`,
one unchanged, zero `importable`**. The Radarr identity case was unchanged with zero
importable results. Sonarr's other 48 rows remained unknown. This explains why the
existing Import Check automation did not override the current holds. Its source
is `packages/domain/src/queue-cleanup.ts`, `applyImportChecks`; it consumes the
native queue, so older downloads outside that queue are not its completed-folder
sweep. No janitor mode or rollout level was changed.

## Unresolved ownership and next safe step

The **128 current unreferenced entries** are 103 under `tv` (364.448 GB), 19 under
`movies` (328.327 GB), and six root entries (4.685 GB). Missing client references
cannot distinguish manual handling, history removal, a former client/path or wanted
unimported content. Current SAB retains history; automatic age pruning is not a
supported explanation for their missing records.

The **2,033 legacy completed entries** break down by download category as music
1,297/648.574 GB, movies 132/493.750 GB, TV 253/467.371 GB, `newfolder`
97/232.152 GB, audiobooks 33/18.634 GB, ebooks 191/3.688 GB and comics
30/3.197 GB. Here `newfolder` is a legacy **download category**, not the separately
inventoried 33.397 TB Media folder. The old 63.298 GB incomplete tree is also outside
current SAB's `/incomplete`. No current job was joined to those legacy paths.

Exact remaining evidence scopes are:

1. Legacy HaynesTower container inventory and non-secret bind mounts; whether
   `binhex-sabnzbdvpn`, `linuxserver-sabnzbd` and predecessor importing apps still
   own these paths. Those two SAB names are historical evidence in the September 26
   research note, not a claim they are running today.
2. Those legacy clients' read-only category/completion/history settings, queue and
   import records, including old path translations. The supported Tower SSH route
   timed out in #297; no alternate route, key, identity or grant was attempted.
3. The August 20 ignore operation's actor/intent and original failure reasons for
   pre-window downloads, if preserved in older logs or an owner record. Current
   native events do not supply that intent.
4. Per-file native import, current library copy and wanted-content/ownership evidence
   for any proposed cleanup. #297 proved **zero retained bytes safe to purge**.

A separately scoped next step can assess how to restore visibility of old completed
jobs and review ignored/unreferenced ownership before choosing retention behavior.
Increasing a history limit could expose old jobs to automatic import and is a
behavior change, not an authorized diagnostic here. No follow-on work was started.

## Delivery and evidence state

Source: documentation only, on `agent/stranded-downloads-1030`. Runtime: inspected,
unchanged. Validation: fresh filtered settings/API reads, exact category-window
probe, representative native histories and paths, Loki cleanup/janitor records,
version-matched upstream source, and `git diff --check`; no application test run
is needed for this evidence note. Required PR CI and independent review govern
delivery. Private session-local JSON under `/tmp/stranded-1030-*` contains the
representative joins; it is ephemeral evidence, never cleanup clearance.
