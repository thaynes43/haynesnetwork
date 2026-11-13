# Kometa collections that add, 2026-11-13

Read-only audit for story 825. Nothing here changes a list, a collection, a tag, or a setting.

The collections that are filling the movie library are the seasonal default and IMDb Popular. In the 92-day window, seasonal added 332 movies (81 on disk, 1,229.5 GB) and IMDb Popular added 108 (61 on disk, 1,137.6 GB). Together that is 440 of the 474 Kometa movie adds. Seasonal's bytes arrived in three waves: 18 September titles (48.8 GB), 115 October titles (654.3 GB, of which 25 are titles Trash had already deleted), and 198 November titles (526.4 GB). Of the 332 seasonal adds, 319 have no watch record. Christmas has not run since this Kometa config started adding, and its list has no count cap in the upstream default.

The options are for a ruling. The one I would take is to stop the seasonal default and IMDb Popular from adding, and leave their Plex shelves as a view of what is already in the library. Reasons and the other levers are in section 4.

## How this sits with the story

Story 825's constraint line asks for an ADR or design amendment in the same change. This change records an audit and changes no behavior, so no ADR or design is amended. The acceptance line also asks for Tom's rulings as the grooming outcome. Those rulings are not in this file. The questions are in section 5. The coordinator records acceptance.

The story subject says "who watched it." This report uses the household watch record from story 824 (a title has a record, or it does not). A per-account split is not in any file here.

GB below is bytes / 1e9, the same unit as story 824, rounded to 0.1. Exact integers are in the CSVs. A count in a table is exact. A yearly figure marked estimated is the 92-day on-disk bytes times 365/92.

## Method

Rules first. The counts were filled after these rules were frozen. They follow story 824's add rules where this report uses the same words.

- **92-day window:** `2026-08-14T00:00:00Z` inclusive through `2026-11-14T00:00:00Z` exclusive. Same window as `.agents/context/2026-11-13-intake-inventory.md`.
- **Since cutover:** `arr_added_at` on or after `2026-07-06T00:00:00Z`. That is the first day a movie carries `kometa-added`. It is not the 92-day window.
- **Measured at:** 2026-11-13, replica `postgres16-11` (`pg_is_in_recovery()` true, time zone `America/New_York`, first query 14:48 ET). `SELECT` only. Radarr history is three `GET /api/v3/history` pages, `pageSize=1000`, newest first, stopped when the oldest record on the page was before 2026-08-14. Sonarr and Radarr quality profiles are one `GET /api/v3/qualityprofile` each. API keys were expanded inside the pod. Grafana and Loki were not available in this session.
- **Config read:** haynes-ops `bab21e1497c41be303e9b8cc4773f185176b6f84` (2026-11-13 17:43:52Z), `kubernetes/main/apps/media/kometa/`. The seasonal, universe, and award schedules are the upstream Kometa v2.5.4 default files (the HelmRelease pins image `v2.5.4`). The live `/config/config.yml` on the PVC was not read. It holds tokens, the seed is copied only when that file is absent, and the live file can differ. What the Plex mirror shows on this date is in section 1.
- **Add attribution.** A tag is the lowercased label on `media_items.arr_tags`. Umbrella tags are `kometa-added` and `pmm-added`. A requester tag matches `^[0-9]+-`. Seerr evidence is the `mediarequests` tag, a requester tag, or a `ledger_events` row with `source='seerr'` and `event_type='requested'` on that item. Conflict is an umbrella tag plus Seerr evidence. **Kometa** is `kometa-added` and not a conflict. **Legacy** is `pmm-added`, no `kometa-added`, and not a conflict. The collection is the other tag, ignoring `dnd` and any label containing `release-block`. No Radarr or Sonarr item has two collection tags (the count of items with two was 0). No movie added since 2026-07-06 is `kometa-added` with no collection tag.
- **On disk.** `deleted_from_arr_at` is null and `size_on_disk > 0`. Bytes are current `size_on_disk`. A title Radarr has with size 0 is counted as no file. Bytes are not spread across collections.
- **Watch record.** `play_count > 0` or `last_viewed_at` is set. Null play count is no watch record. This database has no zero play count (story 824). No watch record is not a never-watched proof. The harvest only indexes titles that appear in the newest Tautulli history pages. `last_viewed_at` is the newest harvested play, so a later play hides an earlier one.
- **Trash.** A prior delete is a `trash_batch_items` row with `state='deleted'` and the same TMDB id whose `deleted_at` is before `arr_added_at`. A later delete is the same with `deleted_at` after `arr_added_at`.
- **Grab path.** On grabbed history for a window add that has a file: `Search` only, `Rss` only, both, or `Search` plus `UserInvokedSearch` or `InteractiveSearch`. Import bytes are history `data.size` on `downloadFolderImported` for those movie ids. They can exceed current size when a file was replaced.
- **Seasonal wave.** The added timestamp in `America/New_York`, matched to the v2.5.4 `range` that contains that month and day. Two ranges that both contain the day stay as one overlap row. Bytes are not split across them.
- **Plex overlap.** Held members of `HOps Movies` collections, joined through `media_plex_matches` on rating key. A shared movie is one ledger item in both collections on 2026-11-13. That is current shelf overlap. It is not a second copy on disk.

