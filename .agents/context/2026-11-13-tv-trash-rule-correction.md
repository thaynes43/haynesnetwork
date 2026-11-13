# TV Trash rule correction — 2026-11-13

OpenProject story **#835** (epic #814). Design and rule body only. Nothing was written to
Maintainerr, Sonarr, or any other live system. No rule test, rule execute, or collection handle
was called. The movie rule was not changed.

The rule is [DESIGN-014 D-15](../../docs/designs/014-rules-tuning-space-policy.md). This note is the
evidence. Counts below are **measured** (command and time) or a **projection** (this note's rule,
not a Maintainerr run). Decimal TB is bytes / 10^12.

Story 835's written scope (comment 7994) lists four clauses and does not mention a votes floor.
The owner's later ruling on the same story (comment 8099, 2026-11-13T18:55Z, "Add the votes floor") adds
the fifth clause. This note follows that ruling. The story names DESIGN-014 or its successor; D-15
is on DESIGN-014. The movie clause stays.

## Correction after the adversarial review (C1–C6)

The review is the PR comment headed "Adversarial review (Fable 5.2)", also story 835 comment 8096.
Its reads were 2026-11-13, 18:32Z–18:50Z. Numbers below that are not given a command of this
session are that review's measurements. This session's reads are dated with the command.

`GET /api/rules/constants` (Maintainerr pod, localhost, 2026-11-13, before the Sonarr read at
19:21:34Z): Sonarr property id **20**, name `ratingVotes`, human name "Show rating (IMDb) vote
count", type number (key `0`), possibilities `[0, 1, 2, 3, 18, 19]`. The constants payload does not
name comparators. The image's `RulePossibility` (`packages/contracts/dist/rules/constants.js`, same
day) maps `BIGGER = 0`. `doRuleAction` implements it as `val1 > val2`. Movie group 1's live votes
clause (`GET /api/rules`, same window) is action `0`, `firstVal` `[1, 19]`, value `"99"`. The show
clause uses `[2, 20]` and the same action and value.

Sonarr `GET /api/v3/series` at **2026-11-13T19:21:34Z** (1,085 series), joined to the 953 tvdb ids
exported from replica `postgres16-11` at **2026-11-13T19:20:38Z**. Cutoff
**2026-05-17T19:21:34Z**. The fifth clause is `ratings.votes > 99`. Null votes fail. `0` does not.

| Prefix, in the body's order | Shows | Bytes |
| --- | ---: | ---: |
| Rating below 6.0 | 54 | 7,838,701,560,290 |
| And votes greater than 99 | 51 | 7,626,460,152,772 |
| And no `mediarequests` tag (id 1) | 12 | 838,724,127,581 |
| And ended | 10 | 412,648,319,552 |
| And `previousAiring` at or before the cutoff | 10 | 412,648,319,552 |

54 − 3 = 51. The three removed from the rating prefix sum to 212,241,407,518 bytes, and
7,838,701,560,290 − 212,241,407,518 = 7,626,460,152,772.

| Show | tvdb | Rating | Votes | Ended | Tag id 1 | Bytes |
| --- | ---: | ---: | ---: | --- | --- | ---: |
| Condor | 342107 | 0 | 0 | yes | yes | 95,093,226,610 |
| Nightmare Tenants, Slum Landlords | 297091 | 0 | 0 | yes | yes | 89,873,803,876 |
| 90 Day: The Last Resort Between The Sheets | 457446 | 5.9 | 56 | no | yes | 27,274,377,032 |

All three carry `mediarequests`, so the tag prefix stays 12 and the ten stay the ten. The review's
old-order prefixes (ended, aired, rating, tags) were 661 shows (126.7 TB), 648, 32, then 10. Its
rating-then-tag prefixes, with no votes clause, were 54 (7.8 TB), 12, 10, 10. The two-clause prefix
here is 51 because votes removes only those three; the tag is what brings the prefix to 12. The
single-clause rating row matches the 17:49:20Z row byte for byte. Ended on this read is still 661
shows and 126,721,810,699,983 bytes.

