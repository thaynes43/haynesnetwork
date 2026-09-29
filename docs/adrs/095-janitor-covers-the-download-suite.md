# ADR-095: The queue janitor covers the download suite: LazyLibrarian and Kapowarr through a source adapter

- **Status:** Accepted (2026-09-29; ships with every new cell in census, flipped by the coordinator after deploy)
- **Date:** 2026-09-29
- **Deciders:** Tom Haynes (owner direction, 2026-09-29: the janitor should be generic enough to cover the whole
  download suite, monitor for loops, and not wait on calendars). The classes come from the coordinator's work order of
  the same day, which rested on a read-only audit of LazyLibrarian, SABnzbd and Kapowarr. Drafted by Opus 5.5.
- **Supersedes (in part):** ADR-083's scope ("the Sonarr/Radarr/Lidarr download queues") and its C-04 write-back list,
  which now reach LazyLibrarian and Kapowarr (C-01, C-03 here); ADR-083's single promotion ladder, which becomes one
  ladder per instance family (C-05). ADR-094 C-08 said each new source "is a new write-back and needs its own ruling
  under hard rule 4": this ADR is that ruling for LazyLibrarian and Kapowarr.
- **Amends:** hard rule 4's write-back list (CLAUDE.md), as ADR-083 C-04, ADR-093 C-08 and ADR-094 C-03 did (C-03).

## Context and problem statement

The ADR-083 queue janitor classifies every errored grab in the Sonarr, Radarr and Lidarr queues and acts where a class
is enforced. On 2026-09-29 the live config enforced all nine shared cells (L2). The rest of the download suite has the
same kinds of stuck work and nothing that clears it. The coordinator's read-only audit that day, re-checked for this
ADR against the live services:

- **LazyLibrarian** (books and audiobooks) keeps its grab log in `cmd=getHistory` (8,514 rows: 4,521 Failed, 3,285
  Processed, 706 Seeding, 2 Snatched). It has no queue and no blocklist verb of its own.
  - **Strands.** A Snatched download that reached 100% but did not import is never aborted by LazyLibrarian: its
    post-processor leaves a download at 100% "to retry next cycle" for ever. The coordinator cleared 12 by hand that
    day. A snatch whose job SABnzbd no longer shows reads 0% and is aborted once it is older than LazyLibrarian's task
    age (2 hours): the row becomes Failed, which is LazyLibrarian's own blocklist, and the book's format goes back to
    Wanted (LazyLibrarian `download_client.py` `get_download_progress`, `postprocess.py` `_handle_snatched_timeout`
    and `_handle_aborted_download`). LazyLibrarian itself deletes every job it processed from SABnzbd's history
    (`DEL_COMPLETED`), which SABnzbd archives, so the live history holds almost nothing but strands.
  - **Leftovers.** LazyLibrarian copies rather than moves (`destination_copy = True`), so the SABnzbd folder of every
    Processed download stays on disk. 1,786 were deleted by hand that day (about 377 GB). 769 more still hold a folder
    and a Processed row. SABnzbd cannot delete them: its history delete removes only a job's incomplete folder, never
    the completed one (SABnzbd 5.1.3, `api.py` `_api_history_delete`).
  - **Missing library copies.** 79 Processed rows record a library destination that is no longer on disk. For those
    the SABnzbd folder may be the only copy left.
  - **Fail loops.** 60 book-and-format pairs have 5 or more failed grabs and are still Wanted (the worst, one eBook,
    173). The dominant reasons are "Duplicate NZB", "Unable to locate a valid filetype" and "Failed to send nzb".
  - MyAnonaMouse torrents (qBittorrent `books-mam`) must keep seeding.
- **Kapowarr** (comics) has a queue (`GET /api/activity/queue`, empty that day), a removal with blocklist (`DELETE
  /api/activity/queue/{id}` with `{"blocklist": true}`) and a search (the `auto_search` task), but no retry verb. It
  drops a failed download from its queue and blocklists it itself; its history held 2 failed downloads. Its 429s are
  burst-rate, so calls must stay sparse.

Extending the janitor raises three problems of its own. The config validator required exactly the three *arr
instances, so widening it naively would invalidate the stored config and silently revert every cell to census. The
ladder's L2 means every cell enforced, so new census-only cells would drag the live level back to L1. And the
evaluator, the persistence and the admin page are keyed by the *arr instance and its integer queue id, which
LazyLibrarian does not have.

## Decision drivers

