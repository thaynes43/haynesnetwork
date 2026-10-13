# DESIGN-055: Self-service media repair: the Repair Guide, its remedies, and the Seerr issue bridge

- **Status:** Accepted (owner, 2026-10-12: ADR-109, ADR-110 and ADR-111 accepted; Q-01..Q-05 ruled below; P1..P8
  approved in PLAN-077's order, one phase per release, each verified live before the next)
- **Last updated:** 2026-10-13 (P4 decisions after D-05: the Episode Re-map as built, no discard, the Title Check and the Mislabel Block as built). Before that 2026-10-12 (P3 decisions after D-11: the Seerr Issue mirror, the title page reports, the `/r/seerr/<id>` link, the admin list and Activity's Import Check row; P2 decisions in D-02, D-05 and D-07; P1 decisions in D-08 and D-09; D-12 and Q-04 and Q-09 amended: the readiness gate is the owner's judgment, ADR-112)
- **Satisfies:** PRD-001 R-262..R-271, US-18, US-19, AC-40..AC-45; governed by ADR-109 (repair in place), ADR-110
  (episode-title evidence), ADR-111 (Seerr issue bridge and readiness gate). Extends DESIGN-005 (Fix D-15, Force Search
  D-17, one search per Fix D-25), DESIGN-046 (the queue janitor), DESIGN-052 (term grammar and single-writer profiles),
  DESIGN-030 (Activity), DESIGN-012 (webhook ingestion), DESIGN-032 (ticket locator). Plan: PLAN-077.

## Overview

The owner wants Plex users to fix problems themselves on haynesnetwork.com instead of filing Seerr issues for staff.
That can become the rule only once the platform reliably fixes what people actually report. Three Seerr issues were
worked by hand on 2026-10-12, and none was self-serviceable:

| Case | The report | What it really was | What fixed it by hand | What today's tools would have done | Remedy here |
|---|---|---|---|---|---|
| A. Regular Show: The Lost Tapes S01 (Seerr 4) | "Missing episode 11 and all the episodes after 10 are slid up by 1" | A BiOMA pack numbered one behind TVDB from E12 on: 8 files one slot low, the real E11 "upgraded" away; a Disney+ E23 filed on E24; the only E11 and E13 releases rejected by the profile; Portuguese default audio | Manual import of the existing files, highest first, then rename; two override grabs plus manual imports; a hand unpack of a `.7z`; a per-series release profile; Plex show-level audio language | Episode Fix: blocklist, then a search that finds nothing acceptable. Season Fix: also blocklists the 10 good releases | D-04 Re-map, D-05 Mislabel Block, D-06 Release Pick, D-08 language check, D-09 season guard |
| B. The Paper (2025) S02E06 (Seerr 3) | "Missing episode 6" | A finished download whose inner file name Sonarr parsed as 2x06 to 2x125; import blocked 18 days; the janitor saw it 423 times as `unknown` | Admin manual import | Force Search: 81 releases, 0 grabbed (the stuck download held the episode). Activity Retry import: same failure, admins only | D-07 queue-aware Force Search and Import Check |
| C. GoodFellas (1990) (Seerr 2) | "Click play, it says I just watched it" | A healthy 87.6 GB DV remux; the play never reached our servers (most likely Plex's own free-catalogue copy) | Nothing to fix on the server | A Won't play Fix with no grab history deletes the 88 GB file and downloads an essentially identical release | D-09 playback triage and Replacement Preview |

The shape: Fix and Force Search stay the only buttons. Each opens the **Repair Guide**, which asks one question at a
time, reads the evidence, previews the remedy, and acts only after the person confirms. Every remedy is a **Repair
Request** with an audit trail, budgeted like Fix. Seerr issues are mirrored into the app and linked to the guide, and
every new report is worked through those tools first, and the owner decides when self-service becomes the default (D-12).

**Facts this design relies on (read-only, 2026-10-12).** Sonarr 4.0.20.3012 and Radarr 6.4.4.10685, both with no
recycle bin (`recycleBin: ""`): a deleted or replaced file is gone. Seerr 3.5.0: 4 issues ever, 18 users, 17 of them
on the default permissions that include `MANAGE_ISSUES`, 10 with an app account (by email); the webhook to the app is
on with types 204 (media events only); the API key acts as user 1 unless `X-API-User` names another. SABnzbd 5.1.3
leaves obfuscated `.7z` posts un-extracted (haynes-ops#3834); since 2026-09-29 the janitor's `bad_release` cell has
removed and blocklisted 82 Sonarr downloads carrying "Found archive file" (issue #887). The janitor's *arr family is
at L2. App usage: 2 Fix requests in 90 days (one person), 1 Helpdesk ticket ever.

## Detailed design

### D-01 The Repair Guide

- **Entry points.** The existing `<MediaAction action="fix">` and `<MediaAction action="forceSearch">` (ADR-071) open
  the guide instead of today's dialogs. No new head button. A verb shown inside the guide that is a media action
  ("Pick a release", "Import it") gets a `MEDIA_ACTIONS` registry row and the action-anatomy guard's token list.
- **Container.** A `Modal` (hard rule 8: an explanatory multi-step confirm). Steps replace each other in place inside
  the modal body, which reserves its height for the tallest step, so nothing outside it moves (hard rule 9).
- **Question tree.**

  | Entry | First question | Routes to |
  |---|---|---|
  | Fix on an episode or movie with a file | "What's wrong?" (the R-45 reasons, worded for people) | Won't play: D-09 triage, then Fix with the Replacement Preview. Wrong language: D-08. Wrong episode (TV) or wrong content: "Which episode is this really?" opens D-04; a wrong movie runs Fix with the Replacement Preview. Missing subtitles: the Bazarr path (ADR-016). Wrong version or quality: Fix, with "See every release" (D-06). Something else: Fix, or a prefilled Helpdesk ticket. |
  | Fix on a season (`Fix · Season N`) | "Which episodes are wrong?" | D-09 season guard; "they're all shifted by one" opens D-04 |
  | Force Search on a missing episode or movie | none: it reads the queue first | D-07; when nothing is found, "See every release" opens D-06 |
  | A Seerr issue link (D-11) | preselected from the issue (D-10 routing table) | as above |

- **Preview contract.** Before any write the guide shows what it found (the evidence, each item with its source), what
  it will do, and what will be gone afterwards (any file, any blocklisted release). "Gone" lines are never pre-ticked.
  The confirm button names the action ("Move 8 files", "Import it", "Grab this release").
- **Outcome.** After the write the slot shows the ADR-028 live chip, and the final line says what happened in plain
  words. The same text becomes the Seerr resolve note (D-10).
- **Copy.** Owner copy rules: no em-dashes, no personal names, friendly and plain, "cluster" never "Kubernetes".

### D-02 Repair Requests

- **Table `repair_requests`** (BC-03), guard-listed in `no-direct-state-writes`:
  `id` uuid · `requester_id` FK users · `media_item_id` FK media_items · `kind` text CHECK (`remap`,
  `import_download`, `release_pick`, `audio_preference`, `language_search`) · `scope` text CHECK (`item`, `season`,
  `episode`) · `season_number` int null · `target_child_ids` int[] (episode ids) · `target_label` text · `reason` text
  null (a `FIX_REASONS` value when the guide started from Fix) · `preview` jsonb (exactly what was shown and confirmed)
  · `status` text CHECK (`pending`, `actioned`, `completed`, `refused`, `failed`, `timed_out`) · `actions_taken` jsonb
  (the `FixActionEntry[]` shape) · `seerr_issue_id` int null · `fix_request_id` uuid null (when the guide ended in a
  classic Fix) · `created_at`, `updated_at`, `completed_at`.
- **Single writer** `packages/domain/src/repair-requests.ts`: `createRepairRequest` (pending row plus a
  `repair_requested` ledger event in one transaction, before any mutating call, under the per-requester advisory lock
  that `createFixRequest` uses), `recordRepairAction`, `completeRepairRequest`, `refuseRepairRequest`. Ledger event
  types gain `repair_requested`, `repair_completed`, `repair_failed`, and `release_list_requested` (D-06).
- **Budget (ADR-080).** `countRecentFixBudget` also counts `repair_requests` and `release_list_requested` events, in
  the arr pool. Admins bypass as today. One press is one unit, however many calls it makes.
- **One open repair per grain.** At most one open Repair Request or Fix Request per (movie) or (series, season); the
  open check is shared both ways, so a re-map and a season Fix cannot run together.
- **Completion** is read, never assumed: a re-map completes when the episode-file read-back matches the plan; an
  import when the target episode or movie has the imported file; a grab when the ADR-028 phase reaches `complete`. Open
  rows time out at the existing 48-hour horizon (`FIX_TIMEOUT_HORIZON_MS`).
- **As built in P2 (2026-10-12, migration 0099).** The table, the `repair_requested` / `repair_completed` /
  `repair_failed` events and the writer (`createRepairRequest`, `recordRepairTransition`, `completeRepairRequests`,
  `expireStaleRepairRequests`) landed with kind `import_download`. `countRecentFixBudget` counts Repair Requests.
  The open check, both ways: a repair meets any open repair on the movie or on the same season; against a Fix, a season
  Fix matches by its season and an episode Fix by its episode. An import onto one episode is therefore not held up by a
  Fix on another episode of the same season, which touches a different file (seen in e2e: a Fix still waiting for its
  replacement on S01E02 would otherwise block importing S01E10 for up to 48 hours). The writer can also take the
  season's episode ids, for a remedy that moves files across the season (P4's re-map). `release_list_requested` arrives
  with P5. The `refused` status exists but P2 never writes it: every refusal is thrown before the row, as in P1.

### D-03 The write surface (hard rule 4)

Every write goes through `@hnet/arr/write`, `@hnet/plex/write` or the Seerr write client, called only from
`packages/domain`, after its Repair Request row (or, for the bridge, its write row) is committed.

| Call | Where | Endpoint | Used by |
|---|---|---|---|
| `manualImport(files, importMode)` | Sonarr, Radarr | `POST /api/v3/command` `ManualImport` | D-04, D-06 follow-through, D-07 |
| `renameFiles(...)` | Sonarr (series + file ids), Radarr (movie ids) | `POST /api/v3/command` `RenameFiles` | D-04 |
| `grabRelease({guid, indexerId, override?})` | Sonarr, Radarr | `POST /api/v3/release` | D-06, D-08 |
| `deleteQueueItem(id, {removeFromClient, blocklist, skipRedownload: true})` | exists | `DELETE /api/v3/queue/{id}` | D-07 |
| Mislabel Block profile write | Sonarr | `/api/v3/releaseprofile` | D-05 |
| `setItemPreference(ratingKey, {audioLanguage})` | each Plex server | `PUT /library/metadata/{ratingKey}/prefs` | D-08, original language only (Q-03 ruling) |
| `commentOnIssue`, `resolveIssue` | Seerr, with `X-API-User` | `POST /api/v1/issue/{id}/comment`, `POST /api/v1/issue/{id}/resolved` | D-10, as the bridge user (Q-02 ruling) |

New reads (`@hnet/arr/read` and the Plex and Seerr read clients): `getManualImport` by `downloadId` or by folder
(series, season), `listReleases` by episode or movie, queue records for a target, episode and movie files with
`mediaInfo`, Seerr `listIssues` and `getIssue`, Plex item streams and preferences.

**Contract rule.** Each new request body is pinned in a fixture taken from the running version's own UI request
(Sonarr 4.0.20.3012, Radarr 6.4.4.10685, Seerr 3.5.0) and asserted in `write-clients.test.ts` (P2's `ManualImport` in
`manual-import-clients.test.ts`, beside its reads); the app sends no field the UI does not send. The
`arr-write-import-guard` test stays green.

### D-04 Episode Re-map

The remedy for "this file is really episode N" and "every episode from N on is shifted by one". It moves existing
library files onto the right episodes with Sonarr's own manual import. Nothing is downloaded.

1. **Scope.** One season of one Sonarr series. Every source is an episode file of that season inside the series
   folder. Movies have no re-map; a wrong movie is a Fix.
2. **Claims.** A single move (the file on episode A belongs to episode B), or a shift (every file from episode N
   through M, default the last episode with a file, moves by k = +1 or -1). The guide pre-fills a shift when Title
   Evidence (D-05) or Title Check flags suggest one, and shows each file's verdict beside it.
3. **No implicit displacement.** Every target slot must be empty, or hold a file that the plan itself moves, or hold a
   file the person explicitly ticks "discard this file" for (shown with its name and size, never pre-ticked). With no
   recycle bin, an import onto an occupied slot deletes that slot's file for good, so the plan refuses every other case.
   *As built (P4 decisions 2 and 3): the discard tick is not offered, since a re-map never deletes a file (owner ruling,
   2026-10-12); for a library file, an import onto an occupied slot would leave that slot's file on disk but unmapped.*
4. **Order.** For k = +1, highest episode first; for k = -1, lowest first; a single move is one step. This is the order
   that fixed Case A by hand: each move lands on a slot whose file has already moved. A cycle (a swap) has no free slot
   to pass through and is refused with "ask staff".
5. **Multi-episode files** move as a set (their episode ids shift together). A plan that would split one is refused.
6. **Freshness.** Just before executing, the season's episode files are read again; if any file id, size or mapping
   differs from the preview, nothing runs and the guide shows the new state.
7. **Execution.** For each step: read the file's manual-import candidate (`GET /manualimport` on the season folder with
   `filterExistingFiles=false`), send `ManualImport` with `importMode: 'move'`, the target episode ids, and the file's
   own quality, languages and release group; read the series' episode files back and check the file is on its target.
   The first mismatch stops the run; the steps done so far are each complete and lose nothing, by rule 4's order.
8. **Rename.** `RenameFiles` for the moved files, then a read-back of their names.
9. **Vacated slots.** Each episode left without a file is offered Force Search (D-07) or the Release Pick (D-06) in the
   same guide. Case A's Spice It Up is that step.
10. **Mislabel offer.** When the plan is a shift and two or more moved files came from one release group (from each
    file's grab or import history), the result step offers "Stop <group> from filing this show again", which writes a
    Mislabel Block term (D-05) on confirm.
11. **Limits.** At most 40 moves per request. Refused while any queue record targets that season (an import could race
    the moves) or another open repair or Fix holds it (D-02).
12. **Who.** Anyone who can use Fix, within the budget: no file is lost without an explicit discard tick, and a re-map
    can be reversed by another re-map.

### D-05 Title Evidence, the Title Check and the Mislabel Block (ADR-110)

**Title Evidence** (`packages/domain/src/title-evidence.ts`, pure):

1. Normalize: lowercase, fold accents, `&` to "and", drop punctuation, apostrophes and the quality, source, codec,
   audio, language and group tokens (`2160p`, `WEB-DL`, `AMZN`, `HMAX`, `DSNP`, `PCOK`, `DDP5.1`, `H.265`, `DUAL`,
   `MULTI` and the rest, a versioned list).
2. Extract the title segment: the tokens after the `SxxEyy` (or `NxNN`) token up to the first stripped token.
   `Regular.Show.The.Lost.Tapes.S01E10.Spice.It.Up.1080p...` gives "spice it up";
   `The_Paper_2025_S02E06_125_Years_Young_...` gives "125 years young"; a BiOMA name gives nothing.
3. Score the segment against every TVDB title of the season (from the *arr's episode list; two-part titles split on
   `/` or `;`), by token-set similarity.
4. Verdict against the numbered episode: `agrees` (the numbered episode is the best match and scores at least 0.8),
   `disagrees` (another episode scores at least 0.8 and beats the numbered one by at least 0.3; the best episode and
   score are kept), `silent` (an empty segment), otherwise `ambiguous`. The thresholds are starting values that the
   Title Check census tunes before anything relies on them (PLAN-077 P4).
5. A title that agrees outranks the number; silence and ambiguity are never evidence against an import.

**As built in P2 (2026-10-12, `title-evidence.ts`, TITLE_EVIDENCE_VERSION 1).** The rules above, with what the live
names forced (1,817 real release names from Sonarr's Lost Tapes search and grab history were parsed; only true
mismatches stay `ambiguous`):

- `agrees` needs the numbered (or mapped) episode to be the season's best match (rule 4), so a close call where another
  episode scores higher is `ambiguous`. Scoring is the Dice coefficient on token sets; a two-part title scores its whole
  and each part. Titles that are empty, "TBA" or "TBD" leave nothing to compare: `silent`.
- Two kinds of stop token: codes (`1080p`, `x264`, `AMZN`, ...) always end the title; words that are also tags (`red`,
  `french`, `proper`, `dual`, ...) end it only when another stop token follows ("Franklin and the Red Scooter").
- Multi-episode names are a range, as Sonarr reads them (`S01E01-E03`, `S01E55E56`); a file is judged against all the
  episodes it holds. Spelling variants match (hyphens joined, accented letters dropped, `12,000`, `2½`, `&amp;`).
- Two additions for the Import Check (D-07): **movie Title Evidence** (the release's title, before its year, must
  contain the movie's title, original title or an alternate title, at least 0.8 of its words, and name a year within one
  of the movie's; a TV-shaped name is `ambiguous`) and the **series year** (a release whose series part names a year more
  than one off the series' year names another show).
- Q-06 data: Dice marks down shortened titles (`Terror.Tales.of.the.Park.VII` for the Halloween special scores 0.71;
  a two-episode file named with both titles 0.67 to 0.75), so those stay `ambiguous` until the Title Check census tunes
  the thresholds (P4).

**Title Check** (census, ADR-110 C-03): sync mode `title-check`, hourly at :35 (after the janitor's :25). It reads
Sonarr history `downloadFolderImported` events since its cursor and writes one `title_checks` row per imported file:
`id`, `instance`, `series_id`, `episode_id`, `episode_file_id`, `source_title`, `verdict`, `best_episode_id`,
`score`, `created_at`. A `disagrees` row whose file is still on that episode puts a flag on the episode row of the
title page ("This file's name says it is E23, All You Can Fit") that opens D-04 pre-filled. It writes nothing to
Sonarr. The nightly digest gains one count line.

**Mislabel Block** (T-310, ADR-110 C-04): one Sonarr release profile, "haynesnetwork: mislabelled releases (managed,
do not edit)", "must not contain" terms only, no tags.

- **Term:** `/^(?=.*\b<series title words joined by \W*>\b)(?=.*\b<group>\b)/i`, built only from the DESIGN-052 D-12
  whitelist grammar (words, separators, the apostrophe and accent alternations) and a group token from
  `[A-Za-z0-9.-]`, then checked by the same compile validator before every write.
- **Table `mislabel_block_terms`:** `series_id`, `release_group`, `term`, `repair_request_id`, `state`
  (`active`, `expired`, `removed`), `created_at`, `expires_at` (365 days). At most 500 active terms.
- **Single writer** `reconcileMislabelBlock` (domain): writes and reads back the profile on a confirmed offer (D-04
  rule 10), and in the `title-check` run removes expired terms and repairs drift, the ADR-094 janitor release block
  pattern. A write that cannot be read back answers the person with "not saved" and leaves the term `removed`.
- **Adoption:** Case A's hand-made profile (tag `lost-tapes-release-block`, id 31 on series 1061) becomes the first
  term, after which the tag profile and the tag are removed by hand with a read-back (PLAN-077 P4).

**P4 decisions (2026-10-13, PLAN-077 P4).** What the build of D-04 and D-05 settled, with the reads behind it:

1. **The kill switch.** One more remedy in `repair_guide_remedies`, `episode_remap`, ships off. It covers the re-map in the
   Fix guide, the Title Check flag on the title page that opens it, and the Mislabel offer after it. The Title Check
   census and the Mislabel Block's upkeep run whatever the switch says (neither moves a file).
2. **What a library-file import does** (Sonarr 4.0.20.3012's `ManualImportService` and `ImportApprovedEpisodes`, read at
   the tag, and Case A's hand fix of 2026-10-12): a `ManualImport` of a file already inside the series folder is not a
   new download. The file stays where it is; Sonarr deletes the episode-file record for that path (a database delete,
   `ManualOverride`), adds a new record on the chosen episodes (a new id, the scene name dropped) and writes no history
   row. An episode that still had another file keeps that file on disk but unmapped. So the plan never imports onto an
   episode whose file it does not move, and the order matters for a run that stops part way.
3. **No discard.** Owner ruling (2026-10-12, the P4 work order): a re-map never deletes a file. Rule 3's "discard this
   file" tick is not built; an episode that keeps a file the plan does not move refuses the plan ("Fix that episode
   first, or ask staff for help").
4. **Two-episode files.** A shift whose range cuts one refuses (rule 5). A single move of one moves the whole file by
   the offset chosen: "the file on S05E06 is really S05E07" moves S05E05-06 to S05E06-07.
5. **Order.** Each move waits for the moves that free its target episodes; among the moves that are ready, a +1 shift
   takes the highest episode first and a -1 shift the lowest. A cycle refuses (a single move or a shift by one cannot
   make one; the check stays as a guard). At most 40 moves.
6. **The run.** One `ManualImport` per move, `importMode: move`, with the fields Sonarr's own series-folder import sends
   (`path`, `folderName`, `seriesId`, `episodeIds`, `releaseGroup`, `quality`, `languages`, `indexerFlags`,
   `releaseType`, `episodeFileId`; no download id), taken from `GET /manualimport?seriesId=&seasonNumber=` for the file.
   Each command is awaited (up to 60 seconds), then read back: the file at that path holds exactly the target episodes.
   The first move that does not land stops the run; what moved is renamed, and the Repair Request closes `failed`, so
   the season's grain is free for the person to run the rest. Every move and read-back is in the request's trail
   (`appendRepairActions`).
7. **Refused while Sonarr is busy.** Besides a queued download for the season (rule 11), the plan refuses while a
   `ManualImport` or `RenameFiles` is still queued or running on Sonarr (`sonarr_busy`): a late command could land on a
   slot a new plan counts as free.
8. **Rename.** One `RenameFiles` with every moved file (`{seriesId, files}`, the body Sonarr's Organize sends), then
   Sonarr's own rename preview (`GET /rename?seriesId=&seasonNumber=`) as the read-back, up to three passes: Sonarr
   renames in its own order and skips a name another file still holds, never overwrites it. A file left with its old
   name is reported (`renamed: false`); it is still on the right episode.
9. **Evidence in the preview** is the file's scene name, else the name the Title Check judged; never the file's path,
   which Sonarr renamed after the episode it sits on.
10. **Plex watch state.** Plex keeps a watched mark on the episode (its metadata item), not on the file, and a re-map
    does not touch Plex: after it, the marks stay on the episode numbers, and the preview says so in one line. A Plex
    episode-ordering change (Case 3 of the P4 work order, The Loud House S10, fixed by hand by switching the show to TVDB
    ordering once nobody had watch state on it) moves watched marks; it is not built here. It would need its own ADR, a
    Plex write and a watch-state check first.
11. **What names can and cannot see.** LAZY's Amazon season packs of The Loud House S05 and S06 carry no episode titles
    (`The.Loud.House.S05E01.1080p.AMZN.WEBRip.DDP2.0.H.264-LAZY`), so Title Evidence is `silent` and the Title Check
    cannot flag them; subtitle and title-card evidence stay out of scope (Alternatives). A person who sees it can still
    fix S05 with a shift; a scrambled season (S06) is a series of single moves, and a swap needs staff.
12. **The Title Check as built** (`title-check.ts`, migration 0101). The cursor is the newest `history` row's import
    time less two hours of overlap (the first run reads 48 hours). A file's candidate names are the history record's
    `sourceTitle` and its `droppedPath` file name; the kept verdict is any `agrees`, else `disagrees`, else `ambiguous`,
    else `silent`. A series whose episode read fails for a reason that may pass holds the cursor: nothing imported at
    or after its oldest import is written that run, so the next run reads it all again. The hold lasts at most a day
    per import (then it is given up on and the library-wide read picks it up), and a series Sonarr answers 404 for is
    gone and is skipped. One row per file, with the episode numbers stored so a report reads without Sonarr. Every hour the
    open flags of up to 200 series are re-read and a flag whose file has left its episodes is cleared (a re-map, an
    upgrade, a delete); the title page's live read clears one too. The one-off library-wide read
    (`repair-guide.ts title-check --backfill`) judges every import record Sonarr kept, plus the scene name of a current
    file with no record, against the episodes holding the file now. The nightly failure digest gains the count line; a
    flag opened in the last 24 hours sends the digest on its own.
13. **The Mislabel term as built** (`release-terms.ts` `renderMislabelTerm`, `mislabel-block.ts`). D-05's `\b` and `\W*`
    are written `(?<![a-z0-9])`, `(?![a-z0-9])` and `[^a-z0-9]*`: the same in .NET and JavaScript, and `\b` misses an
    `_`-separated name. The group is written in lower case under `/i`. Beyond the grammar it refuses a group that is
    an ordinary tag or a title word (`group_too_broad`) and a series title that would also block another library show
    (`names_other_series`, "Regular Show" against "Regular Show: The Lost Tapes"). A write that cannot be read back
    leaves no active term (one `removed` row; the upkeep takes a stray term out of the profile). A second profile with
    the block's name is never repaired: every write refuses until staff delete the copy, as the Release Block does.
14. **The adoption** (ADR-110 C-05) moves the hand profile's group term (BiOMA on The Lost Tapes) into the Mislabel
    Block. The hand profile (`Regular Show: The Lost Tapes: block off-by-one numbered postings`, id 3, tag 31) also
    holds five terms that are not a series and a group: the German title "Die verlorenen Videos", the double-episode
    token `S01E13E14`, and three number-and-title pairs (`S01E11 Secret Menu`, `S01E13 Smoke Alarm`,
    `S01E24 All You Can Fit`). ADR-110 C-04 admits only series-and-group terms, so the hand profile stays in place until
    the owner rules on Q-10; removing it would drop those five blocks.

### D-06 Release Pick

The remedy for "nothing acceptable was found": an interactive release list for one missing episode or movie.

- **Read.** `GET /api/v3/release?episodeId=` (Sonarr) or `?movieId=` (Radarr): a live indexer search. Opening the list
  records one `release_list_requested` event against the budget (D-02). The list stays in the dialog while it is open.
- **Each row:** release title, size, quality, languages, custom-format score, age, indexer and protocol; the *arr's
  rejection reasons in plain words (a versioned mapping, unknown reasons shown verbatim); the Title Evidence badge
  against the target; and one state:

  | State | When |
  |---|---|
  | Grab | the *arr approved it |
  | Override | rejected, every reason is on the overridable list, the target is a missing episode or movie, and the person can use Fix and has budget left (Q-01 ruling) |
  | Not allowed | any reason is on the hard-refusal list (the reason is shown) |

- **Overridable reasons:** quality not wanted by the profile, custom-format score below the minimum, language not
  wanted, and an episode number that differs from the target **only when** Title Evidence agrees with the target.
- **Hard-refusal reasons:** blocklisted; matches a "must not contain" term (Release Block, Mislabel Block or any other
  profile); CAM, TELESYNC, TS, WORKPRINT, sample or unknown quality; larger than the profile's size limit for its
  quality (or 15 GB for an episode and 100 GB for a movie when the profile sets none); already in the queue for the
  target; Title Evidence disagrees with the target.
- **Grab.** Approved: `POST /release {guid, indexerId}`. Override: the same call with the override fields carrying the
  target series, episode ids, quality and languages, pinned to the UI's request (D-03). The ADR-028 chip follows it.
  When the import blocks (a mis-numbered name), the Import Check (D-07) runs with the person's chosen episode as the
  expected mapping. That is Case A's "override grab, then manual import onto the right episode".
- **Who** may override (Q-01 ruling, owner, 2026-10-12): anyone who can use Fix, for a missing episode or movie only,
  within their hourly Fix budget, and only when every rejection reason is on the overridable list. The hard-refusal
  list applies to everyone, admins included. A Not allowed row offers "Ask staff", which opens a Helpdesk ticket
  prefilled with the target (ADR-061 locator) and the release title.

### D-07 Queue-aware Force Search and the Import Check (issue #597 Part 1)

Force Search reads the queue for its target before it searches:

| Queue state for the target | What Force Search does | What it says |
|---|---|---|
| nothing | searches, as today; when the ADR-028 window ends `nothing_found`, offers "See every release" (D-06) | "Searching" |
| downloading, queued or held by a delay profile | nothing | "Already on its way" with the progress |
| finished, import blocked or pending | the **Import Check** below | per outcome |
| download failed | removes it with blocklist (`skipRedownload: true`) and searches once | "Removed a failed download and searched again" |

**Import Check** (T-306), shared by Force Search, the Release Pick's follow-through and the janitor:

1. Read the download's candidates: `GET /api/v3/manualimport?downloadId=<id>&seriesId=<id>` (or the movie's).
2. **Importable** when every rule holds: exactly one video candidate maps to the target (Sonarr's manual-import mapping,
   the queue record's own mapping, or, when those disagree, the episode that Title Evidence agrees with, which must be
   the target); no permanent rejection except the identity rejections this check exists to overrule ("matched to series
   by ID", "unexpected considering the ... folder name", "were not found in the grabbed release"); no sample, archive,
   password or unparseable rejection; Title Evidence `agrees` or `silent`; the target has no file, or the *arr does not
   say "not an upgrade"; the candidate's series is the target's series.
3. Importable: `ManualImport` with the target ids and `importMode: 'auto'`, read back the target's file: "Found a
   finished download and imported it."
4. `disagrees`: "Import this download onto..." lists the season's missing episodes with the agreeing one preselected.
   Allowed only for the agreeing episode or the grab's own target; anything else goes to staff.
5. A release defect: remove with blocklist, search once: "Removed a bad download and searched again."
6. "Found archive file": report only while haynes-ops#3834 is open: "This download has to be unpacked before it can
   be added, and that needs staff for now." The guide offers a prefilled Helpdesk ticket. Then the D-14 rule applies.

Each press is one Repair Request (`import_download`) or one search event. Activity keeps its admin Retry import; its
row shows the Import Check result to admins.

**Janitor tie-in** (DESIGN-046 amendment in PLAN-077 P2): a new class `importable` (a blocked item whose Import Check
passes) with one enforce cell per *arr instance, census by default, acting through the same writer when enforced, and
the report-only class `title_mismatch`. Promotion follows the PLAN-065 spot-check pattern; #597's T.O.T.S. ("matched by
ID", 61 records) and The Paper are the first evidence. #597 Part 2's library-state classes (records whose episode
already has a file) stay in #597 and PLAN-065.

**P2 decisions (2026-10-12, PLAN-077 P2).** What the build settled, with the live reads behind it (Sonarr's queue held
105 import-blocked records that day, almost all "matched to series by ID"):

1. **The kill switch.** One more remedy in `repair_guide_remedies`, `import_check`, ships off. It belongs to Force
   Search, so on its own it never opens the Fix guide. The server applies it to every caller; the bulk collection search
   stays search-only (it confirmed "search these", never an import or a removal it did not show).
2. **The read sends only the download id.** Sonarr 4.0.20.3012's `ManualImportController` takes the series-folder
   branch whenever `seriesId` is present (`if (seriesId.HasValue)`), so step 1's `&seriesId=` would list the series'
   library files (read live on A Woman of Substance). The queue's own "Manual Import" button sends only `downloadId`.
3. **The write and its read-back.** `POST /command {name: 'ManualImport', files, importMode: 'auto'}` with exactly the
   fields each UI sends (a field the candidate lacks is left out), quality and languages echoed verbatim. The guide waits
   up to 20 seconds for `GET /command/{id}`, then reads the target's file: `imported`; a command still running answers
   `importing`, and the sync completes the Repair Request from the ingested import (D-02); a failed command or no file
   after it is `failed`.
4. **Which download.** A target's queue records are grouped by download: one on its way wins (a search would only be
   refused), then a stuck one (`importBlocked`, `importPending`, `importFailed`), then a failed one (`failed`,
   `failedPending`, status `failed`, tracked status `error`); the newest grab within a state.
5. **Files.** Force Search judges only the file that holds its target (a pack's other files are not imported); the janitor
   needs every file of the download to pass and every tracked episode covered once. A sample beside the real file is
   ignored; a sample alone is a release defect. A download with no candidate at all goes to staff, never to a removal:
   it may still be packed (P0's lesson; a live Butterbean's Cafe download read empty). A temporary rejection, a file of
   another series, two files for one episode, a not-an-upgrade rejection and any other rejection go to staff, with the
   *arr's words.
6. **`ambiguous` is not importable.** Rule 2 lists `agrees` or `silent`; D-05 rule 5 governs the Title Check's flag, not
   an import. Live: a Rugrats 2021 release that Sonarr's grab history put on the 1991 series mapped onto "Little Dude"
   with no rejection at all; its title (two segments of the 2021 show) is `ambiguous`, so it is never imported.
7. **The series year.** A release whose series part names a year more than one off the series' year is a
   `title_mismatch`, whatever its episode title says. Live: `Franklin.2025.S01E05` (no episode title) mapped onto the 1997
   Franklin's missing S01E05 with no rejection; without this rule it would have imported another show's episode. The cost
   is that a long-running show's release named with its airing year (`Gold.Rush.2026`, `Peppa.Pig.2022`) is reported, not
   imported; the census counts them.
8. **Movies.** Radarr has no episode titles, so the movie Title Evidence of D-05 applies. issue #597's `Alatriste` grabbed
   for A Movie of Eggs is a `title_mismatch`; TurkSeeD's Turkish-titled Spider-Man release agrees (its name carries the
   English title), and was refused anyway because the library already holds a better file.
9. **"Import this download onto..."** offers the episode the title names, when it has no file, and the grab's own target,
   when it has no file; otherwise the download goes to staff. The import onto the chosen episode re-applies every rule but
   the title (a release naming another year's show is never offered).
10. **Plan and confirm.** `fix.searchPlan` is read-only and costs nothing; its digest goes back with the press, which
    re-plans and refuses a changed plan (`FIX_PLAN_CHANGED`). A press without a digest (an older client) searches or
    reports "on its way"; an import or a removal needs the confirmed plan (`FIX_REFUSED`, reason `needs_guide`).
11. **The removal.** A failed or defective download is removed through its first queue record with
    `removeFromClient`, `blocklist` and `skipRedownload`, after the `search_requested` event that records it
    (`payload.queueRemoval`), then one `EpisodeSearch` or `MoviesSearch`.
12. **A packed download stays report only** although haynes-ops#3834 is closed: DESIGN-046 D-26 still classifies it
    `unknown`, and P0's census decides whether it ever acts.
13. **Activity's admin row** showing the Import Check result is not in P2; it moves to P3 with the other admin surfaces
    (PLAN-077 P3).
14. **The janitor** (DESIGN-046 D-27): the Import Check runs only on downloads whose records are all `unknown`, stuck,
    and carry an identity rejection, at most 100 downloads per instance per run; `importable` acts through the same
    ManualImport when its cell is enforced, loop-guarded; `title_mismatch` is report only.
15. **A file the import replaces is "gone afterwards"** (found in the live check of v0.113.0, fixed in v0.113.1). An import onto a target that
    already has a file is an upgrade the *arr accepted (no not-an-upgrade rejection), and the *arr deletes the old file
    (no recycle bin). The plan lists each such file (`replaces`: name, quality, size), the guide shows it as a "gone
    afterwards" line that must be ticked before "Import it" works, and the digest covers it, so a plan that starts
    replacing a file is refused if the person saw the earlier one. Live: The Naked Gun 2½'s stuck 2160p DV download would
    replace the movie's current file; A Woman of Substance's eight Blu-ray remuxes would replace its x265 files.

### D-08 Language-aware Wrong language

1. **Read the file's audio**: Sonarr `episodefile.mediaInfo.audioLanguages` or Radarr `movieFile.mediaInfo.audioLanguages`,
   and each matched Plex item's audio streams (`languageCode`, `default`) on every server (the ADR-047 match).
2. **Ask** "Which language did you want?", with English first and the languages found in the file listed.
3. **The language is in the file:** no blocklist and no delete. Under the Q-03 ruling (owner, 2026-10-12), when the
   wanted language is the title's original language (the *arr's `originalLanguage`), the app sets the title's
   preferred audio language for everyone on every server that has it and reads it back (Case A). Otherwise it changes
   nothing and shows how to choose the audio track in Plex and how to set a default audio language in the person's own
   Plex account. Until PLAN-077 P6 lands the write, every case gets that guidance. Whether Plex offers the same
   preference for a movie is checked in P6; where it does not, a movie gets guidance only.
4. **The language is not in the file:** the Fix runs as today (blocklist, or the D-09 guarded delete path), then
   instead of a blind search it reads the release list and grabs the best approved release whose languages include the
   wanted one. With none approved, it opens the Release Pick filtered to that language.

The one `wrong_language` Fix in the last 90 days took the delete path (read 2026-10-12): this check comes first.

**P1 (2026-10-12):** rules 1 to 3 read the *arr's own `mediaInfo.audioLanguages` (ISO 639-2 codes, `"por/eng"` on The
Lost Tapes S01E12); the Plex stream read moves to P6 with the preference write. "Present" means every file in scope
carries the language and every file's audio could be read; a file the *arr could not read is "unknown" and the Fix
runs as before. With the language present the Fix is refused (`language_present`) and the guide shows how to pick the
track and set a default audio language in the person's Plex account.

### D-09 Fix safety guards and playback triage

**Season Fix.** "Which episodes are wrong?" lists the season's episodes with files, their release and their Title
Check flag, nothing preselected except flagged ones. Only the downloads behind the chosen episodes are marked failed.
A download that also backs episodes the person did not choose (a pack) is not marked, because marking any of its
records fails the whole download (DESIGN-005 D-25). The guide says why ("This pack also holds 10 episodes you marked
fine") and offers those chosen episodes the guarded delete path below, a Re-map or the Release Pick instead. The same
check applies to an episode Fix whose grab is a pack: the person sees which other episodes the blocklist would cost
before anything is marked.

**Replacement Preview** (T-308) on every delete path (no grab history: episode, season fallback, movie). Before any
delete, the guide reads the release list and shows the release the *arr would take next (the first approved release
in the *arr's own order; PLAN-077 P1 verifies the API's order and otherwise ranks by the profile) beside the current
file: size, quality, group, source. The Fix refuses when:

- no approved release exists: "Deleting would leave nothing to replace it", with "See every release";
- the replacement is the **Same Release** (T-308): same group, quality and resolution with a size within 2 percent, or
  a normalized name equal to the current file's scene name: "That would download the same release again", followed by
  playback triage.

**Playback triage** (Won't play). The guide first reads **Playback Evidence** (T-309) for this person and title over
the last 48 hours: the Tautulli play and stop webhooks already stored as Feed notifications (sent at session start,
before Tautulli's 120-second history filter drops short sessions), matched by the person's email and the title's ids,
plus each Tautulli instance's history.

- No play reached our servers: "Your play didn't reach our servers." The guide shows the Watch-here links (ADR-047) for
  the servers this person can use, and explains that Plex also lists its own free copies of some titles, so the copy to
  pick is the one that names our server. The Fix stays available behind "I played our copy and it still won't play".
- Plays reached one server only, and that server is on the known-issues list (an app setting, T-314; written for
  HaynesOps' hardware-transcoding fault, haynes-ops#3833, which was fixed on 2026-10-12): the guide suggests the other
  server's link first.
- Plays reached and stopped quickly: the Fix continues with the Replacement Preview.

PLAN-077 P1 checks that all three Tautulli instances post play and stop to the webhook, and adds Tautulli's Playback
Error trigger.

**P1 decisions (2026-10-12, PLAN-077 P1).** What the build settled, with the live reads behind it:

1. **The kill switch.** One audited app setting, `repair_guide_remedies`, holds four P1 remedies: `replacement_preview`
   (the Replacement Preview and its refusals), `season_guard` (the season guard and an episode Fix's pack cost),
   `language_check` (D-08 rules 1-3) and `playback_triage` (Playback Evidence). Every remedy ships off; staff switch
   them on `/admin/fixes` (the Repair Guide card) or with the in-cluster tool (item 9). Fix opens the guide for a movie
   or a TV episode or season once any remedy is on, skips the steps of the remedies that are off, and opens today's
   dialog when all are off; Music always keeps today's dialog. The server applies the same switch, so a caller that
   skips the guide gets the same guards.
2. **Which release replaces the file (T-308).** With the file on disk the *arr rejects every release that is not an
   upgrade: all 635 GoodFellas releases carried "Existing file on disk has a equal or higher Custom Format score: 5950"
   or "is of equal or higher preference" (Radarr 6.4.4, read 2026-10-12). Those rejections vanish with the file, so
   the replacement is the first release, in the *arr's decision order, that is approved or whose every rejection is an
   **Existing-File Rejection** (T-315, any reason naming the existing file). Every other rejection (blocklisted, a
   must-not-contain term, a quality or size the profile refuses, a queue or delay rule) still stands after the delete.
3. **Q-07, order half: resolved.** `GET /api/v3/release` returns the *arr's own decision order: both ReleaseControllers
   run the decisions through `PrioritizeDecisions` before mapping them. GoodFellas' list leads with its custom-format
   5950 remuxes; a Sonarr season search groups by episode. The override fields stay open for P5.
4. **The Same Release, refined.** "A size within 2 percent" cannot hold for Usenet: a post's listed size includes its
   yEnc and par2 overhead. GoodFellas' own FraMeSToR remux (an 87.61 GB file) is listed at 89.38 to 99.48 GB by four
   indexers, 2 to 14 percent over. The rule is now: the same release group (case-insensitive), quality, resolution and
   edition, not a newer revision (a PROPER or REPACK is a different release), the same custom-format score when the
   *arr scored both (the score carries the DV, HDR, audio and tier features, so FraMeSToR's non-DV remux at 4950 is a
   different release), and a size that fits: a torrent within 2 percent, a Usenet post from 2 percent under to 20
   percent over. A normalized name equal to the file's scene name, or to the release name its last import recorded,
   is the Same Release too. A season pack offered for one episode skips the size test. GoodFellas' replacement is the
   Same Release on identity, so its Fix is refused.
5. **The season guard in practice.** Packs are read from `GET /history/series` (one read, no release search): an
   episode's latest grab names its download, and a download backs every on-disk episode whose latest grab it is. A
   season Fix marks a download only when every on-disk episode it backs was chosen; a pack that also backs an episode
   marked fine is held back and named. A chosen episode with no download record, while others have one, is left for an
   episode Fix (it would need its own Replacement Preview). The delete path, with a Replacement Preview per episode from
   one season release search, applies only when no chosen episode has a record. The search afterwards covers the marked
   or deleted episodes (`EpisodeSearch`); it is today's `SeasonSearch` only when every on-disk episode was chosen and
   acted on, and DESIGN-005 D-25 still decides whether the *arr's own Redownload Failed searches instead. A season Fix
   with nothing safe to do is refused.
6. **An episode Fix in a pack** is refused until the person chooses: "Replace just this episode" (the guarded delete
   path for its own file; the pack stays) or "Block the whole pack" (having seen the other episodes it costs).
7. **Refusals and the preview contract.** Every refusal is thrown before the pending Fix Request row
   (`FixRefusedError`, appCode `FIX_REFUSED`): nothing is written and no budget is used. The guide shows the plan first
   (`fix.preview`, read-only) and sends its digest with the confirm; the Fix reads the plan again just before acting and
   refuses a plan that changed (`FIX_PLAN_CHANGED`), so it never acts on something the person did not see. A Replacement
   Preview that cannot be read refuses the delete. Each "gone afterwards" line (a deleted file with its size, a blocked
   release, a blocked pack) must be ticked before the confirm works; none is pre-ticked.
   **The release search is spent sparingly** (it queries every indexer, whose API hits are capped): the preview and the
   Fix first refuse, read-only, what the Fix would refuse anyway (over the hourly budget, a Fix already open on the
   grain), so such a request runs no search; a release list is reused for 5 minutes, so a preview and its confirm cost
   one search; and a member may run at most 12 live searches an hour (per web pod; cached lists, admins and the
   in-cluster tool are not counted). The preview itself costs no budget unit, unlike P5's Release Pick list.
8. **Playback Evidence (T-309).** The stored Tautulli `play`, `stop` and Playback Error webhooks, matched by the
   person's app or Plex email, or their Plex username, and the title's ledger item or ids (a show at the show level),
   plus each Tautulli instance's history for the title's rating keys on that server, filtered to the person's plex.tv
   id or Plex username. Those come from the session's Plex identity (the sign-in claims) as well as the user row's
   admin overrides: on 2026-10-12 no user row carried a Plex username, so the row alone would match no history. The
   template gains `server` (DESIGN-012 D-02), so a webhook names the server too. Read 2026-10-12: the HaynesOps and
   HaynesKube instances posted `play` and `stop`, and HaynesTower's Tautulli posted nothing to the app. The same day
   all three gained the Playback Error trigger and `server`, and HaynesTower's (outside the cluster) now posts
   through the LAN route `https://haynesnetwork.haynesops.com/api/webhooks/tautulli`. The **Known-Issue Servers**
   (T-314) are the audited app setting
   `playback_known_issue_servers`; Won't play triage suggests another server first when every play reached only these.
   It ships empty: haynes-ops#3833 (HaynesOps never hardware-transcoded) was fixed the same day, before P1 shipped.
9. **The in-cluster tool.** `tsx /sync/src/scripts/repair-guide.ts` prints a title's plan (`preview`, with both planning
   remedies on whatever the switch says), a person's Playback Evidence (`evidence`) and a file's audio languages
   (`audio`), reading only; `settings` prints the switch and writes it, audited, with `--set` and `--known-issue`. It is
   how the live checks run: the app's sign-in cannot be driven from inside the cluster.

### D-10 The Seerr Issue mirror, its surfaces and its writes (ADR-111)

**Table `seerr_issues`** (BC-05), guard-listed: `seerr_issue_id` int PK · `issue_type` smallint (1 video, 2 audio, 3
subtitles, 4 other) · `status` (`open`, `resolved`) · `problem_season`, `problem_episode` (0 means the whole season or
title) · `media_type`, `tmdb_id`, `tvdb_id` · `media_item_id` null (the ledger item, by tmdb for movies and tvdb for
TV, the DESIGN-005 D-14 rule) · `target_child_id` null (the Sonarr episode) · `reporter_seerr_user_id` ·
`reporter_user_id` null (the app user by case-insensitive email) · `message` (the first comment) · `comment_count` ·
`seerr_created_at`, `seerr_updated_at`, `read_at` · `staff_handled_at` null · `staff_note` null (what staff did by
hand and which capability was missing; D-12).

**Sync.** Mode `seerr-issues` every 10 minutes reads `GET /api/v1/issue` (all statuses, newest first, until rows are
unchanged). The Seerr webhook gains the four issue types (types 204 to 4044, a one-off reversible change recorded in
PLAN-077 P3); an issue webhook only triggers a fresh `GET /api/v1/issue/{id}`, and it is not stored as a Feed
notification, so a report has one record in the app.

**Routing** (the guide entry a Seerr issue opens):

| Issue | Guide entry |
|---|---|
| video, episode or movie with no file | Force Search (D-07) |
| video, file present | Fix, "What's wrong?" |
| video, a whole season (episode 0) | the season view with Title Check flags; "Fix · Season" |
| audio | Fix, Wrong language (D-08) |
| subtitles | Fix, Missing subtitles |
| other | the guide's first question |

**Surfaces.** On the title page, an open report shows above the episode list: "Reported in Seerr: <message>" and the
guide button preselected. Admins also see who reported it. `/admin` gains a Seerr issues list: issue, title, age,
the linked repairs (which tool fixed it), and "Mark fixed by hand" with a note naming the missing capability (D-12).

**Writes** (Q-02 ruling, owner, 2026-10-12: comment and resolve, never as the owner's account): through a dedicated
Seerr user ("haynesnetwork.com", created once by staff with `MANAGE_ISSUES`; its id in the audited app setting
`seerr_bridge_user_id`), every call sending `X-API-User`. Single writer `packages/domain/src/seerr-issue-writes.ts`,
table `seerr_issue_writes` (`seerr_issue_id`, `kind` `comment` or `resolve`, `body`, `state` `intended`, `done` or
`failed`, `created_at`, `done_at`; unique per issue and kind). The intended row commits before the call and is completed
after it, so a crash never posts twice.

- **Comment**, once per new issue: "Thanks for the report. You can fix this one yourself on haynesnetwork.com: <link>.
  Sign in with your Plex account. If that doesn't sort it out, reply here and staff will take a look."
- **Resolve**, when the linked Repair Request or Fix completes: a comment "Fixed on haynesnetwork.com: <the outcome
  line>", then `POST /api/v1/issue/{id}/resolved`.
- Never: delete an issue, reopen one, edit any comment, or write without the bridge user.

### D-11 Reporter onboarding

- **The link** is `https://haynesnetwork.com/r/seerr/<issueId>`: a small route that looks up the mirror row and
  redirects to the title page with the guide preselected (or to a short explanation while the ledger has no item for
  it yet). A stable link survives a changed mapping.
- **Sign-in.** Signed out, the route sends the person through Authentik's "Log in with Plex" and back to the link.
  Their first sign-in creates the account in the Default role (R-03), which sees every library (ADR-081) and has the
  budget's fallback of 25 actions an hour. Nothing has to be granted. PLAN-077 P3 verifies the round trip keeps the
  link.
- **First visit.** The reporter sees "You reported this in Seerr. Here's what you can try first." above the guide.
- **Delivery** is Seerr's own comment notification (D-10), sent however the reporter set up Seerr. The app adds no
  channel.

**P3 decisions (2026-10-12, PLAN-077 P3).** What the build settled for D-10's read side, D-11 and D-12, with the live
reads behind it (Seerr 3.5.0, 4 issues, all resolved). Seerr is only read; the comment and resolve stay P7.

1. **The reads.** `GET /api/v1/issue?take=100&skip=&filter=all&sort=added`, paged to the end under a 50-page cap (a
   longer list fails the run rather than mirror part of it), and `GET /api/v1/issue/{id}`. Read live: `status` is 1 open
   or 2 resolved; the list carries every comment (without its author); an issue carries no title, only
   `media.tmdbId`/`tvdbId`. Strip-mode schemas (`packages/arr/src/schemas/seerr.ts`) keep only what the mirror reads.
2. **A full read every run**, not "until rows are unchanged": at today's rate the whole list is one page, and only a
   complete read can tell that Seerr deleted an issue. Such an issue gets `removed_at` (kept, with its staff note,
   cleared if it comes back). A failed list read writes nothing. Sync mode `seerr-issues`, CronJob
   `sync-seerr-issues` every 10 minutes; Sonarr is read only for an episode's id (kept while the title, season and
   episode are unchanged; unknown while Sonarr is down).
3. **Columns beyond the list above:** `reporter_name` (the name Seerr shows, for admins only, ADR-111 C-02),
   `removed_at`, `staff_handled_by`, `created_at` and `updated_at`. The reporter's email is read only to match the app
   account (`resolveUserIdByEmail`, the DESIGN-005 D-14 path) and is never stored; the ledger item comes from the
   shared `resolveMediaItemId`. A fixed-by-hand mark needs a note (a CHECK as well as the writer).
4. **The webhook.** An `ISSUE_*` notification (the default template's `{{issue}}.issue_id`) triggers one fresh read
   (`refreshSeerrIssueFromEnv`, 5-second timeout) and answers 202 without a Feed row; an unreachable Seerr still answers
   202 and the sync catches up. Media notifications keep the Feed path. The webhook types change (204 to 4044) is
   recorded in PLAN-077 P3.
5. **Routing** (`seerrGuideEntry`, the client): an episode or movie with no file opens Force Search on it; with a file,
   Fix on it, Audio preselecting Wrong language and Subtitles Missing subtitles (Video and Other ask "What's wrong?";
   the person always confirms); a season opens Fix · Season when anything in it is on disk, else Force Search on the
   season; the whole show opens Fix with the episode picker, or Force Search · Whole show when nothing is on disk; an
   episode Sonarr does not list falls back to its season. Title Check flags on the season view wait for P4.
6. **The title page** shows one banner per open report, plus the one a link arrived with whatever its status, right
   under the title header (above the episode list): "Reported in Seerr", the type and episode, the reporter's own
   words, the date, a link to the Seerr issue and the guide button (`MediaAction` Fix or Force Search with its grain).
   Admins also see the reporter's name. A resolved report says Seerr marked it resolved and that the person can try
   again.
7. **The link** is public. Signed out it shows an onboarding card and nothing about the report (issue ids are
   sequential): three steps, "Sign in with Plex" whose `callbackURL` is the link itself (Better Auth carries it through
   Authentik; the first sign-in creates the account, R-03), and a note that the report stays open in Seerr. Signed in,
   a missing row, a row with no title yet, or one with no app reporter yet is read fresh from Seerr first; then
   `/library/<id>?seerr=<issueId>` when the person can see the title (ADR-047), else a card: not in the Library yet,
   removed in Seerr, a library the account cannot see, or no such report.
8. **First visit.** The title page opens the routed guide once, with "You reported this in Seerr. Here's what you can
   try first." above its first step ("This was reported in Seerr..." for anyone else), then drops `?seerr=` from the
   address so a reload does not open it again.
9. **Linked repairs** (D-12) are the app's own Repair Requests, Fixes and Force Searches on the same title and grain
   (a movie: all of them; an episode: that episode by id or by its SxxEyy label, its season and the whole show; a
   season: the season and its episodes), made from the report until a day after Seerr last changed a resolved report
   (an open report has no end). A Repair Request whose `seerr_issue_id` names the issue is linked whatever its grain;
   the guide does not set that column yet, and P7 sets it when the resolve needs an exact link.
10. **The staff note** (`setSeerrIssueStaffNote`): "Mark fixed by hand" opens a Modal that needs a note naming the
    missing capability; editing keeps the first mark's time and person; "Clear the mark" is the ConfirmButton
    two-step. Each change writes `update_seerr_issue_note` (before and after) in the same transaction.
11. **`/admin/seerr`** (Open by default, All adds resolved and removed reports): one card per report with the title,
    type and episode, the reporter's words, the reporter (Seerr name, and the app account or "no haynesnetwork account
    yet"), the comment count, links to Seerr, the fix-it-yourself link with Copy (built from the public origin, so it
    reads `https://haynesnetwork.com/r/seerr/<id>` from the in-cluster route too), the linked repairs (what, target,
    status, by whom, staff marked) and the staff note.
12. **Activity's admin Import Check row** (D-07 P2 decision 13): `activity.importCheck` (admin only) runs
    `planForceSearch` read-only, as if `import_check` were on, for a stuck Sonarr episode or Radarr movie; the failure
    page shows what a Force Search press would do ("Ready to import", "Needs staff", ...) and the Import Check's own
    reason. Nothing is written.

### D-12 Working practice and the readiness judgment

**Owner clarification (2026-10-12), ADR-112:** "The gate is a judgment call, not a count. The intention is to keep building haynesnetwork.com until it can handle the kinds of problems people actually report, then steer users to fix things themselves instead of staff fixing them. Working practice: every new Seerr issue is worked through haynesnetwork.com's self-service tools first, as a user would. When a tool fixes it, the reply teaches the user that tool. When no tool can, staff fix it by hand and the missing capability is added to the plan. The owner decides when coverage is good enough to make self-service the default."

This replaces the counted gate of ADR-111 C-05 and the Q-04 ruling (a replay of Cases A, B and C, then 3 consecutive
Self-Served issues). Nothing in the app computes readiness.

- **Working practice.** Every new Seerr issue (and Helpdesk media ticket) is worked through haynesnetwork.com's
  self-service tools first, as a user would. The reply on the issue teaches the tool that fixed it (the D-10 comment and
  resolve line name it). When no tool can fix it, staff fix it by hand, mark the issue fixed by hand with a note, and add
  the missing capability to PLAN-077 (or a new plan) so the next report of that kind is self-serviceable.
- **What the app keeps** (lightweight, no scoring): the `/admin` Seerr issues list (issue, title, age, linked repairs,
  and the staff note), so an admin can see what is open and which tool fixed what. The linked repairs come from the app's
  own Repair Request, Fix and Force Search records, never from Seerr status (ADR-111 C-08).
- **What was dropped:** the nightly outcome classification (Self-Served, Staff-Assisted, Unfixable), the `outcome`
  column and `ticket_outcomes`, the streak, the digest line and the replay checklist. Q-09 (whether an Unfixable outcome
  restarts the count) is moot.
- **The rule.** The owner decides when coverage is good enough to make self-service the default. Until he says so, Seerr
  issue filing stays open and the comment offers the link as an invitation (D-10). When he decides, Q-05's ruling applies
  unchanged: filing stays open, every new issue gets the fix-it-yourself comment, and staff step in only after a
  self-service attempt has failed or when no remedy fits.

### D-13 Ops dependencies outside this repo

| Dependency | Where | Needed by |
|---|---|---|
| SABnzbd extracts obfuscated `.7z` posts | haynes-ops#3834 | D-07 rule 6, D-14 |
| All three Tautulli instances post play and stop to the webhook; the Playback Error trigger is added | Tautulli settings (each instance's API or UI) | D-09 (P1, 2026-10-12: all three post play, stop and Playback Error; HaynesTower through the LAN route) |
| The Seerr webhook sends issue types | Seerr settings (API) | D-10 (done 2026-10-13: types 204 to 4044, read back; PLAN-077 P3) |
| The Seerr bridge user exists | Seerr users (API or UI) | D-10 writes |
| Case A's hand-made release profile is retired | Sonarr | D-05 adoption |

### D-14 Phase 0: stop blocklisting releases SABnzbd failed to unpack (issue #887)

Sonarr's and Radarr's "Found archive file, might need to be extracted" leaves `bad_release` and becomes report-only,
with its own reason ("archive left unpacked"), in a DESIGN-046 amendment made with the fix. Like every D-10 ruling in
DESIGN-046, it moves items toward observation. After haynes-ops#3834 ships, a census of the message decides whether it
ever returns to an acting class. The 9 episodes still missing after the earlier removals are searched again by hand.
Shipped as DESIGN-046 D-26 (2026-10-12): the message classifies `unknown` with the reason "Archive left unpacked: …".

## Alternatives considered

- ADR-109, ADR-110 and ADR-111 record the option-level alternatives.
- **Extending `fix_requests`** instead of a new aggregate: a Fix has a required reason, a blocklist-or-delete path and
  its own statuses; a re-map or an import has none of them. One shared open-check and one budget keep them together.
- **Seerr issues as Feed notifications**: the Feed is a stream of events, not a record with a lifecycle and outcome.
- **A tag-scoped release profile per series** (Case A's hand fix): one tag and one profile per affected series grows
  without bound; title-anchored terms in one profile are the Release Block's proven pattern.
- **Subtitle-text and title-card evidence**: deferred. Plex can serve a file's text subtitles, but comparing them needs
  reference text per episode, and a title card needs OCR. The Title Check census shows whether names alone leave a gap
  worth that cost.

## Test strategy

All unit and integration tests use the embedded Postgres harness (`@hnet/test-utils`) and in-memory or stub clients;
no Docker. The changes touch `packages/domain`, `packages/arr` and `packages/sync`, so `e2e-gate` runs the Playwright
suite on each PR.

| Area | Tests |
|---|---|
| D-02 | `repair-requests.test.ts`: pending row and event in one transaction before any call; budget shared with Fix and Force Search; one open repair per grain both ways; completion from the ingested import; timeout sweep |
| D-03 | `write-clients.test.ts`: each new body against the pinned fixture; the import guard |
| D-04 | `remap-plan.test.ts` (pure): shift +1/-1 order, refusals (occupied slot, cycle, split multi-episode file, more than 40 moves), discard only when ticked; `remap-flow.test.ts`: freshness abort, stop on first mismatch, rename, read-back |
| D-05 | `title-evidence.test.ts`: the three cases' real names (BiOMA silent, `S01E10.Spice.It.Up` agrees with E11, `The_Paper_2025_S02E06_125_Years_Young` agrees with 2x06, the Penguins Spanish titles disagree); `mislabel-block.test.ts`: grammar, compile check, read-back, expiry, cap |
| D-06 | `release-pick.test.ts`: state per row from rejection sets, hard refusals win, override body |
| D-07 | `import-check.test.ts`: The Paper importable, T.O.T.S. "matched by ID" importable, Penguins `title_mismatch`, archive report-only, the live Rugrats 2021 and Franklin 2025 mismatches, Aqua Teen's and Spider-Man's refusals, "Import this download onto..."; `queue-aware-search.test.ts`: Case B imports and sends no search, a failed download removed and searched once, nothing sent while a download is in progress, a changed plan refused; `manual-import-clients.test.ts` (arr): the reads and the pinned body |
| D-08 | `language-check.test.ts`: language present writes nothing to the *arr; absent grabs a matching approved release |
| D-09 | `fix-guards.test.ts`: season guard refuses a pack backing unchosen episodes; Same Release refusal; no-approved-release refusal; Playback Evidence from stored Tautulli notifications |
| D-10 | `seerr-issues-sync.test.ts`: mirror upsert, mapping, webhook triggers a read only; `seerr-issue-writes.test.ts`: one comment per issue across a crash, `X-API-User` on every call, resolve only after completion |
| D-12 | `seerr-issues-admin.test.ts`: the staff note and fixed-by-hand mark persist and the linked repairs come from the app's own records |
| e2e | `apps/web/e2e/support/stub-arr.ts` gains manual import (GET and command), release list and grab (with override), `RenameFiles`, staged queue states with status messages, file `mediaInfo`, Seerr issues with `X-API-User`, and Plex preferences. Journeys replay Cases A, B and C (AC-40..AC-42), the Seerr link and sign-in (AC-43), and the admin Seerr issues view (AC-44), at phone and desktop widths |

## Open questions

Owner decisions (asked one at a time; each answer is folded back here as a ruling). On 2026-10-12 the owner chose the
recommended option on Q-01..Q-05 and approved P1..P8 in PLAN-077's order, one phase per release, each verified live
before the next. Q-09 came up in review afterwards; the owner's clarification of 2026-10-12 (D-12, ADR-112) amended Q-04 and closed Q-09 as moot:

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Who may grab a release the quality profile rejected (Release Pick override, D-06)? Options: **A** anyone who can use Fix, within their hourly budget, for a missing episode or movie only, when every rejection is on the overridable list and nothing is on the hard-refusal list; **B** a new per-role grant, off for every role until turned on in /admin; **C** admins only, others send their pick to staff. Recommendation: **A** (it follows the "repair is a verb" ruling, ADR-080, and the refusal list carries the risk). | **Ruling (owner, 2026-10-12): A.** Anyone who can use Fix may override, for a missing episode or movie only, within the hourly Fix budget, and only when every rejection reason is on the overridable list. The hard-refusal list applies to everyone. Folded into D-06 and ADR-109 C-06. |
| Q-02 | Should the app write to Seerr issues (D-10)? Options: **A** read-only (the app shows issues and links; staff comment and resolve by hand); **B** one comment per new issue with the fix-it-yourself link, and a resolve with a note when the linked repair completes, posted as a dedicated Seerr user; **C** like B but comment only; **D** like B but posted as the owner's own Seerr account (what the API key does by default). Recommendation: **B**. | **Ruling (owner, 2026-10-12): B.** Comment once on each new issue with the fix-it-yourself link, and resolve it when the linked repair completes, posted as a dedicated Seerr bot user through `X-API-User`, never as the owner's account. Folded into D-10 and ADR-111 C-03. |
| Q-03 | When a Wrong language report finds the wanted audio already in the file, should the app change Plex for everyone (D-08)? Options: **A** set the title's preferred audio language on every server that has it, only when the wanted language is the title's original language (a dubbed default track), otherwise guidance only; **B** set it on every request; **C** never change Plex, guidance only. Recommendation: **A**. | **Ruling (owner, 2026-10-12): A.** Set the title's preferred audio language for everyone on every server that has it, only when the wanted language is the title's original language; otherwise show guidance and change nothing. Folded into D-08 and ADR-109 C-07. |
| Q-04 | What evidence makes the platform ready for "fix it yourself" to be the rule (D-12)? Today's rate is about 1.3 Seerr issues a month (4 since 2026-07-11). Options: **A** Cases A, B and C replayed end to end by a non-admin account (stubs in e2e, plus a live preview-only run of each remedy on the real titles), then the next 3 real issues self-served; **B** the next 5 real issues self-served in a row (about four months at today's rate); **C** 60 days in which every real issue is self-served, with at least 3 issues; **D** no number, the owner decides at a review once P1..P6 ship. Recommendation: **A**. | **Ruling (owner, 2026-10-12): A.** An agent replays the three cases as a non-admin user on the built tools, then the next 3 real issues are self-served with no staff help. Folded into D-12 and ADR-111 C-05.<br>**Amended (owner, 2026-10-12): the counted gate is dropped.** "The gate is a judgment call, not a count. The intention is to keep building haynesnetwork.com until it can handle the kinds of problems people actually report, then steer users to fix things themselves instead of staff fixing them. Working practice: every new Seerr issue is worked through haynesnetwork.com's self-service tools first, as a user would. When a tool fixes it, the reply teaches the user that tool. When no tool can, staff fix it by hand and the missing capability is added to the plan. The owner decides when coverage is good enough to make self-service the default." No replays and no streak; see D-12 and ADR-112, which supersedes ADR-111 C-05. |
| Q-05 | Once the gate passes, what does the rule do? Options: **A** Seerr issue filing stays open, every new issue gets the fix-it-yourself comment, and staff act only after a self-service attempt failed or when no remedy fits; **B** issue reporting in Seerr is switched off for everyone but admins (Seerr permissions) and haynesnetwork.com becomes the only place to report; **C** A for 30 days, then B. Recommendation: **A**. | **Ruling (owner, 2026-10-12): A.** Seerr issue filing stays open; haynesnetwork comments with the self-service link, and staff step in only after a self-service attempt fails or when no remedy fits (option A's wording). Folded into D-12 and ADR-111 C-05. |
| Q-09 | Does an Unfixable outcome (closed with no remedy applied, for example no release exists anywhere) restart the Q-04 count of 3 consecutive Self-Served issues? Options: **A** yes, every real issue that is not Self-Served restarts it (the ruling's literal wording); **B** no, an Unfixable issue is skipped and neither counts nor restarts; **C** it counts toward the 3 when staff confirm no remedy could exist. Recommendation: **B** (the gate measures whether self-service works where a fix exists; an issue nobody can fix says nothing about that). Gates P8 only. | **Closed, moot (owner, 2026-10-12).** The Q-04 count no longer exists (Q-04 amendment, D-12, ADR-112), so there is nothing for an Unfixable outcome to restart. |
| Q-10 | Case A's hand profile holds five blocks that are not a series and a release group (P4 decision 14). Options: **A** a new ADR adds a second Mislabel term kind, a series-anchored mislabelled name (a number with another episode's title, an alternate title, a double-episode token), written from a confirmed re-map's own file names and by the adoption, then the hand profile is deleted; **B** keep the hand profile as a hand-kept exception beside the Mislabel Block; **C** drop the five blocks (the season is complete) and delete the hand profile. Recommendation: **A**. | (open: owner) |

Driver items, resolved inside PLAN-077 (not owner questions):

| ID | Question | Resolution |
|----|----------|------------|
| Q-06 | The Title Evidence thresholds (0.8 and 0.3). | (open: tuned on the Title Check census in P4 before the Import Check relies on `disagrees`) |
| Q-07 | The exact override fields of Sonarr's and Radarr's `POST /release`, and whether `GET /release` returns releases in decision order. | **Order: resolved in P1 (2026-10-12).** Both *arrs return the decision order (D-09, P1 decision 3). The override fields stay open for P5. |
| Q-08 | Does Plex offer a preferred audio language for a movie, as it does for a show? | (open: checked in P6) |
