# Trash re-add audit — 2026-11-13

> **Read this with its adversarial review, [2026-11-13-trash-readd-audit-review.md](2026-11-13-trash-readd-audit-review.md). Where they differ, the review governs.** The counts below were confirmed by re-measurement. Three things were not: claim 3 is wrong as written (eight deleted titles re-fetched the deleted release before the Release Block went live on 2026-09-27, and three of the four rows marked "Unproven" are provable from the ledger); the route table omits three routes this app owns (Trash Restore, Ledger Add & search, the failsafe restore diff); and the question list changes (Q-03 dropped, Q-04 and Q-05 reframed, Q-08 to Q-11 added). This text is left as the worker wrote it. Banner added by the coordinator at intake.

Read-only audit for OpenProject story **#818** (epic #814, saga #813). Worker `haynesnetwork-1113-163844`. No setting, search, delete, or sweep was issued. Every number below is measured on 2026-11-13 unless it says estimated.

The story's constraint line says an ADR or design amendment lands in the same change. The story's scope is this audit and forbids a fix. Nothing here changes behavior, so no ADR is amended. The acceptance line also asks for an adversarial review on the story; that review is the coordinator's, and this note does not record it.

Grafana was not available in this session. Two log checks were not run. The queries are in the gap list.

## What the owner asked, and what is true today

Three claims:

1. A Trash-deleted title comes back only when someone requests it again in Seerr.
2. That requested copy is then protected from Trash.
3. The same release is never fetched again, and lists and upgrades do not put a trashed title back.

**Claim 1 is false for the past and partly true going forward.** Of the 34 deleted movies still in Radarr, 29 came back from Kometa (lists), 4 from Seerr, and 1 never left. No deleted movie has been added since 2026-10-27. Every deleted movie that is **absent** is on Radarr's import-list exclusion list (592 of 592), and all 13 deleted shows are on Sonarr's. Kometa and an import list skip that list. Seerr does not. A manual add does not either.

**Claim 2 is partly true, and it is not permanent.** A Seerr add is tagged `mediarequests`. Maintainerr's movie rule, last read on 2026-10-30, excludes that tag from the pool. The app's own guardian does not read the tag. It reads a Save, the `dnd` tag, a recent watch, a watchlist, and the 180-day Age Guard. An upgrade does not strip `mediarequests` or a Save. The Age Guard resets when the file is replaced, so an upgrade lengthens that 180 days. After 180 days, a Kometa re-add with no Save and no watchlist can be trashed again. A Seerr re-add stays out of the pool only while the Maintainerr clause and the tag both remain.

**Claim 3 holds for every return that has a Deleted-Release Record, as a different posted name, and it is unproven where no record exists.** The app has stamped zero re-adds as the same release. History for the 34 agrees: no grab of the same title contains the recorded release group. Four movies were re-grabbed with no record of what was deleted, so those four are unproven. Fifty deleted movies have no active release record at all. A term expires after 365 days; none have expired. The earliest expiry is 2027-07-09.

## How this was read

| Read | When (America/New_York) | What |
| --- | --- | --- |
| CNPG replica `pg_is_in_recovery()` | 11:44 | `true`. Session time zone `America/New_York`. `SELECT` only. |
| `trash_sweep_status` | after 11:45 | last outcome `ok` at 11:45:55. The 11:45 sweep deleted the movie batch that expired at 11:17 (32 items). That sweep was the schedule, not this audit. |
| Radarr `GET /api/v3/system/status` | same day | Radarr 6.4.4.10685. One deployment, `deploy/radarr`. |
| Radarr `GET /api/v3/movie` | after the 11:45 sweep | 9,598 movies. Compared with 626 deleted TMDB ids inside this session. Raw body not stored. |
| Radarr `GET /api/v3/exclusions/paged?pageSize=1000` | same pass | 595 rows, one page. |
| Radarr `GET /api/v3/history/movie?movieId=` | same pass | 34 movie ids, one GET each, event type, date, source title, and quality only. |
| Sonarr `GET /api/v3/series`, exclusions, history for series 1084 | same pass | 1,085 series. 13 deleted TVDB ids. |
| Radarr and Sonarr `GET /api/v3/importlist`, `releaseprofile`, `qualityprofile`, `config/downloadclient` | same pass | names, flags, and counts. No list fields, no terms, no keys. |
| haynes-ops clone `3ad4b39f` | same day | `kubernetes/main/apps/media/kometa/`. The live `config.yml` is a PVC copy the seed does not overwrite. Those booleans were not read off the PVC. |

