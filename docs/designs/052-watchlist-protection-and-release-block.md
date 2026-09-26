# DESIGN-052: Watchlist protection for Trash — the Watchlist Registry, the Registry Gate, the Watchlist Keep, the Release Block, and everyone's Seerr watchlist

- **Status:** Draft
- **Last updated:** 2026-09-26 (first draft, PLAN-072 S1)
- **Satisfies:** PRD-001 R-255..R-259, US-16, AC-33..AC-37 (R-86 and R-92 annotated); governed by ADR-093; extends
  DESIGN-010 (Trash and the safety audit), DESIGN-011 (batches and the windowed sweep), DESIGN-014 (the space
  policy), DESIGN-048 (the one expedite derivation, ADR-086 D-11), and reads DESIGN-049 / DESIGN-051 (the owner's
  watchlist, Watchlist Changes).
- **Context:** DDD-002 BC-03 Media Ledger (the Trash section); glossary T-261..T-266 (new), T-70 and T-74
  (amended).
- **Evidence:** `.agents/context/2026-09-26-watchlist-trash-protection-research.md` (cited below as "research §N").

## Overview

```
sync-watchlist-registry  14,29,44,59 * * * *      (and inline, first thing in a sweep that has a batch due)
   roster      plex.tv /api/v2/user + /api/users + /api/home/users          (owner token)
   owner       discover.provider.plex.tv watchlist, includeGuids            (owner token, as sync-watch does)
   friends,    community.plex.tv GraphQL  user(id:uuid).watchlist          (owner token; hidden = empty)
   full Home
   Seerr users seerr /api/v1/user/{id}/watchlist?page=N                     (API key; each user's own token)
   managed     plex.tv home switch token, only once Q-01 proves it safe
        │  per account: read | carried | unresolvable | unreadable   (a failed read never removes a title)
        ▼
   watchlist_registry_accounts / _items  (+ plex_discover_ids mapping cache)  ──►  Registry Gate (D-07)
                                                                                     │
 space-policy :17 ─ proposal leaves watchlisted titles out (D-08) ◄──────────────────┤
 sweep :45 ─ gate ─ guardian keeps `watchlisted` (D-09) ─ record release ─ Release Block PUT + read-back
            ─ claim ─ Maintainerr handle (D-14)                                        │
 Expedite ─ same gate, guardian and release steps                                      │
 Trash wall ─ "On a watchlist" (D-10)  ◄───────────────────────────────────────────────┘

 Radarr / Sonarr   one app-owned release profile each: "must not contain" terms (D-12, D-13)
 Seerr             watchlist sync on for every user, once, behind an audited setting (D-17)
```

## Detailed design

### D-01 — Who counts, and how accounts are classified

"Anybody" is every account in the owner's plex.tv roster plus the owner (42 today, research §1). HaynesOps and
HaynesTower serve the same movie and TV files, so there is no per-server scoping: every roster account counts.

The roster is read at the start of every refresh with the owner server token (HaynesOps, falling back to
HaynesTower, the order `sync-watch` uses):

- `GET https://plex.tv/api/v2/user` (JSON): the owner's account id and uuid.
- `GET https://plex.tv/api/users` (XML): one `<User id= username= thumb= home= restricted= …>` per account.
- `GET https://plex.tv/api/home/users` (XML): Home membership, `restricted`, `admin`.

Classes: `owner`; `home_full` (home, not restricted); `home_managed` (home, restricted); `friend` (not home). A
Seerr user whose `plexId` is not in the roster becomes `seerr_only` (0 today). The account key is the plex.tv
account id. The uuid comes from the `thumb` (`https://plex.tv/users/<uuid>/avatar?c=<digits>`).

An account new to the roster starts as `never_read`. An account missing from the roster is marked `left_at` and
keeps protecting its titles for 24 hours; only then is it deleted with its items (it no longer has access), so a
flapping or partial roster read never drops protection at once. The roster read failing fails the whole refresh
(D-04).

### D-02 — Read paths (exact shapes)

Every call sends `X-Plex-Token` (owner token) or `X-Api-Key` (Seerr), `Accept: application/json`, and for plex.tv
the app's existing `X-Plex-Client-Identifier` and `X-Plex-Product`, never `X-Plex-Version` (ADR-092 C-08). Each
call has a 10 s timeout and up to 3 attempts on 429, 5xx or a network error, backing off 2 s times the attempt.

**Owner.** The existing `@hnet/plex` `getWatchlist()` (discover provider, `includeGuids`, 100 per page, at most 20
pages; a truncated read is a failure). Rows carry the discover id (the `plex://` guid suffix) and tmdb/tvdb/imdb.

**Friends and full Home members: community.plex.tv GraphQL**, as an HTTP GET:

```
GET https://community.plex.tv/api?query=<q>&variables=<v>
q = query W($uuid: ID = "", $first: PaginationInt!, $after: String) {
      user(id: $uuid) { watchlist(first: $first, after: $after) {
        nodes { id guid type title year } pageInfo { hasNextPage endCursor } } } }
v = {"uuid":"<account uuid>","first":100,"after":<endCursor or null>}
```

`first` must be 10..100. At most 50 pages per account; 120 ms between calls. Answer classes:

- HTTP 200 with `data.user.watchlist`: **ok** (an empty list is ok; see `empty_unverified`, D-04).
- HTTP 200 whose `errors` all start with `User not found:`: **unresolvable** (the managed users today).
- Anything else (non-200, non-JSON, other GraphQL errors, too many pages): **failed**.

Nodes give `id` (24-hex discover id), `type` (`movie` or `show`), `title`, `year`. No external id is available
(research §2); D-03 maps them.

**Seerr users** (all 16 today, including the owner):

```
GET http://seerr.media.svc.cluster.local:5055/api/v1/user?take=100&skip=<n>      → results[{id, plexId, userType}]
GET http://seerr.media.svc.cluster.local:5055/api/v1/user/{id}/watchlist?page=<p>
    → {page, totalPages, totalResults, results[{id, ratingKey, title, mediaType, tmdbId}]}
```

