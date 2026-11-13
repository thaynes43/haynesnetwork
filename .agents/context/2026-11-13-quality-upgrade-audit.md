# Quality profiles, upgrades, and the bytes they cost

Read-only audit for story 826. Every figure below was read on 2026-11-13. Nothing in Radarr, Sonarr, Lidarr, Kometa, or this app was changed.

The 92-day window is the intake inventory's window: 2026-08-14T00:00:00Z inclusive through 2026-11-14T00:00:00Z exclusive. GB is bytes/1e9, rounded to 0.1. TB is bytes/1e12. The CSVs beside this file hold the integers. A rounded column can miss its total by 0.1; the integer rows were checked.

## The answer

Upgrades in these 92 days downloaded **40,681.2 GB** and left **7,477.2 GB** on disk.

| App | Upgrades | Downloaded | Net on disk |
| --- | ---: | ---: | ---: |
| Radarr | 500 | 17,952.3 GB | 4,231.6 GB |
| Sonarr | 8,450 | 22,703.8 GB | 3,240.5 GB |
| Lidarr | 810 | 25.0 GB | 5.0 GB |

The disk growth is the climb into a higher quality, mostly into a remux. Same-quality replacements are most of the download. On movies they added 205.4 GB. On shows they removed 865.3 GB, so the disk would have been larger without them. The three rounded nets add to 7,477.1; the integer sum rounds to 7,477.2.

Every live movie and every live show is on the profile `FHD-UHD`, which upgrades until a 2160p remux. Every live artist is on Lidarr's profile `Any`, which upgrades until lossless. Radarr and Sonarr have no import lists. Kometa's git seed sets `upgrade_existing: false`, so Kometa does not replace a file it already has. The upgrades are the profile, and almost all of them arrived by RSS.

The change I would make, and this report does not make it: set the video cutoff to WEB 2160p and treat a file of that quality or better as finished. Over these 92 days that stops **2,843.6 GB** of net growth and **20,455.8 GB** of downloads. Files below that quality would still climb. I would also stop same-quality replacements, which are the rest of the download, and I would point Lidarr's lists at the Lossless profile. None of those options deletes a file that is already on disk.

## How a number was counted

**History.** `GET` of `/api/v3/history` (Lidarr `/api/v1/history`), page size 1,000, newest first, one request at a time, inside the app pod. The walk stopped when the oldest record on a page was before 2026-08-14. Each record was reduced before it left the pod: ids, time, quality name, score, format names, size, revision, and an alphabetic delete reason. Release titles, paths, and download URLs were not kept.

**An upgrade pair.** A file delete whose reason is exactly `Upgrade`, paired with an import of the same target within 120 seconds. The target is the movie, the episode, or the album. Pairs are chosen globally, smallest time gap first, and each record is used once. Download bytes are the import's `data.size`. Deleted bytes are the delete's `data.size`. Net is import minus delete. An upgrade delete with no import inside 120 seconds is counted aside and is not subtracted. Radarr had 0 unpaired. Sonarr had 0. Lidarr had 460, totaling 11.0 GB.

**Quality rank** is the profile order, best last in the number used here. Members of one group share a rank, so WEBRip and WEBDL are the same rank, and FLAC and FLAC 24bit are the same rank. A higher rank is what the profile calls better. The score cutoff applies only once the file is already at the cutoff quality. Below that, any higher rank upgrades. That rule is written in `recyclarr.yml` and matches the history: files below the remux rung upgraded for a higher quality even when the new score was lower.

**Class,** first match wins, and the integer bytes of the classes sum to the app total:

1. Resolution rose, and the old file was a remux and the new file is not: `resolution_up_leaving_remux`.
2. Resolution rose: `resolution_up`.
3. Resolution fell: `resolution_down`.
4. Same resolution, higher rank, and the new file is a remux: `to_remux_same_resolution`.
5. Same resolution, higher rank: `higher_rank_same_resolution`.
6. Same rank, WEBRip replaced by WEBDL: `webrip_to_webdl`.
7. Same quality name: `same_quality_name`.
8. Anything else at the same rank: `same_rank_other`.

**Where the title came from,** in this order, from the replica's current labels: a conflict (umbrella tag and a requester tag, or `mediarequests`, or a Seerr requested-ledger event), then `kometa-added`, then `pmm-added` alone, then Seerr (a media request, a requester tag, or a Seerr event), then a `spotify*` tag, then unattributed. Tags are the labels on the item now, not a history of who added it. The inventory states the same limit.

**A watch record** is the inventory's definition: `media_metadata.play_count > 0` or `last_viewed_at` set, on the movie, the series, or the artist. One watched episode marks the whole series. `play_count` is never 0 in this database, so a null is "no watch record", not "never watched". Music has no Tautulli rows, so every Lidarr byte is no-watch-record. No per-account play was read.

**Release source is inferred.** The grab is the history event that carries it. A grab counts when it is the same target, the same quality name, and the same score, 0 to 48 hours before the import, closest first. If another grab within 60 seconds of that one has a different source, the row is `ambiguous`. This is not the inventory's download-id join. Download ids were not kept.

**The October brake.** Commit `cefc168c` (2026-10-03) set the until-score to a reachable number (Radarr 8450, Sonarr 500; both had been 10000) and the minimum upgrade increment to 100 (it had been 1). Recyclarr runs at 05:30 America/New_York, so the scheduled apply is 2026-10-04T09:30:00Z. That instant is the schedule, not a measured apply time. "Before" and "after" split on the import's timestamp against that instant.

**A cutoff option.** `avoid`: the old file's rank was already at or above the proposed cutoff, so that upgrade would not have been grabbed if a file at the cutoff was finished. `jumped_over`: the old file was below the cutoff and the new file was above it, so an upgrade would still have happened, but not past the new cutoff. The size of that shorter upgrade was not measured. `stays`: the new file was still at or below the cutoff, so the upgrade would still have happened. The detail is `2026-11-13-quality-cutoff-detail.csv`. Its `old_above_cutoff` + `old_at_cutoff_grabbed_higher` + `old_at_cutoff_same_group` equals the `avoid` integers.