The ledger's newest Radarr `last_seen_at` is 2026-11-13 04:30. Presence is taken from the *arr, not from the ledger. The ledger still listed the 32 movies the 11:45 sweep had already removed.

## 1. Route table

A title is "guarded" when this route cannot add a Trash-deleted title. "Partly guarded" means the title can come back and the old release is blocked only when a matching term exists. The Title Exclusion is an import-list exclusion (`ensureTitleExclusions`, `packages/domain/src/title-exclusion.ts:151`), written before the delete (`recordAndBlockReleases`, `packages/domain/src/release-block.ts:1654`). The Release Block is one profile, `haynesnetwork: deleted releases (managed, do not edit)` (`packages/domain/src/release-terms.ts:31`), written by `reconcileReleaseBlock` (`packages/domain/src/release-block.ts:1243`). A term lasts 365 days (`RELEASE_TERM_LIFETIME_DAYS`, `packages/domain/src/release-block.ts:62`).

| Route | What guards a deleted title | Code or config | Live read, 2026-11-13 | Verdict |
| --- | --- | --- | --- | --- |
| Seerr request | The exclusion list is not consulted. Seerr's add is `POST /movie` or `POST /series` (ADR-097). The Release Block applies to the search that follows, when a term exists. The add is tagged `mediarequests` except the two cases in ADR-093 C-11 (anime series if `animeTags` is empty; a search of a movie Radarr already has). | ADR-097 C-02; ADR-093 C-11. The app does not perform this add. | Four movies and one show in the returned set carry `mediarequests` plus a Seerr user tag. Two of those movies, and the show, were already on the exclusion list and still came back. | Partly guarded |
| Seerr watchlist sync | Same Seerr add, once sync turns a Plex watchlist row into a request. | `seerr_watchlist_enroll` (`packages/domain/src/seerr-enroll.ts`). ADR-093 C-11. | Setting `enabled` true, `onlyUserIds` null (every user). 21 enrollment rows, all confirmed, 0 opt-out, last checked 10:44. | Partly guarded |
| `set_watchlist` | Writes the Plex watchlist. It does not call Radarr or Sonarr. Seerr sync may then request the title. | `packages/mcp/src/tools.ts:266`. The tool text says an add of a title that is not on Plex makes Seerr download it. | Not invoked. No separate live add was found. | Partly guarded, by the Seerr path above |
| Kometa `radarr_add` / `sonarr_add` | Kometa's client skips an import-list exclusion (ADR-097, Kometa `respect_list_exclusions_when_adding()`). It does not skip a title that is not on that list. `upgrade_existing` is false in the git seed, so Kometa does not replace a file it already has. | Git seed in haynes-ops `kometa/app/externalsecret.yaml`: global Radarr and Sonarr `add_missing: true`, `search: true`, `upgrade_existing: false`, movie availability `released`, profile `FHD-UHD`. Explicit `radarr_add_missing: true` on defaults universe, seasonal, oscars, golden, and on the four collections in `movies-awards.yml`. Charts (`movies-charts.yml`), curated franchises (`movies-franchises.yml`), and the TV files `shows-franchises.yml` and `shows-collections.yml` do not set the flag false, so they inherit the global true. People, studio lists, and the app-managed include set it false. | The 25 seasonal returns share one Radarr `added` time, 2026-10-01 10:32:56Z, which is the run ADR-097 already named. Two returns carry the IMDb Popular tag and two the universe tag. No Kometa-tagged return has an `added` time after 2026-09-13 except that Oct 1 wave. PVC flags were not re-read. | Guarded for a title that is on the exclusion list. Unguarded for the 32 present movies that are not on it, if they later leave the library without Trash writing the exclusion. |
| *arr import lists | An import list skips the exclusion list. | Radarr and Sonarr import-list exclusion APIs, as ADR-097. | `GET /api/v3/importlist` is `[]` on both. | Guarded today because no list is configured. A list added later would still skip the 592 movies and 13 shows that are excluded, and would not skip the 32. |
| Manual add | The movie or series add does not read the exclusion list. A later search still goes through the release profile. | ADR-084 D-3 and ADR-093 C-18 (a hand grab of a rejected release is still possible). | None of the 34 is untagged. This route did not produce the current returns. It remains open. | Unguarded for the title. Partly guarded for the release. |
| Upgrade, RSS, cutoff search | Does not add a missing title. For a title already in the library, FHD-UHD may upgrade until the cutoff. The release profile has no tag and `indexerId` 0, so it applies to those decisions too. | ADR-093 C-07. Quality profile `FHD-UHD`. | Radarr cutoff `Remux-2160p`, `upgradeAllowed` true. Sonarr cutoff `Bluray-2160p Remux`, `upgradeAllowed` true. All 34 returned movies are on FHD-UHD. `autoRedownloadFailed` is false on both. | Does not re-add a missing title. Can grab a new release of one that is already in. The old release stays blocked until the term expires. |
| Disk rescan of a file that survived the delete | No indexer fetch. Not an exclusion-list path. | Not a writer in this app. | The returned movies' imports are `downloadFolderImported` after the new `added` time, except The Devil's Mouth, whose file predates the recorded delete. | Not observed as a re-add. Unproven as a future path if a hardlink survives. |

