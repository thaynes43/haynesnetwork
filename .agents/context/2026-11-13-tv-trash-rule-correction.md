# TV Trash rule correction — 2026-11-13

OpenProject story **#835** (epic #814). Design and rule body only. Nothing was written to
Maintainerr, Sonarr, or any other live system. No rule test, rule execute, or collection handle
was called. The movie rule was not changed.

The rule is [DESIGN-014 D-15](../../docs/designs/014-rules-tuning-space-policy.md). This note is the
evidence. Counts below are **measured** (command and time) or a **projection** (this note's rule,
not a Maintainerr run). Decimal TB is bytes / 10^12.

The story and the work order agree. The story names DESIGN-014 or its successor; D-15 is on
DESIGN-014, and the sentences in DESIGN-010 and DESIGN-052 that still said both pools keep the
added-date clause now point here. The movie clause stays.

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

132 of the 1,085 Sonarr series are not in the 953. The rule never sees them. Every one of the 953
was in the GET.

## The live TV group, this session

Group 2, `dataType` `show`, `libraryId` `"2"`, `useRules` true, `isActive` true. Collection id 3,
`deleteAfterDays` 9999, `arrAction` 0, `listExclusions` true, `forceSeerr` true,
`manualCollection` false, `manualCollectionName` `""`, `sonarrSettingsId` 1, `tagInArr` false.
Four clauses, ids 156–159, and the 748-character description, copied into DESIGN-014 D-15 as the
pre-image. No PUT followed this GET.

## Projection rule

Clock **2026-11-13T17:49:20Z**. Cutoff **2026-05-17T17:49:20Z** (`clock - 15552000` seconds).

Universe: a Sonarr series from the 17:48:36Z GET whose `tvdbId` is one of the 953 live Sonarr
ledger rows matched to HaynesOps section `2`.

A show is in the projected pool when all of these hold. This is a stand-in for D-15, not a
Maintainerr evaluation. The air-date line is the one place the stand-in is not the property the
rule reads.

| Clause | Passes when | Source |
| --- | --- | --- |
| Ended | `ended` is true | Sonarr GET. The getter returns 1 for that. |
| Aired | `previousAiring` parses and is `<=` the cutoff. Null fails. | Sonarr GET. **Stand-in** for Plex `sw_lastEpisodeAiredAt`. |
| Rating | `ratings.value` is not null and `< 6.0` | Sonarr GET. Same field as the getter. |
| Tag | tag id 1 is absent | Sonarr GET, id from the tag GET. |
| Views | not applied | The clause is removed. |

Bytes are `statistics.sizeOnDisk`. `dnd` is tag id 27 on that same GET. Watchlist is the 201
tvdb ids above. "After keeps" means in the pool, tag 27 absent, and tvdb not in the 201.

On the 953:

| Clause | Shows that pass | Bytes |
| --- | ---: | ---: |
| Ended | 661 | 126,721,810,699,983 |
| `previousAiring` at or before the cutoff | 793 | 149,351,491,357,630 |
| Rating below 6.0 | 54 | 7,838,701,560,290 |
| No `mediarequests` tag | 483 | 134,520,715,968,231 |
| Has `mediarequests` tag | 470 | 81,365,137,757,896 |
| All four pool clauses | 10 | 412,648,319,552 |

The rating count and its bytes match the audit's rating row (54 shows, 7,838,701,560,290 bytes).
Ended 661 matches the audit's HOps status split. No `mediarequests` 483 and tagged 470 match the
audit's tag split. Every HOps show had a `previousAiring`. Among shows that passed ended, rating
and the tag, **0** had a finale after the cutoff, so the air-date stand-in removed nobody from
that set.

### The ten

Sorted by rating, then title. Same order as worst-rated would use for a strict less-than on the
rating; ties are not broken here.

