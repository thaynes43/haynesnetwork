# 2026-11-13 — Age Guard library fill (story 836)

**Correction, applied in ADR-119 / DESIGN-052 D-31 (review of PR 1067, 2026-11-13).** The tables below are the Age Guard alone, measured as if the fill rule already ran. They are not a count of deletions. With the ledger-coverage guard the rule does nothing for the July 2026 fill: those stamps stop protecting on their own on 2026-12-29, and the Sonarr ledger covers a full window only from 2026-12-30 10:20:40. Under the live pools the switch changes no deletion today (review: TV pool 0 members; movies 524, 464 clear and 60 recent before and after, `trash_candidates` refreshed 14:00:13). Story 835's rule, the review's projection, matches 0 of the 389. The "at most 5 percent nearby imports" test had no power on this fill: the last scan stamp plus 6 hours is 2026-07-03 06:36, and the first Sonarr import is 11:20:40, so "0 of 638" and "1 of 232" would read the same had every show been downloaded that night. The label is still right on unused evidence: 869 stamps in 2 hours 36 minutes, 866 with an other-server date more than a day older. The cutoff range that keeps the same verdicts is 13 through 232, not 9 through 232. The 2026-10-30 "7 movies" row means kept by the Age Guard and not by a watchlist. This session's own `SELECT` (replica `postgres16-11`, `trash_candidates_state.refreshed_at` 2026-11-13 15:15:05.495-05) found 0 of 524 movie candidates with no Plex match and a TV pool of 0.

Read-only. Replica `pod/postgres16-11` (`cnpg.io/cluster=postgres16`, `cnpg.io/instanceRole=replica`), database
`haynesnetwork`, `SELECT` only. Clock of the census query: `2026-11-13 12:51:41.238254-05`. The 180-day cutoff is
`now() - interval '180 days'` = `2026-05-17 12:51:41.238254-04` (exactly 180 × 24 hours). Calendar days are
`America/New_York`. Bytes are `media_items.size_on_disk`, one row per title. Decimal TB is bytes ÷ 10^12. No
per-account plays, progress, or last-viewed times were read.

The rule these counts follow is DESIGN-052 D-31, read as the fill rule with the ledger already covering the window. A library-day (one Plex library, one America/New_York date) is a
fill when it has at least 100 titles and `near_imports * 20 <= titles`. A near import is a
`downloadFolderImported` event of that title's own *arr kind within 6 hours of that stamp. A fill stamp is left
out of the newest Plex date only when the title has no near import of its own and a different Plex server has a
strictly older dated added time. A download import inside 180 days still protects. "Changes protection" means
today's Age Guard is recent and the new one is not.

## Libraries (measured)

| Server      | Library       | Section  | Matches | Oldest added           | Newest added |
| ----------- | ------------- | -------- | ------- | ---------------------- | ------------ |
| hayneskube  | HOps Music    | artist 2 | 4,870   | 2025-05-02             | 2026-11-13   |
| haynesops   | HOps Movies   | movie 1  | 5,186   | 2000-01-01 (one row)   | 2026-11-11   |
| haynesops   | HOps TV Shows | show 2   | 1,013   | 2026-07-02 22:00:21-04 | 2026-11-11   |
| haynestower | HNet Movies   | movie 1  | 5,185   | 2022-01-28             | 2026-11-11   |
| haynestower | HNet TV Shows | show 2   | 1,018   | 2019-03-29             | 2026-11-11   |

Every match in these five libraries is dated. Music is not read by the Age Guard. Live Sonarr shows on HaynesOps
TV are 953, which matches the 2026-11-13 TV Trash audit.

## Day size (measured)

| Library            | Days  | Titles | Max day | Median day | Days ≥ 100                               |
| ------------------ | ----- | ------ | ------- | ---------- | ---------------------------------------- |
| HaynesOps movies   | 2,146 | 5,186  | 141     | 2          | 2 (276 titles)                           |
| HaynesOps shows    | 69    | 1,013  | 638     | 2          | 2 (870 titles); both days are also ≥ 200 |
| HaynesTower movies | 814   | 5,185  | 409     | 2          | 8                                        |
| HaynesTower shows  | 445   | 1,018  | 33      | 1          | 0                                        |

The largest HaynesOps TV day that is not 2026-07-02 or 2026-07-03 is 8 titles.

Ledger history starts 2026-07-02 22:27:34-04 (Radarr `downloadFolderImported`, 1,611 events through 2026-11-13) and
2026-07-03 11:20:40-04 (Sonarr, 25,350 events). There is no `movieFolderImported` or `seriesFolderImported` row.
Early Radarr title counts: July 2 has 6, July 3 has 85, July 4 has 154, July 5 has 147, July 6 has 105. Sonarr on
July 3 has 294 import events and 9 titles.

## Which days are fills (measured)