The ten shows that pass the five predicates are the same ten as the four-predicate table below, the
same **412,648,319,552** bytes. Lowest votes among them: **1,276**. The three that remain after
`dnd` and the watchlist are unchanged: Star Wars Resistance (tvdb 351575), Muppets Now (368781),
Tales of the Walking Dead (411314), **55,304,752,845** bytes. They are the expected collection
after an apply, not a "projected pool" of ten. The other seven pass the predicates and are excluded
by Maintainerr's global exclusions.

`GET /api/rules/exclusion?rulegroupId=2` at **2026-11-13T19:24:49Z**: **360** rows, every
`ruleGroupId` null, 168 movie, 8 show, 11 season, 173 episode. The eight show rating keys joined to
HaynesOps section `2` on the replica immediately after that GET:

| Rating key | tvdb | Title | In the ten |
| ---: | ---: | --- | --- |
| 90207 | 343608 | Total DramaRama | yes, `dnd` |
| 80762 | 393197 | The Acolyte | yes, `dnd` |
| 51617 | 393204 | Ironheart | yes, `dnd` |
| 102165 | 368613 | She-Hulk: Attorney at Law | yes, `dnd` |
| 100477 | 393192 | Willow | yes, `dnd` |
| 71941 | 393203 | Secret Invasion | yes, `dnd` |
| 58589 | 79854 | Mickey Mouse Clubhouse | yes, `dnd` and watchlist |
| 81211 | 459465 | The Baldwins | no |

The three expected members are not in that list. Watchlist at **2026-11-13T19:24:02Z**: 201
distinct show tvdb ids (`COALESCE(watchlist_registry_items.tvdb_id, plex_discover_ids.tvdb_id)`,
`kind = 'show'`). Of the ten, only Mickey Mouse Clubhouse is listed. Each of the ten has one dated
`media_plex_matches` row on HaynesOps section `2` at that same read (`hops_rows` 1, `hops_dated` 1).

Sonarr reports an unrated show as rating 0 and votes 0. On this series GET, 21 of 1,085 series are
rating 0 and votes 0, 10 of them with files or bytes, matching the review's count. In the 953, two
are unrated (the two rows above). `0 < 6.0` passes the rating clause. The votes clause drops them.

`sw_lastEpisodeAiredAt` reads the last episode, by Plex index, of the highest-index season HaynesOps
holds (`plex-getter.service.js`, read this session). A season index of 0 is not that season when a
higher index exists. The review measured a Muppets Now special dated 2025-03-06; it is not the date
the clause tests. An on-disk season older than the finale can admit a show; a null or later Plex
date drops one the stand-in keeps. `ended` can come from `tryMetadataFallback` when Sonarr has no
series id. `rating`, `ratingVotes` and `tags` are not in that fallback set and stay Sonarr
properties. The review measured 31 HaynesOps shows with no Sonarr match in the 15:00Z run.

`doRuleAction` lowercases both string sides before `includes`. The stored tag value stays
`mediarequests`. The app still keeps a household view inside 30 days (`classifyGuardian`,
`RECENTLY_WATCHED_WINDOW_DAYS`). The review measured Mickey Mouse Clubhouse at 56 household plays
with a household view on 2026-11-10; the exclusion, the watchlist and that keep hold it. Nothing in
the rule does. Those two figures are the review's household totals, not a per-account record.

Removing the date-added clause removes the cover `judgeAge` assumes for a title with no Plex match.
The review measured 0 of 524 movie candidates and 0 of the ten with no Plex match, and 339 of 661
ended HaynesOps shows with no download import inside 180 days. Story 836 owns the code question
(a pool member with no Plex match should be `unknown`).