Maintainerr does not add titles. There is one Radarr and one Sonarr deployment. The Sonarr mislabel profile (36 ignored terms, no tags) blocks some release names. It does not stop a series from being added. Two further Radarr profiles and one Sonarr profile are tag-scoped to a single title. They are not the Trash block.

The 11:45 sweep outcome `ok` means `auditMaintainerr` passed (`packages/domain/src/trash-batches.ts:1502`). That audit requires `listExclusions: true` and, except on an episode pool, `forceSeerr: true` (`packages/domain/src/trash-flow.ts:221`). So those two flags were on when today's deletes ran. The `mediarequests` clause of the movie rule was not re-read. Maintainerr is not one of this story's read routes. It was last read on 2026-10-30 (`.agents/context/2026-10-30-trash-catch-up.md`).

## 2. Live cross-check

Population, replica, after the 11:45 sweep:

| Kind | Deleted titles | In the *arr now | Of those, on the exclusion list | Absent | Absent and not excluded |
| --- | ---: | ---: | ---: | ---: | ---: |
| Movie (distinct TMDB on a deleted batch item) | 626 | 34 | 2 | 592 | 0 |
| Show (distinct TVDB) | 13 | 1 | 1 | 12 | 0 |

Radarr's exclusion list has 595 rows. 594 of them are deleted movies. One (TMDB 1220564) is in neither `media_items` nor the trash tables. Sonarr's list has 68 rows. All 13 deleted shows are on it. The other 55 were not matched to a trash batch and were not investigated.

App audit rows (`trash_title_exclusions`): Radarr 324 `backfill` and 151 `sweep`; Sonarr 13 `backfill` and no sweep rows. A title Maintainerr excluded itself has no app row. Babygirl is the example: on Radarr's list, no app row, deleted 2026-09-20 after `listExclusions` was required, re-added by Seerr on 2026-09-28.

Release records, all `active`, none `expired`: Radarr 638 records, 619 distinct terms; Sonarr 63 records, 63 distinct terms. The live profiles hold 620 and 64 ignored terms. That is the distinct terms plus the sentinel `hnet-release-block-sentinel`. The profiles match the records.

`readd_same_release` is true on **zero** rows. Radarr: 37 stamped different, 3 seen with no grab, 598 not seen. Sonarr: 1 stamped different (the show below).

The 2026-10-30 note's 34 present movies are still 34. Every current Radarr `added` time is on or before 2026-10-27, so none of these movie records was created after that note. The note did not list ids, so this is the count plus `added`, not a stored id list.