| Show | Year | tvdb | Rating | Bytes | `previousAiring` | `dnd` | Watchlist | HOps added |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| Total DramaRama | 2018 | 343608 | 4.0 | 21,216,798,990 | 2022-07-22T14:00:00Z | yes | no | 2026-07-03 00:17:51-04 |
| The Acolyte | 2024 | 393197 | 4.3 | 33,475,224,915 | 2024-07-17T01:00:00Z | yes | no | 2026-07-03 00:01:12-04 |
| Ironheart | 2025 | 393204 | 4.5 | 32,223,030,084 | 2025-07-02T02:36:00Z | yes | no | 2026-07-02 22:43:07-04 |
| She-Hulk: Attorney at Law | 2022 | 368613 | 5.2 | 27,244,469,073 | 2022-10-13T07:00:00Z | yes | no | 2026-08-05 04:19:03-04 |
| Star Wars Resistance | 2018 | 351575 | 5.3 | 28,892,374,991 | 2020-01-27T03:00:00Z | no | no | 2026-11-04 22:30:00-05 |
| Willow | 2022 | 393192 | 5.7 | 29,472,437,707 | 2023-01-11T08:00:00Z | yes | no | 2026-07-29 03:05:00-04 |
| Secret Invasion | 2023 | 393203 | 5.8 | 25,314,489,631 | 2023-07-26T07:00:00Z | yes | no | 2026-07-02 23:36:28-04 |
| Mickey Mouse Clubhouse | 2006 | 79854 | 5.9 | 188,397,116,307 | 2016-11-06T14:25:00Z | yes | yes | 2026-07-02 22:56:11-04 |
| Muppets Now | 2020 | 368781 | 5.9 | 13,041,795,823 | 2020-09-04T07:00:00Z | no | no | 2026-08-16 01:12:00-04 |
| Tales of the Walking Dead | 2022 | 411314 | 5.9 | 13,370,582,031 | 2022-09-19T01:00:00Z | no | no | 2026-08-01 01:37:00-04 |

Sum of the ten: **412,648,319,552** bytes (0.412648319552 TB, 0.413 TB to three decimals). Seven
carry `dnd` (357,343,566,707 bytes). One of those seven is watchlisted (Mickey Mouse Clubhouse,
188,397,116,307 bytes). The watchlisted show is already in the seven, so it is not a further
subtraction. After `dnd` and the watchlist: **3** shows, **55,304,752,845** bytes
(0.055304752845 TB, 0.055 TB to three decimals): Star Wars Resistance, Muppets Now, Tales of the
Walking Dead.

`7 dnd bytes + 3 remaining bytes = 412,648,319,552`. The ten individual byte figures are the
audit's ten figures.

### Beside the audit

The audit's projected pool was 10 shows and 0.413 TB, and 3 shows and 0.055 TB after `dnd` and
the watchlist, at a projection clock of 2026-11-13 16:57 UTC (finale on or before 2026-05-17).
This projection's set, the per-show bytes, and the two sums are the same. The cutoff moved about
52 minutes later. No `previousAiring` in the pool sits between the two cutoffs, and no ended,
low-rated, untagged HOps show has a finale in that gap (there were 0 such finales after the later
cutoff at all).

What this projection does not measure: Plex `sw_lastEpisodeAiredAt` is the
`originallyAvailableAt` of the last episode, by index, of the highest-index season. Sonarr
`previousAiring` is the last episode Sonarr has already marked aired. They can differ when Plex
has no date on that episode, or a later date than `previousAiring`. This session did not read
Plex. A difference of that kind would not show up in the table above.

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

**Q-04** (DESIGN-014). The group's name stays "hnet — unwatched low-value TV" after the views
clause is removed. Recommendation: do not rename on the apply. The description says plays are not
a predicate. A rename is not in the ruling.

The audit's Q-02 (Age Guard and the library fill), Q-07 (lifetime watch) and Q-08 (seasons) stay
out of this story. The ruling adopted the recommendation, which is the small show-level rule.

## Not done

- No live write. Story 823 applies the body, after this design is reviewed.
- No Maintainerr evaluation. The ten are a projection.
- No Plex library read, so the air-date stand-in is not the property the rule will read.
- No glossary term. No ADR. No code, so the package tests, typecheck and lint were not run.
- The adversarial review on the PR is the coordinator's, before merge.
