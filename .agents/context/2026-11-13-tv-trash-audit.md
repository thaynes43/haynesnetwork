# TV Trash audit — 2026-11-13

OpenProject story **#822** (epic #814). Read-only. No rule, cap, or setting was changed.

The story's acceptance artifact is this note. Its constraints also say an ADR or design amendment lands in the same change as a behavior change. Scope keeps the rule change out, and acceptance is the owner's ruling, which is still open. This pull request is the audit only. An ADR waits until that ruling.

Full tables: [2026-11-13-tv-trash-census-shows.csv](2026-11-13-tv-trash-census-shows.csv) (1,085 shows) and [2026-11-13-tv-trash-census-seasons.csv](2026-11-13-tv-trash-census-seasons.csv) (5,684 seasons). Titles are included. No person is named.

Every count below is either **measured** (command and time) or a **projection** (this census, not a Maintainerr rule run). Decimal TB means bytes / 10^12.

## What is empty

Measured 2026-11-13, `GET /api/collections` and `GET /api/rules` on Maintainerr 3.32.0 (`GET /api/app/status`, commit tag `latest-e6327bb`):

| Collection | id | type | library | members | bytes |
| --- | ---: | --- | --- | ---: | ---: |
| hnet — unwatched low-value TV | 3 | show | `"2"` | 0 | none |
| Leaving Soon — TV | 23 | show | `"2"` | 0 | none |
| hnet — unwatched low-value movies | 1 | movie | `"1"` | 540 | 11,186,645,382,359 |

The TV rule group is id 2, active, `useRules` true, `dataType` **`show`**. Its collection records `handledMediaAmount` 13 and `handledMediaSizeBytes` 972,840,970,033. Those are historical. The app's TV batch items agree on the count and almost on the bytes: 13 deleted items, 966,386,331,756 bytes, first delete 2026-08-05 08:45-04, last delete 2026-09-14 16:45-04 (replica `postgres16-11`, `trash_batch_items` joined to `trash_batches`). There is no open TV batch. The rule text dates its age clause to 2026-09-14, the same calendar day as the last TV deletion.

The candidate snapshot agrees. Measured 2026-11-13 11:45-05: `trash_candidates_state` for `tv` is 0 items and 0 bytes. Movie snapshot the same minute: 524 items.

Library `"2"` is the HaynesOps Plex library whose section key is `2` and whose name is HOps TV Shows (`plex_libraries` joined to `plex_servers`). Maintainerr settings name one Plex server, HaynesOps. The TV rule's Plex predicates read that server only.

## The live rule, predicate by predicate

Group 2, section 0. The first clause has a null operator, which starts the set. Each later clause has operator `0` (`AND`). A missing value fails an AND clause (the comparator drops the show). Number comparisons are strict. `BEFORE` on a date property whose custom value is a number of seconds compares `value <= now - seconds`. Action codes from the image's rule constants: `SMALLER` = 1, `NOT_CONTAINS` = 9, `BEFORE` = 5.

| # | id | Reads | Test | Value |
| --- | ---: | --- | --- | --- |
| 1 | 156 | Sonarr property 19, `rating`, "Show rating (IMDb) (scale 0-10)" | smaller than | 6.0 |
| 2 | 157 | Plex property 17, `sw_amountOfViews`, "Total views" | smaller than | 1 |
| 3 | 158 | Sonarr property 2, `tags`, "Tags (show)" | does not contain | `mediarequests` |
| 4 | 159 | Plex property 0, `addDate`, "Date added" | before | 15,552,000 seconds (180 days) |

There is no vote-count clause. The movie rule still has one (IMDb votes greater than 99) plus IMDb rating below 6.5, movie view count below 1, the same request tag, and the same 180-day added-date clause (condition ids 160–164, group 1).