| Library-day                                                                                               | Titles                                               | Span                        | Near imports (6 h)                 | Other server older by > 1 day | Verdict                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------- | ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HaynesOps TV 2026-07-02                                                                                   | 638                                                  | 120 min (22:00:21–23:59:58) | 0                                  | 635                           | Fill. Two titles are on one server.                                                                                                                                                               |
| HaynesOps TV 2026-07-03                                                                                   | 232                                                  | 691 min (00:00:35–11:31:43) | 1 (0.4%)                           | 231                           | Fill by the size test. The 5% count had no power: only the 11:31 stamp is inside Sonarr history, and it is a real arrival. |
| Movie days 2026-07-03, 07-04, 07-05, 07-06, 07-15, 10-01, 10-17, 11-01, both movie libraries              | 100% of titles have a download import within 6 hours |                             |                                    |                               | Real arrivals. Not fills.                                                                                                                                                                         |
| In-window movie days 2026-05-17 through 2026-06-30 with ≥ 5 titles and < 50% near imports                 | at most 12                                           |                             | 0, because history has not started |                               | Not fills. Under 100.                                                                                                                                                                             |
| HaynesTower movies 2023-09-18 (409), 09-19 (139), 09-20 (145), 09-24 (111), 09-26 (112), 2025-05-31 (163) | ≥ 100, 0% near imports                               |                             |                                    |                               | The rule labels these fills. They are already outside 180 days and only get older, so the label removes no protection that exists today or later. The ledger cannot see imports from those years. |

638 + 232 = 870 Plex matches on the two TV fill days = 824 live Sonarr shows + 46 live Radarr rows matched into
HaynesOps TV by tmdb. The audit's 604 + 220 = 824 is the show subset. 638 − 604 = 34 and 232 − 220 = 12.

Of the 953 live Sonarr shows on HaynesOps TV: 824 are on the two fill days, 2 of those are one-server, 15 have an
other-server date still inside the window, 807 have an other-server date outside it, and 432 of the fill shows
also have a download import inside the window. The 389 that would clear are the rest (other server outside the
window and no import inside it). That 389 matches the verdict table.

## Paper census (measured)

Live Radarr and Sonarr rows with a movie or show Plex match and `deleted_from_arr_at` null. No row moved from
recent to unknown.

| Kind   | Transition      | Titles | Bytes               |
| ------ | --------------- | ------ | ------------------- |
| Radarr | clear → clear   | 3,783  | 121,192,914,574,090 |
| Radarr | recent → clear  | 40     | 1,368,757,512,491   |
| Radarr | recent → recent | 1,370  | 43,611,721,155,978  |
| Sonarr | clear → clear   | 3      | 104,700,881,687     |
| Sonarr | recent → clear  | 389    | 85,031,322,181,927  |
| Sonarr | recent → recent | 567    | 130,776,036,718,854 |

Titles that lose the Age Guard: 40 + 389 = **429**. Bytes: 1,368,757,512,491 + 85,031,322,181,927 =
**86,400,079,694,418** (86.400 decimal TB). This is the Age Guard only. Save, `dnd`, watchlist and recent watch
still apply and were not subtracted.

Movies that are recent only by a Plex date, have some older Plex date, and have no download import inside the
window: 157 titles, 5,155,985,257,336 bytes. The 40 are the subset on a fill day. The other 117 stay, and
5,155,985,257,336 − 1,368,757,512,491 = 3,787,227,744,845 bytes. Shows in that same shape are exactly 389, so
every such show is on the fill.

The 40 movies' in-window stamps are all on HaynesOps TV 2026-07-02 (34) and 2026-07-03 (12). Thirty-three have
movie-library dates, all outside the window; those 33 byte figures add to 1,368,757,512,491 (summed 2026-11-13
from the list in DESIGN-052 D-31). Seven have `size_on_disk` 0. Be Cool (2005) has the TV-fill stamp and stays
recent: the other server's show date is 2026-06-07.

The twenty largest shows and the 33 movies are listed in DESIGN-052 D-31. The largest movie is A Simple Plan
(1998), 85,239,155,760 bytes, both movie libraries 2026-05-05, twelve days before the cutoff. It does not reach
the show list.

## What was not counted

Music-library spikes (HaynesOps Music 2025-05-03 has 3,332 titles; 2026-10-28 has 836) are out of scope. The
2026-10-30 Trash catch-up counted 7 movies kept "recent only" inside a pool snapshot. That row means kept by
the Age Guard and not by a watchlist, not kept by a fill (review of PR 1067, 2026-11-13: 60 pool movies kept by
the Age Guard, 54 by an import, 6 by a Plex date, none by a fill day). Those 7 were not re-identified by title.
The 157 / 40 / 117 split above is a different population (every live Radarr title, not that day's pool).

The matcher question is DESIGN-052 Q-24. The Age Guard excludes a wrong-type stamp from the older-date test and does not fix the matcher. The 2026-10-30 "7 movies" reading is Q-25.