`arr_added_at` before 2026-07-06 is not a real add date. On 2026-07-02, 8,805 movies share one added day. That is the library import. Dates from 2026-07-06 on are the ones this report treats as adds.

## 1. What can add

Collections run at 06:30 `America/New_York` every day (`kometa` HelmRelease, controller `collections`). The seed's Radarr block is `add_missing: true`, `search: true`, `upgrade_existing: false`, `monitor: true`, `availability: released`, quality profile `FHD-UHD`, tag `Kometa-Added`. The Sonarr block is the same add and search flags, `upgrade_existing: false`, `monitor: all`, `cutoff_search: false`, profile `FHD-UHD`, tag `Kometa-Added`. A comment next to the franchise default says the global add and search flags are false. The keys above them are true. This report follows the keys.

Live profiles, `GET /api/v3/qualityprofile`, 2026-11-13: Radarr `FHD-UHD` allows upgrade, cutoff `Remux-2160p`, floor `WEBRip-1080p`. Sonarr `FHD-UHD` allows upgrade, cutoff `Bluray-2160p Remux`, floor `WEBRip-1080p`. All 474 Kometa movie adds in the window are on `FHD-UHD` with `minimumAvailability` `released`.

Global `show_missing` is false, so a Plex collection shows titles that are already in the library. `radarr_tag` is applied when Kometa adds a movie, not onto a movie already in Radarr. One movie therefore carries one collection tag: the collection that added it.

The full list is `2026-11-13-kometa-can-add.csv`. The adders:

| Group | What it adds | Tag | Schedule | Cap in git |
| --- | --- | --- | --- | --- |
| Seasonal default | 18 holiday and heritage lists. One Radarr tag for all of them | `SeasonalCollection` | One `range` per list, below | IMDb searches limit 500. Halloween's franchise collections have no count cap. Christmas, Latinx, and the heritage-month MDBList have no limit key |
| Universe default | 17 universe lists, one tag | `UniverseCollection` | Every collections run | `minimum_items: 2`. No vote floor |
| Oscars and Golden Globe defaults | Year collections, latest-4 through latest. The two static "best picture" and "best director" lists are turned off here and rebuilt in `movies-awards.yml` with the same add flags and the same tags | `OscarsCollection`, `GoldenGlobeCollection` | Every collections run | No count cap |
| `movies-charts.yml` | Popular Now, Top Rated, Top Grossing, IMDb Popular, IMDb Top 250 | one tag each | Every collections run | Popular Now 60, Top Rated 100, Top Grossing 100. IMDb Popular and Top 250 have no count cap. Vote floors: Popular Now and Top Grossing 300, Top Rated 2,000, IMDb Popular `tmdb_vote_count` 300 and English. Top 250 is unfiltered |
| `movies-franchises.yml` | 24 hand franchise lists, one tag. Monsterverse does not use the template, so it does not write `MovieCollection`; it still inherits the global add | `MovieCollection` | Every collections run | No vote floor |
| `shows-franchises.yml` | TV franchise lists, one tag. "A Song of Ice and Fire" is a Plex title search and does not name a missing show | `ShowCollection` | Every collections run | No vote floor. Sonarr `monitor: all` |
| `shows-collections.yml` | Six curated series lists, each with its own tag. Three are household lists; those names are not repeated here. Three are themed (big-kid cartoons, kid cartoons, earth and space) | per list | Every collections run | Fixed id lists. Sonarr `monitor: all` |

Seasonal ranges from the v2.5.4 default, month/day, evaluated in the container time zone `America/New_York`:

| List | Range | Also in the builder |
| --- | --- | --- |
| New Year's Day | 12/26–01/04 | one IMDb search, limit 500 |
| Valentine's Day | 02/01–02/29 | four IMDb searches, limit 500 |
| St. Patrick's Day | 03/01–03/18 | one IMDb search, limit 500 |
| Easter | 03/20–04/30 | two IMDb searches, limit 500 |
| Mother's Day | 05/05–05/10 | keywords, limit 500 |
| Memorial Day | 05/18–06/07 | one IMDb search, limit 500 |
| Father's Day | 06/15–06/20 | keyword, limit 500 |
| Independence Day | 06/23–07/11 | four IMDb searches, limit 500 |
| Labor Day | 09/01–09/10 | one IMDb search, limit 500 |
| Halloween | 10/01–10/31 | three IMDb searches, limit 500, plus the Hotel Transylvania, Addams Family, Addams animated, Conjuring, Halloween, Nightmare on Elm Street, Mummy, Alien, Ghostbusters, and Hocus Pocus collections, plus one movie id |
| Veteran's Day | 11/01–11/30 | two IMDb searches, limit 500 |
| Thanksgiving | 11/01–11/30 | keyword, limit 500 |
| Christmas | 12/01–12/31 | one MDBList, no limit key |
| Heritage, pride, history, and disability lists | see the CSV | IMDb, MDBList, or Letterboxd |

The seasonal template sets `delete_not_scheduled: true`. Outside its range the Plex collection is removed. The Radarr movie and its tag stay.

On 2026-11-13 at 14:00 ET the Plex mirror on `HOps Movies` had `Veteran's Day Movies` (child count 232) and `Thanksgiving Movies` (child count 138), category Seasonal. It did not have a Halloween Movies collection. A collection titled `Halloween` has 5 children and category Sequels; that is the film line, not the holiday list. `Christmas HNet` was present (58 children). That list sets `radarr_add_missing: false` and is on a display window of 11/01–01/07. This matches the v2.5.4 ranges for November. It is not a reading of the PVC file.

`plex_collection_members` has 0 rows for those two Seasonal collections. Chart collections in the same sync have a member row per child (IMDb Popular 66 of 66). The November wave cannot be split into Veteran's Day versus Thanksgiving from this database. The child counts are Plex's own counts.

These do not add a missing title: the franchise default (`radarr_add_missing: false`), `movies-lists.yml`, `movies-people.yml`, Christmas HNet, the three audio collections (`plex_all` over files already in the library), and the two app-managed verify collections. In Theaters was removed from `movies-charts.yml` on 2026-07-10. It is not a current adder. Movies it already added are in section 2.

Trakt charts are commented out in the chart files. The seed has no Trakt block.

## 2. What each has added

### The 92-day window

An add is a Kometa movie or show whose `arr_added_at` is inside the window. 474 movies and 3 shows. Every movie is `FHD-UHD` / `released`. None of these 474 is a conflict. Bytes are current size. `2026-11-13-kometa-window-adds.csv`.

| Collection | Adds | On disk | No file | On disk (GB) | No watch record | No-watch bytes (GB) | Share of bytes with no watch record |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Seasonal | 332 | 81 | 251 | 1229.5 | 319 | 919.3 | 74.8% |
| IMDb Popular | 108 | 61 | 47 | 1137.6 | 84 | 640.2 | 56.3% |
| IMDb Top 250 | 12 | 11 | 1 | 158.4 | 12 | 158.4 | 100% |
| Popular Now | 4 | 4 | 0 | 137.2 | 3 | 112.9 | 82.3% |
| Universe | 17 | 2 | 15 | 50.1 | 16 | 29.9 | 59.7% |
| Top Rated | 1 | 1 | 0 | 21.2 | 1 | 21.2 | 100% |
| Show collections | 3 | 0 | 3 | 0.0 | 3 | 0.0 | |

Story 824, earlier the same day, has the same seasonal, Top 250, Popular Now, Universe, and Top Rated rows. IMDb Popular there was 23 titles with a watch record and 645.2 GB with no record. This pass has 24 and 640.2 GB. One title gained a watch record between the two reads, or the two queries disagree by one title. The bytes of the other rows match to 0.1 GB.

Top Grossing has a Plex collection of 100 and no `topgrossing` tag on any movie. It has not added a movie since cutover. Oscars and Golden Globes added on 2026-07-06 only (section below), nothing in this window.