`sw_amountOfViews` on a show walks every child season, including specials, then every episode, and adds the length of that episode's Plex watch-history rows. The history read is `/status/sessions/history/all` for that metadata id, served from the library's history snapshot when the snapshot is present. One history row on one episode makes the total at least 1, so the "smaller than 1" test fails. The rows are for the one configured Plex server. Plays on HaynesTower and HaynesKube are invisible to this clause. The app's cross-server watch keep is a different check, and it runs only after a show is already in the pool.

`addDate` is the show record's `addedAt` on that Plex library, the same field the plex-match sync stores in `media_plex_matches.plex_added_at`. It records when that show row appeared in HOps TV Shows. The finale's air date and the date Sonarr first listed the series are other fields, and this clause does not read them.

Exclusions for group 2, measured the same day: 360 rows came back, all global (`ruleGroupId` null), none owned by the group. Types: 168 movie, 8 show, 11 season, 173 episode. A show is removed when its own id is excluded. An episode exclusion does not remove the show. Eight show exclusions cannot empty a library of 953 shows.

The five-item cap is not a Maintainerr predicate. Measured in `app_settings.space_policy`, updated 2026-10-30 11:07-04:

- enabled, mode `over-target`, `minCandidates` 1, array `haynestower` enabled
- TV: `maxItems` 5 enabled, `targetBytes` disabled (stored value 107,374,182,400), no `strategy` key
- movies: `maxItems` 50, strategy `largest`, `targetBytes` disabled

An absent TV strategy resolves to worst-rated (`packages/domain/src/space-policy.ts`). The cap trims a batch built from shows already in the pool. With zero pool members it never selects. `minCandidates` 1 would allow a batch of one show.

The app's own keeps (`packages/domain/src/trash-flow.ts` `classifyGuardian`, `packages/domain/src/trash-age-guard.ts`) apply to pool members at batch build and at the sweep:

- an open Save
- the `dnd` tag
- household last view inside 30 days
- on a watchlist
- Age Guard: newest of (download import, Plex `addedAt` on any server) inside 180 days
- unevaluable: no ledger row, watchlist unknown, rule evaluation failed, or a Plex match with no date

A requester tag is not a keep (owner ruling 2026-07-09). The Maintainerr `mediarequests` clause is stricter than the app. In-progress is not its own keep. A partial play protects the show when the harvested last view is inside 30 days.

The Age Guard is series-scoped: one episode import inside 180 days protects the whole series (`trash-age-guard.ts`). ADR-097 records the same whole-show assumption for the title exclusion and the Release Block.

## Why the pool is empty

Measured on the replica, 2026-11-13 11:49-05 (`now() - interval '180 days'` = 2026-05-17 11:49-04). HOps TV Shows holds 953 ledger shows, every one dated. Oldest `plex_added_at`: **2026-07-02 22:00:21-04**. Newest: 2026-11-11 18:26-05. Shows at or older than the cutoff: **0**. Shows inside 180 days: **953**.

The added dates are a library fill, then a trickle:

| Day (America/New_York) | Shows |
| --- | ---: |
| 2026-07-02 | 604 |
| 2026-07-03 | 220 |
| 2026-07-06 through 2026-11-11 | 129 |

The plex-match rows for that library were all restamped 2026-11-13 11:52-05, from Plex's own `addedAt` (`packages/sync/src/plex-match.ts`). The dates run from July 2 through November 11, so they are the library's added dates. A single sync clock would have stamped one timestamp.

Clause 4 (`addDate` before 180 days) therefore fails for every show the rule can see. Clauses 1–3 do not, on the census proxies below. The AND of a clause that fails for every show is an empty pool. This is a deduction from the live predicate and the synced `addedAt`, not a Maintainerr evaluation. A native rule test is a command and was not called. The live membership of 0 matches the deduction.

The other clauses, projected onto those 953 shows (Sonarr rating and tags, Tautulli play counts as a stand-in for Plex history length):

| Clause | Shows that pass | Bytes |
| --- | ---: | ---: |
| Rating below 6.0 | 54 | 7,838,701,560,290 (7.839 TB) |
| HaynesOps Tautulli plays = 0 | 938 | — |
| HaynesOps Tautulli plays > 0 | 15 | — |
| No `mediarequests` tag | 483 | — |
| `mediarequests` tag | 470 | — |
| Added at least 180 days ago | 0 | 0 |