### Movies

"Different group" means no post-return grab's source title contains the recorded release group. That is the block's own idea of the same release (title, year, resolution, group). It is not a byte-for-byte proof, and a repost that drops the group would not match.

| Title | TMDB | Radarr added (UTC) | Route | Recorded group | On disk now | Same release? |
| --- | ---: | --- | --- | --- | --- | --- |
| The Devil's Mouth | 1481343 | 2026-07-06 (before the 2026-09-13 delete) | Kometa IMDb Popular tag; the record never left | none | FLUX WEBDL-2160p, grabbed 2026-07-29 | Not a return. No grab after the recorded delete. |
| Do Not Enter | 999136 | 2026-07-26 10:59 | Kometa IMDb Popular | none | SCOPE WEBDL-2160p | Unproven. No Deleted-Release Record. |
| Annabelle | 250546 | 2026-08-30 10:31 | Kometa universe | none | FLUX WEBDL-2160p (two failed grabs of the same name, then one import) | Unproven. No record. |
| Mother Mary | 1102883 | 2026-08-30 11:01 | Kometa IMDb Popular | none | SCOPE WEBDL-2160p (one failed grab of a different group, then SCOPE) | Unproven. No record. |
| Jay and Silent Bob Reboot | 440762 | 2026-09-13 10:30 | Kometa universe | none | PmP Remux-1080p | Unproven. No record. |
| Another Simple Favor | 974573 | 2026-09-28 12:21 | Seerr user 15 | BYNDR, FLUX, Kitsune | HONE WEBDL-2160p | Different group. Not on the exclusion list. |
| Babygirl | 1097549 | 2026-09-28 12:23 | Seerr user 1 | FraMeSToR | CiNEPHiLES Remux-2160p | Different group. On the exclusion list. |
| Terrifier | 420634 | 2026-09-28 12:23 | Seerr user 1 | FraMeSToR (release name says 2016) | UnKn0wn Remux-2160p | Different group. Not on the exclusion list. |
| A Nightmare on Elm Street (2010) | 23437 | 2026-10-01 10:32 | Kometa seasonal | D-Z0N3 | FraMeSToR Remux-1080p | Different group. |
| We Bury the Dead | 1198984 | 2026-10-01 10:32 | Kometa seasonal | FraMeSToR | Remux-2160p, no group in the name | Different posted name. The group token is absent, so the term would not match. Same bytes unproven. |
| Scooby-Doo | 9637 | 2026-10-01 10:32 | Kometa seasonal | FraMeSToR | KRaLiMaRKo Remux-1080p | Different group. A failed grab in the same minute was a different title. |
| Keeper | 1288072 | 2026-10-01 10:32 | Kometa seasonal | CiNEPHiLES, FraMeSToR, dOwn | Aisha Remux-2160p | Different group. |
| Rabbit Trap | 1193824 | 2026-10-01 10:32 | Kometa seasonal | PiRAMiDHEAD, playBD | TURG WEBDL-2160p | Different group and quality. |
| The Astronaut | 1086260 | 2026-10-01 10:32 | Kometa seasonal | FraMeSToR, dOwn | seedpool Remux-2160p | Different group. |
| The Hand That Rocks the Cradle (2025) | 1362315 | 2026-10-01 10:32 | Kometa seasonal | FLUX | Kitsune WEBDL-2160p | Different group. |
| Cuckoo | 869291 | 2026-10-01 10:32 | Kometa seasonal | seedpool | TvR Remux-2160p | Different group. |
| In a Violent Nature | 1214509 | 2026-10-01 10:32 | Kometa seasonal | FraMeSToR, UBits | UnKn0wn Remux-2160p | Different group. |
| Borderline | 1013482 | 2026-10-01 10:32 | Kometa seasonal | Aisha | ADDICTION Remux-1080p | Different group. |
| 31 | 284564 | 2026-10-01 10:32 | Kometa seasonal | FraMeSToR | NCmt Remux-1080p | Different group. |
| Get Away | 1201753 | 2026-10-01 10:32 | Kometa seasonal | PiRaTeS | FLUX WEBDL-2160p | Different group and quality. |
| Cherry Falls | 12619 | 2026-10-01 10:32 | Kometa seasonal | EPSiLON | decatora27 Remux-1080p | Different group. |
| Humane | 914215 | 2026-10-01 10:32 | Kometa seasonal | PiG30N | BYNDR WEBDL-2160p | Different group and quality. |
| Tammy and the T-Rex | 55563 | 2026-10-01 10:32 | Kometa seasonal | FraMeSToR | BLURANiUM Remux-2160p | Different group. |
| Zom 100: Bucket List of the Dead | 1070514 | 2026-10-01 10:32 | Kometa seasonal | FLUX | OzONE WEBDL-1080p (imported 2026-10-13) | Different group. A failed 2160 grab the same day has no group token. A failed grab on 2026-10-01 was a different title. |
| I Am the Pretty Thing That Lives in the House | 407559 | 2026-10-01 10:32 | Kometa seasonal | NINJACENTRAL | EcK WEBDL-1080p | Different group. |
| Grafted | 1201262 | 2026-10-01 10:32 | Kometa seasonal | none (Remux-1080p) | PTP Bluray-1080p | Different quality. |
| Mad Heidi | 566805 | 2026-10-01 10:32 | Kometa seasonal | CiNEPHiLES | TvR Remux-2160p | Different group. |
| Spookley the Square Pumpkin | 54408 | 2026-10-01 10:32 | Kometa seasonal | OnlyWeb | no file | No grab in history. Not fetched. |
| Frankie Freako | 1127407 | 2026-10-01 10:32 | Kometa seasonal | BYNDR | WEBDL-2160p, no group in the name | Different posted name. Group token absent. Same bytes unproven. |
| The Dead Thing | 1287842 | 2026-10-01 10:32 | Kometa seasonal | KITSUNE | a different group, WEBDL-1080p, name year 2024 | Different group. |
| Hellbent | 47488 | 2026-10-01 10:32 | Kometa seasonal | ELEVATE | no file | No grab in history. Not fetched. |
| Mosquito | 41574 | 2026-10-01 10:32 | Kometa seasonal | AOS | no file | No grab in history. Not fetched. |
| Dear Dracula | 140109 | 2026-10-01 10:32 | Kometa seasonal | ADDICTION | CONVOY WEBDL-1080p | Different group. |
| Lucky Strike | 1594914 | 2026-10-27 23:52 | Seerr user 13 | DUDU WEBDL-2160p | SCOPE WEBDL-1080p, then on 2026-10-29 MGE WEBDL-2160p | Different group, twice. On the exclusion list (backfill, 2026-10-03). |