Import sizes for these movie ids, from the history walk, are larger than current size where a file was replaced: IMDb Popular 1,792.9 GB across 103 imports for 61 movies; seasonal 1,266.3 GB across 86 imports for 81 movies. Current size is what is on disk now. The quality mix is `2026-11-13-kometa-import-quality.csv`. Seasonal's on-disk files are 61 at 1080p (677.3 GB) and 19 at 2160p (550.5 GB), plus one 720p. IMDb Popular's imports are mostly WEBDL-2160p (57 events, 861.4 GB) and Remux-2160p (10 events, 544.7 GB). The profile can still upgrade a 1080p file toward Remux-2160p. That later growth is Radarr's upgrade path. The seed sets `upgrade_existing: false`, so Kometa is not the upgrade caller.

How the file got there, current size of the file, same history walk:

| Collection | Search only | RSS only | Search and RSS | Search and a manual search |
| --- | ---: | ---: | ---: | ---: |
| Seasonal | 66 files, 1080.8 GB | 3 files, 34.6 GB | 2 files, 11.5 GB | 10 files, 102.7 GB |
| IMDb Popular | 30 files, 537.2 GB | 25 files, 478.1 GB | 6 files, 122.3 GB | 0 |
| IMDb Top 250 | 10 files, 147.6 GB | 1 file, 10.7 GB | 0 | 0 |
| Popular Now | 4 files, 137.2 GB | 0 | 0 | 0 |
| Universe | 2 files, 50.1 GB | 0 | 0 | 0 |
| Top Rated | 1 file, 21.2 GB | 0 | 0 | 0 |

`Search` is the grab source Kometa's search uses, and Radarr's own search uses it too. `Rss` is the monitored movie being caught from the feed. A manual source is `UserInvokedSearch` or `InteractiveSearch`, and every one of those seasonal files also has a `Search` grab.

### Seasonal waves

`2026-11-13-kometa-seasonal-waves.csv`. Dates are `America/New_York`. The 92-day rows sum to 332 adds, 81 files, 1,229.5 GB, and 319 with no watch record.

| Added | Which v2.5.4 ranges are open | Adds | On disk | GB | No watch record |
| --- | --- | ---: | ---: | ---: | ---: |
| 2026-07-06 | Independence Day (before the window) | 12 | 1 | 4.5 | 12 |
| 2026-09-01 | Labor Day | 1 | 0 | 0.0 | 1 |
| 2026-09-15 | Latinx Heritage only | 18 | 4 | 48.8 | 18 |
| 2026-10-01 | Latinx and Halloween | 114 | 31 | 630.4 | 105 |
| 2026-10-08 | Latinx and Halloween | 1 | 1 | 23.9 | 0 |
| 2026-11-01 | Veteran's Day and Thanksgiving | 189 | 43 | 521.1 | 186 |
| 2026-11-02 | both November lists | 6 | 1 | 3.4 | 6 |
| 2026-11-10 | both November lists | 3 | 1 | 2.0 | 3 |

They add on the first day the range is open, not before it. Halloween's builder is the one that pulls whole franchises (Alien, Ghostbusters, the Conjuring, and the others listed above) with no vote floor. October's 115 adds cannot be split between Latinx and Halloween: both ranges are open, both Plex collections are gone now, and the tag is one tag. November's 198 adds cannot be split either: both ranges run all month, and the member rows were not stored.

Plays recorded against those waves (`2026-11-13-kometa-seasonal-watch.csv`). "Inside the season" means `last_viewed_at` falls in that 2026 range. A newer play outside the range would hide an in-season play. No watch record means the harvest has no play at all.

| Wave | Season status on 2026-11-13 | No watch record | Latest view inside the 2026 range |
| --- | --- | ---: | --- |
| Independence Day, 12 adds | ended 07-11 | 12 | 0 |
| Labor Day, 1 add | ended 09-10 | 1 | 0 |
| Latinx on 09-15, 18 adds | ended 10-15 | 18 | 0 in the Latinx span |
| October 1 and 8, 115 adds | Halloween ended 10-31 | 105 | 10 in October; 7 of those also sit in the Latinx span |
| November 1–10, 198 adds | open through 11-30 | 195 | 3 in November so far |

### Since cutover, including the window

`2026-11-13-kometa-since-cutover.csv`. First Kometa-tagged day is 2026-07-06.