The review's mislabel check, not re-run here: 30 Sonarr series with files (1.912 TB) have no
HaynesOps match; seven would pass ended, rating and tag, six of them unrated; Maintainerr joins on
TVDB id and its log showed those Plex shows failing to match. The sentence below that the rule
never sees the 132 series outside the 953 is the ledger join. It is not, by itself, why a
mislabelled series is safe. The votes floor is the reason an unrated mislabel matters less, and the
mislabels need their own story.

Q-04 and Q-06 stay open and are carried to story 823 (comment 8099). Q-05 is the votes floor, ruled.

## What was read

Maintainerr 3.32.0, `commitTag` `latest-e6327bb`, `updateAvailable` false. Measured 2026-11-13,
`GET /api/app/status` on localhost inside `deploy/maintainerr` (`media`, container `app`), before
the Sonarr read at 17:48:36Z.

`GET /api/rules/constants` and `GET /api/rules`, same pod, same session, before that status read.
Constants expose `applications[].props[]` (`id`, `name`, `humanName`, `mediaType`, `type.key`,
`type.possibilities`). They do not name comparators. Comparator names and the date/boolean value
encoding are from the running image's `packages/contracts` `RulePossibility` and
`apps/server/dist/modules/rules/helpers/rule.comparator.service.js`, read as files, not executed
as a rule.

Sonarr `GET /api/v3/series` at **2026-11-13T17:48:36Z**, localhost inside `deploy/sonarr`
(container `app`). An unauthenticated call to `GET /api/v3/system/status` returned **401**. The
series read used the key that pod already holds. The key was not printed and is not in this note.
1,085 series. Status: 778 ended, 300 continuing, 7 upcoming. `ended` agreed with `status == ended`
on every series. `previousAiring` was null on 9 series, none of them in the HaynesOps TV universe
below. `ratings.value` and `statistics.sizeOnDisk` were present on all 1,085.

Sonarr `GET /api/v3/tag` at **2026-11-13T17:48:43Z**, same pod, same key handling. 30 tags. The
two labels this rule uses: id **1** `mediarequests`, id **27** `dnd`. Other labels are not listed.

Replica `postgres16-11` (`kubectl get pods -n database -l cnpg.io/cluster=postgres16,cnpg.io/instanceRole=replica`),
database `haynesnetwork`. Reads from 17:43:58Z through 17:50:25Z.

| Read | When (UTC) | Result |
| --- | --- | --- |
| HaynesOps library | 17:43:58Z | slug `haynesops`, section `2`, name HOps TV Shows, media type `show`, available, 1,013 match rows |
| Those rows by kind | 17:48:21Z | 953 live Sonarr (953 distinct tvdb), 60 live Radarr. The rule's universe is the 953. |
| HOps Sonarr rows joined to metadata | 17:49:20Z | 953 rows. `arr_tags`, `arr_attrs.ended`, `arr_attrs.status`, `tmdb_rating` all agreed with the Sonarr GET (0 mismatches; rating difference over 0.05: 0). |
| Watchlist show tvdb ids | 17:49:20Z | 201 distinct `COALESCE(watchlist_registry_items.tvdb_id, plex_discover_ids.tvdb_id)` where `kind = 'show'` |
| Registry runs | 17:49:20Z | newest `ok`, trigger `schedule`, finished 2026-11-13 12:44:17.922-05 (17:44:17Z) |
| `space_policy` | 17:49:20Z | enabled, mode `over-target`, `minCandidates` 1, TV `maxItems` 5 enabled, TV `targetBytes` disabled, no TV `strategy`, `updated_at` 2026-10-30 11:07:46-04 |

132 of the 1,085 Sonarr series are not in the 953, so this ledger join does not include them.
Every one of the 953 was in the GET. A mislabelled series can still be a different question; the
correction section records the review's check and does not treat this sentence as that proof.

## The live TV group, this session