**Per month** is the 92-day total times 30/92. That is a scale, not a forecast. The inventory's own weekly upgrade net, all three apps, ran from -110.0 GB to 1,564.8 GB.

## Where a later change has to be made

Video profiles are git, not the app UI. Recyclarr re-asserts them nightly.

- File: `haynes-ops` `kubernetes/main/apps/media/recyclarr/app/recyclarr.yml`, clone `bab21e1497c41be303e9b8cc4773f185176b6f84` (2026-11-13 17:43:52Z).
- Schedule: HelmRelease `kubernetes/main/apps/media/recyclarr/app/helmrelease.yaml`, cron `30 5 * * *`, time zone `America/New_York`, image `ghcr.io/recyclarr/recyclarr:8.8.1`.
- The Sonarr delay profile is not in that file. It is documented in `haynes-ops` `.agents/runbooks/arr-quality-profiles.md` and it matches the live `GET` of 2026-11-13.
- Lidarr's profiles, its delay profile, and its 25 lists are not in git. The recyclarr header says FLAC was set through the API. A UI edit there survives until someone edits the API again. A rebuild does not keep it.

Live `GET` on 2026-11-13, versions Radarr 6.4.4.10685, Sonarr 4.0.20.3012, Lidarr 3.2.1.5196. The live FHD-UHD cutoff, until-score, minimum increment, allowed qualities, and the language penalty of -10000 match the git file.

## 1. What is configured

### The profile the library uses

Replica `postgres16-11` (CNPG replica, time zone America/New_York), live rows only, 2026-11-13:

| App | Profile | Titles | Bytes | With a watch record |
| --- | --- | ---: | ---: | ---: |
| Radarr | FHD-UHD | 9,630 | 169.06 TB | 414 |
| Sonarr | FHD-UHD | 1,085 | 217.41 TB | 192 |
| Lidarr | Any | 7,735 | 8.76 TB | 0 |

The other profiles have upgrades off, every format score at 0, and no live titles. Their allowed lists are in `2026-11-13-quality-profiles.csv`.

Current umbrella tags, same replica read. A title can carry neither tag. None carried both.

| App | kometa-added only | pmm-added only | neither |
| --- | --- | --- | --- |
| Radarr | 678 titles, 5.09 TB | 7,004 titles, 103.83 TB | 1,948 titles, 60.14 TB |
| Sonarr | 11 titles, 0.06 TB | 413 titles, 93.78 TB | 661 titles, 123.57 TB |
| Lidarr | 0 | 0 | 7,735 titles, 8.76 TB |

`pmm-added` is most of the movie library. It is the legacy label, not this season's Kometa run.

### FHD-UHD, best quality first

Both upgrade. Minimum format score is 0. Minimum upgrade increment is 100. Propers and repacks are `doNotPrefer`.

**Radarr.** Cutoff `Remux-2160p`. Until-score 8450. Profile language Original. Allowed, best first: Remux-2160p, Bluray-2160p, WEB 2160p (WEBDL and WEBRip), Remux-1080p, HDTV-2160p, Bluray-1080p, WEB 1080p. HDTV-2160p ranks above a 1080p Blu-ray and below a 1080p remux. The git comment calls that slot "junk-tier-low".

**Sonarr.** Cutoff `Bluray-2160p Remux`. Until-score 500. No profile language; the custom format does the language rule. Allowed, best first: Bluray-2160p Remux, Bluray-2160p, WEB 2160p, Bluray-1080p Remux, Bluray-1080p, WEB 1080p. HDTV-2160p is not allowed.

**Lidarr `Any`.** Upgrades on. Cutoff is the Lossless group (FLAC, ALAC, APE, WavPack, FLAC 24bit, ALAC 24bit share one rank). Every lossy group is allowed. WAV is not. There is no custom-format score and no minimum-upgrade field. Propers are `preferAndUpgrade`. The Lossless profile has upgrades off. The Standard profile has upgrades off and its cutoff is Low Quality Lossy. No artist uses those two.

### Scores

Nonzero scores are `2026-11-13-quality-formats.csv`. Radarr's FHD-UHD profile has 60 formats, 48 of them nonzero, 12 at zero. Sonarr's has 34, all nonzero. The other profiles score every format at 0.

Radarr's large positive scores are audio and the remux tiers: TrueHD ATMOS +5000, DTS X +4500, ATMOS +3000, DD+ ATMOS +3000, TrueHD +2750, DTS-HD MA +2500, remux tiers +1950/+1900/+1850, Blu-ray tiers +1800/+1750/+1700, web tiers +1700/+1650/+1600, DV Boost +1000, HDR +500, HDR10+ Boost +100. Repack/Proper is +7, +6, +5.

Sonarr has no audio formats. Web tiers are +1700/+1650/+1600, HDR is +500, a streaming-service tag is +75, and the streaming boost is +75. Repack is +7/+6/+5. HDR at +500 is the until-score, so one HDR format finishes a file that is already a 2160p remux.

Penalties of -10000, Radarr: 3D, AV1, BR-DISK, DV without HDR fallback, Extras, Generated Dynamic HDR, LQ, LQ (Release Title), Language: Not Original, SDR (no WEBDL), Sing-Along Versions, Upscaled, x265 (HD). Sonarr: AV1, BR-DISK, Extras, LQ, LQ (Release Title), Language: Not English or Original, x265 (HD). With minimum score 0, a release carrying one of those is not grabbed.

### Size limits

`2026-11-13-quality-definitions.csv`. Radarr and Sonarr use the TRaSH movie and series definitions: the unit is MB per minute. Every HD quality has a minimum and a null preferred and a null maximum. There is no size cap on the qualities that hold the bytes.

Radarr minimums, MB/min: WEB 1080p 12.5, Bluray-1080p 50.8, Remux-1080p 102, HDTV-2160p 85, WEB 2160p 34.5, Bluray-2160p 102, Remux-2160p 187.4. Sonarr: WEB 1080p 15, Bluray-1080p 50.4, Bluray-1080p Remux 69.1, WEB 2160p 25, Bluray-2160p 94.6, Bluray-2160p Remux 187.4.