| Collection | Adds | On disk | Monitored, no file | GB | No watch record | Trash re-adds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| IMDb Popular | 156 | 95 | 61 | 2052.4 | 110 | 2 titles, 37.7 GB |
| Seasonal | 344 | 82 | 262 | 1233.9 | 331 | 25 titles, 567.2 GB, all on 2026-10-01, 22 of them on disk |
| Popular Now | 13 | 13 | 0 | 702.7 | 6 | 0 |
| In Theaters | 69 | 28 | 41 | 515.4 | 64 | 0 |
| IMDb Top 250 | 15 | 13 | 2 | 209.2 | 15 | 0 |
| Universe | 45 | 6 | 39 | 201.7 | 42 | 2 titles, 50.1 GB |
| Top Rated | 3 | 3 | 0 | 86.1 | 3 | 0 |
| Oscars | 8 | 5 | 3 | 43.7 | 8 | 0 |
| Golden Globes | 21 | 2 | 19 | 40.1 | 21 | 0 |
| Movie franchises | 4 | 0 | 4 | 0.0 | 4 | 0 |
| Show franchises | 11 | 2 | 9 | 58.9 |  |  |

The two universe files in the window are 50.1 GB, the same integer as the two universe re-adds. Of the 11 Kometa show-franchise series, two added in July are the 58.9 GB; July also added 6 series with no file, and August, September, and October added one empty series each. Those three empty series are the window's show adds. None of the six curated TV lists has its tag on a series (the three themed tags were counted; a `for%` tag count on Sonarr was 0).

In Theaters is the picture of "stop adding" after the fact. The collection left the git file on 2026-07-10. The 69 movies it had added are still in Radarr, 28 of them on disk (515.4 GB), 41 still monitored with no file.

### The old tag is not this intake

`pmm-added` plus `seasonalcollection`, without `kometa-added`: 2,478 live movies, 1,207 with a file, 26,894.3 GB. On 2026-07-02, 2,473 movies already carried `seasonalcollection` and none of that day's 8,805 movies carried `kometa-added`. That size is the library that came across with the old tag. It is not downloads by the current seasonal default. Five live legacy seasonal titles are not on that July 2 added day. This pass did not find a separate added day for them. The 26.9 TB figure is the live legacy set, including those five.

### Trash

Of the adds since 2026-07-06, none has left Radarr after that add. Seasonal's later-delete count is 0. One IMDb Popular movie, added 2026-07-06, has a Trash delete row on 2026-09-12 and is still in Radarr with that same added time and 16.0 GB on disk. The added time did not move, so it is not counted as a re-add.

The re-adds are the other direction. Trash deleted them, then a collection added them again:

| Collection | Re-adds since 2026-07-06 | Current size | When |
| --- | ---: | ---: | --- |
| Seasonal | 25 | 567.2 GB, 22 files | all 2026-10-01. Median 39.5 days after the earlier delete |
| IMDb Popular | 2 | 37.7 GB | since cutover; the day was not split out |
| Universe | 2 | 50.1 GB | the window's two files |

Those 25 seasonal re-adds are 25 of the 114 October 1 titles, and 567.2 of that day's 630.4 GB. They are inside the 332. Story 818 already named this October 1 seasonal return and the exclusion gap that let it happen. This pass counted it again from the replica and got the same 25, all on that date.

Titles Kometa tagged that are now absent, and that have an app exclusion row: IMDb Popular 12 of 12 tombstones, In Theaters 9 of 9, Universe 8 of 8, and one each for Golden Globes, movie franchises, and Popular Now. Seasonal has 0 Kometa tombstones. The exclusion list is what stops a later add. How many times a day Kometa tried and was stopped is a log fact. Loki was not available. The query that would answer it is `{namespace="media", pod=~"kometa-collections.*"}` over this window, for lines that record a Radarr add and lines that record the exclusion list skipping a title.

Legacy seasonal tombstones: 154 absent, 129 of them with an app exclusion row. The other 25 have no app row. Story 818 measured Radarr's own exclusion list as covering every absent deleted movie. This session did not re-read that list, so those 25 are not called unguarded here.

The age guard is 180 days (story 818, `TRASH_AGE_GUARD_DAYS`). The October 1 files are inside that guard until about 2027-03-30. That date is 180 days after 2026-10-01, from the constant, not a new measurement. A share of 0 later deletes is what that guard predicts. It is not evidence Trash will keep the titles after the guard ends.

### Ratings on the window adds, as stored now

