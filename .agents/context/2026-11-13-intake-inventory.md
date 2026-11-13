# Intake inventory, 2026-08-14 through 2026-11-13

Read-only audit for story 824. This file states the attribution rules before the counts. The counts below were filled only after those rules were frozen. Nothing here changes a list, a collection, a profile, or a setting.

- **Window:** `2026-08-14T00:00:00Z` inclusive through `2026-11-14T00:00:00Z` exclusive. That is the span of the free-space series supplied with the story (first sample 2026-08-14, report date 2026-11-13). It is 92 days. The story text says "90 days"; the series it says to set the intake against starts on 2026-08-14, so the window follows the series.
- **Measured at:** 2026-11-13, queries in the sections below. Replica `postgres16-11` (`cnpg.io/instanceRole=replica`), database `haynesnetwork`. *arr reads are `GET` only, API key expanded inside the pod.
- **haynes-ops revision read:** `3ad4b39f9bf1edbba54183fbe0c20d5401277a15` (2026-11-13 16:34:49Z).
- **Grafana / Loki:** not available in this session (no Grafana MCP tools). Kometa run logs were not read. The query that would close the Kometa-log gap is named under Coverage.

Story 824's constraints mention an ADR/DESIGN amendment in the same change. This change records an audit and changes no behavior, so no ADR or design is amended. Acceptance asks for this report under `.agents/context/`.

Out of scope, and not in this file: any recommendation to change a list, a collection, or a profile.

## Method

One add has one source. One grab has one source. One import has one source. Bytes that match none of the rules stay in **unattributed**. They are not spread across the other sources. A row that matches two rules that the order below calls a conflict stays in **conflict**, also not spread.

### Evidence used

| Evidence | What it is | What it cannot tell you |
| --- | --- | --- |
| `media_items.arr_tags`, parsed the way `parseArrTags` does (DESIGN-008 D-07) | Current tag labels. A tag matching `^[0-9]+-` is a requester tag; the report keeps only the numeric prefix. `kometa-added` and `pmm-added` are the Kometa/PMM umbrella. `mediarequests` is the Seerr add tag (ADR-093). Other labels are collection or list tags, except `dnd` and any label containing `release-block`, which are ignored as sources. | Tags are the labels on the item at sync time, not a history of who added it. A later tag edit changes the attribution. Kometa's git seed says `radarr_tag` is applied when Kometa adds, not onto items already in the library. |
| `media_metadata.arr_added_at` | The *arr `added` timestamp, synced by the metadata harvest. An **add** is an item whose `arr_added_at` falls in the window, including one later tombstoned. | Not the grab time. An item added years ago can still be grabbed in the window. |
| `media_items.size_on_disk` | Current synced size of the item, retained on a tombstone (419 of 421 Radarr tombstones in the window still have a non-zero size; measured 2026-11-13, replica query in Results). | Not the size of one grab, and not proof of what was deleted from disk. Used only as the add's current size. |
| `ledger_events` where `source='seerr'` and `event_type='requested'` | A Seerr request the app stored. Payload keys present in the window: `mediaType`, `requestedBy`, `seerrMediaStatus`, `seerrRequestStatus`, `tmdbId`, `tvdbId`. | No field distinguishes a person's explicit request from Seerr watchlist sync. Emails and display names are not read. |
| *arr history, paged `GET /history?page=&pageSize=1000&sortKey=date&sortDirection=descending` | Grabs, imports, and file deletes. Kept fields: id, date, eventType, movie/series/episode/artist/album id, quality name, `data.size`, `data.releaseSource`, a short alphabetic `data.reason`, `downloadId`. | The ledger copy of history does **not** store size, release source, or delete reason (payload keys measured 2026-11-13). Indexer names, release titles, paths, and download URLs are not taken; a download URL can carry a key. |
| Kometa git config | Which collections set `radarr_add_missing` / `sonarr_add_missing` and which tag they write. Defaults (`seasonal`, `universe`, `oscars`, `golden`) are in the config.yml **seed** in `externalsecret.yaml`. | The live `/config/config.yml` on the PVC was not read. It holds credentials, and Kometa rewrites it, so it can drift from the seed. |
| `media_metadata.play_count` / `last_viewed_at` | A play that the metadata harvest found in Tautulli. | The harvest only indexes titles that appear in the newest history pages (20 pages × 500 rows per Tautulli instance). `play_count` is null when nothing matched. It is never 0 in this database (measured: 0 rows with `play_count = 0`). Null is **no watch record**, not "never watched". Music has no Tautulli rows (0 of 7735 live artists). A show is one row: one watched episode marks the series. |