Lidarr's figures are the API's own min/preferred/max. They are not MB per minute. MP3-320's maximum of 350 is that scale. This report does not convert them.

### Delay profiles

Live `GET` of `/api/v3/delayprofile`, 2026-11-13. One profile each, id 1, no tags.

| App | Usenet delay | Torrent delay | Bypass at top quality | Bypass above score | That score |
| --- | ---: | ---: | --- | --- | ---: |
| Radarr | 0 min | 0 | yes | no | 0 |
| Sonarr | 120 min | 0 | yes | yes | 1775 |
| Lidarr | 360 min | 720 min | no | no | 0 |

Sonarr matches the runbook (ruling "Wait 2 hours", 2026-10-03). Radarr matches the runbook's "untouched (0 / 0)". Lidarr's delay profile was read the same day into the reduced config. Preferred protocol on both video apps is usenet.

### Import lists

Radarr: empty. Sonarr: empty. Lidarr: 25 lists, all read 2026-11-13. Every one has automatic add on, monitors the whole artist, does not monitor existing albums, does not search, monitors new items `all`, quality profile Any (id 1), metadata profile Standard (id 1). Standard allows an official studio album and refuses singles, EPs, live albums, compilations, and the other secondary types. `shouldSearch: false` means the list adds the artist and does not start a search. Whatever then arrives is free to upgrade, because the profile is Any.

The names and implementations are `2026-11-13-quality-import-lists.csv`: Apple Music new and top albums, Billboard top albums and artists, Last.fm top artists, sixteen Last.fm tags, and three Spotify lists (followed artists, playlists, saved albums). List fields that can hold a credential were not read.

## 2. What the files on disk look like

The quality of a file is not in the replica. It comes from the app. Radarr's movie list and Sonarr's episode-file list were read after the history walk on 2026-11-13. Lidarr's track files were read per artist and finished at 2026-11-13T19:58:19Z. The full histogram is `2026-11-13-quality-files.csv`. Median is the middle of the sorted sizes (the average of the two middle values when the count is even). p90 is nearest-rank: sorted ascending, index `ceil(0.9 × n) − 1`.

**Movies.** The API returned 9,598 movies, all on profile 9. 5,243 have a file, 4,355 do not. File bytes are 167.32 TB. The replica the same evening had 9,630 live movies and 169.06 TB. The gap is 32 movies and 1.73 TB. It was not reconciled. The histogram below is the API. The profile assignment above is the replica. Both say every movie is on FHD-UHD.

| | Files | Bytes | Share of file bytes |
| --- | ---: | ---: | ---: |
| 2160p | 2,366 | 112,430.2 GB | 67.2% |
| Remux (1080p and 2160p) | 3,525 | 148,210.6 GB | 88.6% |
| Remux-2160p, the cutoff | 1,604 | 99,427.6 GB | 59.4% |

The 1,604 Remux-2160p files are exactly the files whose cutoff flag is met. The other 3,639 files, 67,896.5 GB, are below the cutoff. Median Remux-2160p file: 59.16 GB, p90 82.25 GB, median 525.2 MB per minute (n=1,604). Median WEBDL-2160p: 16.88 GB, p90 24.10 GB (n=705). There is no HDTV-2160p movie file.

Estimated remaining exposure, movies only: 3,630 below-cutoff files have a runtime. At the median remux rate of 525.2 MB per minute, replacing each with a remux would add 135.7 TB on top of the 67.85 TB those files occupy now. Nine below-cutoff files had no runtime and are left out. This assumes a remux exists for every movie. The 92-day movie net was 4.23 TB, so 135.7 TB is the size of the pool, not a monthly forecast.

**Shows.** 1,085 series, all profile 9. The episode-file walk returned 64,648 files and 217,797,860,448,252 bytes. The series statistics sum to the same byte total and to 67,184 episode files. The bytes match, so the size table is the whole library. The counts do not match. The walk did not keep how many episodes sit in one file, so this report does not explain the 2,536-count gap. The histogram is files.

| | Files | Bytes | Share of bytes |
| --- | ---: | ---: | ---: |
| 2160p | 10,981 | 70,405.4 GB | 32.3% |
| Remux (1080p and 2160p) | 10,800 | 82,094.1 GB | 37.7% |
| Bluray-2160p Remux, the cutoff | 929 | 15,994.6 GB | 7.3% |

Radarr and Sonarr report `qualityCutoffNotMet` as false on exactly those 929 remuxes: they are the only files that have reached the cutoff, and every other file is still below it. Of them, 870 score 500 or more and 59 score below 500. A score of 500 or more does not stop a later quality-rank upgrade; it only finishes a file that is already on the top rung. Median Bluray-2160p Remux: 14.89 GB, p90 29.64 GB (n=929). Median WEBDL-2160p: 5.01 GB, p90 8.49 GB (n=9,221). Median WEBDL-1080p: 1.59 GB (n=32,126). HDTV-2160p still holds 141 files. The profile does not allow that quality; the files predate the rule.

**Music.** 304,595 track files, 8,767.7 GB. The replica's artist bytes the same evening were 8,761.4 GB. The gap is 6.3 GB and was not reconciled. Lossless (FLAC, FLAC 24bit, ALAC, APE, WavPack, and the 24-bit ALAC name) is 8,530.8 GB, 97.3% of the API bytes, and 276,659 files, 90.8% of the files. FLAC plus FLAC 24bit is essentially all of that. The lossy remainder is about 236 GB. Medians were not computed: the walk stored a sum per artist and quality, not each file.

## 3. What the 92 days of upgrades cost