Current `imdb_rating` and vote counts. They are the harvest's values on 2026-11-13, not the values on the day Kometa added the movie.

Seasonal, 332 adds: IMDb rating under 5 is 97, 5 to under 6 is 81, 6 to under 7 is 84, 7 or higher is 47, no IMDb rating is 23. The 23 with no rating have no file. Titles rated under 6 account for 886.9 GB of the 1,229.5 GB. Median TMDB votes is 7. Median IMDb votes is 347. Titles with IMDb votes under 300 are 166 and only 47.9 GB, because the files landed on the higher-vote titles.

IMDb Popular, 108 adds: median TMDB votes 50.5 (19 of 108 are at or above 300), median IMDb votes 3,450.5 (84 of 108 are at or above 300). The git filter on that collection is `tmdb_vote_count.gte: 300`. The stored `tmdb_votes` do not show that floor. This report does not decide whether the filter failed, the column is a different count, or the live run differs from the git file. Titles with IMDb votes under 300 are 24 and 0 GB on disk.

## 3. Overlap and churn

Collection tags do not overlap. The shelf does. `2026-11-13-kometa-plex-overlap.csv` is held members of both Plex collections on `HOps Movies`, 2026-11-13. The large pairs:

| Pair | Shared movies |
| --- | ---: |
| IMDb Top 250 and Top Rated | 82 |
| Golden Globes best picture and Oscars best picture | 57 |
| Golden Globes best picture and IMDb Top 250 | 43 |
| Oscars best picture and IMDb Top 250 | 35 |
| IMDb Popular and Popular Now | 25 |

A movie already in the library is not downloaded again when a second collection lists it. The tag stays with whichever collection added it. Overlap of the award and top lists is shared shelf space. It is not a second 158 GB.

The churn that happened is Trash, then seasonal. Twenty-five titles left through Trash and came back on 2026-10-01, median 39.5 days later, and they are 567.2 GB of what seasonal put on disk in the window. The churn that has not happened is the new adds leaving. None of the seasonal adds since July 6 has a later Trash delete, and the age guard has not expired on the October files.

The holiday lists do not add ahead of the range. They add on the morning the range opens, and the titles then sit through the range. For the ranges that have already ended, the watch harvest recorded no play on the Independence Day, Labor Day, or September 15 Latinx adds, and a play inside October for 10 of the 115 October adds.

## 4. Options

These are choices for a ruling. Each "saved" number is current size of titles that would not have been added, over the 92 days. It does not include the monitored titles that have no file yet. Turning add off does not unmonitor those, which is what In Theaters shows (41 still monitored, collection already gone). A per-year figure is estimated only where the collection adds on a daily chart. Seasonal is waves. Multiplying the 92 days by 365/92 would count Halloween and November as if they repeated and would assign Christmas a size this database does not have.

| Rank | What I would take | 92-day size already on disk | What a household member would notice |
| --- | --- | --- | --- |
| 1 | Seasonal: stop adding. Leave the Plex lists, which already appear only inside their dates and already show only what is in the library (`show_missing: false`) | 1,229.5 GB in the window, plus 4.5 GB on Independence Day. 251 seasonal titles in the window have no file and can still download | New holiday titles stop arriving on their own. Veteran's Day and Thanksgiving keep what is already on the shelf. Christmas HNet (58 titles, already not adding) still appears from November through January 7. The uncapped Christmas list would not fill Radarr on December 1 |
| 2 | IMDb Popular: stop adding, same way. The shelf stays | 1,137.6 GB. Estimated full year at this on-disk rate: 4,513 GB (1,137.6 × 365/92) | The Popular shelf stays at the titles already in Plex (66 on 2026-11-13). A new popular movie waits for a request |
| 3 | Leave the static lists adding: IMDb Top 250, Top Rated, Top Grossing, Oscars, Golden Globes | Top 250 158.4 GB, Top Rated 21.2 GB, the others 0 in the window. Top Grossing's shelf is already 100, the file's limit | Almost nothing day to day. A new Top 250 entry or a new winner can still be added. That is a few titles, not a wave |
| 4 | Universe, the hand movie franchises, and the TV lists: stop adding. The bytes so far are small and Sonarr is set to monitor every episode | Universe 50.1 GB. Movie franchises 0. Show franchises 0 in the window and 58.9 GB in July | A missing film in a universe, or a series that is not already in Sonarr, stays out until someone requests it |