`dnd` is on 8 of the 953. Parsed requester labels and the `mediarequests` tag overlap on 462 shows; 8 have the tag only; 8 have a requester label only.

HaynesTower's copy of the same library is old: 808 of the 953 have a tower `addedAt` at least 180 days ago, and 2 have no tower match. The rule never reads the tower date. The app Age Guard reads the newest date, so the July 2026 HaynesOps date is the one that wins.

The first show becomes old enough for clause 4 at **2026-12-29 22:00:21-05** (measured: `min(hops addedAt) + interval '180 days'`). That is the July 2 cohort of 604 shows. Maintainerr's own clock subtracts 15,552,000 seconds, which is 180 times 24 hours. Across the autumn clock change that is one hour away from a calendar interval. It does not move the finding off December 29.

A direct Plex library read was refused: `GET /library/sections` on the HaynesOps Plex pod returned **401**, and that pod has no token variable. That route stopped there. The added dates above are the app's copy of the same Plex field, refreshed the same morning.

Grafana was not available in this session (no Grafana tools). The log that would show Maintainerr's own per-clause elimination for group 2 was not read. The membership of 0 and the added-date distribution already identify clause 4.

## Census

Two reads, joined on TVDB id. Every one of the 1,085 live Sonarr series is in the ledger, and the ledger has no extra live series.

- **Sonarr** `GET /api/v3/series`, reduced inside the session, about 2026-11-13 16:52 UTC. 1,085 series, 5,684 season rows, 217,798,000,245,753 bytes. Status: 778 ended, 300 continuing, 7 upcoming. This is the size, rating, status, and air date used below.
- **Replica** `postgres16-11`, America/New_York, queries from 16:47 UTC through 16:57 UTC. Watch, watchlist, tags, Plex added dates, download imports.

On the 953 HOps shows, Sonarr bytes are 215,885,853,726,127 (215.886 TB). The ledger's `size_on_disk` for the same set, read earlier the same hour, was 215,498,404,788,215. Thirteen shows differ in size. One show differs in rating by more than 0.05. Projections use the Sonarr figures. The 132 Sonarr series with no HOps TV match are 1,912,146,519,626 bytes (1.912 TB). The rule never sees them. Metadata `fetched_at` for the TV rows is 2026-11-13 06:15-05.

Watch limits, measured the same day:

- Household `play_count` / `last_viewed_at` come from the metadata harvest, which reads at most 20 pages of 500 Tautulli history rows per instance (`packages/sync/src/metadata-refresh.ts`). Among movies and shows that have a play, the oldest last view is **2026-06-07 20:31-04** and every TV last view is in 2026. An empty `household_plays` cell means "no play inside that harvest," which is about five months, not a lifetime. 192 live shows have a household play (188 with a HaynesTower breakdown, 15 with a HaynesOps breakdown). 893 have none.
- `user_media_watch` covers 164 shows. Fifteen shows have someone in progress, across 6 app users. That flag is not itself a guardian keep.
- `watch_titles` and `watch_events` are one tracked account. Episode events: 1,753 rows, 2023-09-24 through 2026-11-12. That account's four per-season columns (`tracked_account_*`) were in the season CSV as first written and were removed before merge, because they are one account's viewing times and this repository is public. The statements below that rest on that account were measured from those columns.
- Watchlist registry runs finished `ok` at 2026-11-13 11:45-05. 201 distinct show TVDB ids are on some watchlist.