This pull's pairs are the tables below. Radarr matches the inventory exactly: 500 pairs, 17,952.3 GB downloaded, 13,720.7 GB deleted, 4,231.6 GB net, 369 movies. Sonarr's inventory was 22,746.3 GB downloaded and 3,288.9 GB net, from 8,448 paired deletes and 8,474 upgrade imports. This rule pairs 8,450 one-to-one: 22,703.8 GB downloaded, 19,463.3 GB deleted, 3,240.5 GB net. The gap is that rule plus a few events after the inventory walk. Lidarr's inventory included imports this rule does not pair. This pull is 810 pairs, 25.0 GB downloaded, 20.0 GB deleted, 5.0 GB net, plus 11.0 GB of unpaired upgrade deletes that are not subtracted.

Newest import in the pull: Radarr 2026-11-13T16:07:00Z, Sonarr 2026-11-13T18:43:10Z, Lidarr 2026-11-08T09:52:22Z.

### By class

| Class | Movies | Movie download | Movie net | Episodes | Episode download | Episode net |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Same quality name | 253 | 9,922.0 | 205.4 | 6,375 | 15,171.1 | -865.3 |
| To a remux, same resolution | 79 | 3,502.8 | 2,228.4 | 365 | 3,404.3 | 2,058.4 |
| Resolution up | 104 | 3,440.5 | 2,188.9 | 469 | 1,652.0 | 904.6 |
| Resolution up, leaving a remux | 45 | 794.4 | -484.2 | 1 | 5.2 | -3.2 |
| Higher rank, same resolution | 17 | 268.7 | 102.1 | 165 | 594.1 | 229.5 |
| WEBRip to WEBDL | 1 | 18.0 | 4.6 | 1,017 | 1,776.7 | 902.2 |
| Other same rank | 1 | 6.0 | -13.6 | 41 | 62.0 | 15.1 |
| Resolution down | 0 | 0 | 0 | 17 | 38.4 | -0.8 |
| All | 500 | 17,952.3 | 4,231.6 | 8,450 | 22,703.8 | 3,240.5 |

The rounded movie rows add to 17,952.4 downloaded and 4,231.6 net. The rounded episode rows add to the episode total. The integers in `2026-11-13-quality-upgrade-splits.csv` add exactly.

Music: 634 same-quality pairs, 18.1 GB downloaded, 0.4 GB net; 124 higher-rank pairs (lossy to lossless), 4.3 GB downloaded, 3.2 GB net; 52 same-rank pairs (FLAC to FLAC 24bit), 2.6 GB downloaded, 1.4 GB net.

The steps that dominate, from `2026-11-13-quality-upgrade-steps.csv`:

| From | To | Count | Downloaded | Net |
| --- | --- | ---: | ---: | ---: |
| Remux-2160p | Remux-2160p | 114 movies | 7,326.7 | 19.6 |
| WEBDL-2160p | Remux-2160p | 34 movies | 2,105.2 | 1,425.2 |
| Remux-1080p | Remux-2160p | 27 movies | 2,014.7 | 1,305.0 |
| WEBDL-1080p | WEBDL-2160p | 49 movies | 786.9 | 450.5 |
| Remux-1080p | WEBDL-2160p | 41 movies | 700.4 | -490.1 |
| WEBDL-2160p | WEBDL-2160p | 1,444 episodes | 7,351.7 | 58.7 |
| WEBDL-1080p | WEBDL-1080p | 4,853 episodes | 7,335.7 | -1,074.1 |
| Bluray-1080p | Bluray-1080p Remux | 299 episodes | 1,894.1 | 1,020.1 |
| WEBRip-1080p | WEBDL-1080p | 963 episodes | 1,451.3 | 919.5 |
| WEBDL-1080p | WEBDL-2160p | 241 episodes | 1,173.1 | 648.1 |

A 1080p remux replaced by a 2160p web file is the profile calling a higher rank an upgrade while the disk shrinks. That one movie step is -490.1 GB, and the whole "leaving a remux" class is -484.2 GB.

All 17 Sonarr resolution-down pairs are HDTV-2160p to a 1080p quality (10 to Bluray-1080p, 7 to WEBDL-1080p), net -0.8 GB. HDTV-2160p ranks below WEB 1080p on Sonarr, so the profile calls the 1080p file an upgrade. No Radarr upgrade in the window used HDTV-2160p.

### More than once

94 of 369 movies were upgraded more than once. 577 of 7,828 episodes were upgraded more than once. 281 of 330 series had more than one episode upgraded. All 43 music albums in the pair set had more than one track upgraded; 34 albums did it in one wave, 6 in two, 3 in three, a new wave being a gap of more than an hour.

### The twenty largest chains

A chain is one movie, one episode, or one album: the sum of its paired import sizes. The twenty largest in the whole pull are all movies. The largest episode chain is 93.3 GB, and the twentieth movie is 138.9 GB. Full list: `2026-11-13-quality-upgrade-chains.csv`. The pattern in the top of the movie list is one jump onto a 2160p remux and then one or more remux-for-remux swaps.

| Movie | Steps | Downloaded | Net | When |
| --- | ---: | ---: | ---: | --- |
| The Mandalorian and Grogu (2026) | 4 | 315.8 | 54.6 | 2026-08-19, all four |
| Disclosure Day (2026) | 3 | 234.9 | 52.1 | 2026-08-15 to 08-16 |
| Backrooms (2026) | 3 | 224.3 | 52.9 | 2026-08-21 to 08-26 |
| 28 Days Later (2002) | 3 | 198.1 | 34.0 | 2026-08-29 to 09-27 |
| Supergirl (2026) | 3 | 192.7 | 41.6 | 2026-09-01 to 09-04 |
| Moana (2026) | 6 | 187.0 | 38.1 | 2026-09-08 to 10-08 |
| Auntie Mame (1958) | 2 | 181.7 | 52.2 | 2026-08-29 to 09-03 |
| Gone with the Wind (1939) | 1 | 168.4 | 134.3 | 2026-11-03 |

Gone with the Wind is the largest single-step net in the pull: Bluray-1080p to Remux-2160p.

Episode chains are a different shape. Eighteen of the twenty largest are one series, Stranger Things, on 2026-09-05, each a single step from WEB 2160p to Bluray-2160p Remux. The largest episode is 93.3 GB downloaded and 69.8 GB net, against a library p90 of 29.64 GB for that quality. The sizes differ from episode to episode, so they are not one pack size stamped twenty times. The other two of those twenty are House of the Dragon on 2026-08-15, Bluray-2160p to Bluray-2160p Remux.