20 per page; pages read sequentially per user (Seerr caches one response per token, Q-03). `ratingKey` is the
discover id (Seerr fetches `discover.provider.plex.tv/library/metadata/<ratingKey>` for each item); `mediaType` is
`movie` or `tv`. HTTP 200 is **ok**; anything else is **failed**. A user with no stored token answers an empty list;
all 16 have one today.

**Managed Home users.** `POST https://plex.tv/api/home/users/{id}/switch` returns an `authenticationToken` for the
managed user, which could read that user's discover watchlist like the owner path. It is a POST that mints a token
and a session and is **disabled until Q-01 is answered** (PRD Q-15). When enabled, the token lives in memory for one
refresh, is never stored or logged, and a failed switch is **failed** for that account. Until then managed users
are `unresolvable` (no path).

### D-03 — Title identity: discover id first, external ids mapped

The registry keys a title by its plex.tv **discover id** (24-hex), which all three sources give: community node
`id`, Seerr `ratingKey`, the owner rows' guid suffix. It is also the id in the pool: Maintainerr's collection
content carries `mediaData.guid` = `plex://movie/<id>` or `plex://show/<id>` (the show's guid for TV; all 170 pool
items have one, research §2).

External ids are kept for the items that carry them (owner rows: tmdb, tvdb, imdb; Seerr rows: tmdb) and mapped for
the rest through a persistent cache, `plex_discover_ids`, filled by
`GET https://discover.provider.plex.tv/library/metadata/{id}?includeGuids=1` (`Guid[]` of `tmdb://`, `tvdb://`,
`imdb://`). At most 200 new lookups per refresh, 100 ms apart, retrying 429s; an id plex.tv answers 404 for is marked
`not_found_at` and tried again after 7 days. A mapping never changes, so it is never refreshed once found. Mapping
is not needed to protect a pool item that has a `plex://` guid (D-06); it matters for items without one and for
the backfill and reporting queries.

### D-04 — The refresh and the per-account state

`refreshWatchlistRegistry({ trigger })` in `@hnet/domain` (the only writer of the registry tables):

```
take pg advisory lock 'watchlist-registry'
    (the CronJob skips its run if the lock is held; the sweep waits up to 120 s, and if a run finished `ok`
     while it waited, it uses that run instead of starting another)
insert watchlist_registry_runs(trigger, status 'running')
roster ← D-01                                    failure ⇒ run 'failed' (failure 'roster'), stop
upsert accounts; mark missing ones left_at; delete those missing for 24 h (cascade their items)
owner ← discover watchlist                       failure or truncated ⇒ run 'failed' ('owner'), stop
for each other account, sequentially:
    per applicable source (community for friend/home_full; Seerr when linked; switch for managed if enabled):
        ok     ⇒ replace that source's items for the account
        failed ⇒ keep that source's items exactly as they were
    status and timestamps ← rules below   (one transaction per account)
map up to 200 unmapped discover ids (D-03)
prune runs older than 7 days
run ← 'ok' with counts
```

Per-account status after each refresh:

| Status | When | Blocks the gate? |
|---|---|---|
| `read` | every applicable source answered ok this run | no |
| `carried` | at least one applicable source failed this run; `failing_since` set on the first failure, kept until a fully ok read | only once `last_ok_at` is older than 24 h (D-07) |
| `unresolvable` | no source can read it: community answered `User not found:` and there is no Seerr user, or a managed user while the switch path is disabled | never |
| `unreadable` | `carried` or `never_read` continuously for 72 h (`failing_since` ≤ now − 72 h); it keeps its frozen items | never |
| `never_read` | new to the roster, no ok read yet (`failing_since` set on its first failed attempt) | yes, at once: there is no `last_ok_at` (D-07) |

`empty_unverified` is set on a `read` account whose only ok source was community and which returned no titles: a
hidden list reads the same as an empty one (research §2). It never blocks; it is counted (ADR-093 C-05).

The rule that makes this fail closed: **a failed read never removes a title**. A title leaves the registry only when
a successful read of that source no longer lists it. An `unreadable` account keeps its last good titles
indefinitely; a later ok read returns it to `read`.

### D-05 — Data (migration **0081**, `0081_watchlist_protection.sql`)

Next free number verified 2026-09-26: `packages/db/migrations` ends at `0080_watchlist_marks.sql` and no open PR
adds one. New tables, all written only by `@hnet/domain` single-writers (added to the no-direct-state-writes guard):

- **`watchlist_registry_runs`**: `id` uuid pk, `trigger` (`schedule` / `sweep` / `manual`), `status` (`running` /
  `ok` / `failed`), `failure` text null (`roster`, `owner`, `owner_truncated`), `started_at`, `finished_at` null,
  `counts` jsonb (per class and status, `emptyUnverified`, `entries`, `distinctTitles`, `mapped`, `unmapped`).
  Index `(status, finished_at desc)`.
- **`watchlist_registry_accounts`**: `plex_account_id` text pk, `class` (CHECK owner / home_full / home_managed /
  friend / seerr_only), `plex_uuid` text null, `seerr_user_id` int null, `status` (CHECK never_read / read / carried
  / unresolvable / unreadable), `empty_unverified` bool, `first_seen_at`, `left_at` null, `last_attempt_at`,
  `last_ok_at` null, `failing_since` null, `discover_ok_at`, `community_ok_at`, `seerr_ok_at` (each null), `item_count` int,
  `updated_at`. No username, title, email or token.
- **`watchlist_registry_items`**: `plex_account_id` (FK, cascade), `discover_id` text, `kind` (CHECK movie / show),
  `source` (CHECK discover / community / seerr / switch), `tmdb_id`, `tvdb_id` int null, `imdb_id` text null,
  `first_seen_at`, `last_seen_at`. PK `(plex_account_id, discover_id, source)`; indexes `(discover_id)`,
  `(kind, tmdb_id)`, `(kind, tvdb_id)`.
- **`plex_discover_ids`**: `discover_id` text pk, `kind`, `tmdb_id`, `tvdb_id`, `imdb_id`, `resolved_at`,
  `not_found_at`, `attempts`.