- The owner's direction: one janitor for the whole suite, loops monitored, and no calendar waits.
- Hard rule 4: the sources are the source of truth; the janitor removes failed transfer state, never library files;
  every write-back is named and confined to `packages/domain`.
- The live *arr config (L2) must survive the deploy unchanged, and its ladder must keep reading what it reads today.
- Census first (ADR-083): every new cell ships census, and nothing acts until the coordinator flips it.
- A folder may be deleted only when the library copy is proven to exist. MAM torrents are never touched.
- Kapowarr is rate-sensitive: one removal and at most one search per download.

## Considered options

1. **A source adapter seam with the shared rails (chosen).** Each new source gets an adapter that reads and
   classifies its own items and carries out one class's action for one download. One evaluator applies every
   ADR-083 rail to every adapter: cells, the age rail, the per-run cap, one action per download, retry escalation,
   the loop guard, the loop signals and the census rows.
2. **Stretch the *arr client interface to fit.** Rejected: its contract is the *arr queue record (`statusMessages`,
   `ProcessMonitoredDownloads`, release profiles, D-02..D-14). LazyLibrarian has no queue, and fitting it in would put
   LazyLibrarian and Kapowarr rules into the *arr classifier.
3. **A separate janitor per source**, with its own job, table, config and page. Rejected: it duplicates the rails,
   the audit trail, the digest and the admin surface, and the owner asked for one janitor.
4. **Stop the leftovers at the source** by setting LazyLibrarian to move usenet downloads. Not decided here: it is a
   LazyLibrarian setting for the owner (DESIGN-046 Q-05), and the 769 leftovers already on disk still need clearing.

## Decision outcome

Chosen option: **1, the source adapter seam**, because it is the only option that brings a new source under every
ADR-083 rail, the audit trail and the one config without touching the live *arr path.

Shape of the decision (normative; mechanics in DESIGN-046 D-15..D-20):

- **Instances.** `sonarr`, `radarr`, `lidarr`, `lazylibrarian`, `kapowarr`. The *arr instances keep their own path
  (DESIGN-046 D-02..D-14), unchanged. Bazarr, Prowlarr, Seerr, slskd/soularr, goodreads-sync and ytdrivarr are out
  of scope (no stuck download queue).
- **Cells.** LazyLibrarian: `retry_import`, `bad_release`, `leftover`. Kapowarr: `bad_release`. Report only:
  `fail_loop` (LazyLibrarian) and `unknown` (everywhere). Every new cell is census by default.
- **The write-backs, and nothing else:**
  - LazyLibrarian `retry_import`: `cmd=forceProcess`, at most once per run. A download still stuck after
    `retryEscalateRuns` runs is handled as `bad_release`.
  - LazyLibrarian `bad_release`, SABnzbd downloads only: delete the job from SABnzbd's history. LazyLibrarian then
    aborts the snatch itself (Failed, and the format Wanted again). The janitor does not search: a search sent before
    the abort lands could grab the same release again, and LazyLibrarian's own search picks the book up.
  - LazyLibrarian `leftover`: delete the completed SABnzbd folder of a download LazyLibrarian Processed, only after
    confirming every library copy it recorded exists at its recorded destination. The delete is confined to direct
    children of the LazyLibrarian category's completed folder. It needs two mounts on the janitor's job: the book
    library read-only and that one folder read-write. Without them the janitor does not observe leftovers at all.
    Nothing is searched.
  - Kapowarr `bad_release`: remove the queue entry with blocklist, then one `auto_search` for its volume while the
    volume is monitored and still missing issues.
  - A qBittorrent download is never removed (`skipped_seeding`): MAM torrents keep seeding.
- **Config.** The new instances and their cells are optional in the stored config: an absent instance or cell reads
  as census for itself only and never invalidates the rest. The writer stores the full shape. The stored config of
  2026-09-29 reads exactly as it did.