Group 2, `dataType` `show`, `libraryId` `"2"`, `useRules` true, `isActive` true. Collection id 3,
`deleteAfterDays` 9999, `arrAction` 0, `listExclusions` true, `forceSeerr` true,
`manualCollection` false, `manualCollectionName` `""`, `sonarrSettingsId` 1, `tagInArr` false.
Four clauses, ids 156–159, and the 748-character description, copied into DESIGN-014 D-15 as the
pre-image. No PUT followed this GET. The correction session's `GET /api/rules`, before the
19:21:34Z Sonarr read, still showed those ids, that description length, collection id 3,
`mediaServerId` null, and group 1's five movie clauses (ids 160–164) unchanged.

## Projection rule

Clock **2026-11-13T17:49:20Z**. Cutoff **2026-05-17T17:49:20Z** (`clock - 15552000` seconds).

Universe: a Sonarr series from the 17:48:36Z GET whose `tvdbId` is one of the 953 live Sonarr
ledger rows matched to HaynesOps section `2`.

A show passes the predicates when all of these hold. This is a stand-in for D-15, not a
Maintainerr evaluation, and not the collection Maintainerr will hold. The air-date line is the one
place the stand-in is not the property the rule reads. The 17:49:20Z table below was computed before
the votes clause. The 19:21:34Z recompute in the correction section applies the votes clause and
finds the same ten.

| Clause | Passes when | Source |
| --- | --- | --- |
| Rating | `ratings.value` is not null and `< 6.0`. A reported `0` passes. | Sonarr GET. Same field as the getter. |
| Votes | `ratings.votes` is not null and `> 99`. A reported `0` fails. | Sonarr GET at 19:21:34Z. Not in the 17:49:20Z table. |
| Tag | tag id 1 is absent | Sonarr GET, id from the tag GET. |
| Ended | `ended` is true | Sonarr GET. The getter returns 1 for that. For a show Sonarr does not track, the image can answer from the metadata provider. |
| Aired | `previousAiring` parses and is `<=` the cutoff. Null fails. | Sonarr GET. **Stand-in** for Plex `sw_lastEpisodeAiredAt`. |
| Views | not applied | The clause is removed. The app's 30-day household keep is separate. |

Bytes are `statistics.sizeOnDisk`. `dnd` is tag id 27 on that same GET. Watchlist is the 201
tvdb ids above. "After keeps" means the show passes the predicates, tag 27 is absent, and its tvdb
is not in the 201. That remainder is the expected collection, not a ten-show pool.

On the 953:

| Clause | Shows that pass | Bytes |
| --- | ---: | ---: |
| Ended | 661 | 126,721,810,699,983 |
| `previousAiring` at or before the cutoff | 793 | 149,351,491,357,630 |
| Rating below 6.0 | 54 | 7,838,701,560,290 |
| No `mediarequests` tag | 483 | 134,520,715,968,231 |
| Has `mediarequests` tag | 470 | 81,365,137,757,896 |
| Ended, rating below 6.0, no `mediarequests`, air-date stand-in (votes not applied on this clock) | 10 | 412,648,319,552 |

The rating count and its bytes match the audit's rating row (54 shows, 7,838,701,560,290 bytes).
Ended 661 matches the audit's HOps status split. No `mediarequests` 483 and tagged 470 match the
audit's tag split. Every HOps show had a `previousAiring`. Among shows that passed ended, rating
and the tag, **0** had a finale after the cutoff, so the air-date stand-in removed nobody from
that set.

### The ten that pass the predicates

Sorted by rating, then title. Same order as worst-rated would use for a strict less-than on the
rating; ties are not broken here. These ten are not the expected collection. Seven of them are
global exclusions. The expected collection is the three with `dnd` no and watchlist no.

Votes are from the 19:21:34Z Sonarr GET. Every other column is the 17:49:20Z read; bytes and
`previousAiring` matched that GET again at 19:21:34Z. Watchlist "yes/no" matched again at 19:24:02Z.