The Oct 1 seasonal wave is the 25 movies ADR-097 counted, and it ran before the 2026-10-03 exclusion backfill. The backfill left them out because they were already present (ADR-097 C-10). They are still not on the list. That matches the ruling that those copies stay, and it leaves them unprotected against a later non-Trash removal.

Fifty of the 626 deleted movies have no active release record. Five of those fifty are in the table above (the four unproven re-grabs, plus The Devil's Mouth). The other 45 are absent and are on the exclusion list, so a list will not add them. A Seerr request of one of them has nothing to block.

Radarr record mix, active: 338 `legacy_sab` verified, 223 `arr_file` low confidence, 73 `ledger_grab` verified, 4 `arr_grab_history` verified. Sonarr's 63 are all `ledger_grab` verified. The 32 movies deleted at 11:45 today are in the low-confidence set (the term is built from Radarr's renamed file). They are not in the library now.

### The show

| Title | TVDB | Sonarr added (UTC) | Route | Recorded group | On disk now | Same release? |
| --- | ---: | --- | --- | --- | --- | --- |
| The Idol (2023) | 405882 | 2026-10-13 21:59 | Seerr user 12 | KiNGS | HONE season pack, WEBDL-2160p, 5 of 5 episodes | Different group. On the exclusion list. One grab name, five episode records at the same second. |

## 3. Re-requested titles