A series rollup is a different rule: every upgrade import of the series, added together. `2026-11-13-quality-upgrade-series.csv`.

| Series | Upgrade imports | Downloaded | Net |
| --- | ---: | ---: | ---: |
| Guy's Grocery Games | 454 | 1,174.4 | -175.1 |
| Stranger Things | 25 | 1,124.6 | 843.3 |
| Law & Order | 158 | 1,046.4 | 384.2 |
| South Park | 327 | 646.0 | 65.9 |
| Midsomer Murders | 96 | 644.6 | 39.3 |
| The Simpsons | 633 | 568.7 | -363.1 |
| Cheers | 124 | 557.2 | 389.2 |

Stranger Things' 25 imports and their bytes equal the entire Sonarr bucket "already at WEB 2160p, grabbed a higher quality." Guy's Grocery Games is the largest series by download, and the disk shrank.

The largest music chain is one album, 88 track replacements, all FLAC to FLAC, 2.6 GB downloaded, net about zero. Artist and album names are not in the table.

### No watch record

Using the inventory's definition and its caveat (a null is no record, and one watched episode marks the series):

| | Upgrades | Downloaded | Share of download | Net | Share of net |
| --- | ---: | ---: | ---: | ---: | ---: |
| Movies, no watch record | 359 | 12,648.4 | 70.5% | 2,859.2 | 67.6% |
| Movies, watch record | 141 | 5,303.9 | 29.5% | 1,372.5 | 32.4% |
| Episodes, no watch record | 5,091 | 16,181.4 | 71.3% | 2,895.3 | 89.3% |
| Episodes, watch record | 3,359 | 6,522.4 | 28.7% | 345.2 | 10.7% |
| Music | 810 | 25.0 | 100% | 5.0 | 100% |

The movie watch rows round to 4,231.7 against a total of 4,231.6. The episode rows add to 3,240.5. This is not a count of titles nobody has watched.

### Where the upgraded title was added, and what grabbed it

| Origin | Movies | Movie net | Episodes | Episode net |
| --- | ---: | ---: | ---: | ---: |
| pmm-added | 263 | 2,181.7 | 2,536 | 2,560.4 |
| kometa-added | 131 | 1,265.2 | 6 | 15.9 |
| Seerr | 26 | 174.6 | 3,685 | 878.7 |
| Unattributed | 74 | 544.3 | 1,951 | 39.5 |
| Conflict | 6 | 65.8 | 272 | -254.1 |

The rounded episode nets add to 3,240.4 against the integer total of 3,240.5. Counts add to 500 movies and 8,450 episodes.

Inferred source: movies, Rss 487 of 500 (17,663.8 GB downloaded, 4,220.0 GB net), Search 5, a person-invoked search 3, unmatched 5. Episodes, Rss 8,181 of 8,450 (22,122.2 GB downloaded, 3,077.9 GB net), unmatched 207, Search 28, a person-invoked search 31, interactive 1, ambiguous 2. Music's inferred source is weak (547 of 810 unmatched) and is not used below.

## 4. Why an upgrade happened

The score cutoff does not apply until the file is already at the cutoff quality. Until 2026-10-04T09:30:00Z the until-score was 10000, which a real file does not reach, and the minimum increment was 1. A +5 repack or a +75 streaming-service tag was enough to replace a file, including a remux that already scored 8450. After the scheduled apply, a same-quality upgrade has to gain 100, and a file on the top rung stops at 8450 (movies) or 500 (shows).

| | Before the scheduled apply | After |
| --- | --- | --- |
| Movie upgrades | 260, net 1,970.2 GB | 240, net 2,261.5 GB |
| Movie same-quality | 145, 6,558.0 GB down, net 130.5 | 108, 3,364.0 GB down, net 74.9 |
| Episode upgrades | 6,853, net 1,973.9 GB | 1,597, net 1,266.6 GB |
| Episode same-quality | 5,642, 14,041.8 GB down, net -523.6 | 733, 1,129.3 GB down, net -341.8 |

After the brake, episode same-quality upgrades with a score gain under 100: **0**. The +75 streaming-tag swaps stopped. Movie same-quality upgrades with a score gain under 100: **1**, and that one is the score that fell (sample row 6). The movie disk growth did not stop. The after-brake movie net is higher than the before-brake net, because the climb into remux continued.

Of the 108 after-brake same-quality movie upgrades, 33 are Remux-2160p to Remux-2160p (1,951.4 GB downloaded, net -31.5 GB) and 44 are WEBDL-2160p to WEBDL-2160p (883.9 GB downloaded, net 124.4 GB).

Nineteen movie upgrades replaced a Remux-2160p whose recorded score was already at or above 8450 and whose cutoff flag was already met. Eighteen of them are before the scheduled apply, when the until-score was still 10000, so a higher score was still allowed. The nineteenth is sample row 6.

### The sample

Twenty-one upgrades, including the repeats. The full fields (formats gained and lost, revision, repack flag, inferred source) are `2026-11-13-quality-upgrade-sample.csv`. GB here is rounded. Trigger rule: higher quality when the rank rose; cutoff already met or not yet met from the old rank; custom-format score when the quality name was unchanged and the score rose by 100 or more; proper or repack when the revision rose or the repack flag was set and the score rose by less than 100; otherwise the same-quality score change, including a score that fell or did not change. A penalty format of -10000 that left the file is named as well.

