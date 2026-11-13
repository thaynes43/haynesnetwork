# Lifetime household watch history — 2026-11-13

OpenProject story **#837** (parent #814). Read-side only. Nothing about what Trash may delete changes.
The design is DESIGN-008 D-03. The harvest and the one-off backfill land with this note.

Household totals only. No account's plays, progress, or last-viewed time is in this note.

Every count is **measured** (command and time) or **calculated** from those measurements (the rule is next to the
number) or **estimated** (how). Times are America/New_York unless the timestamp says otherwise.

## What the database already stored

Measured 2026-11-13T17:36:49Z on the first Postgres 16 replica (`cnpg.io/instanceRole=replica`), database
`haynesnetwork`. Live means `deleted_from_arr_at` is null.

| Kind | Live items | With metadata | `play_count` null | `play_count` 0 | `play_count` > 0 | Oldest `last_viewed_at` | Newest `last_viewed_at` |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| radarr | 9,630 | 9,630 | 9,216 | 0 | 414 | 2026-06-08 08:29:52-04 | 2026-11-13 09:22:33-05 |
| sonarr | 1,085 | 1,085 | 893 | 0 | 192 | 2026-06-07 20:31:45-04 | 2026-11-13 11:11:05-05 |

Rule: null + 0 + positive = with metadata. 9,216 + 0 + 414 = 9,630. 893 + 0 + 192 = 1,085.

`sources.tautulli` true, same query minute: radarr 414, sonarr 192. That equals the positive play counts.

`extra.tautulli` on live sonarr, 2026-11-13T17:36:59Z: haynestower 188, haynesops 15, hayneskube 0, no extra 893.
Rule: 188 + 15 + 0 + 893 = 1,085 live shows. A show can be counted on one server here (the breakdown key that
was present); this is not a claim that plays exist on only one server.

The stored oldest play is 2026-06-07. A null play count in this table is the old window, not a lifetime zero.
The harvest then stopped at 20 pages of 500.

## Tautulli history

Measured 2026-11-13 from the web pod, one `get_history` at a time, grouped (the harvest's call), page size 500,
until a short page. The filtered walk's command elapsed 23.0 s (23,098 ms, including the kubectl hop).

| Instance | Media | Rows walked | Pages | Unique keys | `recordsFiltered` | Oldest row | Newest row |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| haynesops | episode | 175 | 1 | 16 | 175 | 2026-07-04 00:12:35-04 | 2026-11-12 23:47:43-05 |
| haynesops | movie | 42 | 1 | 28 | 42 | 2026-07-13 22:17:29-04 | (same walk; not separately retained) |
| hayneskube | episode | 0 | — | 0 | 0 | — | — |
| hayneskube | movie | 0 | — | 0 | 0 | — | — |
| haynestower | episode | 32,661 | 66 | 496 | 32,661 | 2023-09-24 16:25:54-04 | 2026-11-13 11:11:05-05 |
| haynestower | movie | 4,033 | 9 | 1,891 | 4,033 | 2023-09-19 23:47:48-04 | 2026-11-13 09:22:33-05 |

Rule for pages: a full page is 500 and the walk stopped on a short page. Tower episodes 65 × 500 + 161 = 32,661.
Tower movies 8 × 500 + 33 = 4,033. Ops fits on one page. Kube returned no episode or movie row; the page counter for that empty answer was not retained, so the table leaves it blank.

Rows older than the stored sonarr floor (2026-06-07 20:31:45-04): tower episodes 23,392 of 32,661; tower movies
3,325 of 4,033; ops 0. Calculated remainder on or after that floor: 32,661 − 23,392 = 9,269 episode rows. That
is not the size of the old 10,000-row window, which mixes movies and episodes.

Unfiltered grouped history, which is one walk rather than three filtered walks, was probed at length 1 the same
hour: haynestower `recordsFiltered` 39,010 and `recordsTotal` 49,262; haynesops `recordsFiltered` 217 and
`recordsTotal` 280; hayneskube `recordsFiltered` 22 and `recordsTotal` 22 (all tracks).

Rule: tower episode + movie + track rows = 32,661 + 4,033 + 2,316 = 39,010, which equals unfiltered
`recordsFiltered`. The 2,316 track rows were measured on the filtered track probe (oldest 2023-09-18 09:11:46-04,
newest 2026-01-30 21:02:17-05), not in the 23.0 s video walk. Kube's 22 rows are tracks (oldest 2026-08-18
17:52:01-04, newest 2026-11-05 02:12:52-05). Ops episode 175 + movie 42 = 217, which equals ops unfiltered
`recordsFiltered`.