A re-request is not a Save. The old "requested items start saved" behavior is retired (`packages/db/src/schema/trash-batch-items.ts`, the vestigial `saved_reason` comment). The guardian's keeps, in order, are an open Save, the `dnd` tag, a recent watch, any read watchlist, and the Age Guard (`classifyGuardian`, `packages/domain/src/trash-flow.ts:1391`). `dnd` is `PROTECTED_TAG` (`packages/domain/src/trash-flow.ts:65`). `mediarequests` is not in that function.

| Protection | How it is applied | How long | Does a file replacement drop it? |
| --- | --- | --- | --- |
| `mediarequests` | Seerr tags the add. Maintainerr's movie rule excludes the tag. Last confirmed 2026-10-30. Not re-read today. | Until the tag or the rule clause is removed. No expiry in the app. | No. Lucky Strike's file was deleted and replaced on 2026-10-29. The movie still carries `mediarequests` and Seerr user 13. |
| Age Guard | Newest download import or Plex date-added, 180 days (`TRASH_AGE_GUARD_DAYS`, `packages/domain/src/trash-age-guard.ts:19`). A folder import and the *arr `added` date do not count. | 180 days, then it lapses. An upgrade is a download import, so it starts the 180 days again. | It lengthens the window. It does not remove it. |
| Watchlist | Any account the registry could read. Enrollment is on (section 1). | While the title stays on a list that was read. It is not a Save. | The list is not the file. A Plex re-key is not re-tested here. |
| Save | `trash_save_intents`, written before Maintainerr is called (ADR-099). The sweep keeps the intent even when the exclusion is missing. | Until the explicit un-save. | The intent is on the ledger row. 189 open intents, 0 unconfirmed, 0 with a failed apply. 23 of them have a download import after `saved_at` and are still open. One historical `relink` ledger row. Six historical `lapsed` rows, from before ADR-099. |
| `dnd` | Maintainerr tag, read by the guardian. | Until the tag is removed. | The tag is on the movie. The Green Lantern lapse (ADR-086) was the Maintainerr exclusion, which was keyed to a Plex rating key. The intent now outlives that key. |

A Kometa re-add does not get `mediarequests`. The 29 Kometa movies in the table are protected by the Age Guard from their import date (the Oct 1 wave runs out about 180 days later, near the end of March 2027) and by a watchlist or a Save if either exists. They are not protected as requests. After the Age Guard lapses, Trash can take them if the Maintainerr rule still selects them.

A request for a movie Radarr already has does not add the tag (ADR-093 C-11). Requesting one of the Kometa copies again would search it and would not mark it `mediarequests`.

## 4. Upgrades

A Saved or pending title stays in Radarr when the file is replaced. The movie id does not change. Lucky Strike is the live case: same movie id, file replaced two days after the Seerr add, tags unchanged.

What the upgrade can grab:

- The profile applies to every indexer and every movie. A term rejects that release pattern, including an upgrade grab, until `expires_at`.
- Kometa's seed sets `upgrade_existing: false`, so Kometa is not the upgrade path. The live PVC was not read.
- Radarr's FHD-UHD profile, which all 34 use, allows upgrades up to Remux-2160p. Sonarr's FHD-UHD allows upgrades up to Bluray-2160p Remux. An upgrade to a **different** group is allowed. That is what Lucky Strike did (SCOPE 1080, then MGE 2160, neither of them the deleted DUDU release).
- `autoRedownloadFailed` is false on both, so a failed grab is not immediately fetched again by the *arr. The retries visible on Annabelle (2026-08-30) and on the Oct 1 wave predate that setting.

After 365 days the upkeep sets the record `expired` and drops the term (`packages/domain/src/release-block.ts:1260`, test "expires terms past their 365 days" in `release-block.test.ts`). The exclusion list does not expire (ADR-097 C-09). So a list still cannot add the title, and a Seerr request, a manual add, or an upgrade of a copy that is already back **can** grab the old release. Nothing has expired. Earliest Radarr expiry 2027-07-09 23:45 EDT. Earliest Sonarr expiry 2027-08-12. The cap is 3,000 terms. Radarr is at 619.