- **`trash_deleted_releases`** (the Deleted-Release Record, D-11): `id` uuid pk, `arr_kind` (CHECK radarr / sonarr),
  `arr_item_id` int null, `media_item_id` uuid null (FK `media_items`, set null), `batch_item_id` uuid null (FK
  `trash_batch_items`, set null), `tmdb_id`, `tvdb_id` int null, `imdb_id` text null, `title` text, `year` int null,
  `season` int null, `identity_source` (CHECK arr_grab_history / arr_file / ledger_grab / legacy_sab / none),
  `release_title` text null, `release_group` text null, `quality` text null (the *arr quality name, e.g.
  `Remux-2160p`), `resolution` int null, `size_bytes` bigint null, `file_name` text null, `indexer` text null,
  `term` text null, `state` (CHECK in_flight / active / abandoned / expired / pruned), `origin` (CHECK sweep /
  expedite / backfill / remediation), `recorded_at`, `activated_at` null, `expires_at`, `ended_at` null. Indexes
  `(arr_kind, state)`, `(media_item_id)`, `(tmdb_id)`, `(tvdb_id)`. **No URL is ever stored** (NZB and download URLs
  carry indexer API keys).
- **`seerr_watchlist_enrollments`**: `seerr_user_id` int pk, `plex_account_id` text null, `enrolled_at`,
  `already_on` bool, `optout_observed_at` null, `last_checked_at`.

Changed tables: `trash_batch_items` gains `keep_reason` text null (CHECK null or tag / recently_watched /
watchlisted / unevaluable / not_in_pool / live_excluded / release_unrecorded); `trash_candidates` gains `plex_guid`
text null (the read-model the walls use, ADR-035); `sync_runs.run_kind`'s CHECK is rebuilt with
`watchlist-registry` (the SYNC_RUN_KINDS parity rule). App setting (no DDL): `seerr_watchlist_enroll` =
`{ "enabled": false, "onlyUserIds": null }`, absent means off, every change audited like every app setting.

### D-06 — Matching a pending item to the registry

A pending item's keys: its discover id `d` when Maintainerr's `mediaData.guid` matches
`^plex://(movie|show)/([0-9a-f]{24})$`; for a movie its tmdb id; for a show its tvdb and tmdb ids.

The registry's keys per kind: every item's discover id, plus its own or mapped external ids.

- `onWatchlist` = any of the item's keys is in the registry for the item's kind.
- `watchlistEvaluable` = the item has a `d`, or no registry item of that kind is unmapped (so an external-id miss
  proves absence). All 170 pool items have a guid today, so this is a guard against a future legacy-agent library.

The match runs in `shapePendingItems` from one snapshot the caller took through the gate (D-07), so a whole sweep or
proposal uses one consistent registry state. `maintainerrMediaSchema` gains `mediaData.guid` (as `plexGuid`) and
`ruleEvaluationFailed`; `FlatPending` and `TrashPendingItem` gain `plexGuid`, `ruleEvaluationFailed`, `onWatchlist`,
`watchlistEvaluable`.

### D-07 — The Registry Gate (the exact fail-closed rule)

`evaluateRegistryGate({ now, purpose })` in `@hnet/domain`:

```
run ← newest watchlist_registry_runs row with status 'ok'
G1  run exists and run.finished_at ≥ now − 30 min                         else refuse 'stale'
G2  (implied by 'ok') the roster was read and the owner's whole list was read
G3  no account has status never_read or carried with last_ok_at null or < now − 24 h
                                                                          else refuse 'account_unverified' (count)
verified ⇒ snapshot = every watchlist_registry_items row (carried and unreadable accounts included)
                      ∪ the owner's live watchlist_add Watchlist Changes since run.started_at (D-19)
```

- **purpose `delete`** (the batch sweep, Expedite item and all): G1..G3 must hold. A refused sweep throws
  `WatchlistRegistryUnverifiedError` after the Maintainerr safety audit and before touching any batch; the batch
  stays `leaving_soon` and the next hourly run tries again. A refused Expedite answers `PRECONDITION_FAILED`.
- **purpose `propose`** (space policy, manual batch creation): never refuses. It uses the newest ok run if it
  finished within 24 h, and otherwise proposes without the filter (logged `gate … purpose=propose filtered=false`),
  because the sweep is where deletion is enforced.
- The sweep runs `refreshWatchlistRegistry({ trigger: 'sweep' })` first, but only when at least one batch is due. If
  that refresh fails, G1 can still pass on the CronJob's run at `:44` (at most 30 minutes old). The web pod never
  refreshes inline; Expedite relies on the CronJob.
- Constants in code (not settings): `REGISTRY_MAX_AGE_MIN = 30` (two missed CronJob runs refuse), `ACCOUNT_CARRY_MAX_H
  = 24`, `ACCOUNT_UNREADABLE_AFTER_H = 72`.
- Item level: an item that is not `watchlistEvaluable`, or that Maintainerr flags `ruleEvaluationFailed`, is kept
  as `unevaluable` (D-09).

What the bounds mean: a title watchlisted within the last 30 minutes before a sweep that could not refresh can be
missed; a title added by an account whose reads have failed for up to 24 hours can be missed; after 24 hours that
account blocks all deletion until it reads again or turns `unreadable` at 72 hours, which is counted and shown.

### D-08 — The guard at proposal time

- `listTrashPending` (the live read the batch snapshot and the sweep use) joins the snapshot from D-07.
- `selectBatchCandidates`: for a **targeted** batch (every space-policy batch, `maxItems`/`targetBytes`), an
  `onWatchlist` item is dropped with the `dnd` items, so it never takes one of the 50 slots. For an untargeted
  (manual) batch it is snapshotted `protected` with `keep_reason = 'watchlisted'`, the way a `dnd` item is.
- The space policy's `minCandidates` counts deletable candidates only (not `dnd`, not watchlisted).
- An item that is not `watchlistEvaluable` is proposed normally; the sweep decides.

### D-09 — The guard at the deletion moment

`classifyGuardian` (`packages/domain/src/trash-flow.ts`, the one derivation the sweep, both Expedite scopes and the
server preview use, ADR-086 D-11):