| # | Date | Title | From → to | Down GB | Net GB | Score | Trigger |
| --- | --- | --- | --- | ---: | ---: | --- | --- |
| 1 | 2026-08-19 | The Mandalorian and Grogu | WEBDL-2160p → Remux-2160p | 83.3 | 58.4 | 6320→4500 | higher quality; cutoff not met; score fell |
| 2 | 2026-08-19 | The Mandalorian and Grogu | Remux-2160p → Remux-2160p | 79.3 | -4.0 | 6500→6500 | cutoff met; no score change, no format change |
| 3 | 2026-08-19 | The Mandalorian and Grogu | Remux-2160p → Remux-2160p | 73.6 | -5.7 | 6500→8550 | cutoff met; HDR10+ Boost and Remux Tier 01 |
| 4 | 2026-08-19 | The Mandalorian and Grogu | Remux-2160p → Remux-2160p | 79.5 | 5.9 | 8550→8555 | cutoff met; repack, revision 1→2 |
| 5 | 2026-11-03 | Gone with the Wind | Bluray-1080p → Remux-2160p | 168.4 | 134.3 | 3555→4000 | higher quality; cutoff not met |
| 6 | 2026-10-23 | Mortal Kombat II | Remux-2160p → Remux-2160p | 69.9 | 0.3 | 8500→8450 | cutoff met; score fell; after the brake |
| 7 | 2026-11-10 | Four Rooms | Remux-1080p → Bluray-2160p | 38.2 | 17.3 | 4450→4000 | higher quality; left a remux; score fell |
| 8 | 2026-10-08 | Moana | Remux-2160p → Remux-2160p | 45.4 | 0.0 | 6600→8550 | cutoff met; Remux Tier 01; after the brake |
| 9 | 2026-11-03 | The Family Man | WEBDL-2160p → Remux-2160p | 82.3 | 57.9 | 6300→4000 | higher quality; score fell |
| 10 | 2026-11-05 | The Family Man | Remux-2160p → Remux-2160p | 82.7 | 0.4 | 4000→6050 | cutoff met; HDR10+ and Remux Tier 01 |
| 11 | 2026-09-05 | Stranger Things | WEBRip-2160p → Bluray-2160p Remux | 93.3 | 69.8 | 500→500 | higher quality; one episode of the series above |
| 12 | 2026-08-15 | House of the Dragon | Bluray-2160p → Bluray-2160p Remux | 39.3 | 28.5 | 500→500 | higher quality, same score |
| 13 | 2026-08-14 | Sex and the City | WEBDL-2160p → WEBDL-2160p | 5.1 | 0.0 | 2200→2275 | +75 streaming-service tag; before the brake |
| 14 | 2026-08-14 | The Kardashians | WEBDL-2160p → WEBDL-2160p | 4.5 | 0.0 | 2200→2275 | +75 streaming-service tag; before the brake |
| 15 | 2026-10-04 | Saturday Night Live | WEBDL-1080p → WEBDL-1080p | 3.5 | -0.9 | 75→1725 | web tier, after the brake, gain over 100 |
| 16 | 2026-10-04 | America's Got Talent | WEBDL-1080p → WEBDL-1080p | 5.2 | -0.2 | 0→1775 | web tier, after the brake |
| 17 | 2026-09-11 | Sister Wives | WEBDL-1080p → WEBDL-1080p | 1.2 | -2.0 | -10000→75 | language penalty left |
| 18 | 2026-08-22 | 60 Days In | WEBRip-1080p → WEBDL-1080p | 8.5 | 6.0 | -20000→0 | LQ and x265 (HD) left; same rank group |
| 19 | 2026-09-07 | one music album | FLAC → FLAC | 0.1 | 0.1 | 0→0 | cutoff met; no score change; 15 steps on the album |
| 20 | 2026-09-04 | one music album | MP3-320 → FLAC | 0.1 | 0.0 | 0→0 | higher quality; the lossless climb |
| 21 | 2026-09-27 | 28 Days Later | Remux-2160p → Remux-2160p | 63.6 | 0.0 | 8450→8550 | HDR10+ Boost; before the brake, until-score was 10000 |

Rows 13 and 14 gained one streaming-service format each (the names are in the CSV). Row 17 lost `Language: Not English or Original`. Row 18 lost `LQ` and `x265 (HD)`. Those two are the language and encode penalties doing what they were added to do. Inferred source on every video row in the sample is Rss.

Same-quality format gains across the whole pull, count of upgrades where the format was on the new file and not the old one, are `2026-11-13-quality-same-quality-formats.csv`. The large movie gains are Remux Tier 01, DV Boost, HDR10+ Boost, and repack terms. The large episode gains, mostly before the brake, are web tiers and streaming-service tags. The large episode losses include x265 (HD) and LQ.

### What lines up with the July upgrade-until-best ruling

A 1080p file becoming 2160p. A web or Blu-ray encode becoming a remux of the same resolution. A file losing a -10000 language, LQ, or x265 (HD) penalty. Those are the profile doing what it was set to do on 2026-07-03, and they are where the net bytes are.

### What a viewer can fail to see as an improvement

- A remux replaced by another remux for a tier, DV, or Atmos format. Row 3 downloaded 73.6 GB and the disk fell 5.7 GB. The 114 Remux-2160p to Remux-2160p movie upgrades downloaded 7,326.7 GB and left 19.6 GB.
- Row 2: a remux replaced by a remux with the same score, no format change, revision still 1, not a repack. The kept fields do not show a reason. The minimum increment, even the old value of 1, is not cleared by a score change of 0.
- Row 6, after the brake: a remux that already scored 8500, cutoff flag already met, replaced by one that scored 8450. The new rules say that file was finished. The kept fields do not show why it was replaced.
- A WEB 1080p file replaced by another WEB 1080p for a +75 tag (rows 13 and 14). That class stopped when the increment became 100. The after-brake rows (15 and 16) still re-download a 1080p web file for a web-tier score, and the disk does not grow.
- WEBRip replaced by WEBDL at the same resolution. Same rank group. Sonarr: 1,017 episodes, net +902.2 GB.
- A 1080p remux replaced by a 2160p web file. The profile calls it an upgrade. Forty-five movies, net -484.2 GB.
- HDTV-2160p replaced by 1080p, because Sonarr ranks the 1080p file higher. Seventeen episodes, net -0.8 GB.
- FLAC replaced by FLAC. 597 of the 810 music pairs are FLAC to FLAC, both scores 0, both revisions 1, neither flagged as a repack. That is the bulk of the 18.1 GB same-quality music download and the 0.4 GB net. `preferAndUpgrade` is on, and the proper flag was not set. The trigger is not in the fields that were kept.