Library play totals from the same probes, used only to check the row counts: tower TV 32,644 and a 17-play
show library, 32,644 + 17 = 32,661 episode rows. Tower movies 3,999 and home videos 34, 3,999 + 34 = 4,033.
Ops TV 175 and movies 42. Kube music 22. The sums match the walked rows.

Calculated page count for the unfiltered tower walk: ceil(39,010 / 500) = 79. The harvest cap is 2 × 79 = 158.
`recordsTotal` is not used. See DESIGN-008 Q-12: episode `group_count` summed to 39,629 and movie `group_count`
to 6,977 (39,629 + 6,977 = 46,606). 49,262 − 46,606 = 2,656, calculated. Track `group_count` was not summed,
so that remainder is unexplained.

The tower episode newest instant equals the sonarr `last_viewed_at` maximum. The tower movie newest instant
equals the radarr maximum. The harvest's recent edge matches Tautulli. The old edge does not: Tautulli holds
rows back to 2023-09-18, and the table's oldest play is 2026-06-07.

## Plex last-viewed is not the household

Measured 2026-11-13 about 17:46Z from the web pod, show sections, page size 500, until a short page. Counts are
the token account's library fields. No per-show time is recorded here.

| Server | Show items | With `lastViewedAt` | With `viewCount` | With `viewedLeafCount` | `viewedLeafCount` and no `lastViewedAt` |
| --- | ---: | ---: | ---: | ---: | ---: |
| haynesops | 990 | 15 | 15 | 90 | 76 |
| haynestower | 989 | 97 | 82 | 93 | 12 |

Rule: leaf-without-last is counted, not subtracted in this note, except ops 90 − 15 = 75, which is one off the
counted 76. The counted 76 is the field combination on the items; the subtraction is a check and it does not
match, so the table keeps the counted 76 and this sentence records the mismatch. Tower 93 − 97 is negative, so
`lastViewedAt` and `viewedLeafCount` are not the same set. Tautulli's distinct show keys the same day were 496
(tower) and 16 (ops). Plex `lastViewedAt` is on 97 and 15 of those libraries. It cannot answer "nobody watched."

A season page (type 3, size 100) was also read. Ops: 4,374 seasons in the section, and the first 100 had none
of the three fields. Tower: 4,374 seasons, and that page of 100 had `lastViewedAt` on 1 and `viewCount` on 1.
The fields are omitted when the token account has no stamp.

The earlier direct read from the Plex pod returned 401. It was not retried.

## What this change stores

A finished read (every instance ends on a short or empty page, under the cap, and no `get_metadata` throws)
writes `play_count` 0, null `last_viewed_at`, and no `sources.tautulli` for a live movie or show with no joined
row. A positive join still sums plays and takes the max instant. An unfinished read writes the joins it has and
leaves everyone else null. Music stays null (DESIGN-008 Q-11).

The one-off backfill is `tsx /sync/src/scripts/watch-history-backfill.ts` on `deploy/haynesnetwork-main`,
`--dry-run` then `--apply`, after the image that contains it is deployed. It is not run from this session.
Expect about two minutes. That estimate is the 23.0 s filtered walk, plus an unfiltered walk of 79 pages of
the same size, plus up to 2,431 `get_metadata` calls at the one measured 18 ms (2026-11-13T17:56:31Z, HTTP 200).
2,431 = 496 + 1,891 + 16 + 28, the distinct video keys in the table above. 2,431 × 18 ms is about 44 s. The
match table skips calls it can answer; how many it can answer was not measured. Database writes of the live
movie and show metadata rows were not timed.

## Gaps

- The unfiltered 79-page walk was not executed. 79 is ceil(39,010 / 500) from the filtered row counts and the
  length-1 unfiltered `recordsFiltered`.
- Overlap between history rating keys and `media_plex_matches` was not measured.
- Track `group_count` was not summed (Q-12).
- Plex was not read for movies. The decision uses the show sections, which are the ones the TV question needs.
- This session does not run the backfill, so the post-backfill earliest play and the recomputed "ended, no play"
  set are not in this note.