Low-confidence terms are the other hole inside the 365 days. 223 Radarr records, all `arr_file`, are built from the renamed file. ADR-093 C-22 measured that kind of term against real names and found it misses about 8 percent. That figure is from the ADR, not re-measured today. Today's 32 deletes are all in this class.

## 5. Regression checklist

| Past failure | Fix | Test that still exists |
| --- | --- | --- |
| ADR-084: a delete left no memory, and the next search grabbed the same release in seconds. The blocklist API cannot create entries. | ADR-093 Release Block, recorded before the delete. ADR-097 exclusion before the delete. | `release-block.test.ts` (record, profile, read-back, re-add stamp including "the same release is an error"). `title-exclusion.test.ts` (write before the handle; a failure deletes nothing). |
| ADR-084 / the 2026-10-01 seasonal wave: Kometa re-added titles deleted before `listExclusions`. | App writes the exclusion first. Backfill skipped titles the *arr still had. | `title-exclusion.test.ts` backfill: "never a title the *arr has now". The live 32 are that skip, still in force. |
| ADR-086: a Save died when Plex re-keyed after an upgrade (one realised case). | `trash_save_intents` and a relink. ADR-099 made the intent the keep and re-applies a same-key lapse too. | `trash-relink.test.ts` (new key, and ADR-099 same-key reapply). `trash-batches.test.ts` ADR-099 block, including a sweep that keeps a Save whose exclusion is not applied. |
| ADR-096: a Save during Maintainerr's rule run was shown as saved and was not recorded. | The wall flips only after the server answers. ADR-099 records the Save before the Maintainerr call. | `apps/web/lib/__tests__/wall-taps.test.ts` ("ADR-096 — confirmed-only"). `apps/web/e2e/trash.spec.ts` covers the confirmed glyph. |
| ADR-093: Arm/Disarm dropped `listExclusions` and `forceSeerr`. | The save lifts the flags and the audit refuses the sweep if they are off. | `trash-flow.test.ts`: a Disarm sends the flags back; the aging invariant refuses a pool with either flag off. Today's `ok` sweep is the live check. |
| ADR-093: a term that does not compile would reject every release. | Grammar whitelist, checked before every write. | `release-block.test.ts`: "refuses before any write: a term outside the grammar". |
| ADR-093: disk-import year window could block a namesake. | The window leaves out a year the ledger already uses for the same title. | `release-block.test.ts` D-25cr. |
| ADR-093 C-09: terms must expire. | 365 days, then the upkeep drops them. | `release-block.test.ts`: expire, and "the hourly upkeep drops a term past its 365 days". Not observed live. |
| Age Guard missed an upgrade because Maintainerr reads one server's date-added. | The app takes the newest download import and any Plex date. | `trash-age-guard.test.ts`: an upgrade 60 days ago is kept; a title upgraded while already in a batch is kept. |
| A pending Save counted toward the space-policy minimum (`#1049`). | The minimum uses the same `saveIntent` check as the batch builder. | `space-policy.test.ts`, added with that fix. Not re-run this session. |
| A fast green-light left the tab on a stale review (`#654`). | UI fix `#659`. | Not re-tested here. Out of the re-add path. |
| Release years hidden and watchlisted candidates shown (`#1054`). | Display fix. | Not a re-add control. |

No test asserts that Seerr's `POST /movie` ignores the exclusion list. That is upstream behavior, cited from ADR-097's read of Seerr, and the five Seerr returns in section 2 are the live evidence. No test covers a manual add. No test covers Kometa's client. The Kometa guarantee is the exclusion list plus Kometa's own skip, which this session did not see in a log.

## Gaps, ToS first

1. **Fifty deleted movies have no release term.** Forty-five are absent and excluded, so only Seerr or a manual add can bring them back, and nothing then stops the old release. Four already came back and were grabbed with no record to compare. Proposed story: list those 50 from the ledger (title, year, delete date, whether any grab name survives) and stop there for a ruling. Do not seed a term from a guess.