I would take 1 and 2, and I would take 4 because the switch is on and one monitored series is a whole show. I would leave 3 as it is. I would not use a rating cap as the only control on seasonal. Titles currently rated under 6 are 886.9 GB of the seasonal window, so a floor of 6 would have skipped most of the bytes, and the 23 unrated titles have no file. Halloween's franchise collections can still clear a rating floor. The cap also keeps adding.

Add without searching is the weaker lever. On seasonal, 1,080.8 GB of the files have only a `Search` grab, so Kometa's search is the path that landed them. RSS still grabbed 34.6 GB with no Search grab, and a monitored movie can be grabbed from the feed later. On IMDb Popular, 478.1 GB was RSS only and another 122.3 GB had both, against 537.2 GB that was Search only. Turning search off would have left the RSS half free to land. It also leaves the 251 and 47 empty monitored titles in place.

Request-only, in the sense the story uses (visible in Plex only for what is already in the library), is the same switch as stop adding. The collections already hide missing titles. `radarr_add_missing: false` is the change. Christmas HNet is already that shape.

A full seasonal year is not estimated. Since July 6 the ranges that have opened are Independence Day (4.5 GB), Labor Day (0), Latinx (48.8 GB), the October overlap (654.3 GB), and the November overlap (526.4 GB). New Year, Valentine's Day, St. Patrick's Day, Easter, Mother's Day, Memorial Day, Father's Day, the spring and summer heritage lists, and Christmas have not opened under this config. Christmas is the next one, on December 1, and the default gives that list no count cap.

## 5. Questions

- **Q-01.** The Christmas list opens 2026-12-01 at the 06:30 run. It has no limit key in the v2.5.4 default. Recommendation: turn seasonal adding off before that run. Rank 1 is that choice for every seasonal list, Christmas included.
- **Q-02.** Stopping future adds leaves the monitored titles that have no file: 251 seasonal and 47 IMDb Popular in the window, 41 In Theaters, 39 universe, 19 Golden Globes, 9 show franchises. Recommendation: decide whether they stay monitored. This audit does not unmonitor them. Their future size is not measured. The mean of the seasonal files that did land is 1,229.5 GB / 81, and the mean of the IMDb Popular files is 1,137.6 GB / 61. Applying those means to the empty titles would be an estimate, and only if a release is found.
- **Q-03.** IMDb Popular's git file requires `tmdb_vote_count` of at least 300. The median stored `tmdb_votes` on the 108 window adds is 50.5. Recommendation: treat a higher vote floor as unproven until a Kometa log line for one of these titles shows the filter. I would stop the add rather than tune the floor.
- **Q-04.** In Theaters is already gone from git and still has 41 monitored movies with no file, plus 515.4 GB on disk. Recommendation: leave the files. Decide the 41 with Q-02.
- **Q-05.** Daily counts of titles the exclusion list stopped are not in this report. Recommendation: run `{namespace="media", pod=~"kometa-collections.*"}` for the window and count Radarr-add lines and exclusion-skip lines per collection. This session had no Grafana tools and did not use another log route.
- **Q-06.** October's 654.3 GB and November's 526.4 GB each sit on two lists at once. Recommendation: judge the wave, not one holiday name. The member rows that would split November were not stored (child counts 232 and 138, member rows 0).

## Checks

- Seasonal day rows inside the window: 1+18+114+1+189+6+3 = 332. Files 0+4+31+1+43+1+1 = 81. Bytes sum to 1,229,475,862,270. No-watch counts sum to 319.
- Those 81 seasonal files partition into 66 + 3 + 2 + 10, and their current bytes sum to the same 1,229,475,862,270.
- Window movie adds: 332+108+12+4+17+1 = 474.
- The 25 seasonal re-adds are all dated 2026-10-01, which is inside the window and inside the 114.
- Legacy seasonal size (26,894.3 GB, 2,478 live) is a different population from the 344 Kometa-tagged seasonal adds. The report does not add them.
- Five live legacy seasonal titles are not on the 2026-07-02 import day. Their added day was not found. The size total still includes them.

## Coverage

- Live `config.yml` on the Kometa PVC was not read.
- Kometa run logs were not read. Q-05 names the query.
- November shelf membership was not readable from `plex_collection_members`.
- Watch figures are no-watch-record figures.
- Sonarr history was not walked. The window's three show adds have no file, so there is no import size to attribute.
- The 25 legacy seasonal tombstones without an app exclusion row were not checked against Radarr's live exclusion list.
