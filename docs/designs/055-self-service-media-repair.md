# DESIGN-055: Self-service media repair: the Repair Guide, its remedies, and the Seerr issue bridge

- **Status:** Accepted (owner, 2026-10-12: ADR-109, ADR-110 and ADR-111 accepted; Q-01..Q-05 ruled below; P1..P8
  approved in PLAN-077's order, one phase per release, each verified live before the next)
- **Implementation amendment, 2026-10-14:** driving-agent design review authorized P4 decision 40 implementation
  at 09:36Z. This is not a new owner ADR ruling or approval for live execution. Accepted ADRs stay unchanged.
- **Last updated:** 2026-10-14 (P4 decision 39 failed-grab staff continuation). Before that 2026-10-14 (P6 decision 15 paired-file track hints). Before that 2026-10-14 (P4 decision 38 owned-import follow-through and D-12 staff guidance). Before that 2026-10-13 (P4 decision 38, the coordinator's ruling on #928: the staff Wrong-Content Replace). Before that 2026-10-13 (P7 decisions 1-10 after D-11: the Seerr Issue bridge as built, the bridge user, the `seerr_issue_bridge` setting, the comment's wording, one write per issue and kind, the exact link, when the resolve happens; Q-12 raised). Before that 2026-10-13 (P6 decision 14 scoped to the audit's flagged shows, ADR-115). Before that 2026-10-13 (P4 decisions 35 to 37, issue #928's evidence: a placement may change the episode count, a second parking episode for a second open cycle, the Second-Copy Fix takes a multi-episode copy). Before that 2026-10-13 (P6 decision 14 and Q-03 amended: the owner's ruling on #955, "English if present", for staff defaults). Before that 2026-10-13 (P6 decision 3: a server's item is the one in a library of the title's own kind, PR #954; P6's live status and sweep in PLAN-077). Before that 2026-10-13 (P6 decision 13: the Language Replace never takes another post of the file's own release; decision 2: Plex lists a show's own track languages first). Before that 2026-10-13 (P4 decisions 26 to 34, ADR-114, the owner's ruling on issue #928 "Carry marks, then move": the Watch Carry, the Plex ordering switch inside it, and a two-episode file through the parking episode; decisions 10, 20, 21 and 23 amended). Before that 2026-10-13 (P6 decisions 1-12 after D-08: the language-aware Wrong language as built, Q-08 answered (a show only), the Audio Preference write and read-back, the track advice, the Language Replace, no removal without a release in the language, a season one episode at a time, the staff scan). Before that 2026-10-13 (P5 decision 17, issue #936: a release that holds several episodes, every one of them
  missing, is a pick for all of them). Before that 2026-10-13 (P4 decision 25, issue #928: the staff Second-Copy Fix). Before that 2026-10-13 (P5 decision 15: another movie's release is refused; P5 decisions 1-14 after D-06: the Release Pick as built, the season list narrowed to the episode, Q-07's override half resolved, the Release List, the open check per episode, the follow-through). Before that 2026-10-13 (P4 decisions 18 to 24, the owner's ruling on Q-11: staff's Season Re-map puts every file of a season where its own name says, passing cycles through a parking episode, after a Plex check, a watch-state check and an evidence spot-check). Before that 2026-10-13 (Q-10 ruled A, ADR-113: the Mislabel Block's mislabelled-name terms, D-05 "Q-10 ruling decisions"). Before that 2026-10-13 (P4 decisions after D-05: the Episode Re-map as built, no discard, the Title Check and the Mislabel Block as built; decisions 15 to 17: a flag the person cannot act on goes to staff, a library's own names are no evidence, staff run the re-map from the cluster). Before that 2026-10-12 (P3 decisions after D-11: the Seerr Issue mirror, the title page reports, the `/r/seerr/<id>` link, the admin list and Activity's Import Check row; P2 decisions in D-02, D-05 and D-07; P1 decisions in D-08 and D-09; D-12 and Q-04 and Q-09 amended: the readiness gate is the owner's judgment, ADR-112)
- **Satisfies:** PRD-001 R-262..R-271, US-18, US-19, AC-40..AC-45; governed by ADR-109 (repair in place), ADR-110
  (episode-title evidence; amended by ADR-113, mislabelled-name terms), ADR-111 (Seerr issue bridge and readiness gate). Extends DESIGN-005 (Fix D-15, Force Search
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
  with P5 (P5 decision 8), and P5 narrows the open check for an episode remedy to its episode (P5 decision 6). The `refused` status exists but P2 never writes it: every refusal is thrown before the row, as in P1.

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
| `setAudioLanguagePreference(ratingKey, locale)` (named `setItemPreference` before P6) | each Plex server that carries the show | `PUT /library/metadata/{ratingKey}/prefs?audioLanguage=<locale>` | D-08, a show's original language only (Q-03 ruling, Q-08: a show only; P6 decision 2) |
| `commentOnIssue`, `resolveIssue` | Seerr, with `X-API-User` | `POST /api/v1/issue/{id}/comment`, `POST /api/v1/issue/{id}/resolved` | D-10, as the bridge user (Q-02 ruling) |
| `scrobble`, `unscrobble`, `setProgress` as each account | each Plex server, with the account's own token (the owner's, or a friend's per-server token from plex.tv `shared_servers`) | `/:/scrobble`, `/:/unscrobble`, `/:/progress` | P4 decisions 26-34, the Watch Carry (ADR-114), staff moves only |
| `setShowOrdering`, `refreshMetadata` | each Plex server carrying the show | `PUT /library/metadata/{show}/prefs?showOrdering=`, `PUT /library/metadata/{show}/refresh` | P4 decision 31, inside a Watch Carry only |

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
   *Staff's Season Re-map (P4 decisions 18 to 24) orders swaps and rotations through a free parking episode; the
   person's re-map still refuses them.*
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
- **Mislabelled names** (ADR-113, the owner's ruling on Q-10): the block also holds terms that name a mislabelled
  release name instead of a group: a `pair` (a number with another episode's title, `S01E11 Secret Menu`), a `double`
  (a double-episode token, `S01E13E14`) and an `alias` (an alternate title Sonarr lists for the series). Pair and double
  carry the series anchor; an alias names the series by itself. Staff add them, and the adoption moves Case A's five in,
  through the same single writer; no person is offered one.

**Q-10 ruling decisions (2026-10-13, ADR-113, built in PLAN-077 P4).** Kept apart from the numbered P4 decisions below.

- **The grammar** (`release-terms.ts` `renderMislabelNameTerm`, `mislabelNameKindOf`):
  `pair` `/^(?=.*(?<![a-z0-9]){series}(?![a-z0-9]))(?=.*(?<![a-z0-9])s0*{S}e0*{E}[^a-z0-9]*{title}(?![a-z0-9]))/i`,
  `double` the same series lookahead then `(?=.*(?<![a-z0-9])s0*{S}e0*{E}[^a-z0-9]*e0*{F}(?![a-z0-9]))` (F after E),
  `alias` `/^(?=.*(?<![a-z0-9]){alias}(?![a-z0-9]))/i`. The words are the exact form's, joined by `[^a-z0-9]*` (their
  apostrophes, accented letters and `&`, as the group term's series words). The episode token is the show template's
  `s0*` form, so `S01E11`, `S1E11` and `S01E011` match and `S01E110` and `S11E11` do not. The hand profile's `[ ._-]`
  and `\b` become `[^a-z0-9]*` and the lookaround boundaries, as in decision 13. A strict template check that also
  compiles the term runs before every write; the writer accepts a group term, a name term or the sentinel and nothing
  else (`isMislabelBlockTerm`).
- **Reading a name** (`parseMislabelName`): a pair is `SxxEyy` then title words (`S01E11 Secret Menu`, or
  `s1e11 secret menu`); a double is `SxxEyyEzz` with z after y (`S01E13E14`, `S01E13-E14`); an alias is a title. Its
  display text (`name_token`) is `S01E11 Secret Menu`, `S01E13E14`, or the alternate title as Sonarr spells it. Season
  0 to 999, episodes from 1. A title word the term cannot write (another script, a symbol) is refused
  (`name_unwritable`).
- **The checks** (`deriveMislabelNameTerm`, ADR-113 C-02): the term must match the mislabelled name in a release title
  of the series, raw and dotted. It must match no ordinary release name of the series (`name_too_broad`): the title
  with every ordinary tag; a pair's words under the next or previous episode or the next season, or an ordinary tag in
  place of its words (`S01E11 1080p` would block the whole episode); a double's two episodes alone and the doubles
  beside it; any release under the series' own title for an alias. A pair must not match a release that gives its
  number the title Sonarr has for it (`name_is_correct`: `S01E12 Secret Menu Item` would stop the right release; the
  titles come from `GET /episode?seriesId=`). An alias must be one of the series' `alternateTitles` (`alias_not_listed`,
  compared folded; the Sonarr series schema gains the field) and must differ from its title (`alias_is_title`). No
  kind may match another library series (`names_other_series`). The series title is the ledger's, else Sonarr's.
- **The writer** (`addMislabelNameTerm({ seriesId, kind, name, origin: 'staff' | 'adoption', dryRun })`): the term is
  derived before the lock (it needs Sonarr's reads), then the group term's `saveTerm` writes it under the same lock:
  idempotent per (series, kind, name), case-insensitive, and per identical term text; the 500 cap counts both kinds;
  expiry; the profile write and read-back; the row in the read-back's transaction; a `removed` row for a write that
  was sent but not confirmed. No Repair Request, no creator, no offer to a person. Removal, reconcile and the hourly
  upkeep handle both kinds unchanged; the removal's audit detail gains `kind` and `nameToken`.
- **Storage** (migration 0102): `kind` (`group`, `pair`, `double`, `alias`, default `group`), `name_token`,
  `release_group` nullable; a group term has its group and no name, a name term its name and no group; a group term's
  origin is `remap` or `adoption`, a name term's `staff` or `adoption`; one live term per (series, kind, lower(group or
  name)). The previous image runs unchanged until a name term exists. After that its writer refuses every profile write
  (its grammar check does not know a name term), which leaves the profile as it is, so a rollback removes the name
  terms first.
- **Staff tool:** `mislabel-block.ts add-name --series <id> (--pair "<SxxEyy title>" | --double <SxxEyyEzz> |
  --alias "<alternate title>") [--dry-run]` adds one as staff (origin `staff`); `adopt --series <id>` takes the same
  name flags for the adoption (origin `adoption`); `list` prints each term's `kind` and `nameToken`.
- **The admin card** (`/admin/fixes`): each term shows its group or its name, then what it blocks ("release group",
  "episode with the wrong title", "double episode", "other title of the show") and where it came from. Text only.
- **Retiring the hand profile** (PLAN-077 P4, owed after the deploy, by hand as ADR-110 C-05): adopt the five names
  (dry run first), read back the Mislabel profile (id 4), then delete profile 3, remove tag 31 from series 1061 and
  delete tag 31, reading back each step. No writer deletes a Sonarr profile or tag.

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
    Plex write and a watch-state check first. **Amended (P4 decisions 26 to 34, ADR-114):** a staff move now carries
    every account's marks onto the content (the Watch Carry), and the ordering switch is built inside it (decision 31).
    The person's own re-map still does not touch Plex.
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
    the owner rules on Q-10; removing it would drop those five blocks. **Ruled (owner, 2026-10-13): Q-10 option A**
    (ADR-113): the five become mislabelled-name terms of the Mislabel Block, then the hand profile and its tag are
    removed by hand ("Q-10 ruling decisions" above).
15. **A flag the person cannot act on goes to staff** (v0.115.1, found in the live library-wide read: 692 files
    disagree, and in nearly all of them the episode the name points at keeps its own file, a whole season in another
    order). The title page's flag offers "Move it" only when that single move can run (`TitleFlag.movable`: the
    target episodes are free or hold this same file); otherwise it says "That episode already has a file, so staff
    need to move this one." with an "Ask staff" link to a prefilled Helpdesk ticket. And when a move is refused because
    the file in the way names another episode itself, the refusal says the two would have to trade places and that
    needs staff, instead of "Fix that episode first" (a Fix would delete a file that only sits in the wrong place).
16. **A library's own file names are no evidence** (v0.115.1, found in the first hourly census): files re-imported from
    a folder of files a Sonarr had already renamed (the 2026-10-12 hand fix of The Loud House S05 re-imported from a hold
    folder) carry that library's earlier, wrong titles (`The Loud House (2016) - S05E46 - Appetite for Destruction
    [AMZN WEBDL-1080p]...`). A name in that shape (`<title> (<year>) - SxxEyy - <title> [`) is not judged: the Title
    Check records it `silent`, and the re-map never shows it as what the file's name says. 15 of the library's 692
    disagreements had such a name (The Loud House 12, Be Cool, Scooby-Doo! 3).
17. **Staff run the re-map from the cluster** (v0.116.0). `repair-guide.ts remap-run --tvdb <id> --season <n>
    (--shift ... | --move ...) --digest <digest>` runs the guide's own `runEpisodeRemap` for a plan staff checked with
    `remap-plan` (a changed plan is refused). Its Repair Request has no requester (`requester_id` null, the trail's
    first step names the staff tool), the "audited, actor null" pattern of the settings, and draws on no one's budget.
    This is how the live census's whole-season offsets that the re-map can fix are worked by staff (issue #916), since a
    person's sign-in cannot be driven from inside the cluster. A staff shift that offers the Mislabel Block (its result
    prints `mislabelGroups`) is accepted with `mislabel-block.ts offer --repair <repair id> --group <group>` (staff, no
    requester). The in-cluster tools now exit only once stdout has drained (a large report piped through `kubectl exec`
    was cut at 64 KiB); the sibling scripts under `packages/sync/src/scripts` got the same fix.
18. **The Season Re-map** (owner ruling on Q-11, 2026-10-13: option A; issue #916). Staff, never a person, from the
    in-cluster tool: `repair-guide.ts season-plan --tvdb <id> --season <n> [--place <from>:<to>,...] [--keep <n>,...]`
    reads and prints the plan; `season-run ... --digest <digest> [--ignore-plex]` runs it (requester null, decision 17;
    behind `episode_remap`). Every file of the season goes to the episode its own names say: the Title Check's precedence
    over its scene name and its judged import name (any `agrees`, else `disagrees`, else `ambiguous`, else `silent`;
    decisions 12 and 16), or where a staff placement says (`--place 21:28`, a two-episode file `--place 53-54:27-28`),
    which outranks a name. A file whose names say nothing stays unless staff place it; `--keep` holds a file in place.
    `season-remap-plan.ts` (pure) and `season-remap-flow.ts`.
19. **Nothing displaced, nothing deleted.** A move is held when an episode it needs keeps a file that does not move:
    `duplicate` (that file's own name agrees with the episode, so this one is a second copy), `collision` (two files
    name one episode), `blocked` (the file in the way stays: held itself, kept, or its name says nothing) and
    `multi_episode` (a two-segment file whose name disagrees; staff place it with a range). Holds cascade to a fixpoint:
    a held file's episodes stay occupied. The plan lists the files whose names say nothing but sit where a moving file
    belongs (`unplaced`), each with a suggestion (the one episode left over if every name-led move went ahead, or an
    ambiguous name's best guess among the leftovers), and those leftover (`open`) episodes. Staff confirm by evidence
    (decision 24) and place them. A second copy, or a file holding another season's or a special's episode, may be
    placed by staff on an open episode of its own chain so the rest of the chain lands: it stays wrong there, still
    flagged (its name still disagrees), and that episode's own file is missing from the library (Fix or Release Pick).
20. **Order and the parking episode.** A step is ready when the episodes it moves onto are free (no file, or left by an
    earlier step). When no step is ready the waits form a cycle (a swap or a rotation): its lowest single-episode file (in a cycle of
    two-episode files only, its lowest file, decision 34) moves first to the **Parking Episode** (an episode of the series with no file that no step targets and no queued
    download or season pack targets, since an import landing on a parked file would replace it; an unmonitored episode
    first, as Sonarr grabs nothing for it, then this season, then specials, then any other season), the rest of the
    cycle follows, and the parked file then moves to its own episode. One parking episode serves every cycle in turn. A series with no free episode at all refuses a cycle
    (`no_parking`): the files cannot pass each other through Sonarr, so the season is listed as a leftover. At most 120
    steps a run.
21. **The Plex check.** Plex reads the episode number from the renamed file and titles the item from its own agent (TMDB
    order on HaynesTower and HaynesOps, except shows switched to TVDB), so a Sonarr move only fixes what viewers see when
    Plex's title for the episode a file moves to is that episode's TVDB title. The plan reads every Plex server that
    carries the series (`media_plex_matches`, then `allLeaves`), counts the season's items whose Plex title is the TVDB
    title of the same number (folded words, Dice at least 0.8; "Episode 13" placeholders say nothing), and lists each
    move whose episode Plex titles differently (an episode with no Plex item yet passes only when the server follows
    TVDB for at least 90% of the season). Such a move makes Plex **worse** when Plex shows the file's own title where it
    sits today (its numbering follows the release, not TVDB); a move whose title is wrong in Plex before and after is
    no worse, and goes ahead with the rest. A run refuses any move that makes Plex worse, or a check that could not be
    done (the plan prints the server's error), unless staff pass `--ignore-plex` (recorded on the Repair Request). So a
    season whose Plex numbering follows the release is left alone: moving it in Sonarr would put the wrong title on it
    in Plex. Switching a show's Plex ordering is staff's `ordering-run` inside a Watch Carry (decision 31).
22. **The run renames as it goes.** Each step: the file's own manual-import candidate, read from the season it sits in
    now (a parked file sits in the parking season); one `ManualImport` (`move`, the decision 6 fields) onto the step's
    episodes; the read-back (the file at its path holds exactly those episodes, under its new id); one `RenameFiles` for
    that file; and the rename read-back (it is off Sonarr's rename preview for that season, under its new path).
    Renaming each step, not once at the end as the person's re-map does, is what lets a cycle pass: the parked file has
    given up its old name before the file taking its episode needs that name. The first step that does not land, or
    whose rename Sonarr skips (a name another file still holds; Sonarr never overwrites), stops the run. Every step
    before it is whole; a file left on the parking episode is reported with the episodes it belongs on (finish it with
    `--place`). Each landed file's names go with it (`carryTitleCheckForward`): a step re-links the file under a new id
    with no import record and no scene name, so the run writes its Title Check row for the new id, judged against its
    new episodes (keeping the old row's origin and import time) and clears the old flag. A second copy moved aside stays
    flagged where it lands. The run then checks that the series holds as many episode files as before. One Repair Request (`remap`,
    claim `names`, the steps, the files held and why, the Plex check) records every call; a season re-map offers no
    Mislabel Block (it is not a shift).
23. **Watch state first** (owner ruling, 2026-10-13). Plex keeps watched marks and resume points on the episode, not the
    file (decision 10), so a move changes what an existing mark means. Before a season runs, staff read every Plex
    server's database for that season, read only, for every account (`metadata_item_settings` view count and offset,
    and `metadata_item_views`). A season where any real person has watch state is not moved; it is listed for the owner
    with the counts. The app's Plex token sees only the owner's own state, so this is a staff step, not a code check.
    **Superseded by decisions 26 to 34 (owner ruling on #928, 2026-10-13: "Carry marks, then move"):** `season-run`
    now reads every account itself (the Carry Snapshot) and carries their state across the move, so a season with
    watch state is moved, and the database read is no longer needed.
24. **Evidence before each season** (owner ruling, 2026-10-13). Staff spot-check at least one swapped pair per season
    against the files' own subtitle streams (short reads, no full decodes; a title card frame when a file carries no
    text subtitles) and the TVDB overviews. A season where the evidence contradicts the names is skipped and reported.
    Every `--place` comes from such a read. Subtitle files beside a video are no evidence: they were fetched for the
    episode the file sat on.
25. **The Second-Copy Fix** (coordinator ruling on issue #928, 2026-10-13: a second copy is a bug, fix it). A **second
    copy** is an episode file that holds another episode of the season, one that has its own file: its slot plays the
    wrong episode, and the slot's own episode is missing from the library. Staff remove it with the app's Fix run as a
    no-person request: `repair-guide.ts copy-plan --tvdb <id> --episode S06E10 [--copy-of <n>]` reads;
    `copy-run ... --digest <digest> --evidence "<what was compared>"` runs (`second-copy-fix.ts`). The plan refuses
    when the slot has no single file of its own, when the file's names (or staff's `--copy-of`, from evidence) name no
    other episode, when that episode has no file of its own (`only_copy`: deleting would lose it, so a re-map or a
    report instead), when another file of the season says it is this slot's episode (`content_elsewhere`: the content
    is already in the library, so a re-map, not a search, fills the slot), or while a download for the season is
    queued. The run opens a Fix Request with no requester (`createFixRequest` takes `requesterId: null` for the staff
    tool, as decision 17 did for Repair Requests: no budget, the trail names the tool), reason `wrong_content`, path
    `delete_search`. It deletes the copy, reads back that the slot is empty and the original still holds its own file
    (else it stops before searching), and sends one EpisodeSearch for the slot. The person's Replacement Preview is not
    a gate here: the copy's content stays on its own episode, so nothing is lost if no release is found and the slot
    shows as missing. Staff confirm first, by subtitles or durations, that both files hold the same episode.

**The Watch Carry** (P4 decisions 26 to 34; ADR-114; owner ruling on issue #928, 2026-10-13: "Carry marks, then move").

26. **What it is.** Plex keeps a person's plays, watch date and resume point on the episode item (by its guid), not on
    the file. A staff move changes what those marks point at, so every staff move carries them: `season-run`,
    `copy-run` and `ordering-run` always run inside a **Watch Carry** (`watch-carry.ts`): (1) a stored **Carry
    Snapshot** of every account's state, refused when it cannot be read; (2) the items the move takes files away from
    are cleared; (3) the move; (4) once Plex shows each moved file on its new item, each account's state is written onto
    the item that plays the file they watched; (5) every account is read again and checked. The person's own re-map
    (D-04) does not carry, and does not need to: it never moves a season anyone has watched without staff (decision 15).
27. **Content is the file.** On each Plex server a file is known by its byte size (a move and a rename keep it; the
    item's file name is kept for reading the record). An account's state for a file is its state on the item that
    played it, summed over every item that played it (plays), with the latest resume point. Plex shows a two-episode file
    as **one** item, at its first episode's number (read live: Mickey Mouse: Mixed-Up Adventures S01, `S01E13-14-15-16`
    is item E13 alone), and plays the whole file from it, so a mark on that item means the person watched the whole
    file, both segments. A second copy's plays count for its original's file (decision 32).
28. **The snapshot.** For every Plex server that carries the series (`media_plex_matches`), the owner's token reads the
    show's library section and every item of the scope with its files (`allLeaves` with `Media[].Part[]`), and every
    account that can see that section is read with its own token: the owner, and each friend whose plex.tv
    `shared_servers` share includes the section (their per-server `accessToken`, read at run time, held only inside
    that friend's client, never stored, logged or printed). The scope is the season and the parking season (a re-map),
    the season (a second copy), or the whole show (an ordering switch). Rows: `watch_carries` (the item map per server,
    the scope, the counts by account index) and `watch_carry_states` (one per account and item with state: plays,
    resume point, last watch, the files). Any account that cannot be read refuses the move, writing nothing. A new
    snapshot of a series is refused while an earlier carry is `cleared`, `waiting` or `mismatch` (it would read the
    cleared or not yet carried items as unwatched, and those marks would be lost): `carry-finish` or `carry-revert`
    first. HaynesTower on 2026-10-13: the owner and 40 friends can see the
    TV library; 11 have state on the held seasons. Plex Home managed users have no token here and are not read.
29. **Clear what would be orphaned, before the move.** HaynesTower empties the trash after every scan, so an item whose
    file leaves disappears, and its guid's state outlives it: the next file to land on that episode would come back
    "watched". So the items holding a file the move takes away (a re-map's moving files; a second copy) are cleared for
    every account with state on them (`unscrobble`) before the move. An ordering switch clears the items whose Plex
    title differs from Sonarr's for the same number (the items it re-matches). The snapshot keeps what was cleared. The
    carry is marked `cleared` before the first clear, so a run that dies part-way blocks a new snapshot. Any failure (a
    write, a read, the audit) puts back every item already cleared, from its state now (a clear that landed but timed
    out is not doubled), and refuses the move (`refused`); an item that cannot be put back leaves the carry `cleared`
    and the error asks for `carry-revert`.
30. **The carry.** After the move, for each account and each item of the write scope (an item that holds a touched file
    now, or that held one before and still exists), the target is the state of the file it holds: **carried**, the plays
    (one `scrobble` each, at most 5) and the resume point when the person had watched the file; **partial**, only the
    resume point (above 60 s, the least Plex keeps on an unwatched item) when they had played part of it; **stale**,
    nothing, when they never played that file (its old mark is cleared). An item playing two files counts as watched
    only when both were (otherwise `partial`). Calls: nothing when the item already matches (plays equal, resume within
    5 s); a lone `progress` when only the resume point differs; otherwise `unscrobble` (when anything is set), the
    scrobbles, then `progress`. Items whose file did not change are never written. An item the account played after the
    snapshot that the carry did not write is left alone (a real new view). **Two-segment re-pairings:** the file is the
    unit, so a mark is carried only when the person watched the whole file that the new item plays; a resume point inside
    it is carried as a resume point, never as a mark, and recorded `partial`. Before writing, the carry waits (paced, up
    to 15 minutes) until every server shows each moved file on the item of its Sonarr season and first episode; Sonarr
    asks both servers to scan the folder after each rename, so this is usually immediate. A wait that runs out leaves the
    carry `waiting` for `carry-finish`.
31. **The Plex ordering switch** (decision 10's ADR is ADR-114). `repair-guide.ts ordering-plan --tvdb <id> --ordering
    tvdbAiring` reads each server's current ordering and how its titles agree with Sonarr's (the items that differ will
    re-match), with a digest. `ordering-run ... --digest <d>` re-plans, takes a whole-show snapshot, clears the
    differing items, then per server sets `showOrdering` (`PUT .../prefs`), reads it back and refreshes the show
    (`PUT .../refresh`). It then waits (paced, up to 20 minutes) until each server's listing is unchanged across two
    reads with 90% of the re-matched files on items titled as Sonarr titles them, or unchanged across five reads (Plex's
    own TVDB data can differ from Sonarr's, as The Thundermans S4 does), and carries and verifies over the whole show.
    The switch's before and after per server are on the carry. `''` (`--ordering default`) puts the library default
    back, inside a carry too.
32. **The Second-Copy Fix carries too** (the #928 case: The Simpsons S38E02 holds S38E01's content, and one person
    watched it). `copy-run` snapshots the season with the copy's file deleted and the same as the original's, clears the
    copy's item for everyone with state on it before the delete, and after the delete credits each person's plays of the
    copy to the original's item. Nobody keeps a mark on the emptied episode, so its real episode comes back unwatched for
    everyone who never saw it.
33. **Verification and records.** After the writes each account with state, or written, is read again: every watched
    file shows watched on the item that plays it, every resume point sits on the item holding its file, and no item in
    the write scope whose file the account never played shows a mark. The counts per server and account index (watched
    files carried, resume points, clean items, new views left alone, failed writes, mismatches) are on the carry and
    printed by the tool, never a name. Status `verified` or `mismatch`; the season re-map's Repair Request and the copy's
    Fix Request record the carry's id and status. Every mark written is one append-only `watch_carry_marks` row (the
    state found, the state written, the calls, the result, the phase), in the transaction of the carry's counters.
    `carry-status (--carry <id> | --tvdb <id>)` prints carries; `carry-finish --carry <id>` runs decision 30 again from
    the stored snapshot (writing only what still differs); `carry-revert --carry <id>` puts every item the carry wrote
    back to its state before the carry first wrote it, newest first. The watch date of a carried mark is the carry's time
    and plays above 5 are carried as 5 (the snapshot keeps both). Pacing: 200 ms between accounts' reads and between
    writes; one season at a time.
34. **A two-episode file passes through the parking episode** (found planning Daniel Tiger's Neighborhood S05, whose
    two-story files are paired against TVDB in two swaps). A cycle with no single-episode file used to refuse
    (`no_parking`); now its lowest two-episode file parks on the one parking episode (Sonarr maps a file to whatever
    episodes the import names) and its move back puts it on both its episodes again. Decision 20 is otherwise unchanged.
35. **A placement may change the number of episodes** (found in the evidence for #928: Spidey and His Amazing Friends
    S01, where the file Sonarr has on episode k holds TVDB's two segments 2k-1 and 2k; S05, where a file on E05-E08
    holds E03-E04). `--place 17:33-34` puts a one-episode file on two episodes, `--place 5-8:3-4` a four-episode file on
    two, and `--place 29-30:25+32` names episodes that are not next to each other (at most 10). The plan still checks
    that the left side names exactly the episodes one file sits on, and that no two placements share an episode.
36. **Two cycles open at once each get a parking episode** (Daniel Tiger's Neighborhood S05 E18-E25: the E18-19 file is
    in two cycles at once, so the plan used to park one file and then find no free episode for the second cycle). When
    no step is ready and a file is already parked, the next cycle parks one of its own files on the next free parking
    episode (same order as decision 20). A stop reports every file still parked. A series with no free episode at all
    still refuses (`no_parking`): Bubble Guppies S05 and Mecha Builders S01, where every episode of the series has a file.
37. **The Second-Copy Fix takes a multi-episode copy** (Paw Patrol S06E48-49 holds the same file content as E46-47;
    Spidey S05's E09-12 file is a copy of E05-06's). The slot is every episode of the season the copy sits on: all are
    emptied, read back and searched. The copy must sit in one season only. A multi-episode copy's names are no evidence
    of everything it holds, so staff name every episode it holds (`--copy-of 46-47` or `46+47`), and each must keep a
    file of its own (else `only_copy`, or `not_a_copy` for an episode of the slot itself); the read-back checks every one
    of them, and the carry credits the copy's plays to each. A stop of a season re-map reports every file still parked
    (`parkedAll`). A copy byte-identical to its original (The
    Simpsons S38E02 and E01: 719,258,375 bytes each) is one content already; the carry tells the copy's item apart by
    its file name, clears it, and credits its plays to the original's item. The carry's wait checks files of one size
    together (each must sit on its own Sonarr episode).
38. **The Wrong-Content Replace** (coordinator ruling on #928, 2026-10-13: wrong-content files are bugs; find a correct
    release first, then replace). A file that holds the wrong content (Mickey Mouse: Mixed-Up Adventures S01's files
    are Season 3 stories; Pokémon S03E01-E34 are Pokémon Horizons episodes; Ben 10 (2016) S01E10 and E12 are Ben 10
    (2005) episodes) is replaced only when a correct release exists. `repair-guide.ts replace-plan --tvdb <id> --episode
    S03E01` only reads: the Release Pick's season search, judged as if the file were already gone
    (`previewReplacementList`: the slot's episodes count as missing, and a rejection about that file alone, an
    Existing-File Rejection or "Episode file on disk contains more episodes", goes with it). It keeps the releases whose
    names agree with the slot's episode (Title Evidence `agrees`; a name without a title is no evidence here, since
    Pokémon Horizons' own `S03E01` releases are what put the wrong files there) and that cover exactly the slot's
    episodes, a plain grab first. With none, the plan refuses `no_release` and the wrong file stays, flagged, waiting for
    a release (an empty slot helps nobody). `replace-run ... --key <k> --digest <d> --evidence "<what was read>"
    [--same-as S03E07,S03E08]` re-plans (one fresh search), snapshots the watch state (Watch Carry kind `wrong_content`,
    migration 0106), opens a Fix Request (requester null, `wrong_content`), deletes the file, reads the slot back empty,
    and grabs the chosen release onto the slot's episodes with Sonarr's override body (`sendReleaseGrab`: the *arr judged
    it while the file was there). A mark on the wrong content never lands on the replacement: `--same-as` names the
    episodes of the show whose own file holds that story, and the carry credits the plays there; without it the marks are
    dropped, each recorded on the carry (`droppedDetail`: account index, file size, state) beside the pre-clear audit
    row. Each import is then checked by subtitles or a title card.

    **Deletion recovery:** before the first delete, the carry records every planned file as awaiting read-back. A
    failed delete stops the run before any grab. Sonarr's file list and every named episode distinguish removed files
    from retained files; missing episodes or failed reads leave the outcome unresolved. The carry's single writer
    stores that evidence and its resulting scope together. Retained files get their pre-clear restored, with each
    write audited; only confirmed removals can credit a copy or drop a mark. If the outcome remains unresolved,
    the carry stays open and neither `carry-finish` nor `carry-revert` may apply the planned deletion scope.
    `carry-finish --carry <id>` first repeats that bounded Sonarr read-back for a Wrong-Content Replace, then restores
    retained content and finishes confirmed removals. Restoration verifies the current file's name and size, so a
    new correct file cannot receive the wrong content's marks. A failed grab leaves its affected episodes missing;
    staff use `release-list` or Fix for a new pick, because deleting a file does not start a Sonarr search.
    Copy mappings remain keyed by the source file id. Equal-size source files with different copy mappings refuse
    before writes; a partial deletion that cannot distinguish a removed source's mapping from a retained equal-size
    source keeps those sources unresolved, rather than crediting another file's marks.
    The run requires a Plex adapter and a stored Watch Carry; an absent adapter refuses before any write. Read-only
    planning remains available without Plex.
    The Fix records successful delete attempts and the per-file/episode read-back before loading or settling the
    carry. A post-delete audit or recovery error stops every grab and attempts a failed transition with that evidence.
    If the audit cannot be saved, the error says so and points staff to `carry-status` and `carry-finish`; the stored
    carry remains the recovery source. Partial-delete errors name confirmed missing episodes and direct staff to
    `release-list` or Fix for a new pick.
    The Fix creation and its carry link commit together; a failed link rolls the Fix back before any delete. The
    stored deletion plan records its version and `grabStarted: false`, then commits `true` before the first release
    POST. Staff recovery keeps a durable no-grab closure marker before changing the scope, validates the linked
    staff Fix and media, and closes a pending/actioned parent through `recordFixAction` once recovery succeeds. A
    repeated recovery is idempotent. Recorded or possible grabs, search-triggered parents and completed parents keep
    their lifecycle. A failed pre-clear restoration names `carry-finish` for Wrong-Content Replace, because its
    pending deletion scope blocks a generic revert.

    The live plans (2026-10-13) added four things. **Several files:** `--also 34` replaces more files with the slot
    when one release holds all their episodes (Mickey's S01E33 and E34 files each sit on one episode, and the right
    release `S01E33E34` holds both); `--same-as 33:S03E65,34:S03E67` names which file each copy belongs to.
    **Parts:** a slot may be filled by several releases that together land on each of its episodes once (`--key a,b`;
    Mickey's S01E13-E16 file is refilled by `S01E13E14` and `S01E15E16`); any other set is refused before anything is
    written. **Renumbered releases:** Sonarr files Mickey's `S01E01E02.Mickeys.Wild.Tire..Sittin.Kitty` on E01 to E04
    (scene numbering, doubled); in replace mode the Release Pick judges such a row by its own name, holding the episodes
    its name numbers, as an override, and a pick only when its titles name them (`classifyReleases` with `replacing`;
    the person's Release Pick still refuses it). **One search:** each plan and run reads the season list once and the
    list is cached (five minutes); `replace-plan --season <n> --slots 1,3,33+34` plans many slots from it and
    `replace-batch --batch '<json>'` runs them in one process, keeping the list after each grab, pausing between slots
    and stopping at the first refusal. Indexer API hits are capped, and a season search per slot would spend hundreds.

    **Owned import recovery (2026-10-13, #928 live evidence).** A release override can record the intended episodes in
    Sonarr's `grabbed` history while its tracked queue reparses the original release numbers. Pokémon's named Johto
    E01 was grabbed for E01 but the queue tracked E12; Mickey's E01/E02 queue tracked E01-E04. Native import remained
    blocked and the unselected library files stayed intact. The queue guard and the janitor's class/mode remain
    unchanged: the real enforced Import Check refuses these downloads. Opening another `import_download` repair also
    refuses while the request that owns the grab is open. Completing that parent to bypass this guard is forbidden.
    An internal, parent-owned Sonarr Import Check therefore plans/runs the existing explicit import write-back under
    the original Fix or `release_pick` Repair Request. Its targets come from the stored parent intent and an exact
    matching `grabbed` history download/title, never episode IDs supplied by the caller. The parent must be open and
    belong to the caller (or an authenticated admin); actor-null staff is an explicit internal call, not public input.
    For a Wrong-Content Replace the linked carry, durable grab-start intent and verified deletion are required.
    Planning preserves every Import Check refusal and requires whole-file coverage to equal the intended episodes,
    all intended episodes to be empty, and fresh candidate/source/unchosen file identities in the confirmation digest.
    Ownership never strips a quality rule. Sonarr 4.0.20.3012's transient `POST /api/v3/manualimport` reprocess endpoint
    (not PUT) reruns its real import decisions against selected episode IDs without importing a file
    ([controller](https://github.com/Sonarr/Sonarr/blob/v4.0.20.3012/src/Sonarr.Api.V3/ManualImport/ManualImportController.cs),
    [service](https://github.com/Sonarr/Sonarr/blob/v4.0.20.3012/src/NzbDrone.Core/MediaFiles/EpisodeImport/Manual/ManualImportService.cs)).
    The parent audits that evaluation before the call and preserves every fresh rejection it returns. This can remove
    a comparison against an unselected existing file while keeping a genuine quality/title/other hard rejection.
    Before ManualImport the original parent records the intent through its audit writer. Its result, command read-back,
    target file identities and unchanged unselected files join that same trail. A claimed/uncertain attempt is observed,
    never replayed; a finished import is adopted without a second command. Completion remains the normal import-ledger
    matcher. This staff recovery adds no public parent-ID argument, parallel repair, implicit re-map or automatic batch
    replay. Staff finish one owned download and verify its physical story/language before a fresh remaining-slot plan.
    The same continuation belongs in a person's Import Check: Force Search derives the parent and download from its
    authenticated server context, target and grab history before native queue-number filtering. It exposes the existing
    Import Check shape with the entire intended file coverage, never public parent/actor arguments or a sliced import.
    Its confirmed run uses the same parent claim and preserves other requests' guards. Public audit evidence records
    confirmation of the shown plan, without inventing physical probes; staff's CLI evidence records actual story/audio
    checks. The GET-only preview retains the current refusal and marks a required selected-target check; it never
    claims that an unevaluated file is already importable. The driver-approved UI uses canonical
    `MEDIA_ACTIONS.checkImportDownload`, label **Check and import**, as the primary non-destructive action inside the
    existing explanatory Modal. Its heading is **Check this download for {targetLabel}** and its explanation is
    **This download was matched to different episode numbers. Check it against the episodes you requested before importing.**
    The raw rejection stays visible. Confirmation checks the whole intended set, then imports only when Sonarr's fresh
    selected-target decision approves. The action-anatomy mirror/parity checks cover the new registry action. An existing
    library-command claim is observed without another import command; transient evaluation is audited separately before
    the actual import claim, so a rejected evaluation never pretends a command is in flight.
    An exact owned grab that is still downloading returns `waiting` (the existing `on_its_way` UI), including when its
    native queue numbers differ from the intended episodes. It neither opens another request nor sends a search/import.
    Discovery distinguishes an executable owned import from read-only request status. An ordinary Fix/repair or another
    person's open parent still owns its matching episode/season: a positively associated downloading queue shows
    `on_its_way`; a blocked or unanchored request shows the existing staff state. A missing grab-history anchor never
    permits a new search or import. Only a fully validated owned parent and exact history can expose an import handle;
    read-only status does not grant ownership or bypass another open request.
    The public plan marks this read-only case `activeRequest: true`, retaining any native queue evidence. Waiting uses
    **A repair is already running** and **This episode already has a repair in progress. You can check it again in
    a little while.** Staff uses **This repair needs staff** and **A repair is already open for {targetLabel}.
    Staff can check its progress and the download.** These states expose no import/search action or executable parent ID.
    Sonarr's manual-import service marks a tracked download Imported only when the imported episode count reaches its
    parsed remote episode count. The queue service emits one row for each of those remote episodes. Mickey's parsed four
    episodes therefore cannot settle from the intended two-episode import alone. After exact owned download/time/import
    history file-ID/byte coverage and unchanged unselected files are verified, continuation forgets only still-present,
    completed, exact-title/series queue rows of that owned misnumbered download through the existing queue writer:
    `removeFromClient: false`, `blocklist: false`, `skipRedownload: true`; no client deletion or search. Original-parent
    intent/result/absence read-back audit that step; absent rows are adopted on retry and library import is never replayed.
    A verified completed parent's audit trail may append this bounded follow-through without changing its lifecycle.
    Import history's title is its scene name or physical basename (Sonarr `HistoryService`), so it is retained as evidence;
    immutable parent/download/time/episode/file IDs and bytes prove the import, rather than literal grab-title equality.
    A multipart Wrong-Content Replace keeps its Fix open until every intended deletion-slot episode in its linked
    verified versioned carry has a later actual import ledger event. The first part alone cannot close the parent and
    strand its remaining owned download. Missing, ambiguous or malformed slot metadata keeps that Fix open; ordinary
    episode/season Fix matching is unchanged. The normal matcher records all matched episode/event IDs in completion.

39. **Continue a failed staff replacement on its original repair (live finding, 2026-10-14).** Mickey's S1 E7/E8
    replacement was rejected by SABnzbd as Duplicate NZB after the original file had been removed and its Watch Carry
    verified. Automatic failed-download retry then grabbed another copy of the same wrong stories. Ordinary P5
    discovery omitted the correctly named multipart alternatives that P4's replacing mode can judge. A staff recovery
    must keep the original Fix and verified version-1 Carry, with no repeated deletion, new Carry or parallel request.
    Plan and run derive the complete intended slot from those stored records. They require a null-requester
    Wrong-Content Replace, its latest successful recorded grab followed by genuine failure history for that same
    download, no owned import claim or actual import, empty intended episodes and unchanged protected files. A raw
    numbering mismatch never changes the intended scope. The fresh digest binds those identities and the selected
    whole-slot release. Reuse P4's exact named-title classification and its narrowly defined renumbering override;
    every other hard refusal, source/group guard, quality rule and budget remains in force.

    A conflicting replacement download may be abandoned only when its exact live queue/source identity belongs to
    this media and slot and its titles/content are positively proved wrong. Record that single-download intent and
    result on the original Fix through the domain writer: blocklist it, skip redownload, leave the download-client
    files, and send no search. Re-read the queue, empty slot and protected files before the next grab. Record the new
    grab intent before calling the existing release writer, then its actual receipt. A claimed or uncertain removal
    or grab is observed or refused; it is never replayed. No caller-supplied episode IDs or public staff override
    grants authority. The normal parent-owned Import Check and whole-slot ledger completion handle the new download.
    Failure keeps truthful waiting evidence on that parent; it does not manufacture completion or resolve a report.

    The failed-download janitor must defer automatic re-search for a failed grab bound to an active, verified
    Wrong-Content Replace. Match the stored download and Carry scope rather than reparsed queue episode numbers.
    Record the hold without changing class enforcement settings or spending the loop guard's search budget.
    Unrelated downloads retain their normal policy. This avoids an automatic search racing the explicit recovery.
    Staff attribution stays null and explicit; a database role lookup never substitutes for authenticated user action.

    **Implementation:** `planWrongContentRetry` and `runWrongContentRetry` expose only the private staff
    `replace-retry-plan` / `replace-retry-run` CLI. A plan takes `--parent fix:<id>`, optional
    `--discard-download <id>`, and the selected `--key`; run also requires its fresh `--digest`, `--evidence`,
    and `--conflict-evidence` when discarding. The failure proof reads one history page of at most 200 rows;
    missing anchors refuse. Short database claims contain no HTTP calls. Each old or new recorded whole-slot
    grab retains its own bounded receipt binding for the janitor. A retry also records its actual HTTP call start
    and returned end separately from the canonical receipt audit, with the unique native download GUID when
    available. An uncertain retry is owned only inside that factual call window and actual GUID binding; intent
    alone never creates an indefinite title match. Retry GRAB time must fall from the floored second of actual
    call start through the exact returned end, with no future grace period. Both the janitor and owned-import helper consume this proof,
    keeping earlier and later same-title foreign grabs outside the continuation. If no post-call fact can save,
    staff must observe the unresolved command; no import handle or title-only ownership is manufactured.
    Hold rows keep the janitor's existing once-per-failure policy. The owned-import
    runner still requires actual new GRAB episode coverage to equal the stored intended slot; it refuses a newly
    reparsed grab rather than importing into protected episodes. Accepted commands whose response or audit is
    lost retain their durable intent and require observation, never a second release POST.

    **An intent is not a download receipt.** Save the actual release call's start and returned end separately
    from its accepted or uncertain canonical receipt. Bind at most one actual native download GUID, with full
    intended episode coverage and GRAB times inside that recorded call window. The janitor and owned-import
    continuation use the same binding. Neither the original Fix creation time nor an unbounded pending intent
    admits an earlier or later same-title foreign grab. A receipt-only audit failure may retain independently saved
    call facts. If a full database outage loses those facts, ownership remains unresolved: no import handle, claimed
    owned GUID or repeated release POST. The janitor must report that missing proof and fail closed for potentially
    affected retries, without calling an unrelated GUID owned or sealing a successful removal. Queue absence is a
    separate observation of an exact recorded discard attempt, not proof that its external command succeeded.
    Missing call proof holds only failure rows matching the validated parent's series and full-slot release intent,
    with available native GRAB identity and recorded time bounds checked. Record those rows as observations with
    an explicit unresolved-proof reason; this is not positive download ownership or permission to import or replay.
    Other series, release titles and downloads outside a known call window continue through their ordinary policy
    in the same run. One unresolved repair must not abort the entire Sonarr failed-download pass.
    If the native GRAB lookback omits an older download, check available ledger GRAB identity and time before
    treating its failure as potentially matching. Known evidence outside the intent/call window excludes that hold.
    Read old production intents from their recorded `release` or `title` field, including the single-release legacy
    Carry, so a newer receipt does not erase the original download's ownership.
    A fast native import may complete that same Fix before its HTTP response evidence is saved. Factual post-call
    audits may append to the completed parent under the existing claimed attempt; they preserve its lifecycle and
    cannot authorize another command. New claims still require the original open, verified repair. Test this race
    through actual native-history ingestion and normal whole-slot completion rather than forcing a database status.
    **Retry attempts follow actual failed downloads.** A durable claim is scoped to the positively identified
    failed GRAB attempt and download GUID, rather than to the first retry ever made on this parent. A later
    genuinely failed owned download may receive a fresh reviewed attempt on the same Fix and Carry. Its saved
    actual call/GUID window, unique whole-slot native GRAB and later genuine same-GUID failure must prove the
    exact attempt; all protected identities remain unchanged and no import, library claim or queue remains for
    that failed download. A truthful accepted-but-503 call can qualify through this native proof without inventing
    a canonical HTTP200 receipt. Missing or ambiguous call facts keep the existing attempt observe-only.
    Preserve every earlier claim and outcome; never replay their removal or grab. Read-back and source/conflict
    fingerprints belong to the selected attempt, and a newer attempt cannot silently reset the protected-file
    boundary. Repeated release titles require the actual GUID and call window to identify the owned continuation.
    Durable pre-command grab-intent order determines attempt succession. A delayed factual receipt from an older
    call must never outrank a newer verified actual GRAB; join call facts to that intent's attempt identity and
    exact scope, independent of their later append order. A newer unproved command remains observe-only.
    The janitor keeps its existing enforcement modes and search budgets throughout.

40. **Recover one selected part of a Wrong-Content Replace (implementation authorized, 2026-10-14).** Decision 38 already accepts
    several disjoint releases for one original file. Mickey's final S1 E13 to E16 file holds E7/E8 stories; two
    selected releases refill E13/E14 and E15/E16. Today decision 39 requires one failed grab to cover the entire
    original slot, and an initial release-call exception makes its parent terminal `failed`. A successful first
    part or an accepted call whose response is lost can then be stranded. The proposal extends the same staff
    repair, with one original deletion and one verified Carry; it never creates a second Fix or Carry.

    **Immutable selection.** Before the original deletion, store a versioned selection on the Carry beside the
    existing version-1 `wrongContentDeletion`: each part's stable identity, selected key, release GUID/indexer,
    exact release title and sorted episode IDs. Its canonical disjoint union must equal every original deletion-slot
    episode exactly once. Store the selection digest and the full series boundary outside that original slot. A malformed,
    overlapping, missing or ambiguous selection refuses before writes. Caller episode IDs never define a part.
    Preserve decision 38's snapshot, pre-clear, same-content mapping, deletion read-back and Carry verification.

    **Truthful open lifecycle.** Once deletion is confirmed, a release-call error appends its part/attempt evidence
    through the domain writer and stops further dispatch; it does not transition this incomplete repair to
    terminal `failed`. Keep `actioned` until an actual accepted receipt or positively bound native GRAB supports
    `recordFixAction(..., search_triggered)`. Save each part's factual receipt immediately, before the next part.
    If a prior part already established `search_triggered`, append the later error without regressing that state.
    No plain SQL status repair, reopened terminal parent or new lifecycle enum is proposed. Pre-delete failures
    retain their existing recovery rules. Completed parents accept factual follow-through only, never new claims.

    **Three distinct cases.** A genuinely failed selected download may receive one reviewed retry for its stored
    part. Its finite actual call window, unique native GUID, full-part GRAB coverage and later genuine same-GUID
    failure must be proved; no import or import claim may exist for that failed GUID. A release POST exception
    alone is not a failed download. Lost response/audit, missing native identity and uncertain cleanup remain
    observe-only; absence from a bounded history page never authorizes another POST. An original selected part
    with no durable dispatch claim may be resumed once from the immutable original selection after a fresh plan.
    A claimed part is never reclassified as unattempted. This resume requires a complete selection produced by
    the new writer contract that claims before every dispatch; missing intent in an older writer's audit is not
    proof of no dispatch. Unresolved transport on this parent blocks new dispatch
    until actual proof reconciles it, even if the next part is disjoint.

    **Private API.** Extend `replace-retry-plan/run` with an exact `--failed-download` selector for a multipart
    parent; derive its part from saved attempts and native history, not from input episode IDs or raw queue numbers.
    The existing one-part decision 39 interface and guards remain compatible. For an original never-claimed part,
    provide private `replace-part-plan/run --parent fix:<id> --part <stored-part-id>`; only its exact original
    selected offer may be dispatched, after fresh classification. Both runs require a fresh digest and staff
    evidence. The caller is explicitly staff and the original requester remains null. Public routes gain no
    parent, part, actor or override argument; reuse existing safe local refusal reasons.
    Persist this in existing Carry `detail` and Fix `actionsTaken` JSONB, using existing parent row locks and
    audit writers. No new table, column, status enum, DDL or migration is needed.

    **Other parts and protected files.** The retry target must still be empty. Every other selected part is either
    empty and positively unclaimed under the complete new writer contract or genuinely pending under its recorded
    attempts, or imported from its exact positively bound selected
    GUID with immutable parent-audited native import IDs, whole-part episode/file IDs, names and source bytes.
    A native auto-import may be adopted only after the same evidence is recorded, without replaying ManualImport.
    Staff ratifies actual English and all intended stories; a filename or HTTP receipt alone is not that proof.
    An unsettled import claim, foreign file or changed original/destination identity refuses. All episodes outside
    the retry target, including imported other parts and the completed prefix, are protected in the fresh digest
    and actual pre-command/read-back boundary. A pending part may advance the original boundary only through
    proved same-parent selected import evidence; never silently replace a protected fingerprint with current data.

    **Claims and transport.** Use the original Fix row lock and append-only actions for one positive pre-write
    claim per part/failed-GUID/attempt. Revalidate the canonical selection, part state, all protected identities,
    fresh allowed offer and parent fingerprint before claiming. Claims contain database work only. One claimed
    external command executes once, outside the transaction, with bounded transport and actual start/returned-end
    timestamps saved separately from its canonical receipt. Resolve and validate read-only target lookup before
    the positive dispatch claim, then revalidate the locked database fingerprint; a lookup failure cannot strand
    an unissued original part behind a transport claim. Every original and retry part saves its actual call
    completion before another call; never substitute the next part's end time or reconstruct a transport timestamp.
    Bind at most one native GUID whose complete part GRAB
    coverage is inside that factual window, from the floored start second through the exact returned end, with no
    future grace period. Missing actual call facts do not gain authority from the parent creation time or an open
    intent. Serialize new mutating commands on the same parent while a command remains unsettled, including owned
    imports. Join late factual receipts to their part and attempt; durable pre-command intent order determines the
    latest attempt for that part. Late A evidence never outranks B, and unproved B stays observe-only.

    **Failed queue cleanup.** A multipart retry may remove only its exact positively owned, genuinely failed
    native download, after checking the current queue identity and saved full-part GRAB binding. Audit intent,
    result and absence read-back on the same parent, using `removeFromClient: false`, `blocklist: false`,
    `skipRedownload: true` and no search. An uncertain removal is observed, never repeated. Re-read the empty retry
    targets and every protected file before the grab. No library delete occurs. This does not broaden decision
    39's existing whole-slot wrong-source discard or grant ownership of a foreign reparsed queue row.
    P0 classifies an unextracted archive as report-only, not a bad release. A genuinely failed selected download
    does not by itself prove physical wrong content or authorize blocklisting, so selected-part cleanup preserves
    the release. Decision 39's physically proved wrong-source discard retains its existing blocklist behavior.

    **Ownership and completion.** Owned import and failed-download janitor ownership consume the same canonical
    part/attempt/GUID binding, including all original and later owned attempts. Import targets equal that entire
    part, never the whole original slot or a sliced file. The queue janitor also holds an active verified selected
    download before queue enforcement only when its saved actual GUID, native series and exact title all agree;
    this prevents the ordinary bad-release removal from bypassing selected-part neutral cleanup. The failed-history
    janitor defers only those active verified owned failures; unresolved proof holds remain narrowly scoped, and unrelated failures keep their current policy,
    enforcement modes and search budget. The original full-slot completion obligation stays in the verified Carry.
    Keep the normal generic episode/time ledger matcher; do not impose GUID matching on ordinary Fixes. Runtime
    finish still requires every original-slot episode's actual selected GUID/native import/file/bytes, physical
    English and story proof, normal ledger event and strict per-account Plex/Carry verification. One part, a grab
    or a prepared command cannot satisfy it. No synthetic history or forced completed state is introduced.

    **Review and validation hold.** Driving-agent design review authorized implementation at 09:36Z; no owner
    acceptance or new ADR ruling is implied. Test a single original four-episode file filled by two pair releases,
    one-pair failure with the other empty or genuinely imported, accepted-but-503 calls, lost audits, concurrent
    claims, unknown transport, never-claimed continuation, stale or foreign files/GUIDs, overlapping selections,
    raw numbering mismatches, native auto-import adoption, delayed A receipts after B, normal all-four completion
    and mixed janitor ownership. Preserve every decision 39 regression. Run only affected tests under nice 19 with
    one worker; no CPU burners, wide parallel suites or looped load reproduction on the shared production node.
    Root copy review, required PR checks, signed release and verified deployment precede any live multipart recovery.

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

**P5 decisions (2026-10-13, PLAN-077 P5).** What the build settled, with the live reads behind it (Regular Show: The Lost
Tapes S01E11 and S01E13, Sonarr 4.0.20.3012, read 2026-10-13):

1. **The kill switch.** One more remedy in `repair_guide_remedies`, `release_pick`, ships off. It is not a Fix remedy
   (it never opens the Fix guide on its own): Force Search's guide offers "See every release" beside its search and when
   the ADR-028 window ends `nothing_found`, and the re-map result offers it for each emptied episode (D-04 rule 9). The
   server applies the switch to every caller.
2. **The read is Sonarr's season list, narrowed to the episode.** The rows kept are those numbered for the target (a
   pack is shown, Not allowed; a multi-episode file that holds it follows decision 17) and a one-episode row numbered for another episode of
   the season whose own title names the target (Title Evidence `agrees` against the target). Why not `?episodeId=`: Case
   A's hand pick, OldT's `S01E10.Spice.It.Up` that held E11, is numbered for E10, and an episode search never returns it
   (the live E11 search listed only rows numbered S01E11). One season search also serves every missing episode of the
   season (P1's cache key `sonarr:season:<series>:<season>`). What a season search adds that does not apply to one episode
   grabbed on its own ("season pack required", "Full season release rejected") is dropped, and so are a renumbered row's
   rejections about its own episode ("Episode wasn't requested", an Existing-File Rejection on that episode's file). Rows
   the *arr could not match to the title are dropped. Radarr reads the movie's list.
3. **Q-07, override half: resolved** from the source at the running tags. The plain grab is `{guid, indexerId}`
   (InteractiveSearchRow, a row with `downloadAllowed`); the override (OverrideMatchModalContent) is Sonarr's `{guid,
   indexerId, seriesId, episodeIds, quality, languages, downloadClientId, shouldOverride: true}` and Radarr's `{indexerId,
   guid, movieId, quality, languages, downloadClientId, shouldOverride: true}`, `downloadClientId` null, `quality` and
   `languages` the row's own objects echoed unchanged (pinned in `release-grab-clients.test.ts`). The app sends the plain
   body only for a row the *arr approved and mapped and that is numbered for the target; every other grab is the
   override, pinned to the target, so the queue record and the grab history name the person's chosen episode. The *arr
   finds the row in its own release cache (30 minutes after the search): a grab never searches again, and answers 404 when
   the row is gone, 409 when the site will not hand the file over.
4. **The reasons in plain words** (`RELEASE_REASONS_VERSION` 1): every rejection text of both *arrs' decision engines is
   mapped to plain words and a class, Overridable Reason (T-320), Hard Refusal (T-321) or neither; unknown words are shown
   verbatim and allow nothing. The *arr's own words sit under the plain ones ("What Sonarr says"). A row on neither list is
   Not allowed (Q-01: Override needs every reason overridable). Hard refusals the app adds to the *arr's: early copies
   (CAM, TELESYNC, and TELECINE, DVDSCR and REGIONAL as the same theatre-or-screener family), Unknown quality, the size caps,
   Title Evidence `disagrees` against the target and a series-year conflict (P2 decision 7). Hard refusals win over an
   approval.
5. **The size caps apply to every row.** The profile's own limit arrives as the *arr's rejection (hard). Whether a profile
   sets a limit for a quality is not on the release list, so the 15 GB (episode) and 100 GB (movie) caps apply to every
   row: a larger pick for one missing item is a staff call.
6. **The open check, per episode.** An episode remedy (`import_download`, `release_pick`) meets a season-wide repair on
   its season (a re-map) and any open repair holding its episode, but not one on another episode of the season, which
   touches a different file: Case A's two missing episodes are picked one after the other. A re-map still meets every open
   repair on its season. An import onto an episode is never held up by that episode's open pick: it is how the pick lands.
   This narrows P2's season grain for imports (D-02).
7. **The Release List (T-319).** The list a person saw is stored with its grab data, the guid and indexer id kept on the
   server; the grab names a row by an opaque key. A grab after 25 minutes is refused (`list_stale`), under the *arr's
   30-minute cache. The rows of one release found on several sites (the same title, protocol, state and reasons) are one row
   carrying every source's key: a site that refuses lets the person try the next. Lists are pruned after a week.
8. **Budget.** Opening a list writes the Release List and its `release_list_requested` event in one transaction under the
   requester's lock, after the budget check, and is refused before searching when the hourly budget is used up;
   `countRecentFixBudget` counts the event. Reopening the same target's list within 5 minutes returns the same list free. A
   target with a file or a download in the queue gets no list and costs nothing. The grab is a Repair Request (`release_pick`):
   another unit. P1's member throttle (12 live searches an hour per web pod) also covers the list's search.
9. **Missing items only (Q-01).** A target with a file answers `has_file`; a download on its way `on_its_way`, with its
   progress; a stuck or failed one `queue_stuck`, for Force Search's Import Check. The grab reads the target and its queue
   again just before sending and refuses, sending nothing, when either changed.
10. **The follow-through is P2's.** The grab goes to the chosen episode; when the *arr cannot file the download (a
    renumbered name: "were not found in the grabbed release"), the Import Check imports it there, from the person's Force
    Search on that episode (the queue record names it) or the janitor's enforced `importable` cell. The result step offers
    Force Search when the live phase stalls. Nothing new acts on its own.
11. **Completion and failure are read.** `completeRepairRequests` completes an actioned pick once its target records an
    `imported` event; `settleReleasePicks` (after every sync run, and before every list and grab) closes a pick whose target
    recorded `download_failed` and no import as `failed`, with its `repair_failed` event, which frees the episode for another
    pick. Before a list or a grab for a target with an open pick and nothing in its queue, the *arr's own history settles
    it at once (the pick's grab, by its release title, and a `downloadFailed` or `downloadIgnored` record for the same
    download), so "Pick another release" never waits for the sync; a pick still open after that holds the target (no list,
    no cost). A list a grab went out from is spent: it is neither reused nor grabbed from again (what it offered may since
    have failed and been blocklisted); a grab the site refused leaves it usable for another site. Only a 4xx answer means
    nothing went out (404: the *arr's cache dropped the row; 409: the site refused; any other: the *arr refused the
    request). A timeout, a dropped connection or a 5xx may come after the *arr handed the release on, so the grab answers
    `unsure`: the pick stays open and the list spent (nothing is grabbed twice), the live chip shows what happened, and the
    history settles it, closing it as failed when no grab is recorded 10 minutes on (`UNSURE_GRAB_SETTLE_MS`). A grab also forgets the
    cached list, so the next list searches again and shows the failed release blocklisted. `fix.repairProgress` is the
    grab's live phase (ADR-028), the row authoritative for its terminals.
12. **The recommended pick:** the first Grab in the *arr's order; else the Override whose title names the target and whose
    number matches it, then one renumbered whose title names it, then the *arr's order. Case A, read on the live lists with
    the episodes missing: E11's pick is OldT's E10-numbered release (the hand fix); E13's the AndreMor 720p release. Every
    other row of both is refused (the hand profile's terms, a blocklisted posting, an H.265 release whose title is E12's or
    E14's).
13. **The in-cluster tool.** `tsx /sync/src/scripts/repair-guide.ts release-list (--tmdb <id> | --tvdb <id> --episode
    S01E05) [--json]` prints the list read-only, each row with its key: it searches the indexers, and records and grabs
    nothing.
14. **Staff's Release Pick** (the P4 decision 17 pattern): `repair-guide.ts release-grab (--tmdb <id> | --tvdb <id>
    --episode S01E05) --key <row key>` opens a fresh list as staff (requester null: no budget, no throttle) and grabs the
    row with that key exactly as the guide does: the same states and refusals (a Not allowed row is never grabbed, by
    anyone), one Repair Request with no requester, the plain or the override body. It is how staff work a Seerr issue
    through the self-service tools (D-12) from the cluster, where a person's sign-in cannot be driven.
15. **Another movie's release, and disc images (found in the live check of v0.118.0).** Zom 100: Bucket List of the
    Dead (2023)'s live list carried "The Convert" and "The List" (both 2023) as approved: an indexer tagged them with
    the movie's id, and Radarr trusts the id. The first approved row, and so the recommended pick, was "The Convert" in
    2160p. A movie's Title Evidence has no `disagrees`; `ambiguous` (the name carries none of the movie's titles, or
    names another year) is its mismatch, as for the Import Check (P2 decision 8). So an `ambiguous` movie row is a Hard
    Refusal ("Its name is for a different movie"), approved or not; `silent` (an obfuscated name) is not. A whole disc
    image (BR-DISK, Raw-HD) is not a file Plex can play: it is never a pick (neither list, Not allowed). The plain words
    are `RELEASE_REASONS_VERSION` 2, so a stored list of version 1 is never shown again nor grabbed from.
16. **The recommended override weighs the library's custom formats (found in the live check of v0.118.1).** SpongeBob
    SquarePants S17E18, missing, had only rejected releases. The *arr's order led with an x265 WEBRip the profile scores
    -9925, a format the owner refuses; an HDTV 1080p h264 release was only a quality the profile does not list. Among
    Overrides of the same title evidence, the one with the higher custom-format score is now recommended first, then the
    *arr's order. The list itself keeps the *arr's order.
17. **A release that holds several episodes, every one of them missing, is a pick for all of them (issue #936, ruled by
    the coordinator on its proposal, 2026-10-13).** Two-segment kids shows (TVDB numbers each 12-minute segment) often
    come as files that hold two episodes. Until now such a row was Not allowed ("Holds more than this one episode"), so
    the episodes could not be fixed from the app. The motivating case, Spidey and His Amazing Friends S05E19 and S05E20,
    turned out not to be one (the renumbered rule below).
    - **Which rows.** A row numbered for the target that holds more than one episode of the season (the *arr's mapped
      numbers), and is not a season pack, is judged on the episodes it holds. When every one of them is on the season's
      episode list and has no file, the row is a pick like any other: Grab, Override or Not allowed by its reasons. Title
      Evidence judges its name against all of them, so a name that says it is another episode is still a Hard Refusal.
    - **Not allowed when the *arr filed it on other episodes than its name numbers** (code `renumbered`, neither list:
      "It would be filed on other episodes than its name says"; `ArrRelease.renumbered`: the mapped season or episode
      numbers differ from the parsed ones). Found in the live check of v0.120.0, the first build of this decision. The
      only Spidey S5 releases were untitled `S05E09E10` files (RBB, JFF). Sonarr's scene mapping (one scene episode per
      broadcast of two segments) files them on TVDB E17 to E20, all four missing, so the row was a pick for all four.
      Staff picked RBB's: one 24-minute file, whose own subtitles open with "Aunt May's Flying House" and "Spiders
      Versus Flies", TVDB E09 and E10. The group numbered segments the TVDB way, and Sonarr read the numbers as scene
      numbers. The file was deleted by hand at 15:56Z, read back, and E17 to E20 are missing again. When the *arr
      renumbers a multi-episode release, which episodes the file holds cannot be told from the list, so it is never a
      pick; staff place such files by evidence (issue #928's two-segment files).
    - **Not allowed when it would replace a file.** When another episode it holds has a file, the row stays Not allowed,
      with the reason in plain words ("Also holds S01E14, which already has a file"; code `holds_episode_with_file`,
      neither list). Replacing a file is what Fix is for. An episode whose file state is unknown counts as having one. A
      season pack, and a row that holds an episode missing from the season's list, keep `pack`.
    - **The grab.** The offer carries every episode id. The override body lists all of them in `episodeIds`; an approved
      row keeps the plain body, which Sonarr maps onto all of them itself. Just before sending, every episode is read
      again: one that has a file now, or has a download in the queue, refuses the grab with nothing sent, and the answer
      names that episode.
    - **One Repair Request for all of them.** `targetChildIds` holds every episode, under decision 6's open check per
      episode: an open repair on any of them refuses the pick, and the pick holds each of them (its list answers
      `on_its_way`). The request's label names each episode ("S05E19 · ... and S05E20 · ..."), and its preview keeps them
      as `episodes`.
    - **The confirm names each episode** ("Download this release for both of the missing episodes it holds:", then one
      line per episode), and a row someone can pick says "Holds S05E19 and S05E20, both missing" where a one-episode row
      shows its Title Evidence (a Not allowed row does not, so the line never sits beside a Hard Refusal). An override
      is "an exception for these episodes".
    - **Completion waits for every import.** `completeRepairRequests` already completes only when every target episode
      has an `imported` event. The live chip (`fix.repairProgress`) follows the queue records of any of them, and reads
      `completed` only once all of them imported. A `download_failed` on any of them closes the pick as failed.
    - **The recommended pick.** Among Overrides, a release that holds several episodes ranks after every one that is the
      target alone (evidence rank 3), then the custom-format score, then the *arr's order. The first Grab still leads.
    - The plain words are `RELEASE_REASONS_VERSION` 4 (3 shipped in v0.120.0 without the renumbered rule). Pinned by `release-pick.test.ts` (the pure rows on the Lost Tapes
      S01E13E14 file, then the grab, the refusals, the open check, the live chip and completion over the embedded harness)
      and `release-pick-guide.test.ts` (the words).

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

**P6 decisions (2026-10-13, PLAN-077 P6).** What the build settled, with the live reads behind it. ADR-109 C-02 and C-07
already carry the Plex write (a title-level preferred audio language through `@hnet/plex/write`, only under C-07), so P6
adds no ADR; CLAUDE.md hard rule 4 names the write.

1. **Q-08 answered: a show only.** Read live on HaynesTower and HaynesOps (`GET /library/metadata/{key}?includePreferences=1`):
   a show's own settings carry `audioLanguage` ("Preferred audio language", type text, value `en-US`, default `''` for
   "Account default", `enumValues` the Plex UI languages, about 45, in Plex's own order), beside `subtitleLanguage` and
   `subtitleMode`. GoodFellas' settings are only `languageOverride`, `useOriginalTitle` and
   `enableCreditsMarkerGeneration`. A movie therefore always gets the guidance (reason `movie`).
2. **The write and its read-back.** `setAudioLanguagePreference(ratingKey, locale)` on `@hnet/plex/write` sends
   `PUT /library/metadata/{key}/prefs?audioLanguage=<locale>` (the call Plex Web's Edit, Advanced makes; python-plexapi's
   `editAdvanced`). Only a locale or `''` passes its check, before the URL is built, and it is retried like a read on a
   timeout or a 502-504, since the stored value is idempotent. The value written is Plex's first locale for the language
   in the item's own list (`en-US`, not `en-AU`); a stored variant of the language (`en-GB`) already counts as set. Read
   live on v0.121.0: Plex lists the show's own track languages first, so the first match is the tag its files carry
   (`en-US` on The Lost Tapes, `en` on Boruto, `ja` on JUJUTSU KAISEN). Every
   written server is read back (`getAudioLanguagePreference`) before the request completes. The hand fix of 2026-10-12
   also refreshed the show; the setting does not need a refresh, and none is sent.
3. **The decision** (`decideAudioPreference`, pure). `set` when every file in scope has the wanted language (P1's verdict
   `present`), the title is a show, the *arr's `originalLanguage` (read from `GET /series/{id}` or `GET /movie/{id}`) is
   that language, and a server that carries the show (the ADR-047 match, `media_plex_matches`) prefers another;
   `already_set` when every server already prefers it (The Lost Tapes and Butterbean's Cafe after the hand fix); otherwise
   `guidance` with its reason: `not_original`, `movie`, `unknown_original`, `no_plex`, `no_plex_value`, `not_present`. A
   server that cannot be read is left out of the write and named in the result. A server's item is the one in a library
   of the title's own kind (`show`, `movie`), then the lowest key: 12 Sonarr titles also match a same-named movie, and
   Love, Death & Robots' movie 11764 on HaynesOps sorted before its show 55811 (v0.122.2, PR #954).
4. **The record.** A `set` is one Repair Request (`audio_preference`, one unit of the hourly budget, its
   `repair_requested` event in the same transaction), with a `plex_audio_preference` and a `plex_audio_readback` step per
   server. It is `completed` only when every written server reads back the language, else `failed`, and the person is
   told which server did not take it. `already_set` writes nothing and opens no row. Only another open Audio Preference
   on the title holds one up, and it holds up nothing else: it changes a title-wide Plex setting and no file.
5. **The track advice.** The guidance names the track as Plex lists it for the scope's own file (one episode or the
   movie, `getAudioTracks` on the first server that answers: `English (EAC3 5.1)`), its place among the file's audio
   tracks, and the track that plays first instead (the one the file flags as its default, else the first). Then where
   the audio menu is: a browser or the desktop app (the Audio menu under the summary, or the player's audio and subtitle
   settings), a phone or tablet, a TV or streaming box. A season, or a file Plex cannot read, gets "the audio track whose
   name starts with English". Every case links the person's Plex account settings and the About page's recommended
   settings (`/about#watching`).
6. **The remedies.** `audio_preference` (off: the P1 guidance only) and `language_search` (off: the Fix as before) each
   ship off and need `language_check`; neither opens the guide on its own.
7. **The Language Replace (D-08 rule 4)**, for one episode or a movie whose file lacks the wanted language (verdict
   `missing` or `unknown`). The file is deleted (ticked first), and the download it came from is marked failed so it is
   never taken again. It is not marked when it is a pack that also holds other on-disk episodes (the season guard), or
   when the *arr's own Redownload Failed would then search by itself (DESIGN-005 D-25, read in the plan): that blind
   search would race the language grab, so only the file is replaced (`redownloadKept`; ADR-098 keeps it off in Sonarr
   and Radarr, PR #942 review). A step that fails after an earlier write records the whole trail. The replacement is
   grabbed with the plain body. It is the first release, in the *arr's own order, that:
   - the *arr would take once the file is gone (approved, or rejected only for the existing file, T-315);
   - the *arr parsed as carrying the wanted language;
   - is mapped onto this episode or movie alone (never a pack);
   - passes the Release Pick's hard refusals (P5 decision 15 included: Radarr approved another movie's releases for
     Zom 100);
   - for Sonarr, its named episode title agrees with the target. An ambiguous named title is not an automatic
     Language Replace candidate: an approved `Ben.10.S01E10.Lucky.Girl...playWEB` is still the 2005 story, not the
     2016 target Animo Farm (live P4 replacement follow-up, 2026-10-13). The existing Title Evidence verdict is
     reused; no change to its thresholds or to the Import Check's treatment of ambiguity. A silent title segment
     keeps the existing episode-number, language, Same Release and quality guards;
   - is not the Same Release.
   Sonarr's list is the season list narrowed to the episode, cached with the Release Pick's. A grab the *arr refuses falls
   back to the search the Fix made before, so the target never ends with neither. The record is the Fix Request (path
   `delete_search`, steps `guard_plan`, `mark_failed`, `delete_file`, `language_grab`), which already holds the mark and
   the delete and completes on the import; the reserved Repair Request kind `language_search` stays unused.
   Staff may invoke the same domain writer with requester null and the fresh confirmed language-plan digest;
   no separate arr writer or staff CLI is needed. A normal language replacement preserves correct-story watch state;
   it must not use the wrong-content carry/drop path merely because the file's audio is wrong.
8. **No release in the language: nothing is removed** (`no_language_release`). Rule 4 opened the Release Pick filtered to
   the language instead. The Release Pick is for missing items (Q-01 ruling), and deleting the only copy with nothing in
   the person's language to replace it is the harm P1's "nothing to replace it" refusal guards against. The guide says
   how many releases name the language but are turned down by the library's rules, and offers "Ask staff" (a prefilled
   Helpdesk ticket, category audio).
9. **A season is fixed one episode at a time.** A season whose files lack the language lists those episodes and sends
   the person to each episode's own Fix (`language_by_episode`). With every file carrying it, a season gets the advice
   and, for the show's original language, the same Audio Preference.
10. **A release's languages are the *arr's reading of its name.** Sonarr gives a release with no language token the
    series' original language, so BiOMA's "DUAL" posts read "English" (Case A's E11 list). The Language Replace trusts
    that reading as the *arr does, and the Same Release test keeps it from taking the file's own release again.
11. **The staff scan and sweep.** `repair-guide.ts audio-scan` reads every Sonarr series, one episode-file read each. It
    lists the files whose audio carries the original language behind another one, confirmed on one such file in Plex
    (the language a play starts in), with each server's stored preference. `--apply-original <code>` then sets the Audio
    Preference as staff (requester null, one Repair Request each, the same writer) on every finding with that original
    language whose Plex default is another one. Shows whose original language is not English are not swept: for them, a
    viewer chooses between the original and an English dub, and Q-03 keeps that to a person's own report.
12. **The scan's first read (2026-10-13, read-only).** 965 Sonarr series with files, 63,647 files: 181 series have files
    that carry the original language behind another one, 166 of them English originals (Star Trek: Voyager starts 107
    episodes in German on HaynesOps, Jessie 91 in Czech, Futurama 72 in German). The sweep and its result are in PLAN-077
    P6's status.
13. **Never another post of the file's own release** (found in the live check on v0.121.0). The Language Replace skips
    a release from the file's own release group at the file's quality: the file lacks the language, so that group's
    release of the episode at that quality most likely does too, whatever its name claims. JUJUTSU KAISEN S02E06's file
    is OLYMPUS WEBDL-2160p with Portuguese and Japanese only, and the plan's first pick was OLYMPUS's "MULTi"
    WEBDL-2160p post, which Sonarr reads as eight languages, English among them (`sameGroupAndQuality`).
14. **The household default for staff (owner ruling on #955, 2026-10-13: "English if present"; ADR-115 amends ADR-109
    C-07).** The Q-03 ruling stays the rule for a person's Wrong language report. For the shows the staff audit flags
    (files that start in a language other than the original one), the owner's ruling applies: English where the show's
    files carry an English track (dubs included), else the original language. A show whose files already start in their
    original language is not flagged and stays as it is (a dual-audio anime that starts in Japanese keeps Japanese). A
    show whose files with the chosen language already all start in it, with no server storing another language, is a
    no-op (Boruto: all 291 files start in English). The writer takes it
    as `rule: 'household'`, for staff only (requester null; a person's request with it is refused), and records the rule
    on the Repair Request. Staff apply it with `repair-guide.ts audio-scan --apply-household` (or one show with
    `audio-preference --household`); the scan now also counts each show's English files.

15. **Track names for a paired file (live finding, 2026-10-14).** Plex may list a two-story file as one metadata
    item under its first episode. A Wrong-language report for the second episode still needs that file's actual track
    names. Resolve track hints inside the already matched show using the requested Sonarr file's exact basename and
    bytes, with its full episode coverage. The exact episode remains the preferred match when its physical file agrees;
    a unique item carrying that same file may supply the paired episode's tracks. Never guess a neighbor by number,
    cross shows, accept a stale different file, or choose among conflicting physical matches. Missing/ambiguous proof
    keeps the generic guidance. Apply the same file-aware hint resolution to the ordinary read and scan paths so one
    cannot regress independently. This changes read-only hints only; original-language and staff household eligibility,
    budgets and all preference writers stay governed by decisions 1 to 14 and ADR-115. No unseen track is invented.

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
`seerr_issue_bridge`, P7 decision 2), every call sending `X-API-User`. Single writer
`packages/domain/src/seerr-issue-writes.ts`, table `seerr_issue_writes` (`seerr_issue_id`, `kind` `comment` or
`resolve`, `body`, `state` `intended`, `done`, `failed` or `skipped`, `created_at`, `done_at`; unique per issue and
kind; P7 decision 5 has the rest). The intended row commits before the call and is completed after it, so a crash never
posts twice.

- **Comment**, once per new issue, worded for the report (P7 decision 4): "Thanks for the report. You can try fixing
  this yourself on haynesnetwork.com:", the link with "sign in with your Plex account", the button to press, and "If that
  doesn't sort it out, reply here and staff will take a look."
- **Resolve**, when the linked Repair Request or Fix completes (P7 decision 7): a comment "Fixed on haynesnetwork.com:
  <the outcome line>", then `POST /api/v1/issue/{id}/resolved`.
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

**P7 decisions (2026-10-13, PLAN-077 P7).** What the build settled for D-10's writes (the owner's Q-02 ruling: comment
and resolve, as a dedicated Seerr user, never as the owner's account), with the live reads behind it (Seerr 3.5.0).

1. **The bridge user** is a staff one-off through Seerr's API (D-13), recorded in PLAN-077 P7: a local user
   (`POST /api/v1/user`, username "haynesnetwork.com", email `seerr-bridge@haynesnetwork.com`, a random password that was
   never stored; Seerr's local login is off, so nobody can sign in as it), then `POST /api/v1/user/19/settings/permissions`
   with `1048576` (MANAGE_ISSUES only), read back. It is Seerr user 19. Seerr creates a local user with the default
   permissions first; the permissions write follows in the same step. To undo: `DELETE /api/v1/user/19`. The
   watchlist registry and the enrollment skip local users (`userType` 2), so they never touch it.
2. **One audited setting, `seerr_issue_bridge`** (`{ comment, resolve, bridgeUserId, commentFrom }`), replaces the
   `seerr_bridge_user_id` named above: it holds the bridge user and switches each write on or off (the kill switch).
   Either switch on needs a bridge user above 1 (`SeerrBridgeConfigInvalidError`, BAD_REQUEST). Turning the comment on
   stamps `commentFrom`; turning it off clears it. Written through `setAppSetting` (`update_app_setting`, the row and
   its audit in one transaction) from the "Replies in Seerr" card on `/admin/seerr`, which also reads the bridge user
   from Seerr live and says when it cannot post. Absent, nothing is ever written to Seerr.
3. **Which issues get the comment:** open and not removed in the mirror, mapped to a ledger item that is not
   tombstoned (the link has a title to open), and filed in Seerr at or after `commentFrom`. Turning the switch on never
   reaches back: the four resolved issues of 2026-10-12, and any report filed while the switch was off, get nothing.
4. **The wording** follows the report (`seerrCommentKind`): an episode or movie with no file is `missing` whatever its
   type (the guide opens Force Search on it, P3 decision 5), then Audio is `wrong_language`, Subtitles `subtitles`,
   Video on an episode or movie with a file `wont_play`, and everything else (Other, a season, a whole show, a file
   nobody could read) `other`, which names both buttons. Whether the episode has a file is Sonarr's episode list; a
   movie's is the ledger's file count. Every comment opens "Thanks for the report. You can try fixing this yourself on
   haynesnetwork.com:", gives the `/r/seerr/<id>` link as step 1, the button and reason to press as steps 2 and 3, and
   ends "If that doesn't sort it out, reply here and staff will take a look." (ADR-112 C-04: filing stays open and staff
   still help). A Won't play comment adds the server tip from the hand reply on issue 2. The link is written out:
   Seerr renders a comment with only paragraphs, emphasis and lists, so a Markdown link would lose its address. The
   exact texts are `seerrIssueCommentText` in `packages/domain/src/seerr-issue-writes.ts`, pinned by its tests.
5. **One comment per issue, ever** (`seerr_issue_writes`, unique per issue and kind; the row is the audit, the
   repair_requests pattern). The single writer inserts the `intended` row and commits it before any call; whoever
   inserts it (or takes back a `failed` row under 5 attempts, or an `intended` row older than 5 minutes) owns the call,
   so the sync and a webhook arriving together never both post. Before posting it reads the issue fresh: a comment the
   bridge user already left with the same text is adopted (`done`, no post), which covers a crash after the post and a
   lost answer; an issue Seerr resolved or deleted first is `skipped`. A retry keeps the first body. A failed call
   records its error on the row, shown in `/admin/seerr` with the number of tries.
6. **The exact link P3 deferred** (P3 decision 9): `repair_requests.seerr_issue_id` is now set, and
   `fix_requests.seerr_issue_id` added (migration 0105), only when the guide was opened from that report (its banner,
   or the link's first visit; kept when the guide hands Fix over to Force Search) and the issue is open, mirrored and on
   the same title (`seerrIssueLinkFor`, read in the writer's transaction). Anything else links nothing and the repair
   goes ahead. The remedies send it (`seerrIssueId` on `fix.create`, `forceSearch`, `remap`, `setAudioPreference` and
   `releaseGrab`) from the guide's context; the staff tools never set it.
7. **When the resolve happens:** among the Repair Requests and Fixes that name the issue, nothing is still open
   (`pending`, `actioned`, `search_triggered`) and the newest has `completed`, which is read, never assumed (D-02). A
   failed, timed-out or closed newest record leaves the issue for staff. A Force Search on its own leaves no record with
   an end, so it never resolves anything; nor does a Missing subtitles Fix, which rests at `search_triggered`. One
   resolve per issue, ever: a report the reporter reopens stays with staff.
8. **The resolve** is the outcome note as a bridge comment, then `POST /api/v1/issue/{id}/resolved` (no body, as the
   UI sends), its answer read for status 2. The note names the tool that fixed it (ADR-112 C-02, the reply teaches the
   tool), for example "Fixed on haynesnetwork.com: Force Search found the stuck download for S02E06 and imported it.",
   and ends "If something still isn't right, use Reopen with Comment and staff will take a look." (Seerr's own button
   on a resolved issue). A note that posted before a failed resolve is found on the retry and not posted again.
9. **When the bridge runs:** after every `seerr-issues` sync (every 10 minutes, on a fresh mirror only), and after an
   issue webhook whose read changed the mirror, for that issue only, once the 202 is sent (Next.js `after`), so a new
   report gets its comment within seconds. The bridge's own comment comes back as a webhook and finds its row done.
   Each pass reads the bridge user first (`GET /api/v1/user/{id}`): missing, an admin, without MANAGE_ISSUES, or user 1,
   and nothing is written (`[seerr-bridge] bridge_user_invalid`). Every write sends `X-API-User`; the write client
   refuses user 1 before any call, and a CHECK refuses it in `seerr_issue_writes`.
10. **Delivery** (D-11): Seerr sends a comment to its reporter through its notification agents, and on 2026-10-13 only
    the webhook to this app is on (email and web push are off). A reporter sees the comment when they open the issue
    in Seerr. Q-12 asks whether to change that.
11. **Staff smoke test** (owner-authorized, 2026-10-13): `seerr-bridge.ts --smoke` creates one explicitly marked
    staff test on The Canterville Ghost (1986), Seerr media 10974 / TMDB 65465, as user 19. It checks exactly one
    bridge invitation, links a simulated Repair Request through the normal writer, checks that pending does not
    resolve and completed resolves once, then deletes only that fixture. It never changes a library file, download,
    Plex mark or notification setting. The initial marked report and the resolve note are distinct from the one
    invitation. Every test intent and result is kept through `setAppSetting` (actor null) in
    `seerr_issue_bridge_smoke`, with its permission audit in the same transaction; migration 0107 admits that key.
    A unique run marker, the stored issue id above 4, the matching media, reporter and creation time all guard
    cleanup. An ambiguous create is adopted by its marker, never blindly posted again. `--smoke-cleanup` resumes
    only the recorded fixture after an interruption. The normal bridge gains no general delete surface. The test
    mirror remains marked as removed and its audits survive; OC-052 excludes removed rows and this test marker,
    because a smoke test is not a real person's report.

### D-12 Working practice and the readiness judgment

**Admin guidance (2026-10-14, PLAN-077 P8 working practice).** The issues list links to Seerr, the Library and
PLAN-077. Staff open the report's self-service link and try the tools as a member would. If a tool fixes it, their
reply names that tool and links to the report. A hand fix records the missing capability and adds it to the plan.
The report URL can be opened directly or copied. This guidance adds no counters and does not declare readiness
or change the default; that remains the owner's judgment below.

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
| The Seerr bridge user exists | Seerr users (API or UI) | D-10 writes (done 2026-10-13: Seerr user 19, "haynesnetwork.com", MANAGE_ISSUES only; P7 decision 1) |
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
| D-05 | `title-evidence.test.ts`: the three cases' real names (BiOMA silent, `S01E10.Spice.It.Up` agrees with E11, `The_Paper_2025_S02E06_125_Years_Young` agrees with 2x06, the Penguins Spanish titles disagree); `mislabel-block.test.ts`: grammar, compile check, read-back, expiry, cap; the ADR-113 name kinds against Case A's five hand-made blocks (each matches its mislabelled name and not the right release), their refusals, and the same writer (add, dry run, roll back, remove); `release-terms.test.ts`: the name templates |
| D-06 | `release-pick.test.ts`: state per row from rejection sets, hard refusals win, override body |
| D-07 | `import-check.test.ts`: The Paper importable, T.O.T.S. "matched by ID" importable, Penguins `title_mismatch`, archive report-only, the live Rugrats 2021 and Franklin 2025 mismatches, Aqua Teen's and Spider-Man's refusals, "Import this download onto..."; `queue-aware-search.test.ts`: Case B imports and sends no search, a failed download removed and searched once, nothing sent while a download is in progress, a changed plan refused; `manual-import-clients.test.ts` (arr): the reads and the pinned body |
| D-08 | P1: `fix-guards.test.ts` (the language check). P6: `language-aware.test.ts` (domain): the decision and its reasons, the write on the server that needs it with its read-back and audited Repair Request, `already_set` with no row, a read-back that fails, the remedy off, a stale digest, a movie; the Language Replace's pick (never a pack, a hard refusal or the Same Release), its mark, delete and plain grab in order, the search fallback, nothing removed without a release in the language, a season refused; `audio-language.test.ts` (plex): the prefs and track reads on live-shaped bodies, the pinned `PUT`, the value check, the retry |
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
| Q-03 | When a Wrong language report finds the wanted audio already in the file, should the app change Plex for everyone (D-08)? Options: **A** set the title's preferred audio language on every server that has it, only when the wanted language is the title's original language (a dubbed default track), otherwise guidance only; **B** set it on every request; **C** never change Plex, guidance only. Recommendation: **A**. | **Ruling (owner, 2026-10-12): A.** Set the title's preferred audio language for everyone on every server that has it, only when the wanted language is the title's original language; otherwise show guidance and change nothing. Folded into D-08 and ADR-109 C-07. **Amended for staff defaults (owner, 2026-10-13, issue #955, ADR-115): "English if present".** For a show the staff audit flags (not a person's report), the preference is English where the show's files carry an English track, else the original language; a show whose files already start in that language is left alone. A person's own Wrong language report keeps the original-language rule above (P6 decision 14). |
| Q-04 | What evidence makes the platform ready for "fix it yourself" to be the rule (D-12)? Today's rate is about 1.3 Seerr issues a month (4 since 2026-07-11). Options: **A** Cases A, B and C replayed end to end by a non-admin account (stubs in e2e, plus a live preview-only run of each remedy on the real titles), then the next 3 real issues self-served; **B** the next 5 real issues self-served in a row (about four months at today's rate); **C** 60 days in which every real issue is self-served, with at least 3 issues; **D** no number, the owner decides at a review once P1..P6 ship. Recommendation: **A**. | **Ruling (owner, 2026-10-12): A.** An agent replays the three cases as a non-admin user on the built tools, then the next 3 real issues are self-served with no staff help. Folded into D-12 and ADR-111 C-05.<br>**Amended (owner, 2026-10-12): the counted gate is dropped.** "The gate is a judgment call, not a count. The intention is to keep building haynesnetwork.com until it can handle the kinds of problems people actually report, then steer users to fix things themselves instead of staff fixing them. Working practice: every new Seerr issue is worked through haynesnetwork.com's self-service tools first, as a user would. When a tool fixes it, the reply teaches the user that tool. When no tool can, staff fix it by hand and the missing capability is added to the plan. The owner decides when coverage is good enough to make self-service the default." No replays and no streak; see D-12 and ADR-112, which supersedes ADR-111 C-05. |
| Q-05 | Once the gate passes, what does the rule do? Options: **A** Seerr issue filing stays open, every new issue gets the fix-it-yourself comment, and staff act only after a self-service attempt failed or when no remedy fits; **B** issue reporting in Seerr is switched off for everyone but admins (Seerr permissions) and haynesnetwork.com becomes the only place to report; **C** A for 30 days, then B. Recommendation: **A**. | **Ruling (owner, 2026-10-12): A.** Seerr issue filing stays open; haynesnetwork comments with the self-service link, and staff step in only after a self-service attempt fails or when no remedy fits (option A's wording). Folded into D-12 and ADR-111 C-05. |
| Q-09 | Does an Unfixable outcome (closed with no remedy applied, for example no release exists anywhere) restart the Q-04 count of 3 consecutive Self-Served issues? Options: **A** yes, every real issue that is not Self-Served restarts it (the ruling's literal wording); **B** no, an Unfixable issue is skipped and neither counts nor restarts; **C** it counts toward the 3 when staff confirm no remedy could exist. Recommendation: **B** (the gate measures whether self-service works where a fix exists; an issue nobody can fix says nothing about that). Gates P8 only. | **Closed, moot (owner, 2026-10-12).** The Q-04 count no longer exists (Q-04 amendment, D-12, ADR-112), so there is nothing for an Unfixable outcome to restart. |
| Q-10 | Case A's hand profile holds five blocks that are not a series and a release group (P4 decision 14). Options: **A** a new ADR adds a second Mislabel term kind, a series-anchored mislabelled name (a number with another episode's title, an alternate title, a double-episode token), written from a confirmed re-map's own file names and by the adoption, then the hand profile is deleted; **B** keep the hand profile as a hand-kept exception beside the Mislabel Block; **C** drop the five blocks (the season is complete) and delete the hand profile. Recommendation: **A**. | **Ruling (owner, 2026-10-13): A.** [ADR-113](../adrs/113-mislabelled-name-terms-in-the-mislabel-block.md): three name kinds (`pair`, `double`, `alias`) in the same profile, under the same lifetime, cap and read-back. As built, staff (the in-cluster tool) and the adoption write them; no re-map offers one, so the offer stays the group's alone. The hand profile and its tag are removed by hand once the five are adopted (PLAN-077 P4). Folded into D-05 ("Mislabelled names", "Q-10 ruling decisions") and P4 decision 14. |
| Q-11 | The library-wide Title Check (P4, issue #916) leaves 622 open flags after staff fixed the five seasons a single claim could fix. Nearly all are whole-season reorderings (a streaming service's order against TVDB's), where the episode a file names keeps its own file, or the moves form a rotation. The re-map refuses both by design: it displaces nothing, and Sonarr's rename cannot pass two files through each other's names. Options: **A** a staff season re-map that follows the names. It parks one file on a free episode to break a rotation and renames as it goes; staff place the files whose names are silent; seasons are worked one at a time after an evidence and watch-state check. **B** staff fix the seasons by hand as they are reported. **C** leave them; fix only what people report. Recommendation: **A** (548 of the 692 showed viewers one title and played another; the Plex watch marks on those seasons stay with the episode numbers). | **Resolved (owner ruling, 2026-10-13): A.** P4 decisions 18 to 24 (the Season Re-map); the run and its leftovers are recorded in PLAN-077 and issue #916. |
| Q-12 | Seerr delivers a comment to its reporter only through its notification agents, and only the webhook to this app is on (email and web push are off, read 2026-10-13), so a reporter sees the bridge's comment only by opening the issue in Seerr (P7 decision 10). Options: **A** leave it: the reporter checks the issue, as with the hand replies so far; **B** turn on Seerr's web push (each person allows it once in their browser; no new service); **C** turn on Seerr's email (needs a mail relay and sender address for Seerr); **D** the app tells the reporter itself (a Pushover or email channel it does not have for members today). Recommendation: **B**. | Open; asked through the owner's question tool on 2026-10-13 after P7's live check. Recommendation B; answer pending. Comment and resolve are live either way. |

Driver items, resolved inside PLAN-077 (not owner questions):

| ID | Question | Resolution |
|----|----------|------------|
| Q-06 | The Title Evidence thresholds (0.8 and 0.3). | **Resolved in P4 (2026-10-13): kept.** Read on the library-wide census rather than a week: 18,205 files judged, 692 disagreed, and 546 of those scored 1.0 for the named episode against 0 for their own. On inspection they are real name-against-number conflicts, and 3 subtitle spot-checks out of 3 confirmed the names. The only false positives came from library-shaped names, and decision 16 handles those, not the thresholds. OC-053 re-reads the first week of hourly runs. |
| Q-07 | The exact override fields of Sonarr's and Radarr's `POST /release`, and whether `GET /release` returns releases in decision order. | **Order: resolved in P1 (2026-10-12).** Both *arrs return the decision order (D-09, P1 decision 3). **Override fields: resolved in P5 (2026-10-13)** from the UIs' source at the running tags (P5 decision 3): Sonarr `{guid, indexerId, seriesId, episodeIds, quality, languages, downloadClientId, shouldOverride}`, Radarr `{indexerId, guid, movieId, quality, languages, downloadClientId, shouldOverride}`. |
| Q-08 | Does Plex offer a preferred audio language for a movie, as it does for a show? | **Resolved in P6 (2026-10-13): no.** Read live on both servers: a show's settings carry `audioLanguage`, a movie's only `languageOverride`, `useOriginalTitle` and `enableCreditsMarkerGeneration`. A movie gets the guidance only (P6 decision 1). |