HOps shows by Sonarr status: 661 ended, 292 continuing. Download imports (`downloadFolderImported` only, the Age Guard's event): 561 of 953 have one inside 180 days, 392 do not. The app would clear **0** shows today, because every HOps added date is inside 180 days.

## Projections

These apply the census in this session. They are not Maintainerr evaluations, and they are not a prediction of bytes freed on disk (hard links, saves, and the sweep still apply).

### The current rule, with the age clause removed

Twelve HOps shows, 838,724,127,581 bytes (0.839 TB), pass rating below 6.0, HaynesOps Tautulli plays 0, and no `mediarequests` tag. Four of them are in the July 2 cohort (291,753,258,904 bytes), which is what clause 4 starts admitting on 2026-12-29 if nothing else changes:

| Show | Status | Rating | Bytes | Why it is a weak candidate |
| --- | --- | ---: | ---: | --- |
| Mickey Mouse Clubhouse (2006) | ended | 5.9 | 188,397,116,307 | 56 harvested plays on HaynesTower, on a watchlist, `dnd` |
| Squid Game: The Challenge (2023) | continuing | 5.9 | 45,818,622,882 | still continuing; finale 2025-11-18 |
| Ironheart (2025) | ended | 4.5 | 32,223,030,084 | `dnd` |
| Secret Invasion (2023) | ended | 5.8 | 25,314,489,631 | `dnd` |

The other eight include The Masked Singer (US), which is continuing, and several ended limited series carrying `dnd` (The Acolyte, Willow, She-Hulk, Total DramaRama). The app would keep the `dnd` and watchlisted rows even after the added date ages out.

### Ended, last episode aired at least 180 days ago, rating below 6.0, no request tag

Projection clock 2026-11-13 16:57 UTC, so "180 days" means a finale on or before 2026-05-17. Ten shows, **412,648,319,552 bytes (0.413 TB)**. This is the recommended pool, before the app's keeps:

| Show | Rating | Bytes | `dnd` | Watchlist | HOps added |
| --- | ---: | ---: | --- | --- | --- |
| Total DramaRama | 4.0 | 21,216,798,990 | yes | no | 2026-07-03 |
| The Acolyte | 4.3 | 33,475,224,915 | yes | no | 2026-07-03 |
| Ironheart | 4.5 | 32,223,030,084 | yes | no | 2026-07-02 |
| She-Hulk: Attorney at Law | 5.2 | 27,244,469,073 | yes | no | 2026-08-05 |
| Star Wars Resistance | 5.3 | 28,892,374,991 | no | no | 2026-11-04 |
| Willow | 5.7 | 29,472,437,707 | yes | no | 2026-07-29 |
| Secret Invasion | 5.8 | 25,314,489,631 | yes | no | 2026-07-02 |
| Mickey Mouse Clubhouse | 5.9 | 188,397,116,307 | yes | yes | 2026-07-02 |
| Muppets Now | 5.9 | 13,041,795,823 | no | no | 2026-08-16 |
| Tales of the Walking Dead | 5.9 | 13,370,582,031 | no | no | 2026-08-01 |

After `dnd` and the watchlist, three shows remain (55,304,752,845 bytes, 0.055 TB): Star Wars Resistance, Muppets Now, Tales of the Walking Dead. None has a harvested household play. The Age Guard still holds them until the HOps added date (or a later download import) is 180 days old. Resistance was added 2026-11-04, so its guard runs into May 2027. Muppets Now and Tales clear in early 2027, not on December 29.

### Raising the rating cutoff

Same ended + finale + no request tag + no `dnd` filter, then the false positives the cutoff lets in:

| Cutoff | Shows | Bytes | Household play inside the harvest |
| --- | ---: | ---: | --- |
| below 6.0, and not `dnd` | 3 | 55,304,752,845 | none |
| below 6.5 | 20 | 3,680,973,407,813 | Boruto: Naruto Next Generations, rating 6.2, 1.623 TB, 3 HaynesTower plays, last view 2026-07-30 |
| below 7.0 | 61 | 8,964,956,101,496 | Boruto, plus Glee (rating 6.8, 79 HaynesTower plays, last view 2026-11-12) and Be Cool, Scooby-Doo! (11 plays, last view 2026-10-03) |

Glee's last view is inside the 30-day app keep. Boruto's is not. After the Age Guard lapses, a 6.5 cutoff would offer Boruto for deletion on the strength of a HaynesOps view count of zero.

### Ended, no harvested play, not watchlisted, nobody in progress, not `dnd`

504 shows, **88,134,572,751,569 bytes (88.135 TB)**. Five hundred of them have a finale already 180 days old (87.338 TB). This is the set a "nobody watched recently" rule produces from the harvest. It is not a lifetime unwatched set.

Largest members, all with an empty harvest cell: Game of Thrones (2.075 TB, rating 9.2, finale 2019-05-20), Seinfeld (1.937 TB, 8.8), Friends (1.889 TB, 8.8), Supernatural (1.860 TB, 8.4), 24 (1.812 TB, 8.4). A largest-first cap of 5 on this set is 9,573,130,960,567 bytes (9.573 TB) and is those five. A worst-rated cap of 5 is 281,207,606,444 bytes (0.281 TB) and is low-rated requested shows (Condor, a Beverly Hills series, three Teletubbies series).

The same quiet test on continuing shows is 144 shows, 44,810,005,777,333 bytes (44.810 TB). Largest: One Piece (finale 2026-09-27), MasterChef Australia, Law & Order, NCIS, Law & Order: Special Victims Unit. Those are shows still putting out episodes.

### HaynesOps views as a stand-in for "nobody is watching"

176 HOps shows have HaynesOps Tautulli plays of 0 and HaynesTower plays above 0: 54,975,696,571,294 bytes (54.976 TB). Largest ended examples the current view clause would call unwatched: Live PD (9 tower plays, last view 2026-09-26), Boruto, House (25 plays, last view 2026-08-20), ER, The Office (US) (997 plays, last view 2026-11-13, and one viewer in progress), The Sopranos, The West Wing, Lost.

Fourteen shows have someone in progress and zero HaynesOps plays (7.720 TB), including Saturday Night Live, Sesame Street, The Office (US), and Doc Martin. Doc Martin has an in-progress viewer and an empty household last-view cell, so the 30-day keep would not see it. Its rating is 8.4, so the rating floor keeps it out.

165 shows are watchlisted with zero HaynesOps plays (37.257 TB). Ended, quiet, and watchlisted examples the rating floor would otherwise have to save on its own: Stranger Things (1.423 TB), The Big Bang Theory, Dawson's Creek, Brooklyn Nine-Nine, Curb Your Enthusiasm, The Mandalorian. The app watchlist keep covers these when the registry run is `ok`.

### Seasons

On the 504-show quiet ended set, seasons numbered 1 and up that have files are 1,553 seasons and 88,074,921,047,096 bytes. Specials on that set are 59,651,704,473 bytes. Deleting those seasons deletes the shows. The app would still judge the series.

The one tracked account has 442 mapped seasons. On that account, some shows have a later season started and earlier seasons with no progress and with files. The largest of those unstarted-season groups are continuing shows (Law & Order: Special Victims Unit, Big Brother (US), Pokémon, American Horror Story, South Park). Peaky Blinders, which has ended, shows season 1 started and seasons 2–6 unstarted on that account (0.548 TB). That is one account. It is not a household season census, and it is not a Maintainerr result.

### When the Age Guard would release the quiet ended set

Projected from `max(newest Plex addedAt, newest download import) + 180 days`. Zero shows are clear on 2026-11-13.

| Month the guard clears | Shows | Bytes |
| --- | ---: | ---: |
| 2026-12 | 270 | 53,828,540,986,711 |
| 2027-01 | 33 | 2,726,815,677,867 |
| 2027-02 | 124 | 16,562,502,789,801 |
| 2027-03 | 33 | 7,727,616,979,093 |
| 2027-04 | 22 | 4,032,897,521,075 |
| 2027-05 | 22 | 3,256,198,797,022 |

A download import inside the window keeps the whole series. Of the 311 quiet ended shows in the July 2 cohort, 117 have an import after the HOps add, so they stay protected past the day the library date itself turns 180.

## Recommendation

Keep the rule at **show** level. Keep the per-kind cap at **5** and the ranking at **worst-rated**. Leave the disabled byte cap disabled. `minCandidates` stays 1.

Change the rule in one place that the evidence supports, and leave the rating floor where it is:

1. Require Sonarr **show ended**.
2. Replace Plex **date added** before 180 days with Plex **last episode aired** before 180 days (same 15,552,000-second `BEFORE` encoding the added-date clause uses now).
3. Keep Sonarr rating **below 6.0**.
4. Keep **not tagged `mediarequests`**.
5. Remove the HaynesOps **total views below 1** clause.

The projected pool is the ten shows and 0.413 TB in the table above. The cap of 5 does not change which of the three non-`dnd`, non-watchlisted shows can eventually be deleted, and those three stay Age-Guard-held into 2027. This rule will not move the capacity target this month. It will stop the pool from being empty for a reason that has nothing to do with whether anyone watches the show.

The other candidates lose for a specific reason:

- Leaving the rule alone keeps the pool empty until 2026-12-29, and the first cohort that clause admits is the four July 2 shows above, which the app still holds.
- Dropping only the age clause admits continuing shows and Mickey Mouse Clubhouse.
- A 6.5 cutoff admits Boruto, watched on HaynesTower on 2026-07-30, outside the 30-day keep.
- A 7.0 cutoff also admits Glee, watched on 2026-11-12.
- "Ended and no play in the harvest" is 88 TB and its largest rows are Game of Thrones, Seinfeld, and Friends. The harvest starts in June 2026. That is not "nobody will watch."
- Largest-first picks those rows. Worst-rated on that wide set picks a tenth of a terabyte of a different guess.
- A season rule deletes files the Age Guard, the title exclusion, and the Release Block still treat as one series (ADR-097). The household season progress is not in the database.

## Questions for the owner

**Q-01.** Use "last episode aired at least 180 days ago" in place of "HaynesOps date added at least 180 days ago," and require the show to have ended? Recommendation: yes. The added date is the July 2026 library fill.

**Q-02.** The Age Guard's "newest date wins" ruling of 2026-10-03 makes that same July fill protect every show, including 808 whose HaynesTower added date is already past 180 days. Should a Plex added date that arrived with a library fill lose to an older added date for the same show on another server, while a real download import still protects the series? Recommendation: yes. That is a change to the guard, and it is a separate story. Until it lands, the ten-show pool above is visible to Trash and still held.

**Q-03.** Keep the rating floor at 6.0? Recommendation: yes. 6.5 admits Boruto. 7.0 admits Glee.

**Q-04.** Remove the HaynesOps "total views below 1" clause? Recommendation: yes. It passes 938 of 953 shows and it calls The Office (US) and House unwatched.

**Q-05.** Keep the `mediarequests` exclusion? Recommendation: yes for this change. It covers 470 of 953 shows. The app no longer treats a requester as a keep, and dropping the tag is its own ruling.

**Q-06.** Is the result you want a handful of low-rated ended shows, none of them deletable until 2027, or a larger pool that has to wait for a lifetime watch measurement? Recommendation: take the small rule now so the empty pool has an honest cause, and do not raise the cap or the rating until Q-07 has an answer.

**Q-07.** May a later story extend the watch harvest past its 10,000-row window, or read Plex `lastViewedAt` for both TV libraries, so "no play" can mean lifetime? Recommendation: yes. This session's Plex read returned 401 and stopped. The five-month harvest is why Game of Thrones sits in the 88 TB projection.

**Q-08.** Commission a season-level design only after the Age Guard and the title exclusion can name a season? Recommendation: yes, later. One tracked account does leave earlier seasons unwatched on shows it is still watching. That sample is one account.

## Gaps

- No Grafana tools in this session. The useful log is Maintainerr's last group-2 evaluation, per-clause counts. The empty collection and the added dates do not depend on it.
- Plex `GET /library/sections` from the HaynesOps pod returned 401. No second route was tried.
- Maintainerr's rule test was not called. It is a command.
- Household plays are the Tautulli harvest window. Season progress beyond one tracked account is not in the database.