## 5. Options

These are options. This story changes none of them. Existing files stay where they are unless a row says otherwise. "Confident" means the old file was already at or above the new cutoff, so the upgrade would not have been grabbed. "Per month" is the 92-day net times 30/92.

| Rank | Option | 92-day download avoided | 92-day net avoided | Per month | What a household member would notice | Take it? |
| --- | --- | ---: | ---: | ---: | --- | --- |
| 1 | WEB 2160p cutoff, and a file at or above it is finished | 20,455.8 GB | 2,843.6 GB | 927 GB | 4K web still arrives for a file below it. A 2160p remux does not. A file that is already 2160p web or a remux stays, and stops being replaced. A 1080p file can still become 2160p web, or a 1080p remux, because a 1080p remux ranks below WEB 2160p. | Yes |
| 2 | Stop same-quality upgrades as well | 25,093.1 GB | -659.9 GB | — | No second copy of a quality already on disk. The resolution climb continues. Shows would have kept 865.3 GB that these swaps removed. | Yes, with 1. Do not add the two rows. |
| 3 | Lidarr lists on Lossless, or Any's upgrades off; propers do not prefer | 25.0 GB | 5.0 GB | 1.6 GB | The first lossless file stays. New artists still get added. The lists already do not search. | Yes. It does not move the storage problem. |
| 4 | Remove HDTV-2160p from Radarr | 0 measured | 0 | 0 | Nothing in this window. It closes a rank that lets a broadcast 4K file replace a 1080p Blu-ray. | Yes |
| 5 | The same WEB 2160p finish, only on `kometa-added` and `pmm-added` | movies 9,086.4 of the confident part; shows 3,431.4 | movies 1,684.0; shows 864.4 | — | Requested titles still climb to a remux. The legacy tag is 7,004 of 9,630 movies. | Only if a remux is still wanted for requests. |
| 6 | An 80 GB cap on a movie upgrade | 3,096.0 GB is an upper bound | 1,171.9 GB upper bound | — | A release over 80 GB is skipped when a smaller one the profile accepts exists. When it does not, the title waits. All 35 of these imports are Remux-2160p. | A guard, not the lever. |
| 7 | WEB 1080p cutoff, and a file at or above it is finished | movies 17,748.1 plus shows 22,178.7 | 7,092.2 GB | 2,313 GB | Nothing gets sharper than the file it has. Existing 4K stays. This is 95% of the video upgrade net. | Only if 2160p itself is too expensive. |
| 8 | Cutoff at Bluray-2160p, remux still above it but the confident set is only files already there | movies 7,758.6; shows 181.1 | movies 254.9; shows 52.6 | — | Most remux jumps started from below Bluray-2160p. Those are the cross bucket (movies 2,994.7 GB net, shows 843.3 GB net) and are not in this saving. | No. It looks like "stop at the encode" and does not stop the jump onto the remux. |
| 9 | Upgrades off | 40,681.2 GB | 7,477.2 GB | 2,438 GB | No further automatic quality change. The 3 person-invoked movie upgrades and the 32 person-invoked episode upgrades in this window are inside this total. Whether the switch also blocks an interactive grab was not tested. | Only if the climb to 2160p is unaffordable. It reverses the July upgrade-until-best ruling. |

Option 1 in parts, so the two settings are not confused. Lowering the cutoff quality, and leaving the until-score at 8450, stops a grab of a quality above WEB 2160p. It does not by itself stop a remux replacing another remux, and it does not stop a WEB 2160p file replacing another WEB 2160p if 8450 is still the until-score. A web release may never reach 8450, because that number was chosen for a remux.

| Piece of the WEB 2160p "avoid" set | Movies | Movie net | Episodes | Episode net | Stopped by the cutoff alone? |
| --- | ---: | ---: | ---: | ---: | --- |
| Old file already above WEB 2160p (a remux or a 2160p Blu-ray, replacing itself) | 123 | 254.9 | 5 | 52.6 | Only if a file above the new cutoff is also finished |
| Old file at WEB 2160p, new file higher | 38 | 1,477.8 | 25 | 843.3 | Yes |
| Old file at WEB 2160p, new file the same group | 75 | 162.2 | 1,505 | 52.8 | Only if the until-score is also considered met |
| All three. Integer net 1,894.8 + 948.7 = 2,843.6. The movie parts round to 1,894.9 | 236 | 1,894.8 | 1,535 | 948.7 | The option as I would take it |

The 25 episodes are Stranger Things, 2026-09-05.

What still happens under option 1: movies, the `stays` set, 229 upgrades, net 786.2 GB; shows, 6,915 upgrades, net 2,291.8 GB. That is the climb up to WEB 2160p, including a 1080p file becoming a 1080p remux.

Thirty-five movies jumped from below WEB 2160p to a file above it (2,413.0 GB downloaded, net 1,550.6 GB). They would still upgrade, and they would stop at WEB 2160p. Estimated, not measured: give each the library's median WEBDL-2160p file, 16.88 GB, instead of the file it took. That is 590.8 GB instead of 2,413.0 GB, about 1.8 TB less download and about 1.8 TB less net. It assumes a 16.88 GB web file existed for each of the 35. Shows had no jumped-over rows at this cutoff, so the show saving of 948.7 GB is the whole of it.

Option 2 overlaps option 1. Same-quality upgrades of a file already at WEB 2160p or better are inside option 1's avoid set. Adding the two download columns double-counts those. Taken together, option 2 is what still re-downloads a file that has not reached the cutoff: the after-brake movie remainder is about 3.4 TB of downloads for 75 GB of disk, and the after-brake episode remainder is 1.1 TB of downloads that made the disk 342 GB smaller.

Option 5, the split profile, is smaller than it sounds if the legacy tag is left out. `kometa-added` alone, movies, WEB 2160p avoid: 78 movies, 3,198.1 GB downloaded, 796.7 GB net. Adding `pmm-added` is what produces the 1,684.0 GB. Seerr-attributed movie upgrades are 174.6 GB net for the whole window.