```
GuardianInput = protectedByTag, recentlyWatched, mediaItemId, onWatchlist, watchlistEvaluable, ruleEvaluationFailed
tag              if protectedByTag
recently_watched if recentlyWatched
watchlisted      if onWatchlist
unevaluable      if mediaItemId is null, or !watchlistEvaluable, or ruleEvaluationFailed
otherwise        not kept
```

- `GuardianKeepReason` gains `watchlisted`; `ExpediteVerdict` gains `protected_watchlist`; `classifyForExpedite`
  maps it. The client mirror `previewGuardian` (`apps/web/lib/trash.ts`) and `GuardianPreviewInput` follow, and the
  case-by-case parity test in `apps/web/lib/__tests__/trash.test.ts` grows the new cases.
- The sweep writes the reason when it skips: `markItemSkipped(item, keepReason)` also for the two pre-guardian
  skips (`not_in_pool`, `live_excluded`) and for `release_unrecorded` (D-14).
- Expedite `all`, pass 1 (`guardRecentlyWatched`): a watchlisted item is kept and **never** auto-saved (a watchlist is
  not a Save). Expedite `item` on a watchlisted target refuses, like a tagged one.
- `ruleEvaluationFailed` is the fix research §3 found: Maintainerr's own handler skips flagged members, the per-item
  handle the app calls did not.

### D-10 — The Trash wall and status (copy proposed here; the UX pass is the driving session's)

All copy follows the owner's rules: no em dashes, no names, never whose watchlist, never how many.

- **Pending wall and batch wall tiles:** an `onWatchlist` item gets a meta-line note, bookmark glyph, info tone,
  label **"On a watchlist"** (tooltip and aria: "On a watchlist. It won't be deleted while it stays there."). The
  corner stays the Save toggle; a Save still makes it permanent. The note is read from the newest ok registry run
  through the candidate read-model (`trash_candidates.plex_guid` joined at read time).
- **A batch tile the sweep kept** keeps the existing `skip` glyph; its tooltip names the reason: "Kept: on a
  watchlist", "Kept: watched recently", "Kept: couldn't be checked", "Kept: no longer a candidate", "Kept: saved".
- **Expedite confirm:** the protected count's breakdown includes "on a watchlist".
- **Sweep paused** (the last `delete` gate refused and no sweep has succeeded since): a warning banner on the Trash
  page for anyone with Trash access: "Deletion is paused until watchlists can be checked."
- **Trash settings, a read-only "Watchlists" card (admins):** "Checked 6 minutes ago. 22 accounts read, 20 can't
  be read." with the per-class counts; never a name or a title.

### D-11 — The Deleted-Release Record: what identity exists

Recorded for every item the sweep or Expedite is about to delete, before the handle (D-14). Sources, in order of
preference:

**Movies (Radarr)**

1. `GET /api/v3/moviefile?movieId={id}`: `relativePath` (the renamed file name, e.g. `101 Dalmatians (1996)
   {imdb-tt0115433} [WEBRip-1080p][EAC3 2.0][x264]-NTb.mkv`), `sceneName` (the release name, when imported from a
   download), `releaseGroup`, `quality.quality` (`name`, `resolution`, `source`, `modifier`), `size`.
2. `GET /api/v3/history/movie?movieId={id}&eventType=1` (grabbed): the grab whose `downloadId` matches the file's
   import gives `sourceTitle`, `data.indexer`, `data.releaseGroup`.
3. The ledger: `ledger_events` grabbed/imported rows for the media item (`payload.sourceTitle`, `releaseGroup`,
   `quality`, `indexer`), which outlive the delete (research §5).

`identity_source`: `arr_grab_history` (1+2), `arr_file` (the file's `sceneName` or, when that is null, only group and
quality from the file), `ledger_grab` (3), `none` (the movie has no file: nothing to re-fetch). Live today (pool 1,
170 movies): 7 carry a `sceneName`; 163 came from disk in July and carry only the renamed file name, group, quality
and size (research §5).

**Shows (Sonarr)**

1. `GET /api/v3/episodefile?seriesId={id}`: per file `seasonNumber`, `relativePath`, `sceneName`,
   `releaseGroup`, `quality`, `size`.
2. `GET /api/v3/history/series?seriesId={id}&eventType=1`: grabs' `sourceTitle`.
3. The ledger, as for movies.

One record per distinct (season, release group, resolution) of the series' files, with a matching release name
when one is known. Season 0 (specials) is skipped.

A record whose group and release name are both unknown gets `term` null: it is kept as evidence and counted
(`unblockable`); nothing is blocked for it.

### D-12 — Deriving the "must not contain" term

Tokens: Unicode NFKD, combining marks removed, apostrophes removed, `&` read as `and`, lowercase, split on
`[^a-z0-9]+`. The title tokens come from the known release name (the tokens before its year) when there is one,
else from the *arr's title. Each term is a Perl-style regex Radarr and Sonarr accept (`/pattern/i`, matched against
the release title; research §5). `SEP` below is `[\W_]`.

**Movie, release group known** (the usual case): the title, the year, the resolution, `remux` when the quality is
a Remux, and the group:

```
/^{T}SEP+{Y}SEP(?=.*(?<![a-z0-9]){R}p(?![a-z0-9])){X}.*SEP{G}(?:SEP|$)/i
   T = title tokens joined by SEP+     Y = year     R = 2160 | 1080 | 720 | 480
   X = (?=.*(?<![a-z0-9])remux(?![a-z0-9]))  only for a Remux quality     G = group tokens joined by SEP*
```