Import-list objects were limited to `name` and the enable flag. Radarr and Sonarr have no `enabled` field because `GET /importlist` returned `[]`. Lidarr's object has no `enabled` key; the boolean that turns adding on is `enableAutomaticAdd`, and only that boolean was read besides `name`.

### Add source, first match

Applied to the item, using its current tags and any Seerr `requested` event stored for that item (any date, not only the window).

1. **Conflict.** Umbrella tag (`kometa-added` or `pmm-added`) and Seerr evidence (`mediarequests`, a requester tag, or a stored Seerr request).
2. **Kometa.** Umbrella tag, and not a conflict. The collection is the other tag, ignoring `dnd` and `release-block` labels. One such tag names the collection. None: `no collection tag`. More than one: `multiple collection tags` (the bytes stay on that one row). `pmm-added` without `kometa-added` is the same source, labeled legacy.
3. **Seerr.** `mediarequests`, a requester tag, or a stored Seerr request, and not a conflict. Explicit requests and watchlist sync stay in this one source.
4. **Import list.** A `spotifyartists`, `spotifyalbums`, or `spotifyplaylist` tag. The list column is that tag. It is not one of the 25 Lidarr list names; the list's own tag id was not read.
5. **Unattributed.** Anything else. No add is called manual. There is no stored "added by a person" flag, and an empty tag list is not that flag. `seriesFolderImported` and `movieFolderImported` history totals are 0 (event type 2 on Sonarr and Lidarr, probed 2026-11-13), so a folder import is not available as manual evidence either.

### Grab and import source

History event types were probed on 2026-11-13 (`pageSize=1`, integer `eventType`). The integer is the one the API filters on; it is not the same index on every app.

| App | Grabbed | Imported | File deleted |
| --- | --- | --- | --- |
| Radarr | 1 `grabbed` | 3 `downloadFolderImported` | 6 `movieFileDeleted` |
| Sonarr | 1 `grabbed` | 3 `downloadFolderImported` | 5 `episodeFileDeleted` |
| Lidarr | 1 `grabbed` | 3 `trackFileImported` | 5 `trackFileDeleted` |

A file delete whose `data.reason` is exactly `Upgrade` is paired with an import of the same target within 120 seconds: Radarr target `movieId`, Sonarr target `episodeId`, Lidarr target `albumId`. Pairing is one-to-one, closest time first. The paired import, and the grab with the same `downloadId`, are source **upgrade**. An upgrade delete with no import in that window is reported as an unpaired upgrade delete and is not subtracted from another source.

Otherwise:

- `releaseSource` `User`, `InteractiveSearch`, or `UserInvokedSearch`: source **manual** (the *arr's own marker that a person sent the grab or the search). The import that shares its `downloadId` follows it. `UserInvokedSearch` was not in the first draft of this rule; it is in the Radarr and Sonarr walks, and it is the same marker, not a guess. `Search` and `Rss` stay with the item's add source.
- Else the source is the parent item's add source (the series, movie, or artist), including items added before the window.
- A history id with no ledger row is **unattributed**.

`Rss` and `Search` do not change the source. They are counted beside it. `Search` is what Seerr, Kometa, and the janitor all use to grab; it is not treated as manual.

### Bytes, watch, and the free-space series

- **Add bytes** are `size_on_disk` now. They are not the historical download size.
- **Grab bytes** are history `data.size` on `grabbed` (the announced release size). A grab that fails does not land.
- **Landed bytes** are history `data.size` on the import event (the file that was written). This is the intake compared with free space.
- **Upgrade net** is paired import size minus paired delete size, on the upgrade row only.
- **Other file-delete bytes** (reason other than `Upgrade`, or reason missing) are their own rows. They are removals, not intake, and they are not assigned to Kometa or Seerr.
- A week is Monday 00:00 UTC through the next Monday, clipped to the window. Weeks of 2026-08-10 and 2026-11-09 are partial.
- Free space is the coordinator's series (measured by the coordinator 2026-11-13T16:36Z, GB = 1e9 bytes). This session did not query Prometheus. A week's free-space change is the last sample inside the week minus the last sample before the week. HaynesTower is movies and shows (`/data/haynestower/Media/Movies`). The music array is Lidarr (`/data/media/music`).
- **Watched** means `play_count > 0` or `last_viewed_at` is set on the parent item. **No watch record** is everything else. The share never watched is not computed. The top-20 table is the top 20 sources by landed bytes on titles with no watch record.

### Kometa acquisition flags in git

Read from the seed and the collection files at the revision above. "Inherits on" means the block does not set `add_missing` and the seed's global `radarr.add_missing` / `sonarr.add_missing` is `true`. Tag labels are stored lowercased by Radarr and Sonarr; the map below is lowercase.

| Tag | Collection | add_missing in git |
| --- | --- | --- |
| `seasonalcollection` | Default `seasonal` | true (seed) |
| `universecollection` | Default `universe` | true (seed) |
| `oscarscollection` | Default `oscars` and `movies-awards.yml` share this tag | true |
| `goldenglobecollection` | Default `golden` and `movies-awards.yml` share this tag | true |
| `imdbpopular` | IMDB Popular | inherits on |
| `imdbtop250` | IMDB Top 250 | inherits on |
| `popularnow` | Popular Now | inherits on |
| `toprated` | Top Rated | inherits on |
| `topgrossing` | Top Grossing | inherits on |
| `moviecollection` | `movies-franchises.yml` | inherits on |
| `showcollection` | `shows-franchises.yml` | inherits on |
| `christmashnet` | Christmas HNet | false |
| `a24`, `disneyanimation`, `dreamworkspictures`, `roalddahl`, `jhorror` | `movies-lists.yml` | false |
| `directorcollection`, `actorcollection` | `movies-people.yml` | false |
| `franchisecollection` | Default `franchise` | false (seed) |
| `spatialsurround`, `atmos`, `dtsx` | audio collections | false (they group existing files) |

`music.yml` is not an active Plex library in the seed (the music library block is commented). No Lidarr add in the window carries a Kometa tag.

Live import lists, 2026-11-13: Radarr `[]`, Sonarr `[]`, Lidarr 25 lists and every one's `enableAutomaticAdd` is true (Apple Music, Billboard, Last.fm, Spotify). Names are in `2026-11-13-intake-lidarr-lists.csv`. They are lists, not indexers.

## Results

Collected after the method above. History walks and the replica export are the measurements. Per-event rows were not committed: a history record's download URL can carry a key, and the committed tables are the aggregates.

GB below is bytes / 1e9, the same unit as the free-space series, rounded to 0.1. Exact integers are in the CSVs.

### What was collected

Replica `postgres16-11`, 2026-11-13, before the history walks: item tags, `arr_added_at`, `size_on_disk`, watch columns, and whether a Seerr `requested` event exists for the item. 19,026 item rows (Radarr 10,192, Sonarr 1,097, Lidarr 7,737), including tombstones.

History walks, `GET /history`, `pageSize=1000`, newest first, stopped when the oldest record on the page was before 2026-08-14. None hit the page cap.

| App | When (UTC) | Pages | Grabs | Imports | File deletes |
| --- | --- | --- | --- | --- | --- |
| Radarr | 16:58:54–16:58:56 | 3 | 861 | 767 | 500 |
| Sonarr | 16:59:17–16:59:45 | 40 | 14,725 | 13,200 | 8,683 |
| Lidarr | 17:01:49–17:05:37 | 278 | 1,684 | 272,976 | 1,270 |

The ledger, queried earlier the same day, has more grabs in the same window: Radarr 885, Sonarr 14,814, Lidarr 1,694. The walks are the byte source, because the ledger payload has no size. The differences (24, 89, 10) stay unattributed; they were not spread across sources.

### Adds

An add is an item whose `arr_added_at` is inside the window. 947 items. Every one of them is still in its *arr (none of these rows are tombstoned). Bytes are current `size_on_disk`.

| Arr | Source | Collection or list | Titles | Size (GB) | Titles with a watch record | Share of bytes with no watch record |
| --- | --- | --- | --- | --- | --- | --- |
| Radarr | Kometa | seasonal | 332 | 1229.5 | 13 | 74.8% |
| Radarr | Kometa | IMDB Popular | 108 | 1137.6 | 23 | 56.7% |
| Radarr | Kometa | IMDB Top 250 | 12 | 158.4 | 0 | 100% |
| Radarr | Kometa | Popular Now | 4 | 137.2 | 1 | 82.3% |
| Radarr | Kometa | universe | 17 | 50.1 | 1 | 59.7% |
| Radarr | Kometa | Top Rated | 1 | 21.2 | 0 | 100% |
| Radarr | Seerr | seerr request | 99 | 1016.7 | 19 | 75.9% |
| Sonarr | Seerr | seerr request | 45 | 4451.7 | 18 | 61.7% |
| Sonarr | Kometa | shows-franchises | 3 | 0.0 | 0 | |
| Lidarr | import list | tag `spotifyartists` | 3 | 0.0 | 0 | |
| Lidarr | unattributed | no source tag | 323 | 27.6 | 0 | 100% |

Radarr's 573 adds are all Kometa (474) or Seerr (99). Zero conflict, zero unattributed. Every Kometa movie add carries one collection tag, and every one of those collections has `add_missing` true in git (or inherits the global true). The collections whose git flag is false (Christmas, studio lists, people, the franchise default) are absent from this add set. `GET /importlist` on Radarr and on Sonarr returned an empty list.

Seasonal is 332 of the 474 Kometa movie adds and 1229.5 of their 2733.9 GB.

Sonarr's 48 adds are 45 Seerr shows (4451.7 GB on disk now) and 3 Kometa franchise shows with nothing on disk yet.

Lidarr's 326 adds have no Kometa tag and no Seerr request. Three carry `spotifyartists`. The other 323 have no source tag. Their current size is 27.6 GB. The large music intake is not these new artists; it is imports onto artists already in the library, in the landed table.

Requester-tag ids for the adds are in `2026-11-13-intake-requester-tags.csv` (numeric prefix only). One id accounts for 50 of the 99 Radarr Seerr adds. Explicit requests and watchlist sync are still one source (Q-02).

### Landed files, and upgrades

Landed bytes are the sum of import `data.size`, one event at a time. Radarr imports are one download each (767 downloads, 22.13 TB). Sonarr has 475 downloads whose episodes repeat one identical size; summing those events counts 1.16 TB where counting the download once is 0.56 TB. That is the only Sonarr import double-count found. Imports whose files in one download have different sizes (201 downloads, 8.84 TB) are summed, because each file has its own size. Lidarr track imports mostly have no `downloadId` (261,700 of 272,976); their sizes differ per track (about 26 MB on average) and are summed.

| Arr | Source | Import events | Parents | Landed (GB) | No watch record (GB) | Upgrade deletes paired (GB) | Net (GB) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Radarr | upgrade | 500 | 369 | 17952.3 | 12653.3 | 13720.7 | 4231.6 |
| Radarr | Kometa | 187 | 187 | 2777.4 | 1872.8 | 0 | 2777.4 |
| Radarr | Seerr | 53 | 53 | 994.7 | 771.3 | 0 | 994.7 |
| Radarr | manual | 23 | 23 | 357.6 | 208.7 | 0 | 357.6 |
| Radarr | conflict | 1 | 1 | 20.3 | 20.3 | 0 | 20.3 |
| Radarr | unattributed | 2 | 2 | 14.2 | 9.9 | 0 | 14.2 |
| Radarr | Kometa legacy `pmm-added` | 1 | 1 | 13.8 | 13.8 | 0 | 13.8 |
| Sonarr | upgrade | 8,474 | 330 | 22746.3 | 16217.3 | 19457.4 | 3288.9 |
| Sonarr | Seerr | 2,915 | 116 | 7329.1 | 4650.0 | 0 | 7329.1 |
| Sonarr | Kometa legacy `pmm-added` | 752 | 54 | 1671.2 | 1410.0 | 0 | 1671.2 |
| Sonarr | manual | 436 | 31 | 1018.3 | 817.6 | 0 | 1018.3 |
| Sonarr | unattributed | 572 | 28 | 705.4 | 570.5 | 0 | 705.4 |
| Sonarr | conflict | 44 | 3 | 126.2 | 126.2 | 0 | 126.2 |
| Sonarr | Kometa | 7 | 1 | 17.5 | 0.0 | 0 | 17.5 |
| Lidarr | unattributed | 250,986 | 2,510 | 6571.8 | 6571.8 | 0 | 6571.8 |
| Lidarr | import list (`spotify*`) | 18,963 | 450 | 436.1 | 436.1 | 0 | 436.1 |
| Lidarr | manual | 2,192 | 135 | 75.2 | 75.2 | 0 | 75.2 |
| Lidarr | upgrade | 835 | 42 | 25.9 | 25.9 | 19.9 | 6.0 |

Kometa movie imports in the window, by quality (`2026-11-13-intake-landed-quality.csv`): WEBDL-2160p 50 files, 746.8 GB; Remux-1080p 31 files, 729.3 GB; Remux-2160p 12 files, 671.2 GB; WEBDL-1080p 78 files, 484.7 GB; Bluray-1080p 13 files, 133.7 GB; WEBRip-1080p 3 files, 11.7 GB.

Nine Radarr imports (62.6 GB) still carry the In Theaters tag. That collection was removed from the git files on 2026-07-10. The tag is still on the movie, so the rule places the import on Kometa. These movies were added before the window.

Sonarr's current `kometa-added` tag accounts for 17.5 GB. The 1671.2 GB on `pmm-added` is the older umbrella, mostly with no collection tag (1370.7 GB, 44 series).

File deletes other than a paired upgrade: Sonarr `Manual` 154 events, 196.6 GB; Sonarr `MissingFromDisk` 81 events, 78.9 GB; Lidarr `Upgrade` with no import inside 120 seconds, 460 events, 11.0 GB. Radarr's 500 file deletes are all `Upgrade` and all paired. A Radarr movie removed from the library in this window did not leave a non-upgrade file-delete size in history.

Tombstones in the window (replica, last synced `size_on_disk` still on the row): Radarr 421 movies, 10783.0 GB (419 of them non-zero); Sonarr 4 series, 361.2 GB; Lidarr 1 artist, 0.1 GB. From 2026-11-06 through 2026-11-14, Radarr tombstones are 45 movies, 3246.7 GB. These are item removals. They are not added to the upgrade net.

### Grabs

Grab counts are the events above. `releaseSource` on those events:

| App | Rss | Search | UserInvokedSearch | InteractiveSearch |
| --- | --- | --- | --- | --- |
| Radarr | 595 | 224 | 38 | 4 |
| Sonarr | 11,628 | 2,242 | 760 | 95 |
| Lidarr | 749 | 533 | 402 | 0 |

`Rss` and `Search` kept the item's add source. `UserInvokedSearch` and `InteractiveSearch` are the manual rows.

Announced `data.size` on a grab is the release size. Radarr: 861 grabs, 861 download ids, 26.61 TB, no repeated size. Lidarr: 1,684 grabs, 1.0 TB. Sonarr: 14,725 grab events and 11,381 download ids. 713 downloads repeat one size across 4,057 events. Summing every event counts 186.87 TB; counting each of those downloads once, and counting single grabs as they are, is 41.78 TB. The CSV column `announced_bytes_per_event` is the per-event sum. The 41.78 TB figure is the one that matches "one release, one size."

### Week by week, against free space

A week's free-space change is the last sample inside the week minus the last sample before it. Those deltas chain: they sum to the Aug 14 sample minus the Nov 12 sample (HaynesTower 9030.1 GB less free; music array 11033.0 GB less free). The week of Aug 10 has intake and no delta of its own; the Aug 14 sample is the baseline of the next week. Net in the intake columns is landed import bytes minus paired upgrade-delete bytes, in GB.

| Week (Monday) | HaynesTower delta | Radarr Kometa net | Radarr Seerr net | Sonarr Seerr net | Upgrade net, all three | Music delta | Lidarr unattributed landed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-10 | | 0.0 | 0.0 | 664.4 | 333.7 | | 204.3 |
| 2026-08-17 | -2074.9 | 103.9 | 28.0 | 240.0 | 777.1 | -427.8 | 449.6 |
| 2026-08-24 | -2580.9 | 99.1 | 27.0 | 765.5 | 518.6 | -452.5 | 446.4 |
| 2026-08-31 | -1551.5 | 186.8 | 76.1 | 905.0 | 1564.8 | -317.0 | 442.0 |
| 2026-09-07 | -1521.3 | 148.0 | 87.0 | 206.5 | -110.0 | -139.4 | 363.5 |
| 2026-09-14 | -459.3 | 179.2 | 21.2 | 881.8 | 343.1 | -147.2 | 522.5 |
| 2026-09-21 | -1013.0 | 206.7 | 39.1 | 842.7 | 480.1 | -60.5 | 483.1 |
| 2026-09-28 | -2503.3 | 717.5 | 185.0 | 785.4 | 120.8 | 782.2 | 316.1 |
| 2026-10-05 | -1038.6 | 92.1 | 6.6 | 347.2 | 44.3 | -404.5 | 670.4 |
| 2026-10-12 | -486.3 | 105.5 | 303.5 | 204.0 | 596.3 | -244.4 | 516.8 |
| 2026-10-19 | -3009.3 | 92.3 | 45.2 | 389.4 | 1003.5 | -566.0 | 512.8 |
| 2026-10-26 | -865.8 | 554.7 | 35.7 | 142.0 | 433.6 | -5639.7 | 607.9 |
| 2026-11-02 | -1789.7 | 216.2 | 56.2 | 595.3 | 721.6 | -5027.2 | 635.2 |
| 2026-11-09 | 9863.8 | 75.4 | 84.2 | 360.0 | 698.9 | 1611.0 | 401.4 |

Full source split: `2026-11-13-intake-weekly.csv`. Free-space samples: `2026-11-13-intake-weekly-freespace.csv`.

Over the whole window, import bytes minus all file-delete bytes are Radarr +8.41 TB, Sonarr +13.88 TB, Lidarr +7.08 TB. HaynesTower (movies and shows) history net is about 22.3 TB written. Free space there fell 9.03 TB from the Aug 14 sample to the Nov 12 sample. The two measurements are both reported. They are not forced to match.

From 2026-11-06T00:00Z through 2026-11-14T00:00Z, history is still a net write: Radarr +0.50 TB, Sonarr +1.65 TB, Lidarr +0.73 TB. The HaynesTower sample rose 9863.8 GB between Nov 6 and Nov 12. Movie tombstones in that same week are 3246.7 GB of last synced size. The rise is larger than those tombstones, and the file history in that week does not record a matching removal (Q-04).

### Top 20 by landed bytes with no watch record

This is the closest measured stand-in for "bytes never watched." It is not a never-watched ranking. `play_count` is null for 9,217 of 9,630 live movies and 893 of 1,085 live shows, and there are 0 rows in the database with `play_count = 0`. The harvest records a title only when a play falls in the newest Tautulli history pages. Music has no watch rows at all, so every Lidarr byte is in this table.

| Rank | Arr | Source | Collection or list | Parents | Landed GB | Share of the no-record bytes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Sonarr | upgrade | upgrade | 237 | 16217.3 | 34.9% |
| 2 | Radarr | upgrade | upgrade | 293 | 12653.3 | 27.2% |
| 3 | Lidarr | unattributed | no source tag | 2,510 | 6571.8 | 14.1% |
| 4 | Sonarr | Seerr | seerr request | 65 | 4650.0 | 10.0% |
| 5 | Sonarr | Kometa legacy | no collection tag | 31 | 1129.8 | 2.4% |
| 6 | Radarr | Kometa | seasonal | 62 | 864.0 | 1.9% |
| 7 | Sonarr | manual | manual grab | 16 | 817.6 | 1.8% |
| 8 | Radarr | Seerr | seerr request | 33 | 771.3 | 1.7% |
| 9 | Radarr | Kometa | IMDB Popular | 47 | 626.5 | 1.3% |
| 10 | Sonarr | unattributed | no source tag | 18 | 570.5 | 1.2% |
| 11 | Lidarr | import list | spotifyplaylist | 448 | 434.7 | 0.9% |
| 12 | Radarr | manual | manual grab | 16 | 208.7 | 0.4% |
| 13 | Sonarr | Kometa legacy | Emmy collection | 5 | 185.1 | 0.4% |
| 14 | Radarr | Kometa | IMDB Top 250 | 11 | 158.4 | 0.3% |
| 15 | Sonarr | conflict | kometa and seerr | 3 | 126.2 | 0.3% |
| 16 | Radarr | Kometa | Popular Now | 3 | 112.9 | 0.2% |
| 17 | Sonarr | Kometa legacy | Trakt trending | 4 | 95.1 | 0.2% |
| 18 | Lidarr | manual | manual grab | 135 | 75.2 | 0.2% |
| 19 | Radarr | Kometa | In Theaters | 8 | 53.9 | 0.1% |
| 20 | Radarr | Kometa | universe | 2 | 35.9 | 0.1% |

Among movie adds, the no-record bytes are led by seasonal (919.3 GB), Seerr (771.3 GB), and IMDB Popular (645.2 GB). That split is in the adds CSV, and it is the same watch limitation.

### Coverage

Unattributed landed bytes, stated on their own:

| Arr | Unattributed landed GB | Share of that arr's landed GB |
| --- | --- | --- |
| Radarr | 14.2 | 0.06% of 22,130 |
| Sonarr | 705.4 | 2.1% of 33,614 |
| Lidarr | 6571.8 | 92.4% of 7,109 |

Conflict, also not spread: Radarr 20.3 GB (1 movie), Sonarr 126.2 GB (3 series, 44 imports).

The ledger-versus-walk grab gaps (24, 89, 10) are a further unattributed count, with no bytes, because those events were not in the walk.

What would close each gap:

- **Never watched.** A full-library play count that includes zeros, joined on TMDB, TVDB, or MusicBrainz. The harvest in `packages/sync/src/metadata-refresh.ts` cannot produce a zero. Music has no Tautulli contribution on any of the 7,735 live artists.
- **Seerr watchlist versus a person's request.** A field on the Seerr request that the ledger does not store. Payload keys in the window are only `mediaType`, `requestedBy`, `seerrMediaStatus`, `seerrRequestStatus`, `tmdbId`, `tvdbId`.
- **Which Lidarr list.** The artist's tag, or a history field naming the list. `enableAutomaticAdd` is true on all 25 lists (`2026-11-13-intake-lidarr-lists.csv`). The list's tag id was not read. 2,510 artists with 6571.8 GB of imports have no source tag.
- **Kometa's own log of the add.** Not read. Grafana and Loki tools are not in this session, and no other log route was used. The lines that would close a tag conflict are Kometa's record of adding a movie or series (collection, external id, time) for HelmRelease `kometa` over this window. The live `config.yml` on the PVC was not read either; it holds credentials and can drift from the git seed.
- **The 11-hour break in Sonarr history on 2026-10-30.** Kept events are present in hours 10–12 UTC and again at hour 23, and absent from hours 13–22. Pages do not overlap. This was not walked a second time. It may be a quiet stretch. It may be the missing grabs the ledger still has.
- **Upgrade imports without a paired delete.** The pairing rule is one-to-one, yet the upgrade rows hold more imports than paired deletes: Sonarr 8,474 imports against 8,448 paired deletes (26 more), Lidarr 835 against 810 (25 more). Radarr's 500 and 500 agree. The method above does not say which rule placed those 51 imports under upgrade, and their bytes are not separated out; the per-event rows were not kept, so this cannot be settled without walking the history again. Found by the advisory review on the pull request and recorded here by the coordinator at intake. Until it is settled, read the Sonarr and Lidarr upgrade rows as accurate to within those events.
- **Free space versus history.** HaynesTower history net is about 22.3 TB written; free space fell 9.03 TB. The music array fell 11.03 TB, including 5639.7 GB in the week of Oct 26, while Lidarr's whole-window net is 7.08 TB and that week of unattributed imports is 607.9 GB. The Nov 6–12 HaynesTower rise of 9863.8 GB happened in a week whose file history is a net write. Radarr removals in the window did not leave a non-upgrade file-delete size.

### Files

| File | What it is |
| --- | --- |
| `2026-11-13-intake-adds.csv` | Adds by source and collection |
| `2026-11-13-intake-landed.csv` | Imports by source and collection, with net after paired upgrade deletes |
| `2026-11-13-intake-landed-quality.csv` | Imports by source and quality |
| `2026-11-13-intake-grabs.csv` | Grabs by source, collection, and quality; announced bytes are per event |
| `2026-11-13-intake-weekly.csv` | Landed and net bytes by week, arr, and source |
| `2026-11-13-intake-weekly-freespace.csv` | The coordinator's series, one row per week |
| `2026-11-13-intake-deletes.csv` | File deletes by reason |
| `2026-11-13-intake-top-no-watch-record.csv` | The top 20 above |
| `2026-11-13-intake-requester-tags.csv` | Numeric requester-tag ids on adds |
| `2026-11-13-intake-lidarr-lists.csv` | The 25 Lidarr lists and `enableAutomaticAdd` |

### Questions

- **Q-01.** The watch column is "no watch record," because this database has no zero play count. Recommendation: keep it that way until a full-library play count, zeros included, is joined by TMDB, TVDB, or MusicBrainz.
- **Q-02.** Explicit Seerr requests and watchlist sync are one source. Recommendation: leave them together until the request payload records which is which. Seerr's API was not called.
- **Q-03.** 6571.8 GB of Lidarr imports have no source tag, and every Lidarr list is set to add. Recommendation: leave that byte total unattributed. Assigning it to "the lists" would be a guess. The list tag on the artist would close it.
- **Q-04.** HaynesTower free space rose 9863.8 GB between the Nov 6 and Nov 12 samples, while *arr file history that week is a net write and the week's movie tombstones are 3246.7 GB. Recommendation: explain that rise from the dataset, snapshots, or the metric before reading it as the libraries shrinking.
