# 2026-09-26 — Research: watchlists vs the Trash cycle, and re-requests that must not re-fetch the deleted release

**Trigger:** issue [#576](https://github.com/thaynes43/haynesnetwork/issues/576) ("Seerr re-requests a Trashed title
that is still on the owner's Plex watchlist") and three owner rulings on 2026-09-26:

1. *"We should not be deleting things that are on anybody's watchlist across the server."*
2. *"We should be requesting things even if they were previously deleted but later added by someone else. We just
   need to grab a fresh index."* and *"We can't re-request the same index but we can the same title different
   index."*
3. Asked on his phone which watchlists should auto-request: **"Everyone's watchlist requests"** (turn Seerr's
   watchlist sync on for every Seerr user, movies and TV).

**Outcome:** the design is **ADR-093 / DESIGN-052 / PLAN-072**. This note keeps the verified evidence that design
rests on, with the corrections the skeptic passes made. Method: four read-only research tracks (the Trash
pipeline, whose watchlists can be read, re-request mechanics, the live Maintainerr install), one skeptic per
load-bearing claim, and a critic pass. Every probe was a GET, a read-only SQLite open or a `BEGIN READ ONLY`
database read, run from a `haynesnetwork-main` or a `media/*` pod. No token, username or other person's title list
was printed; outputs are counts plus the Trash items themselves.

**Interim action already taken:** the three watchlisted titles still `pending` in the open movie batch `08576e59`
(Trap, Death of a Unicorn, The Legend of Ochi) were **Saved** on 2026-09-26 at about 15:15Z through
`setBatchItemSaved` (actor null; the coordinator acting on ruling 1) before the batch's sweep at about
2026-09-27T06:45Z. A Save is permanent (Maintainerr exclusion plus a durable save intent, ADR-086).

## 1. Who "anybody" is: 42 accounts, and one set of files

- plex.tv, owner token: `/api/users` has 41 users (36 friends, 5 Plex Home members, 3 of them managed), the owner
  is the 42nd. `/api/home/users` and `/api/v2/home/users` agree (1 admin, 2 full, 3 restricted). `/api/v2/friends`
  answers 410. Tautulli's active users on the three servers union to the same 42.
- Shares: HaynesTower 40 users, HaynesKube 37, HaynesOps 5. Every friend but one has HaynesTower.
- **One delete removes a title for everyone.** HaynesOps (`/data/haynestower/Media/Movies`) and HaynesTower
  (`/data/Movies`) index the same files (identical path tails and byte sizes checked on Trap and Death of a Unicorn;
  deleted titles are gone from both). HaynesKube carries only the Peloton and YouTube libraries.
- One outgoing invite is pending (created 2026-07-13, to a non-user); accepting it makes 43.

## 2. Whose watchlist can be read, and how

| Path | Accounts | Notes |
|---|---|---|
| (a) The app today: discover provider with the owner server token (`packages/plex/src/read.ts` `getWatchlist`, 100 per page, `includeGuids`) | owner (1) | Cached in `watch_reco_signals` (source `watchlist`, 150 rows, replaced every 15 minutes by `sync-watch`). |
| (b) Seerr `GET /api/v1/user/{id}/watchlist?page=N` with the app's `SEERR_API_KEY` | the 16 Seerr users: owner, 1 of 2 full Home members, 14 of 36 friends | Seerr reads each user's list with **that user's own stored Plex token**, so it sees **private** lists. 20 per page, `{page,totalPages,totalResults,results[{id,ratingKey,title,mediaType,tmdbId}]}`. All 16 tokens answered 200 (list sizes 150 for the owner, then 4, 75, 1, 131, 5, 2, 28, 3, 0, 42, 34, 56, 10, 26, 3). **Correction (design review, PR #594):** a 200 proves nothing on this route: Seerr 3.4.1 answers any failed plex.tv read (a bad token, a 5xx, a 429) with 200 and an empty list, so the one user that answered 0 has an unverified token; the 15 with titles are proven. The API key acts as Seerr user 1 (ADMIN). Seerr's local Watchlist table is empty (the route would serve it instead of the Plex list). |
| (c) Maintainerr 3.29.0 Plex rule properties `[0,28]` "Watchlisted by (username)" and `[0,30]` "Is Watchlisted" | **4**: owner, 2 full Home members, 1 friend | Maintainerr is bound to the one server it manages (HaynesOps). It enumerates that server's `/accounts` (21 entries) joined to plex.tv users that have a username and an avatar uuid. Managed users have no username and are dropped; 35 friends are not on HaynesOps at all. Rules run every 8 h (`0 0-23/8 * * *`). |
| (d) Plex Home switch: `POST https://plex.tv/api/home/users/{id}/switch` → `authenticationToken` | the 3 managed users (untested) | A POST that mints a token/session for the managed user; not probed (read-only scope). Whether managed users even have a discover watchlist is unknown. All 3 have no PIN. |
| (e) community.plex.tv GraphQL with the owner token | owner, both full Home members, all 36 friends **resolve**; managed users answer `User not found: Data loader item not found` | Works as an HTTP GET: `https://community.plex.tv/api?query=…&variables=…` with `X-Plex-Token`. Query: `query W($uuid: ID = "", $first: PaginationInt!, $after: String) { user(id: $uuid) { watchlist(first: $first, after: $after) { nodes { id guid type title year } pageInfo { hasNextPage endCursor } } } }`, `first` 10..100 (1, 101, 200 are rejected). Nodes carry the 24-hex discover `id`, `guid` (`plex://movie|show/<id>`), `type` (the upper-case enum `MOVIE` / `SHOW`, re-probed 2026-09-26), `title`, `year` (also `originallyAvailableAt`, `slug`, `userState{watchlistedAt}`); **no tmdb/tvdb/imdb** field is accepted and introspection is disabled. The uuid comes from each `/api/users` `thumb` (`https://plex.tv/users/<uuid>/avatar?c=<digits>`). |

**Correction (skeptics, partly refuted "reads 39 of 42"):** community returns a watchlist the owner may not see as
an **empty list with no error**. Three friends whose Seerr reads return 75, 26 and 3 titles read as empty through
community. Of the 21 friends that read empty through community, 11 have `friendStatus` FRIENDS, 1 INVITE_SENT and 9
null; the 10 non-FRIENDS accounts are almost certainly hidden, not empty. The owner's own privacy setting is
`watchlist: PRIVATE` (a setting in real use). So:

- **Positively known today: 22 of 42 accounts** (18 read with titles through community, plus 4 Seerr users among
  the community-empties: 3 hidden lists and 1 that answered empty, unverified since an empty answer is also Seerr's
  error answer).
- **Unknowable today: 20 accounts** (17 friends that read empty through community and have no Seerr user, plus the
  3 managed users). The hidden lists found so far add no hit in the pool, the open batch or the deleted set.
- Any friend who signs in to Seerr once (it is linked to HaynesTower, `newPlexLogin` true) gives Seerr a token, and
  the (b) path then reads their list even if it is private.

**The best union is (e) + (b) + (a)** (community for everyone it resolves, Seerr for its 16 users, discover for the
owner), with (d) as the only candidate for the managed users.

Other facts:

- The app holds no Plex token for anyone but the owner (the three `PLEX_*_TOKEN` values all sign in as the owner;
  Tautulli exposes no user tokens; the app's Authentik token cannot read Plex source connections).
- Mapping a discover id to tmdb/tvdb: `GET https://discover.provider.plex.tv/library/metadata/{id}?includeGuids=1`
  gives `Guid[]` (`tmdb://`, `tvdb://`, `imdb://`). A first pass without retries failed on 40 of 469 ids; two later
  passes with retry on 429 and 50–150 ms spacing failed on 0. Treat an unmapped id as fail-closed and retry.
- **Pool items need no mapping:** Maintainerr's collection content (`GET /api/collections/media/{id}/content/{page}`)
  carries `mediaData.guid` (`plex://movie/<24hex>`, the show guid for TV) and a top-level `ruleEvaluationFailed`; all
  170 pool members have `plex://` guids. The app's zod schema strips both today.
- Seerr's `getWatchlist` keeps one cached response (with ETag) per token, whatever the offset. Sequential page reads
  for one user worked live; concurrent reads of different pages were not tested. It also wraps the discover call and
  the page's 20 metadata fetches in one try/catch and returns an empty list on any error (Loki shows `Failed to
  retrieve watchlist items`, 2 in one day from the owner-only sync, one a plex.tv 503), and it drops items with no
  tmdb guid or a 404.
- Watchlist history: the app keeps only the owner's current list. Community `activityFeed(types:[WATCHLIST])`
  returns dated **add** events (750 from 2022-05-08 to 2026-09-26) but not removals.

## 3. What Trash deletes, and how

- Candidates come only from two Maintainerr rule groups (movies: group 1 → collection 1, IMDb < 6.0, > 99 votes,
  0 views on HaynesOps, no `mediarequests` tag, Plex added > 180 days ago; TV: group 2 → collection 3, show rating
  < 6.0, 0 views, no `mediarequests`, > 180 days). No rule reads a watchlist. Live: collection 1 holds 170 movies;
  collection 3 is empty. Leaving Soon shells 17/18 (collections 22/23) have no rules and `arrAction` 4.
- The space policy (ADR-073) runs hourly while HaynesTower is over its 75% target, proposes and promotes one batch
  per kind (cap 50 movies or 5 shows, worst-rated first) with a 7-day window. A new movie batch forms about 30
  minutes after the previous sweep (one open batch per kind).
- Every deletion is the app's per-item `POST /api/collections/media/handle` against the rule collection (the batch
  sweep at `:45`, or Expedite, unused since 2026-07-07). With `arrAction 0`, `listExclusions: true`,
  `forceSeerr: true` Maintainerr: deletes the whole Radarr movie / Sonarr series **with files** and adds an
  import-list exclusion; deletes the Seerr media record (requests cascade); removes the item from its collections.
  No unmonitor, no blocklist, no download-client cleanup. Maintainerr's own aging deletes nothing (`deleteAfterDays`
  9999 on both pools; every Loki "Removed movie|show" line in 30 days falls in a sweep hour).
- Guards today: Saves (Maintainerr exclusion + durable save intent, 128 open), the `dnd` tag, watched on any server
  within 30 days, unknown to the ledger (fail closed), and "no longer in the pool / live-excluded" at sweep. **None
  reads a watchlist.** The sweep's `classifyGuardian` (`packages/domain/src/trash-flow.ts`) keeps only for `tag`,
  `recently_watched`, `unevaluable`.
- Maintainerr flags an already-pooled item whose rule data was transiently unavailable (`ruleEvaluationFailed`) and
  its own handler skips such items, but the per-item handle the app calls never checks the flag.
- Side finding: the sweep marks an item `deleted` before the handle call and tolerates handle failures, so "deleted"
  overstates reality (2026-09-13: 45 marked, 39 removed; The Devil's Mouth is still in Radarr, id 9555, with its
  file). Maintainerr's handle answers 409 while its rule or collection executor holds the lock, and 409 again when
  `handleMedia` returns 'failed'.
- **Addition (design review, PR #594): a removed *arr record is not proof the files are gone.** Never Let Go (2024)
  and Sleeping Beauty (2011), marked deleted on 2026-08-22, have no Radarr record, yet their files still exist and are
  accessible on HaynesOps and HaynesTower (Plex `checkFiles=1`). Orphaned files are a Maintainerr cleanup matter;
  DESIGN-052 D-14 notes them.

## 4. Watchlisted titles already deleted, and at risk

- **Deleted while on a watchlist, still listed today (ruling 1 breaches):** Babygirl (2024, tmdb 1097549, batch
  `3671be2e`, deleted 2026-09-20T05:45Z; the owner and a friend; on Radarr's import-list exclusions), Another
  Simple Favor (2025, tmdb 974573, batch `2620cf65`, deleted 2026-08-22T22:45Z; two friends), Terrifier (tmdb
  420634, batch `a10aa977`, deleted 2026-08-29T23:45Z; one friend; the ledger's year is 2018, the film premiered in
  2016). The activity feed shows each was added before its deletion and never re-added since.
- Silent Night (tmdb 891699, deleted 2026-08-15) and The Unholy Trinity (tmdb 1195518, deleted 2026-09-06) had a
  friend's add before deletion but are on no list today; whether they were listed when deleted is unknowable.
- Open batch `08576e59` held 4 watchlisted titles: Trap, Death of a Unicorn, The Legend of Ochi (pending, now
  Saved) and The Toxic Avenger Unrated (the owner saved it 16 s after watchlisting it).
- The movie pool holds 6 watchlisted titles (Trap, Summer of 69, The Legend of Ochi, Influencers, Death of a
  Unicorn, The Alto Knights). A Maintainerr "Is Watchlisted" rule would have caught 1 (Death of a Unicorn, the
  owner's). **The next movie batch (about 2026-09-27) may draw Summer of 69, Influencers and The Alto Knights**
  (friend-watchlisted), whose sweep would be around 2026-10-04.

## 5. Re-requests: why "a fresh index" does not happen today

- A Trash delete leaves Seerr with no media record, so Seerr treats the title as never requested (any version; the
  v3.3.0 DELETED-status change matters only when the Seerr delete fails). Watchlist sync reads each enabled user's
  **20 newest** titles every 3 minutes (`0 */3 * * * *`) and requests, auto-approved, anything not available; TV
  requests ask for `seasons: 'all'`. Today only Seerr user 1 (the owner) has sync on; all 16 users hold an
  auto-request and auto-approve permission (`defaultPermissions` 277872800). 96 requests, 0 auto-requests.
- Radarr/Sonarr accept a Seerr add of an excluded title (exclusions are read only by list sync and Radarr's own
  collection auto-add). Seerr requests carry tag `mediarequests` (except anime series, which get `animeTags`, empty
  live), and that tag excludes a title from both Trash pools from then on. **Addition (design review):** live, Seerr's
  Sonarr settings are `tags: [1]` and `animeTags: []`, so an anime series Seerr requests is untagged (Boruto and
  Attack on Titan are Seerr-requested and untagged); an admin's request-level override can replace the tags too, and
  Seerr adds no tag when it only searches a movie Radarr already has.
- **No release memory survives the delete.** The *arr deletes the title's blocklist and history with the record
  (`BlocklistService.HandleAsync(MoviesDeletedEvent)` / `SeriesDeletedEvent`); the blocklist API has **no create
  call** (only `POST /api/v3/history/failed/{id}` and `DELETE /api/v3/queue/{id}?blocklist=true`, both needing a
  history row or queue item on the current record). **Correction (skeptic):** the app does keep release identity
  for downloads since 2026-07-03: `ledger_events` payloads carry `sourceTitle`, `downloadId`, `indexer`,
  `releaseGroup`, `quality`, `downloadClient` for grabbed/imported rows and outlive the delete (76 of 416 deleted
  movies, 7 of 13 series).
- The first search after a re-add fires within 3 to 84 s of the add and picks the same top release (5 of 5
  verifiable cases), far faster than any app sync. ADR-084 E-1's "re-apply the blocklist when the sync sees the
  re-add" therefore cannot work.
- SABnzbd (5.1.3, both instances, `no_dupes=3` Fail) rejects a duplicate by NZB name (case-insensitive) **or** by an
  MD5 over the NZB's article ids, within its own history only (since 2026-07-03). **Correction:** routing follows
  the item's tag at grab time: `mediarequests` items go to SABnzbd-Fast, everything else to SABnzbd main, so a Seerr
  re-request of a title SAB main downloaded meets no duplicate record. Most Trash-deleted movies (about 78%) have no
  cluster SAB record at all; the pre-July **legacy SAB on HaynesTower** (`binhex-sabnzbdvpn`, history 2023-09 to
  2026-09) holds the original NZB names for about 80% of them. Exactly (rm-skeptic): the two legacy histories
  (`binhex-sabnzbdvpn` and `linuxserver-sabnzbd`, the latter up to 2026-07-03) hold a completed record for 331 of the
  416 deleted movies, 284 of the 327 with no cluster record, so about 43 deleted movies have no recoverable release
  identity. Silent Night and The Unholy Trinity have 0 grabbed or imported `ledger_events` rows (as do Babygirl,
  Another Simple Favor and Terrifier), so only the legacy histories can identify them (DESIGN-052 D-15).
- When the duplicate check does fire, SAB fails the job in about 5 s, Radarr blocklists that post and searches again,
  and every copy costs one counted indexer fetch (Prowlarr logs a duplicate grab as a successful redirect). Terminator
  3 took 11 fetches across 4 indexers.
- **The lever that blocks before any fetch is a Radarr/Sonarr release profile** ("must not contain" terms). Both
  expose `/api/v3/releaseprofile` (`{name, enabled, required[], ignored[], indexerId, tags[]}`; GET, POST, PUT by id,
  DELETE by id); 0 profiles exist live. A profile with no tags applies to every title; terms match the release title
  case-insensitively, or as a regex when written `/pattern/i`; a matching release is rejected permanently. Radarr's
  profile repository is uncached, so a PUT applies to the next decision. **Recyclarr** (daily `sync` at 05:30,
  `reset_unmatched_scores` on the FHD-UHD profile) would zero an app-made custom format's score overnight but does
  not manage release profiles. All indexers are usenet (4 per *arr).
- Seerr `preventSearch` plus an app-picked grab (`GET /release` then `POST /release`) would also work, but it puts
  every Seerr request behind the app.

## 6. The latent Arm/Disarm defect

`apps/web/app/(app)/settings/trash/trash-settings-client.tsx` sends `saveRule.mutate({ payload: { ...rule,
isActive: !active } })`, where `rule` is the `GET /api/rules` group. That GET has no top-level `listExclusions`,
`forceSeerr` or `arrAction` (they sit under `collection`). `upsertTrashRule` lifts only `radarrSettingsId` /
`sonarrSettingsId`. Maintainerr 3.29.0 `updateRules` reads those flags **only** from the top level
(`rules.service.js:495-502`) and defaults them to false/0, so one Arm/Disarm (or any app-side rule save) would turn
off `listExclusions` and `forceSeerr` and undo the 2026-09-14 ruling (ADR-084 E-3). `arrAction` would become 0,
which for a Leaving Soon shell is the aging-invariant violation ADR-036 guards. Never triggered.

## 7. Where the scratch evidence lived

The scripts and raw outputs were in the session scratchpad (`wl-protect/`, including `critic/union2.out`,
`critic/feed-join.out`, `skcov/cross.out`, `rules-resolved.txt`, the copied Seerr 3.4.1, Maintainerr 3.29.0 and
Radarr/Sonarr sources). They are not kept; everything load-bearing is above or in DESIGN-052.