Example (Babygirl's deleted file):
`/^babygirl[\W_]+2024[\W_](?=.*(?<![a-z0-9])2160p(?![a-z0-9]))(?=.*(?<![a-z0-9])remux(?![a-z0-9])).*[\W_]framestor(?:[\W_]|$)/i`
matches `Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR` and its space-separated repost,
and not `Babygirl-2024-2160p iT WEB-DL … -HONE` or the 1080p `-APEX` release. It blocks every post and every indexer
of that group's release at that resolution: "the same title, different index" (ruling 2) is any other release.

**Movie, no group but a release name:** the exact name, separator-insensitive:
`/^{all tokens of the name joined by SEP*}(?:SEP|$)/i`.

**Show, per (season, group, resolution):**

```
/^{T}SEP+(?:{Y}SEP+)?s0*{S}(?:e[0-9]+)*(?![0-9a-z])(?=.*(?<![a-z0-9]){R}p(?![a-z0-9])).*SEP{G}(?:SEP|$)/i
```

This covers season packs and single episodes of that season from that group. Absolute (anime) and daily numbering
are not covered (documented; Q-05).

**Self-check before recording:** the term is compiled in the app (JavaScript regex, the same constructs .NET
supports) and must match every release name of its record; a group term that fails falls back to the exact form,
and a term that matches nothing it came from is not recorded (`term` null, logged).

### D-13 — The Release Block writer

- **One profile per *arr**, owned by the app: `name` `haynesnetwork: deleted releases (managed, do not edit)`,
  `enabled` true, `required` `[]`, `ignored` = the sentinel plus the live terms, `indexerId` 0 (every indexer),
  `tags` `[]` (every movie or series, including Seerr's `mediarequests` ones; a re-added title carries no app tag,
  so the profile cannot be tag-scoped). The sentinel `hnet-release-block-sentinel` (a plain term no release carries)
  keeps the profile valid, since Radarr/Sonarr refuse a profile with no term.
- **Shape of the API:** `GET /api/v3/releaseprofile`, `POST /api/v3/releaseprofile`,
  `PUT /api/v3/releaseprofile/{id}` with `{id, name, enabled, required, ignored, indexerId, tags}`; identical on
  Radarr 6.4.4 and Sonarr 4.0.20. Radarr's profile store is uncached, so a PUT governs the very next decision.
- **Confined surface:** `@hnet/arr/write` gains `listReleaseProfiles`, `createReleaseProfile`,
  `updateReleaseProfile` on `RadarrWriteClient` and `SonarrWriteClient`, import-confined to `packages/domain` by the
  existing guard. Hard rule 4 is amended in the same PR (ADR-093 C-08).
- **`reconcileReleaseBlock({ arrKind })`**, the single writer, under `pg_advisory_xact_lock('release-block:<kind>')`:
  1. rows past `expires_at` become `expired`, and `in_flight` rows older than one hour (a sweep that died between
     Phase A and its claim) become `abandoned`; desired = sentinel + the distinct terms of `in_flight` and `active`
     rows, newest first; beyond **3,000** terms the oldest `active` rows become `pruned` (WARN);
  2. `GET` the profiles; find ours by exact name. None: `POST`. One: compare the `ignored` sets; equal means no
     write; otherwise `PUT` the whole object. More than one: throw (someone copied it; a person resolves it);
  3. `GET` again and verify every desired term is present (read-back); otherwise throw `ReleaseBlockError`.
- **Idempotent:** a set comparison, so a repeat does nothing; two deletions that derive the same term share it. A
  hand edit is overwritten on the next reconcile, and a deleted profile is re-created.
- **Growth:** a term lives **365 days** from its record (`expires_at`, extended when the same term is recorded
  again); at about 50 movie deletions a week the profile settles near 2,600 movie terms. The cost of that many regex
  terms per release decision is Q-04.

### D-14 — The sweep, step by step

`sweepExpiredBatches` → for the due batches:

1. Maintainerr safety audit (ADR-023 C-04, now including the D-16 flags). Unsafe: refuse (as today).
2. `refreshWatchlistRegistry({ trigger: 'sweep' })`, then the gate (D-07, `delete`). Refused: throw
   `WatchlistRegistryUnverifiedError`; nothing is written; the batch stays open.
3. Per batch, `expireOneBatch`: the fresh pending read (with the registry join) and live exclusions, as today.
   Items gone from the pool or live-excluded: `skipped` with `not_in_pool` / `live_excluded`. Guardian keeps:
   `skipped` with the reason.
4. **Identity** for each survivor (D-11). An *arr read that fails (network, 5xx) counts toward the existing
   consecutive-failure breaker (`HANDLE_FAILURE_LIMIT`, 3): three in a row mean the *arr is down, so the sweep aborts
   before Phase A and leaves the batch `leaving_soon` for the next hourly run (the existing abort path, nothing
   deleted). A single failure between successes skips only that item (`skipped`, `release_unrecorded`); it comes
   back in a later batch. An item never loses protection for want of a record: no record, no delete.
5. **Phase A, before any delete:** one transaction inserts `in_flight` records for every survivor; then
   `reconcileReleaseBlock` for each *arr involved (at most one PUT each) with its read-back. Failure: the `in_flight`
   rows become `abandoned`, no item is claimed, the batch stays `leaving_soon`, the run logs `release-block failed`.
6. **Phase B, per item (unchanged claim discipline):** one transaction does the guarded claim (`pending` →
   `deleted`), the `trash_expedited` event, the deletion audit (ADR-034/035) **and** flips the item's records to
   `active` with `batch_item_id`. A lost claim (Saved mid-sweep) flips them to `abandoned`. Then the Maintainerr
   handle.
7. After the loop, if any record was abandoned, reconcile again so the orphan terms leave the profile.

Expedite (both scopes) runs the same order per call: audit, gate (without an inline refresh), guardian, identity,
Phase A, claim, handle. The two write paths share one helper (`recordAndBlockReleases`) so they cannot drift.

Ordering guarantee (ADR-084 E-6): the term is in the *arr's profile, read back, before the handle that deletes the
record. A re-add seconds later meets the block on its first search.

### D-15 — Seeding the block: backfill and the three remediation titles

A one-off script, `packages/sync/src/scripts/release-block-seed.ts` (not a sync mode), with `--dry-run` (counts only)
and `--apply`:

- **Backfill:** every `trash_batch_items` row in state `deleted` whose media item has a grabbed or imported
  `ledger_events` row before `deleted_at` becomes a record (`origin` `backfill`, `identity_source` `ledger_grab`,
  `expires_at` = `deleted_at` + 365 days, so old deletions age out on the same clock). About 76 movies and 7 series
  qualify (research §5).
- **Remediation** (`--manual <file>`: tmdb id, title, the release's own year, release names): `origin`
  `remediation`, `identity_source` `legacy_sab`. The names come from the legacy HaynesTower SABnzbd history (read-only
  over `hw-ssh`), matched to `trash_batch_items.deleted_size_bytes` by size. The 2026-09-26 read of a copy gives:
  - Babygirl (2024, tmdb 1097549): `Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR`
    (55.01 GB downloaded, 53.31 GB deleted).
  - Terrifier (tmdb 420634; the ledger says 2018, the release says 2016):
    `Terrifier.2016.Uncut.UHD.BluRay.2160p.DTS-HD.MA.5.1.HEVC.REMUX-FraMeSToR` (41.33 GB, 40.05 GB deleted).
  - Another Simple Favor (2025, tmdb 974573): `Another.Simple.Favor.2025.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265`
    from `-FLUX` or `-Kitsune` (both about 14.57 GB, 14.11 GB deleted; size cannot tell them apart), so both groups
    are blocked; `-BYNDR` and other releases remain.
  Q-11 confirms these on the live host before the terms are written.

Both run through the same record-and-reconcile writer, then a read-back of the Radarr profile.

### D-16 — The Arm/Disarm fix and the grown safety invariant

- **Server-side, so no client change is needed.** `upsertTrashRule` (update path) reads the live group and builds
  the PUT: every field Maintainerr's `updateRules` reads only at the top level (`arrAction`, `listExclusions`,
  `forceSeerr`, `tagInArr`, `keepInMaintainerrOnly`, `cleanupLeftoverFolders`, `radarrSettingsId`,
  `sonarrSettingsId`, `radarrQualityProfileId`, `sonarrQualityProfileId`, and any other the 3.29.0 `updateRules`
  reads; the build enumerates them from its source) comes from the payload's top level when present, else from the
  live group's `collection`. `useRules` missing is taken from the live group; `useRules: false` with rules present is
  refused (it would delete every rule row). `dataType`, `libraryId` and the manual-collection fields still
  round-trip verbatim (a change there wipes membership).
- **After the PUT**, a `GET` compares those flags and `collection.deleteAfterDays` with what was intended; a mismatch
  throws `MaintainerrRuleDriftError` (logged `rule_save_drift`), so the admin sees the failure and the audit below
  catches the state.
- **The aging invariant grows** (`evaluateAgingInvariants`, ADR-036): an active rule pool must also have
  `listExclusions: true` and `forceSeerr: true` (the ADR-084 E-3 ruling and this design's re-request path). A
  violation makes the audit unsafe, so sweeps and Expedite refuse until it is fixed. `maintainerrCollectionSchema`
  gains the two fields (present in `GET /api/collections`).

### D-17 — Everyone's Seerr watchlist: enrollment

- **Setting:** `seerr_watchlist_enroll` = `{ enabled, onlyUserIds }`, off until PLAN-072 S9. `onlyUserIds` limits a
  canary.
- **Step:** at the end of each `watchlist-registry` run while enabled, for every Seerr user of type Plex (`userType`
  1) with no `seerr_watchlist_enrollments` row (and in `onlyUserIds` when set):
  1. `GET /api/v1/user/{id}/settings/main` → the settings body;
  2. both `watchlistSyncMovies` and `watchlistSyncTv` already true: insert the row with `already_on` (the owner);
  3. otherwise `POST /api/v1/user/{id}/settings/main` with **the whole GET body echoed** plus
     `watchlistSyncMovies: true, watchlistSyncTv: true`; the response must show both true; then insert the row. A
     failure logs and retries next run (no row).
- **Enroll once, respect an opt-out** (driver decision, Q-08): an enrolled user is re-checked once a day; if their
  flags are off, `optout_observed_at` is set and logged once, and the app never turns them back on.
- **Why the whole body:** Seerr 3.4.1's route assigns `username`, `locale`, `discoverRegion`, `streamingRegion`,
  `originalLanguage` and, for a target without `MANAGE_USERS`, the four quota fields from the body; echoing the GET
  keeps them. The API key acts as Seerr user 1, the only user allowed to edit user 1. For a user with no settings
  row Seerr creates one (`new UserSettings({ user: req.user, … })`); Q-09 checks it lands on the target user, which
  the canary and the read-back prove.
- **Confined surface:** `@hnet/arr/write` gains `SeerrWriteClient.setWatchlistSync(userId, { movies, tv })`,
  import-confined to `packages/domain`; the domain writer `enrollSeerrWatchlistSync` records the row after the
  external write succeeds (the Authentik-apply precedent, ADR-045).
- **Why in the app:** a Plex user who signs in to Seerr later (`newPlexLogin` is on) is enrolled within 15 minutes,
  which "Everyone's" implies; a one-shot script would miss them.
- **Expected first-enable volume:** Seerr reads each user's 20 newest titles, so at most about 34 movies and 48 shows
  (an upper bound computed over every readable list, research §5), all auto-approved (every user holds
  `AUTO_APPROVE`), TV as whole-series requests. Seerr quotas (Q-10) may hold some back.

### D-18 — Rollout order and the remediation re-requests

The order is ADR-093 C-13 and PLAN-072's step order:

1. Ship the registry, gate, guard, Release Block and the Arm/Disarm fix with enrollment off.
2. Verify read-only, then on the first real guarded sweep (terms written and read back before the first handle).
3. Seed the block (D-15): the backfill and the three remediation titles' terms.
4. Enable Seerr enrollment for one user (Seerr user 2, the full Home member), watch one 3-minute sync, then all.
5. Re-request whatever the enable did not: for Babygirl, Another Simple Favor and Terrifier,
   `GET /api/v1/movie/{tmdbId}`; if `mediaInfo` shows no request, `POST /api/v1/request`
   `{"mediaType":"movie","mediaId":<tmdbId>}` with the API key (the owner; ADMIN, auto-approved). Babygirl is on
   Radarr's import-list exclusions, which a Seerr add ignores (research §5). Each is a one-off operation by the
   coordinator, not app code.
6. Verify each grab chose a release outside the blocked terms (Radarr history `sourceTitle`; the decision log's
   "Contains these ignored terms" on the blocked one) and imported.

Silent Night and The Unholy Trinity are on no watchlist today (research §4) and are not re-requested; if anyone lists
them, Seerr requests them and the backfill's terms apply where the ledger knew their release.

### D-19 — The owner's Watchlist Changes count at once

The gate's snapshot adds the owner's `watch_marks` rows with action `watchlist_add` (state `written` or `pending`, not
reverted) made since the newest ok run started, keyed by the mark's discover guid (ADR-092 D-03). A `watchlist_remove`
never subtracts (fail closed); the next read settles it. So "add it to my watchlist" by voice or ChatGPT protects a
Leaving Soon title from that moment.

### D-20 — Sync mode, CronJob, configuration, stubs

- `--mode=watchlist-registry`: `refreshWatchlistRegistry({ trigger: 'schedule' })`, then the enrollment step when
  enabled. It writes its own runs table and no `sync_runs` row (the `smart-alerts` shape); it joins `SYNC_RUN_KINDS`
  so the CLI accepts it (the CHECK rebuild in 0081).
- haynes-ops: a `sync-watchlist-registry` CronJob in `kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`,
  schedule `14,29,44,59 * * * *` (free minutes; `:44` lands a minute before the sweep, `:14` three before the space
  policy), `concurrencyPolicy: Forbid`, the `sync-watch` resources, `envFrom` `haynesnetwork-secret`.
- Credentials already in `haynesnetwork-secret` (verified in `externalsecret.yaml`): `PLEX_HAYNESOPS_TOKEN`,
  `PLEX_HAYNESTOWER_TOKEN`, `SEERR_API_KEY`, `RADARR_API_KEY`, `SONARR_API_KEY`, `MAINTAINERR_API_KEY`. The sweep job
  mounts the same secret; it now also builds the Plex read, Seerr read and Radarr/Sonarr write clients.
- Egress: the `frontend` namespace has no CiliumNetworkPolicy for haynesnetwork; plex.tv, community.plex.tv and
  discover.provider.plex.tv answered from the web pod (research §2). S6 confirms the CronJob pods.
- `pnpm dev:local`: stub plex.tv (`/api/v2/user`, `/api/users`, `/api/home/users`), community GraphQL (a fixture
  roster including a hidden-empty friend and a `User not found:` managed user), discover metadata, Seerr (users,
  watchlist pages, settings main GET/POST) and the *arrs (`releaseprofile`, `moviefile`, `episodefile`,
  `history/*`).

### D-21 — Logging

Never logged: tokens, uuids, usernames, emails, a person's titles, which account lists a title. Accounts appear only
as their class and `acct:<first 8 hex of sha256(account id)>` for correlation. Trash item titles (our library) are
fine.

- `[watchlist-registry] run_complete {trigger, status, durationMs, roster, byClass, byStatus, emptyUnverified,
  entries, distinctTitles, mapped, unmapped}`; `run_failed {trigger, failure}`; `account_failed {class, source,
  errorClass, acct}` (warn); `account_unreadable {class, acct, failingSinceH}` (warn, once).
- `[watchlist-registry] gate {purpose, verified, reason, ageMin, blocking, filtered}`.
- `[trash] kept {batchId, maintainerrMediaId, title, reason}` per skip; the sweep summary gains per-reason counts.
- `[release-block] recorded {arrKind, origin, identitySource, shape: group|exact|none}`; `reconciled {arrKind,
  total, added, removed, expired, pruned, wrote, ms}`; `failed {arrKind, step}` (error).
- `[seerr-enroll] enrolled {seerrUserId, alreadyOn}`; `optout_observed {seerrUserId}`; `failed {seerrUserId, status}`.
- `[trash] rule_save_drift {ruleGroupId, fields}` (error).
- A Loki alert in haynes-ops (with the CronJob PR): `gate` with `purpose=delete verified=false` on every sweep for 6
  hours pages the owner that reclaim is paused.

### D-22 — Code map

| Package | Change |
|---|---|
| `@hnet/db` | migration 0081; schema files for the six tables and two columns; `SYNC_RUN_KINDS` + `watchlist-registry`; enums for statuses, sources, keep reasons, identity sources |
| `@hnet/plex` | roster reads (`getAccount`, `listUsers`, `listHomeUsers`), `communityWatchlist(uuid)`, `discoverMetadata(id)`; the switch call behind a flag (Q-01) |
| `@hnet/arr` | `maintainerrMediaSchema` + `mediaData.guid`, `ruleEvaluationFailed`; collection schema + `listExclusions`, `forceSeerr`; Seerr read `listUsers`, `userWatchlist`; `/write`: release-profile methods on Radarr/Sonarr, `SeerrWriteClient` |
| `@hnet/domain` | `watchlist-registry.ts` (refresh, gate, snapshot), `release-block.ts` (identity, terms, reconcile), `seerr-enroll.ts`; `trash-flow.ts` (guardian, pending shape, `upsertTrashRule`, invariant); `trash-batches.ts` (proposal filter, sweep phases, keep reasons); `trash-candidates.ts` (`plex_guid`); `space-policy.ts` (`minCandidates`) |
| `@hnet/sync` | the `watchlist-registry` mode; the sweep's client wiring; `release-block-seed.ts` |
| `@hnet/api` | Trash status gains the registry summary; Expedite maps the gate refusal |
| `apps/web` | `previewGuardian` mirror, the wall note, skip-reason tooltips, the paused banner, the Watchlists card |
| haynes-ops | the CronJob, the Loki alert, the image tag |
| CLAUDE.md | hard rule 4 (ADR-093 C-08) |

## Alternatives considered

- **Maintainerr's "Is Watchlisted" rule as the guard, or as defence in depth** (ADR-093 option A1): 4 of 42 accounts,
  8-hour lag, fail open for pooled items. Not added even as a second layer: it would change pool membership in a
  runtime config that is not in git, for no coverage the registry lacks.
- **Store only an aggregate "title is on some list" set:** smaller and more private, but then a failed read of one
  account cannot carry that account's titles forward (D-04). Per-account rows stay internal (ADR-093 C-06).
- **Refresh only inside the sweep:** would leave Expedite and proposals without a fresh registry and make every sweep
  pay the full read; the CronJob plus an inline refresh when a batch is due covers both.
- **Treat an unreadable account as blocking forever:** one revoked token would stop reclaim for good; the 72-hour
  reclassification keeps the frozen list as protection and makes the gap visible instead.
- **One release profile per title, or tag-scoped profiles:** a profile per title multiplies API objects; a re-added
  title carries no app tag, so tag scoping cannot reach it.
- **Exact release-name terms only:** misses reposts under other names and every disk-imported file, which has no
  release name.
- **A unique index on the term:** each deletion keeps its own evidence row; the reconcile deduplicates.

## Test strategy

- **Pure units:** roster XML parsing and classification (owner, full, managed, friend; uuid from `thumb`);
  community answer classification (data, empty, `User not found:`, other errors, non-JSON); Seerr paging; the
  per-account state machine (read, carried at 1 h and 25 h, unreadable at 72 h and back to read, never_read, the
  empty_unverified flag); the gate (G1..G3 boundaries at 30 min and 24 h, `propose` never refusing, the D-19 overlay
  adding and never subtracting); the match rule (guid, tmdb, tvdb, the evaluable rule with an unmapped entry);
  `classifyGuardian` order and the new reasons; term derivation fixtures (the Babygirl example and its reposts, the
  Annabelle FLUX dotted/spaced names, a remux vs WEB-DL of the same group, apostrophes and `&`, a TV season pack and a
  single episode, a different group not matching) plus the self-check fallback; the reconcile set diff, sentinel,
  cap and expiry; the Arm/Disarm payload builder (the live 3.29.0 GET shape in, a PUT with the top-level flags out;
  `useRules` rules).
- **Integration (embedded Postgres, stub HTTP):** migration 0081 applies and replays; the refresh writes and carries
  forward; a sweep with a watchlisted item skips it with `watchlisted`; a stale registry refuses the sweep and writes
  nothing; a recording stub proves the order *arr identity GETs → release-profile PUT → read-back GET → claim →
  Maintainerr handle; a failed PUT deletes nothing; a claim lost to a mid-sweep Save abandons the record and the
  final reconcile removes its term; Expedite item and all follow the same order; the Arm/Disarm toggle sends
  `listExclusions`/`forceSeerr` back unchanged; the invariant refuses a pool with either false; enrollment echoes
  the GET body, skips `already_on`, never re-enables an opt-out, honours `onlyUserIds`; the seed script's dry run
  writes nothing.
- **Web:** the `previewGuardian` parity test with the new cases; the tile note and tooltip render without moving
  neighbours (ADR-015); the paused banner.
- **Guards:** `@hnet/arr/write` import confinement covers the new methods; the no-direct-state-writes guard covers the
  new tables.
- **Live (PLAN-072 S6..S10):** read-only checks, the first guarded sweep, the seed, the canary and the re-requests,
  each with its evidence in the plan log.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Managed Home users: does `POST plex.tv/api/home/users/{id}/switch` with the owner token work without side effects (a new device or session record, disturbing the owner token), and do managed users have a discover watchlist at all? | (open; PRD Q-15, owner's call because it signs in as a managed user) Disabled until answered; managed users count as unreadable. |
| Q-02 | May the guard use friends' **private** watchlists read through Seerr's stored tokens? | **Resolved by the driver decision recorded in ADR-093 C-01/C-06:** yes, as guard input only, never shown or logged. |
| Q-03 | Seerr caches one watchlist response per token with its ETag. Can our sequential page reads interleave badly with Seerr's own 3-minute sync of the same user (a 304 answered from the other page's cache)? Only sequential reads were tested. | (open) PLAN-072 S6 compares a registry read of each Seerr user with a direct read and watches Seerr's sync logs for errors after enrollment. |
| Q-04 | What does a release profile with about 2,600 regex terms cost Radarr and Sonarr per release decision (RSS sync, a search)? | (open) PLAN-072 S7 records Radarr's RSS-sync and search durations before and after; the 3,000 cap is lowered if it hurts. |
| Q-05 | Do the derived terms match real release names: title normalization (apostrophes, `&`, punctuation), remux detection, TV season naming? Anime absolute and daily numbering are out of scope. | (open) PLAN-072 S6 runs the derivation over the 170 pool movies and the ledger's grabbed names read-only and reports the self-check misses. |
| Q-06 | "Index" read as the release (all posts and indexers of one group's release at one resolution), not one NZB post or one indexer. | Driver interpretation (ADR-093 C-07); it matches "the same title, different index". |
| Q-07 | Is a 365-day term life right, or should a block last as long as the title exists anywhere? | (open; PRD Q-16) 365 days bounds the profile; the owner may lengthen it. |
| Q-08 | Should a user's own later opt-out of Seerr watchlist sync be respected? | Driver decision: yes (enroll once). Revisit if the owner wants it enforced. |
| Q-09 | Seerr 3.4.1 creates a missing settings row with `user: req.user` (the API key's user 1). Does TypeORM's cascade from the target user still link it to the target? | (open) The S9 canary targets a user with no settings row and reads the settings back, and user 1's settings are checked unchanged. |
| Q-10 | Do Seerr's default quotas hold back first-enable auto-requests (a `QuotaRestrictedError` is logged only at debug)? | (open) S9 reads `GET /api/v1/settings/main` `defaultQuotas` before the enable. |
| Q-11 | The remediation releases were inferred by size from a copy of the legacy HaynesTower SAB history; Terrifier's ledger year (2018) differs from its release's (2016). | (open) S8 re-reads the live history read-only and confirms each name and the Radarr ids before writing terms. |
| Q-12 | What does `releaseGroup` look like for the 163 disk-imported pool movies (how many are null, so only an exact name or nothing can be blocked)? | (open) Measured by the S6 dry run; a null group with no name is counted `unblockable`. |