Option 6's 80 GB line is an upper bound. A cap rejects one release. Another release under the cap can still be grabbed, and then the saving is smaller. A 30 GB cap on an episode remux is the same kind of bound: 29 imports, 1,275.8 GB downloaded, 873.5 GB net, almost all of them the Stranger Things episodes, which sit above the 29.64 GB p90. A 60 GB movie line is 114 imports, 8,536.0 GB downloaded, 2,391.0 GB net, also an upper bound. There is no maximum on these qualities today.

### The order I would take

1. WEB 2160p, and a file of that quality or better is finished. It is the storage option whose show half is fully measured and whose movie half has a confident 1,894.8 GB, with a further estimated 1.8 TB on the 35 jumps. It keeps the 1080p to 2160p web climb, which is the July ruling's picture getting sharper, and it stops the remux rung, which is where the movie disk grew.
2. Stop same-quality upgrades below that cutoff too. The October brake already did this for gains under 100. What remains is a score jump of 100 or more, and it is a download problem. The disk effect of stopping all same-quality swaps would have been small on movies and backwards on shows.
3. Point Lidarr's 25 lists at Lossless, or turn upgrades off on Any, and set propers to `doNotPrefer` like the video apps. Put the profile in git first (Q-05). 97.3% of music bytes are already lossless. The FLAC-to-FLAC replacements are not a visible improvement.
4. Remove HDTV-2160p from the Radarr allowed list. It did not fire. It should not be able to.

I would not turn upgrades off, and I would not use a Bluray-2160p cutoff as if it stopped the remux jump. I would use a size cap only as a guard on top of the cutoff. I would split automatic titles onto a lower profile only if a requested movie should still climb to a remux, and only with `pmm-added` included. Without that legacy tag the split saves the 796.7 GB, not the 1,684.0 GB.

## 6. Questions

**Q-01.** Is a 2160p web file the place to stop, with a file of that quality or better left alone?
Recommendation: yes. Confident 92-day net avoided: 2,843.6 GB (movies 1,894.8, shows 948.7), about 927 GB a month if the window repeated. The show figure is complete. The movie figure leaves out 35 jumps whose shorter landing was not measured; the estimate for those is about 1.8 TB more.

**Q-02.** A 1080p remux ranks below WEB 2160p, so option 1 still replaces it with a 2160p web file, or lets a 1080p web file become a 1080p remux. Forty-five movies went from a 1080p remux to a 2160p web file and the disk fell 484.2 GB. Should a 1080p remux count as finished?
Recommendation: leave the rank. Take option 1 as written. Change the rank only if a 1080p remux should win over a 2160p web file.

**Q-03.** Should a same-quality replacement continue once a file of that quality exists?
Recommendation: no. It is most of the download. On shows it made the disk smaller. The October brake already stopped gains under 100.

**Q-04.** `pmm-added` is on 7,004 of 9,630 movies and 103.83 TB. If requested titles should keep the remux ladder and tagged titles should stop, is that legacy tag in the tagged set?
Recommendation: yes, treat it with `kometa-added`. The current tag alone avoids 796.7 GB of the confident movie net. The two tags together avoid 1,684.0 GB. If every title should stop at WEB 2160p, skip the split and do Q-01 once.

**Q-05.** Lidarr's profiles, propers, delay, and 25 lists live only in the app. Should they move into git before anyone changes them?
Recommendation: yes, in a later change, not this one. Then point the lists at Lossless and set propers to `doNotPrefer`.

**Q-06.** Two remux replacements are not explained by the rules in force at the time. On 2026-08-19 a Remux-2160p file was replaced by another with the same score and no format change (sample row 2). On 2026-10-23, after the brake, a Remux-2160p file that already scored 8500 was replaced by one that scored 8450 (sample row 6). The movie list does not return the current custom-format score, so this audit cannot say how many remuxes on disk are still under 8450.
Recommendation: do not investigate these two before deciding Q-01. A file at or above WEB 2160p being finished would have stopped both.

**Q-07.** Lidarr replaced 597 FLAC files with FLAC at score 0, revision 1, repack flag off. `preferAndUpgrade` is on. The kept fields do not show the trigger.
Recommendation: set propers to `doNotPrefer` and stop upgrades on the profile the lists use. Do not guess the trigger.

**Q-08.** Keep the inventory's "no watch record" wording?
Recommendation: yes. 70.5% of movie upgrade downloads and 71.3% of episode upgrade downloads are on titles with no watch record. That is not "never watched", and it is a poor sole reason to stop an upgrade.

## What this did not measure

- Grafana and Loki were not available in this session. No metric was required for these byte totals. The series that would describe free space are the ones the intake inventory already names.
- Download ids were not stored, so release source is inferred and labeled. A season pack can put one download's size on several episode imports. The top remux episodes have different sizes. This report does not subtract a pack-size double count.
- The Radarr movie list does not include the custom-format score. The history is the evidence that remux-to-remux churn continued after 4 October.
- The 32-movie gap and the 1.73 TB gap between the API and the replica. The 6.3 GB gap between Lidarr's track-file sum and the replica. The Sonarr file-count gap, with matching bytes.
- The replacement size for a jump that would have stopped at a lower cutoff, except the one labeled estimate on the 35 movies.
- Kometa's live `config.yml`. The seed's `upgrade_existing: false` is cited from the intake inventory and the trash-readd audit. The live file was not opened; it holds credentials.
- Whether `upgradeAllowed: false` also blocks an interactive grab.
- Any per-account play, any indexer name, any list credential.

## Story and this work order

The story's constraints talk about an ADR or a design amendment when behavior changes. This audit changes no behavior, so no ADR and no design is amended. The intake inventory took the same reading. Import lists, monitor flags, and search flags are in this report because the story's scope includes them; the numbered work order led with profiles and upgrade bytes. Where the two differed, the story was followed.

Out of scope, and not done: any change to a profile, a format, a list, or a setting, in an app or in git.