| Show | Year | tvdb | Rating | Votes | Bytes | `previousAiring` | `dnd` | Watchlist | HOps added |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| Total DramaRama | 2018 | 343608 | 4.0 | 1,276 | 21,216,798,990 | 2022-07-22T14:00:00Z | yes | no | 2026-07-03 00:17:51-04 |
| The Acolyte | 2024 | 393197 | 4.3 | 146,846 | 33,475,224,915 | 2024-07-17T01:00:00Z | yes | no | 2026-07-03 00:01:12-04 |
| Ironheart | 2025 | 393204 | 4.5 | 71,278 | 32,223,030,084 | 2025-07-02T02:36:00Z | yes | no | 2026-07-02 22:43:07-04 |
| She-Hulk: Attorney at Law | 2022 | 368613 | 5.2 | 214,672 | 27,244,469,073 | 2022-10-13T07:00:00Z | yes | no | 2026-08-05 04:19:03-04 |
| Star Wars Resistance | 2018 | 351575 | 5.3 | 9,581 | 28,892,374,991 | 2020-01-27T03:00:00Z | no | no | 2026-11-04 22:30:00-05 |
| Willow | 2022 | 393192 | 5.7 | 35,804 | 29,472,437,707 | 2023-01-11T08:00:00Z | yes | no | 2026-07-29 03:05:00-04 |
| Secret Invasion | 2023 | 393203 | 5.8 | 93,871 | 25,314,489,631 | 2023-07-26T07:00:00Z | yes | no | 2026-07-02 23:36:28-04 |
| Mickey Mouse Clubhouse | 2006 | 79854 | 5.9 | 6,882 | 188,397,116,307 | 2016-11-06T14:25:00Z | yes | yes | 2026-07-02 22:56:11-04 |
| Muppets Now | 2020 | 368781 | 5.9 | 1,573 | 13,041,795,823 | 2020-09-04T07:00:00Z | no | no | 2026-08-16 01:12:00-04 |
| Tales of the Walking Dead | 2022 | 411314 | 5.9 | 8,734 | 13,370,582,031 | 2022-09-19T01:00:00Z | no | no | 2026-08-01 01:37:00-04 |

Sum of the ten: **412,648,319,552** bytes (0.412648319552 TB, 0.413 TB to three decimals). Seven
carry `dnd` (357,343,566,707 bytes). One of those seven is watchlisted (Mickey Mouse Clubhouse,
188,397,116,307 bytes). The watchlisted show is already in the seven, so it is not a further
subtraction. After `dnd` and the watchlist: **3** shows, **55,304,752,845** bytes
(0.055304752845 TB, 0.055 TB to three decimals): Star Wars Resistance, Muppets Now, Tales of the
Walking Dead.

`7 dnd bytes + 3 remaining bytes = 412,648,319,552`. The ten individual byte figures are the
audit's ten figures.

### Beside the audit

The audit counted 10 shows and 0.413 TB, and 3 shows and 0.055 TB after `dnd` and the watchlist,
at a projection clock of 2026-11-13 16:57 UTC (finale on or before 2026-05-17). It called the ten a
projected pool. This note does not: the ten pass the predicates, and the expected collection is the
three. The set, the per-show bytes, and the two sums are the same. The 19:21:34Z votes clause
removes nobody from the ten. The cutoff moved about
52 minutes later. No `previousAiring` in the pool sits between the two cutoffs, and no ended,
low-rated, untagged HOps show has a finale in that gap (there were 0 such finales after the later
cutoff at all).

What this projection does not measure: Plex `sw_lastEpisodeAiredAt` is the
`originallyAvailableAt` of the last episode, by index, of the highest-index season HaynesOps holds.
Sonarr `previousAiring` is not that read. They differ in both directions. A Plex date that is null,
or later than `previousAiring`, drops a show this table keeps. A Plex date earlier than the true
finale admits a show whose real finale is recent, because HaynesOps may not hold that season.
Specials (season index 0) are not the episode under test when a higher-numbered season is on the
server. This session did not read Plex. The correction section records the image getter and the
review's counts.