2. **223 low-confidence terms, including every movie deleted today.** The term is the renamed file, not the posted name. ADR-093 C-22's miss rate was about 8 percent of real names. A later Seerr request can fetch a name the term does not match, inside the 365 days. Proposed story: a ruling, then either keep `arr_file` / `low_confidence` items (`release_unrecorded`) or accept the miss. Faster Trash should not start on this class until that ruling.

3. **Terms expire.** After expiry a Seerr request or an upgrade can grab the old release. Lists stay blocked. First expiry 2027-07-09. Proposed story: a ruling only, unless the owner wants the life changed. No code until then.

4. **The block matches a name pattern, not an indexer id.** A repost that omits the group is a different name. We Bury the Dead and Frankie Freako landed as group-less names. They are not proven to be the old release. Proposed story: none until a grab is shown to be the same bytes. Do not store download URLs. They carry keys.

5. **A hand grab can take a release the profile rejected** (ADR-093 C-18). Not seen in these 34 histories. The grabs follow the add by seconds, which is automatic search. Proposed story: none. Treat a hand grab as an admin action.

6. **Thirty-two present movies have no exclusion.** They are safe from Kometa while they stay in Radarr. A delete that is not Trash does not write the exclusion, and the next Kometa run can add them and search. The 2026-10-03 ruling left them out on purpose. Proposed story: if that ruling is reversed, one backfill of those 32. The exclusion is inert while the movie is present. The existing script skips present titles, so this needs an explicit exception, not a re-run of `--apply`.

7. **`mediarequests` is not an app keep.** Protection of a re-request depends on a Maintainerr clause last read on 2026-10-30. Proposed story: re-read that clause (Maintainerr `GET`, which this session did not have), and if the owner wants the protection inside the app, add the tag to the guardian. That is a design change, after a ruling.

8. **Kometa's live `config.yml` may have drifted from the git seed.** The seed is what section 1 quotes. Proposed story: print only `add_missing`, `search`, `upgrade_existing`, and the per-default flags, from the PVC, with tokens stripped. One short read.

9. **Log confirmation was not available.** Grafana is not in this session. Useful Loki, for the coordinator, not run here: `{namespace="media"} |= "Exclusion List"` on the Kometa collections job, and `{namespace="frontend"} |= "[release-block] readd"` for `sameRelease`. The database stamp is already zero.

## Questions for the owner

Q-01. Does "requests it again from Seerr" include Seerr's watchlist sync, and therefore `set_watchlist`? Both create a Seerr request and both ignore the exclusion list. Recommendation: count them as the allowed path. They are already how ruling 3 of 2026-09-26 adds titles. Say so in the faster-Trash ruling if sync should stop requesting deleted titles.

Q-02. After a term's 365 days, may a Seerr request or an upgrade fetch the old release? The code allows it. Recommendation: keep 365 days. The first expiry is 2027-07-09, so this does not block the current faster-Trash decision. It does mean "never the same release" is not what the code does.

Q-03. Should the 32 movies that are back, and not excluded, gain an exclusion while they sit in the library? Recommendation: yes. It does not remove them. It stops Kometa if they are deleted outside Trash. It reverses the "leave present titles" line of the 2026-10-03 ruling, so it needs a new ruling.

Q-04. Are the 45 absent movies with no release record an accepted Seerr risk? Recommendation: yes until a later read can name them, and do not invent terms. Faster Trash does not make this worse for titles it deletes, because a delete with no term is kept. It matters for these 45 old ones.

Q-05. Are low-confidence deletes acceptable for faster Trash? Recommendation: no. Keep a movie whose only name is the renamed file, the same way a movie with no name is kept, until the miss rate is accepted in a ruling.

Q-06. Is a manual add in Radarr or Sonarr allowed? Recommendation: yes, as an admin action. The release profile still applies to the search. Do not build a second block for the UI.

Q-07. Should faster Trash wait on a PVC read of Kometa's add flags? Recommendation: yes, one read of the booleans. The git seed is from a file last changed 2026-07-19 (`9a6d3d84` on that path) inside clone `3ad4b39f`, and the file itself says the PVC wins after the first seed.