- **One ladder per instance family:** `arr` (Sonarr, Radarr, Lidarr; PLAN-065's ladder, unchanged), `books`
  (LazyLibrarian) and `comics` (Kapowarr). A family's level, age and nag come from its own cells. The books and comics
  ladders have no calendar criteria: a cell is promoted after the coordinator's spot-check of its census, and the nag
  fires whenever such evidence exists below L2.
- **Loops.** The loop guard (ADR-094) extends to every removal on the new sources that can re-grab (`bad_release`):
  the janitor holds a book format or a volume it already removed on two earlier downloads (`skipped_loop`). Every loop
  event is a `[queue-cleanup] loop_detected` line, now with `kind: 'fail_loop'` too. The nightly digest lists the
  fail loops beside the janitor's own loops.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Supersedes ADR-083's scope in part.** The janitor covers the download suite: Sonarr, Radarr and Lidarr as before, LazyLibrarian and Kapowarr through the source adapter. Every ADR-083 rail applies to every instance: census first, per-class per-instance audited config, the per-run cap, the minimum age, one action per download, retry escalation. |
| C-02 | Good: LazyLibrarian strands clear themselves (a forced import pass, then a removal that lets LazyLibrarian abort and want the book again); SABnzbd leftovers stop filling the disk; fail loops and missing library copies become visible every night instead of in a hand audit. |
| C-03 | **Hard rule 4 is amended.** The write-back list gains the janitor's LazyLibrarian and Kapowarr write-backs: `forceProcess`; the SABnzbd history-job delete that lets LazyLibrarian abort a snatch; the delete of a Processed download's completed SABnzbd folder after its library copy is confirmed, confined to the LazyLibrarian category's completed folder; the Kapowarr queue removal with blocklist and its `auto_search`. All go through `@hnet/downloads/write` and `@hnet/kapowarr/write` (and the existing `@hnet/lazylibrarian/write` `forceProcess`) from `packages/domain` only. Never library files, never a qBittorrent torrent. CLAUDE.md changes in the same PR. |
| C-04 | Good: the stored config of 2026-09-29 survives the deploy exactly (a test loads that shape). Nothing acts on the new sources until the coordinator flips a cell. |
| C-05 | **Supersedes ADR-083's single ladder in part.** The promotion ladder is per family. The `arr` family's level, criteria and nag are PLAN-065's, unchanged, and new cells elsewhere never lower it. The `books` and `comics` ladders wait on evidence, not on a calendar (owner direction). |
| C-06 | Risk: deleting a folder that holds the only copy, or another download. Mitigated: a leftover is only a folder no other SABnzbd job names, whose every LazyLibrarian row is Processed and whose every recorded library destination exists as a file under the library roots, checked in the run that deletes it; a folder with a missing copy, or named by two jobs, is reported, never touched; the delete refuses anything that is not a direct child of the configured folder, and any symlink. |
| C-07 | Risk: a new standing write surface on the media storage. The mount is narrow (one folder read-write, the library read-only), the job runs hourly with a cap of `maxActionsPerRun` per source, and without the mounts the class is inert. |
| C-08 | Risk: a removal loop (a strand removed, re-grabbed, stranded again). The loop guard holds a book format or volume after two janitor removals, and the loop signals and the digest show it. LazyLibrarian's own fail loops are reported, never acted on: the fix for them (a better release filter, another indexer) is a person's. |
| C-09 | Neutral: the adapter seam is generic. A future source is one adapter plus its cells, and each new write-back still needs its own ruling under hard rule 4. |
| C-10 | Bad: more reads per hour: LazyLibrarian's whole grab log and book list, SABnzbd's queue and the jobs it needs, the whole LazyLibrarian category history of SABnzbd (about 9 MB) when the mounts are present, and Kapowarr's queue. |
| C-11 | Risk: rollback. The writer leaves out an all-census source, so until a books or comics cell is enforced the stored config is one the previous image accepts. After one is enforced, the previous image reads the row as invalid and falls back to all-census for every cell (fail safe): roll forward, or rewrite the row without the source instances. |

## More information

- DESIGN-046 D-15 (the source adapter seam), D-16 (instances and config back-compat), D-17 (a ladder per family),
  D-18 (LazyLibrarian), D-19 (Kapowarr), D-20 (loops and the digest). Build plan and ladder log: PLAN-065.
- ADR-083 (the census-first janitor), ADR-094 (the loop guard and the loop signals).
- Upstream references (the running versions): LazyLibrarian `postprocess.py` (`_handle_snatched_timeout`,
  `_handle_aborted_download`) and `download_client.py` (`get_download_progress`), SABnzbd 5.1.3 `api.py`
  (`_api_history_delete`, `_api_history_default`), Kapowarr `frontend/api.py` (`/activity/queue/<id>` DELETE with
  `blocklist`) and `features/download_queue.py`.
- Found in the audit and left to the owner: LazyLibrarian's `reject_audio` filter lists only German words, so a
  "[French]" audiobook was grabbed (DESIGN-046 Q-07).