### Age Guard on the three

Not part of the Maintainerr rule. `judgeAge` keeps a title while `now - newest < 180 * 86,400,000`
ms. Newest is the later of the newest Sonarr `downloadFolderImported` and the newest
`plex_added_at` on any server. Measured 2026-11-13 17:50:25Z. Each of the three has 2 Plex matches
and 0 undated. Household `play_count` and `last_viewed_at` are null on all three (no harvested
household play). Those two columns are household totals.

| Show | Newest import | Newest Plex added | Newest | Clear at (UTC) |
| --- | --- | --- | --- | --- |
| Star Wars Resistance | 2026-11-04 22:41:01-05 | 2026-11-04 22:30:00-05 | the import | 2027-05-04 03:41:01Z |
| Muppets Now | 2026-08-16 01:30:00-04 | 2026-08-16 01:12:00-04 | the import | 2027-02-12 05:30:00Z |
| Tales of the Walking Dead | 2026-08-11 14:06:01-04 | 2026-08-01 01:37:00-04 | the import | 2027-02-07 18:06:01Z |

All three are `recent` at the 17:50:25Z clock. The audit's note that Tales clears from its HOps
added date (2026-08-01) is earlier than the guard: the download import on 2026-08-11 is newer, so
the guard uses that. This does not change the ten or the three.

The cap still drops `dnd`, watchlist, an open Save and an Age Guard `recent` title before it
counts to 5 (`selectBatchCandidates`). The deletable input from this pool is empty until those
three dates clear. After that, three is under five.

## Aging invariant

`evaluateAgingInvariants` does not read predicates. Group 2's collection already has
`deleteAfterDays` 9999, `arrAction` 0, `listExclusions` true and `forceSeerr` true. Replacing the
added-date clause does not make `auditMaintainerr` refuse the pool. No superseding ADR.

`upsertTrashRule` forwards a decoded rule unchanged, so it can express every clause. Its
post-write `ruleGroupDrift` compares the delete flags, not the clauses or the description. The
apply procedure in D-15 does that comparison itself and puts the pre-image back through the same
writer if it fails. No code in this story.

## Questions

**Q-04** (DESIGN-014, open). The group's name stays "hnet — unwatched low-value TV". Maintainerr
names the Plex collection from the group once the pool has a member. This session's `GET /api/rules`
showed the movie collection's `mediaServerId` 98837 and the TV collection's `mediaServerId` null
(collection id 3). "Unwatched" would then show on HaynesOps for shows that may have been watched.
Recommendation: story 823 puts the name to the owner before the apply. Comment 8099 carries it
there. A rename is not in either ruling.

**Q-05** (resolved, comment 8099, 2026-11-13T18:55Z). The owner answered "Add the votes floor".
The fifth clause is in D-15. It changes none of the ten.

**Q-06** (open, carried to story 823). A list-added, never-requested show is in the expected three
(Star Wars Resistance). The review measured the 2026-11-04 list add, tag `pmm-added`, 35 files
still downloading, and 267 of 373 ended unrequested HaynesOps shows carrying `pmm-added`.
Recommendation: yes, no change now; record it for the larger-pool design. Not re-measured here.

The audit's Q-02 (Age Guard and the library fill), Q-07 (lifetime watch) and Q-08 (seasons) stay
out of this story. The ruling adopted the recommendation, which is the small show-level rule.

## Not done

- No live write. Story 823 applies the body, after the coordinator accepts the corrected design.
- No Maintainerr evaluation. The ten pass a Sonarr stand-in. The expected collection is the three,
  and it stays a projection until 823 reads the collection.
- No Plex library read, so the air-date stand-in is not the property the rule will read.
- No glossary term. No ADR. No code, so the package tests, typecheck and lint were not run.
- The adversarial review is on the PR. This correction applies C1–C6. It does not mark the story
  complete.
