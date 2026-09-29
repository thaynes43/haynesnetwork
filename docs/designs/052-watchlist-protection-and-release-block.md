# DESIGN-052: Watchlist protection for Trash — the Watchlist Registry, the Registry Gate, the Watchlist Keep, the Release Block, and everyone's Seerr watchlist

- **Status:** Accepted (2026-09-28; live since v0.101.0, PLAN-072 S6–S10 verified)
- **Last updated:** 2026-09-28 (PLAN-072 S8–S10 done live: D-25di records the rulings; the Seerr Sonarr settings PUT must omit the read-only `id`). Prior: 2026-09-27 (PLAN-072 S6 (a)..(g) passed live on v0.101.0; D-25dd..D-25dh record its results and
  the rulings they needed: a term now matches the raw release title Radarr and Sonarr test (an apostrophe inside a word
  is an optional separator, an accented letter an alternation, an inner `and` optional), because S6(e) found 345 of
  19,434 Sonarr names and 3 of 1,159 Radarr names the *arr would not have blocked; the owner leaves managed Home users
  out (Q-01, PRD Q-15); 2 of 164 pool items kept `release_unrecorded` is not material (Q-12; Q-13 not asked); Q-03 and
  Q-05 answered; D-25q's split is 21 / 21 live; a renamed-only term's reach is an accepted limit (ADR-093 C-22); folded
  into the overview, D-02, D-12, the test strategy and the open questions. D-25di records the review of that fix: `´`
  is an apostrophe to the fold as well, `İ` is written as itself, a word the two readings disagree on falls back
  alone, and a double-escaped `&amp;` or `&#39;` spelling matches the plain ones). Prior: 2026-09-26 (D-25db and D-25dc
  record the review of the PLAN-072 S4 deploy, haynes-ops #3223:
  every sweep and registry CronJob suspend and resume in the rollout goes through haynes-ops git, never `kubectl`,
  and the registry CronJob runs `backoffLimit: 0`; folded into D-20). Prior: 2026-09-26 (D-25cr..D-25da record the
  fourth review pass of PR #595: a renamed-only term's
  widened years leave out a namesake's year, the `--manual` seed's term takes the *arr's years, a season-less ledger
  import is blocked by its exact name or keeps the series, the rollback forbids the older image's Rules-tab Arm/Disarm,
  the Library notice keeps the watchlist note on Save, the Start-a-batch preview counts only freeable bytes and
  mirrors the `propose` filter, the Expedite-all protected line and the Expire now outcome lines are pinned and
  dash-free, and the stubs keep a release profile per *arr; folded into D-08, D-10, D-11, D-12, D-15, D-16, D-20 and
  D-21; ADR-093 C-13 now holds the web delete paths with the sweep, per D-25cc, and glossary T-73 names the ADR-093
  discipline). Prior: 2026-09-26 (D-25ca..D-25cq record the third review pass of PR #595: the D-19 overlay takes an
  add whose outcome plex.tv never confirmed and an undone remove, the web delete paths held with the sweep until S6,
  a failed Phase A cleans the *arr that failed, the upkeep checks the profile itself and also runs in the registry
  job, a sweep that throws records its pause, the seed records a term once, identity checks the external id, an
  enrollment keeps the user's own flags, the registry failure lines log the status, the card's exclusion counts do
  not wait on a hung *arr, the Expire now preview and the Library notice know the watchlist keep, the tile view and
  the stubs are tested, and hard rule 4 names every write; folded into D-05, D-10, D-11, D-13, D-14, D-15, D-17,
  D-19, D-20, D-21, D-22 and D-23). Prior: 2026-09-26 (D-25bn..D-25bz record the second review pass of PR #595: an owner list that shifts
  between pages, the re-add window from its own sighting, a record per name for a movie's exact fallback, fold-only
  terms counted, the hourly Release Block upkeep, a pending enrollment row, the episode pool invariant, the Expedite
  and gate refusal copy, the Expire report's abort reason, the card's first-failed headline, the unverifiable reasons
  and OPS-017's alerts; folded into D-02, D-05, D-12, D-13, D-14, D-16, D-17, D-22 and D-23). Prior: 2026-09-26
  (D-25ax..D-25bm record the rulings from the PR #595 code review: a handle's lost
  answer settled by the *arr's own answer, the D-19 margin and late re-read, the per-delete log line, `seerr_only`
  accounts while Seerr's user list fails, every name of a series key and of a ledger key, a stale ledger import, the
  short exact name, a pause that ends when its batch leaves, the card's "Lists" split, re-adds counted by title, the
  phone tile note, the S6(e) pool report, the shared Phase A seam and the copy added for review; folded into D-10,
  D-14, D-19, D-21, D-22 and the test strategy). Prior: 2026-09-26 (D-25 also records the rulings made while building
  PLAN-072 S2 part 2: the
  Deleted-Release Record, the Release Block writer and the two-phase sweep and Expedite, the seed, the Arm/Disarm fix,
  the Seerr enrollment and the D-23 counts, rows D-25ad..D-25aw). Prior: 2026-09-26 (D-25 records the rulings made
  while building PLAN-072 S2 part 1: the registry, the gate and snapshot, the guard and the D-10 surfaces). Prior:
  2026-09-26 (D-24 records the rulings from the PR #594
  design review, folded into D-01..D-22
  and the test strategy: Seerr answers are classified by content, per-source read states, the manual Expire path,
  a required watchlist snapshot, the year alternation and a whitelist grammar for terms, records activated only
  after a verified delete, a bulk legacy SAB seed, items with no recordable term kept, a sweep that pauses cleanly;
  D-23 adds the re-add evidence and exclusion visibility ADR-084 E-4/E-5 asked for. Prior: 2026-09-26, first
  draft, PLAN-072 S1)
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
   managed     not read: the owner left them out (Q-01, D-25de), so they are unresolvable
        │  per account and source: ok | failed | not applicable   (a failed read never removes a title;
        │  an empty answer after a list with titles is a failed read, D-04)
        ▼
   watchlist_registry_accounts / _sources / _items  (+ plex_discover_ids)  ──►  Registry Gate (D-07)
                                                                                     │
 space-policy :17 ─ proposal leaves watchlisted titles out (D-08) ◄──────────────────┤
 sweep :45 ─ refresh ─ gate ─ guardian keeps `watchlisted` (D-09) ─ record release ─ Release Block PUT
            + read-back ─ claim ─ Maintainerr handle ─ *arr GET ─ record active (D-14)  │
            (a refusal is a clean `paused` outcome, trash_sweep_status)                 │
 Expedite, manual Expire now ─ same gate (no refresh), guardian and release steps       │
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

An account new to the roster starts with each of its sources `never_read` (D-04). An account missing from the
roster is marked `left_at` and keeps protecting its titles for 24 hours; only then is it deleted with its items (it
no longer has access), so a flapping or partial roster read never drops protection at once. The roster read failing fails the whole refresh
(D-04).

### D-02 — Read paths (exact shapes)

Every call sends `X-Plex-Token` (owner token) or `X-Api-Key` (Seerr), `Accept: application/json`, and for plex.tv
the app's existing `X-Plex-Client-Identifier` and `X-Plex-Product`, never `X-Plex-Version` (ADR-092 C-08). Each
call has a 10 s timeout and up to 3 attempts on 429, 5xx or a network error, backing off 2 s times the attempt.

**Owner.** The existing `@hnet/plex` `getWatchlist()` (discover provider, `includeGuids`, 100 per page, at most 20
pages; a truncated read is a failure). Rows carry the discover id (the `plex://` guid suffix) and tmdb/tvdb/imdb. The
list is paged by offset, so a later page whose `totalSize` differs from the first page's means the list changed
between pages; the whole read is repeated once from the start, and a second inconsistent read is truncated (D-25bn).

**Friends and full Home members: community.plex.tv GraphQL**, as an HTTP GET:

```
GET https://community.plex.tv/api?query=<q>&variables=<v>
q = query W($uuid: ID = "", $first: PaginationInt!, $after: String) {
      user(id: $uuid) { watchlist(first: $first, after: $after) {
        nodes { id guid type title year } pageInfo { hasNextPage endCursor } } } }
v = {"uuid":"<account uuid>","first":100,"after":<endCursor or null>}
```

`first` must be 10..100. At most 50 pages per account; 120 ms between calls. Answer classes (D-04 turns each into
the source's outcome):

- HTTP 200 with `data.user.watchlist` and **no** `errors` entry: **answered**, with its nodes (possibly none).
- HTTP 200 with no data whose `errors` all start with `User not found:`: **not found**. The managed users answer
  this today (`Data loader item not found`); a made-up uuid answers the same, and a private list can too (`User not
  found: User privacy prevents viewing` is reported against Maintainerr's community reads). So it does not mean
  "no list".
- Anything else is **failed**: non-200, non-JSON, any other `errors` entry (a partial answer that carries data
  **and** errors included), a node `type` other than `MOVIE` or `SHOW`, a node `id` that is not 24-hex, more than 50
  pages.

Nodes give `id` (24-hex discover id), `type`, `title`, `year`. `type` is the upper-case GraphQL enum `MOVIE` or
`SHOW` (re-probed live 2026-09-26 on the owner's first page: 66 `MOVIE`, 34 `SHOW`), mapped to kind `movie` / `show`;
any other value fails the account's read, never a silent skip. No external id is available (research §2); D-03
maps them.

**Seerr users** (16 at authoring, including the owner; 17 Plex users at PLAN-072 S6, 2026-09-27, the owner among
them, whose link is recorded but read through discover, D-25e, so 16 Seerr sources):

```
GET http://seerr.media.svc.cluster.local:5055/api/v1/user?take=100&skip=<n>      → results[{id, plexId, userType}]
GET http://seerr.media.svc.cluster.local:5055/api/v1/user/{id}/watchlist?page=<p>
    → {page, totalPages, totalResults, results[{id, ratingKey, title, mediaType, tmdbId}]}
```

20 per page; pages read sequentially per user (Seerr caches one response per token, Q-03). `ratingKey` is the
discover id (Seerr fetches `discover.provider.plex.tv/library/metadata/<ratingKey>` for each item); `mediaType` is
`movie` or `tv`.

**Seerr never reports a failure on this route, so its answers are classified by content, not by status.** Seerr
3.4.1's `PlexTvAPI.getWatchlist` (`server/api/plextv.ts`) wraps the discover call and the page's 20 per-item
metadata fetches in one try/catch. On any error (a revoked or expired stored token, a plex.tv 5xx, 429 or timeout,
one non-404 failure among the metadata fetches, which rejects the whole `Promise.all`) it logs `Failed to retrieve
watchlist items` and returns `{totalSize: 0, items: []}`, and the route (`server/routes/user/index.ts`) answers
HTTP 200 `{page, totalPages: 0, totalResults: 0, results: []}`: the same body as an empty list, on any page. Loki
already shows these errors from the owner-only sync (2 in one day, one a plex.tv 503). The reader therefore:

1. Takes `totalResults` and `totalPages` from page 1 and reads pages 2..`totalPages` in order (at most 50).
2. Calls the read **inconsistent** when a later page reports a different `totalResults` or `totalPages` (including
   `totalPages: 0`), when a page before the last returns no results, or when a page repeats a `ratingKey` of an
   earlier page (Seerr's ETag cache answering one page with another page's body, Q-03, or the list shifting between
   page reads). An inconsistent read is repeated once from page 1 after 2 s; a second inconsistent read is
   **failed**.
3. Calls a read with `totalResults: 0` **empty**; D-04 decides whether that is ok (it is failed when the source's
   last ok read had titles). An empty page 1 is also repeated once after 2 s before it is classed.
4. Calls the read **failed** on non-200, non-JSON, a `ratingKey` that is not 24-hex, or a `mediaType` other than
   `movie` / `tv`.
5. Does **not** check that the results add up to `totalResults`: Seerr legitimately drops, per page, every item
   with no tmdb guid and every item whose metadata answers 404. Those titles are a coverage limit (ADR-093 C-05).
6. Reads Seerr's own local Watchlist rows as the list when a user has any, because the route answers those instead
   of the Plex list. None exist today (research §2); S5 re-checks, and it is a coverage limit too (C-05).

A user with no stored token answers an empty list. All 16 have a stored token; the 15 that answered with titles
prove theirs works, and the one that answered 0 is unverified, because 0 is also the error answer (research §2). At
PLAN-072 S6 (2026-09-27) the 16 Seerr sources (2 full Home members, 14 friends) all read `ok`, 15 with titles and one
with 0 (`empty_unverified`), and each equalled a direct sequential Seerr read in two runs (Q-03).

**Managed Home users.** `POST https://plex.tv/api/home/users/{id}/switch` returns an `authenticationToken` for the
managed user, which could read that user's discover watchlist like the owner path. It is a POST that mints a token
and a session, and it stays **off**: the owner answered Q-01 (PRD Q-15) on 2026-09-26, "Leave them out", and is moving
everyone on Plex Home to their own account linked with the server (D-25de). A managed user's only source is
`not_applicable`, so the account is `unresolvable` (D-04) and never blocks. A member who moves to their own account
appears in the roster at the next refresh (D-01) and is read like any other account. (Had the switch been enabled,
its token would have lived in memory for one refresh, never stored or logged, and a failed switch would have been
**failed** for that source.)

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

### D-04 — The refresh, and the per-source and per-account state

`refreshWatchlistRegistry({ trigger })` in `@hnet/domain` (the only writer of the registry tables):

```
take pg advisory lock 'watchlist-registry'
    (the CronJob skips its run if the lock is held; the sweep waits up to 120 s, and if a run finished `ok`
     while it waited, it uses that run instead of starting another)
insert watchlist_registry_runs(trigger, status 'running')
roster ← D-01                                    failure ⇒ run 'failed' (failure 'roster'), stop
upsert accounts; mark missing ones left_at; delete those missing for 24 h (cascade their sources and items)
owner ← discover watchlist                       failure or truncated ⇒ run 'failed' ('owner'), stop
for each other account, sequentially, one transaction per account:
    for each of its sources, Seerr first (Seerr when linked; community for friend/home_full;
                                          switch for managed, not_applicable while disabled):
        outcome ← the D-02 answer and the outcome rules below: ok | failed | not_applicable
        ok                      ⇒ replace that source's items (inserted ON CONFLICT DO NOTHING)
        failed / not_applicable ⇒ keep that source's items exactly as they were
        the source's status ← the source table below
    the account's status ← derived from its sources (below)
map up to 200 unmapped discover ids (D-03)
prune runs older than 7 days
run ← 'ok' with counts
```

State is kept **per (account, source)**, because failures are per source: one source failing never changes what
another source of the same account contributes, blocks or freezes.

**Outcome rules.** "Had titles" means the source's last ok read (`last_ok_count`) returned at least one title.

| Answer (D-02) | Source had titles? | Outcome |
|---|---|---|
| community answered with titles; Seerr consistent with titles; switch ok | any | `ok` |
| community answered empty; Seerr empty | no (never read, or read empty) | `ok`, with `empty_unverified` (a hidden community list and a failed Seerr read both look like this) |
| community answered empty or not found; Seerr empty | yes | `failed` (carried forward), logged `account_hidden` once; see the exception below |
| community not found | no | `not_applicable` |
| failed (D-02), inconsistent twice (Seerr) | any | `failed` |

Exception: a **community** source that had titles and now answers empty or not found, on an account whose **Seerr**
source is `ok` with titles in the same run, turns `unreadable` at once instead of blocking. That account's whole
list, private titles included, is read through Seerr with its own token, so nothing it lists can be missed; the
community source's last titles stay frozen. Only a Seerr read of the same account settles a community transition
this way; a community read never settles a Seerr one (community cannot see private lists).

**Per-source status:**

| Status | When | Blocks the gate? |
|---|---|---|
| `read` | `ok` this run | no |
| `carried` | `failed` this run after an earlier ok read; `failing_since` set on the first failure, cleared by the next ok read | only once `last_ok_at` is older than 24 h (D-07) |
| `never_read` | `failed` with no ok read ever (new to the roster, or a new source) | yes, at once: there is no `last_ok_at` (D-07) |
| `unreadable` | `carried` or `never_read` continuously for 72 h (`failing_since` ≤ now − 72 h), or the community exception above; it keeps its frozen items | never |
| `not_applicable` | the source cannot read this account: community not found with nothing ever read, a managed user while the switch is disabled | never; its stored items (if any) are kept |

**Per-account status** (stored, derived, for the counts and the Watchlists card): `never_read` if any source is
`never_read`; else `carried` if any is `carried`; else `unreadable` if any is `unreadable`; else `unresolvable` if
every source is `not_applicable`; else `read`. `empty_unverified` is counted per source (ADR-093 C-05).

The rule that makes this fail closed: **a failed read never removes a title**, and an empty answer after a list with
titles is a failed read. A title leaves the registry only when an ok read of that source no longer lists it while
still listing something, or when the account leaves the roster (D-01). `not_applicable`, `unresolvable` and
`unreadable` never delete stored items. An `unreadable` source keeps its last titles indefinitely; a later ok read
returns it to `read`.

Accepted cost (ADR-093 C-05): the registry cannot tell a hidden list, a Seerr read that failed inside Seerr, or a
list its owner truly emptied from one another. So when anyone empties a list the registry had read with titles
(a friend hiding it, or removing the last title of a short list), that source keeps its last titles, blocks deletion
from 24 h to 72 h, then turns `unreadable` with its titles frozen until the list has titles again. The pause is
visible (D-10) and bounded; the alternative, believing the empty answer, lets one plex.tv error strip a list.

A whole-run check was considered (fail the run when the number of community sources with titles halves against the
previous ok run, a community backend answering empty for everyone) and not adopted: the outcome rules already carry
every such source forward, so failing the run would only pause reclaim without protecting another title. The run
logs `community_mass_empty` (warn) instead when it happens.

### D-05 — Data (migration **0081**, `0081_watchlist_protection.sql`)

Next free number verified 2026-09-26: `packages/db/migrations` ends at `0080_watchlist_marks.sql` and no open PR
adds one. New tables, all written only by `@hnet/domain` single-writers (added to the no-direct-state-writes guard):

- **`watchlist_registry_runs`**: `id` uuid pk, `trigger` (`schedule` / `sweep` / `manual`), `status` (`running` /
  `ok` / `failed`), `failure` text null (`roster`, `owner`, `owner_truncated`), `started_at`, `finished_at` null,
  `counts` jsonb (per class and status, per source and outcome, `emptyUnverified`, `accountHidden`, `entries`,
  `distinctTitles`, `mapped`, `unmapped`). Index `(status, finished_at desc)`.
- **`watchlist_registry_accounts`**: `plex_account_id` text pk, `class` (CHECK owner / home_full / home_managed /
  friend / seerr_only), `plex_uuid` text null, `seerr_user_id` int null, `status` (derived, D-04; CHECK never_read
  / read / carried / unresolvable / unreadable), `first_seen_at`, `left_at` null, `item_count` int, `updated_at`.
  No username, title, email or token.
- **`watchlist_registry_sources`** (the per-source state, D-04): `plex_account_id` (FK, cascade), `source` (CHECK
  discover / community / seerr / switch), PK `(plex_account_id, source)`; `status` (CHECK never_read / read /
  carried / unreadable / not_applicable), `last_outcome` (CHECK ok / failed / not_applicable), `last_error_class`
  text null (an error class, never a body), `last_attempt_at`, `last_ok_at` null, `failing_since` null,
  `last_ok_count` int null, `empty_unverified` bool, `hidden_logged_at` null (so `account_hidden` logs once),
  `updated_at`.
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
  `years` int[] (the term's year alternation, D-12), `term` text null, `term_confidence` text null (CHECK null or
  verified / low_confidence, D-12), `state` (CHECK in_flight / active / abandoned / expired / pruned), `origin`
  (CHECK sweep / expedite / backfill / remediation), `recorded_at`, `activated_at` null, `expires_at`, `ended_at`
  null, `readd_seen_at` null, `readd_same_release` bool null (D-23). Indexes `(arr_kind, state)`,
  `(media_item_id)`, `(tmdb_id)`, `(tvdb_id)`. **No URL is ever stored** (NZB and download URLs carry indexer API
  keys).
- **`seerr_watchlist_enrollments`**: `seerr_user_id` int pk, `plex_account_id` text null, `enrolled_at`,
  `already_on` bool, `optout_observed_at` null, `last_checked_at`, `confirmed_at` null (null = pending: inserted
  before the app's write, confirmed once both flags are seen on, D-25bs), `movies_before` and `tv_before` bool null
  (the user's own flags before the app's write, what a rollback restores, D-25cj).
- **`trash_sweep_status`** (one row, `id` smallint pk CHECK = 1; D-14): `last_outcome` (CHECK ok / paused_gate /
  paused_release_block / paused_audit_unsafe / aborted_arr), `last_reason` text null (a reason code, e.g. `stale`,
  `account_unverified`, `validate`, `read_back`, `duplicate_profile`), `last_at`, `paused_since` null (set on the
  first non-ok outcome with a batch due, cleared by the next ok one), `last_ok_at` null.

Changed tables: `trash_batch_items` gains `keep_reason` text null (CHECK null or tag / recently_watched /
watchlisted / unevaluable / not_in_pool / live_excluded / release_unrecorded); `trash_candidates` gains `plex_guid`
text null and `rule_evaluation_failed boolean not null default false` (the read-model the walls and the Expedite
preview use, ADR-035; filled by `refreshTrashCandidates`, carried by `readCandidateSnapshot` into
`shapePendingItems`); `sync_runs.run_kind`'s CHECK is rebuilt with `watchlist-registry` (the SYNC_RUN_KINDS parity
rule). App setting (no DDL): `seerr_watchlist_enroll` = `{ "enabled": false, "onlyUserIds": null }`, absent means
off, every change audited like every app setting.

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

**The snapshot is a required, typed parameter that carries its purpose.** `shapePendingItems` and
`listTrashPending` are shared by eight callers (Expedite item and all, `resolvePendingTarget`,
`guardRecentlyWatched`, `createBatchFromPending`, the space policy, `expireOneBatch`, the paged wall and its
preview), and the natural default of "no snapshot" would read every item as not listed and evaluable (all pool
items carry a `plex://` guid), which makes it deletable. So:

```
WatchlistSnapshot = { purpose: 'delete',  verified: true,  keys, runId }     from the gate, purpose delete
                  | { purpose: 'propose', filtered: boolean, keys, runId }   from the gate, purpose propose
                  | { purpose: 'display', keys, runId }                     the newest ok run, for walls and previews
```

- The parameter has no default in TypeScript. At run time, a missing snapshot, or a `delete` snapshot that is not
  verified, sets `watchlistEvaluable = false` on every item, so `classifyGuardian` keeps each one as `unevaluable`
  (fail closed).
- `propose` with `filtered: false` (no ok run within 24 h, D-07) also leaves every item not evaluable; a proposal
  still proposes it (D-08) and the sweep decides.
- `display` evaluates normally against the newest ok run; with no ok run at all it behaves like a missing snapshot.
- Every delete path (`expireOneBatch`, both Expedite scopes, and the helpers they call, `resolvePendingTarget` and
  `guardRecentlyWatched`) passes a `delete` snapshot; a guard test asserts it, like the existing import guards.

### D-07 — The Registry Gate (the exact fail-closed rule)

`evaluateRegistryGate({ now, purpose })` in `@hnet/domain`:

```
run ← newest watchlist_registry_runs row with status 'ok'
G1  run exists and run.finished_at ≥ now − 30 min                         else refuse 'stale'
G2  (implied by 'ok') the roster was read and the owner's whole list was read
G3  no (account, source) row of a current account is never_read, or carried with last_ok_at < now − 24 h
                                                                          else refuse 'account_unverified' (count)
verified ⇒ snapshot = every watchlist_registry_items row (carried, unreadable, not_applicable and unresolvable
                      sources included) ∪ the owner's live watchlist_add Watchlist Changes since run.started_at (D-19)
```

- **purpose `delete`** (the batch sweep, the manual Expire now, Expedite item and all): G1..G3 must hold. The gate
  throws `WatchlistRegistryUnverifiedError`. The scheduled sweep catches it after the Maintainerr safety audit and
  before touching any batch and returns a clean `paused` outcome (D-14; the Job exits 0); the batch stays
  `leaving_soon` and the next hourly run tries again. Expedite and the manual Expire now answer
  `PRECONDITION_FAILED` with the reason.
- **purpose `propose`** (space policy, manual batch creation): never refuses. It uses the newest ok run if it
  finished within 24 h, and otherwise proposes without the filter (logged `gate … purpose=propose filtered=false`),
  because the sweep is where deletion is enforced.
- Only the scheduled sweep (`sweepExpiredBatches({ registry: 'refresh' })`, the `trash-batch-sweep` mode) runs
  `refreshWatchlistRegistry({ trigger: 'sweep' })` first, and only when at least one batch is due. If that refresh
  fails, G1 can still pass on the CronJob's run at `:44` (at most 30 minutes old). **The web pod never refreshes
  inline:** Expedite and the manual Expire now (`sweepExpiredBatches({ registry: 'gate-only' })`) take the gate on
  the CronJob's newest run, so a tRPC mutation never runs a 42-account read.
- Constants in code (not settings): `REGISTRY_MAX_AGE_MIN = 30` (two missed CronJob runs refuse), `ACCOUNT_CARRY_MAX_H
  = 24`, `ACCOUNT_UNREADABLE_AFTER_H = 72`.
- Item level: an item that is not `watchlistEvaluable`, or that Maintainerr flags `ruleEvaluationFailed`, is kept
  as `unevaluable` (D-09).

What the bounds mean: a title watchlisted within the last 30 minutes before a sweep that could not refresh can be
missed; a title added through a source whose reads have failed for up to 24 hours can be missed; after 24 hours that
source blocks all deletion until it reads again or turns `unreadable` at 72 hours, which is counted and shown.

### D-08 — The guard at proposal time

- `listTrashPending` (the live read the batch snapshot and the sweep use) joins the snapshot from D-07.
- `selectBatchCandidates`: for a **targeted** batch (every space-policy batch, `maxItems`/`targetBytes`), an
  `onWatchlist` item is dropped with the `dnd` items, so it never takes one of the 50 slots. For an untargeted
  (manual) batch it is snapshotted `pending`, and the sweep's guardian skips it with `keep_reason = 'watchlisted'`
  if it is still listed then (D-09); the wall's "On a watchlist" note comes from the registry either way. It is not
  snapshotted `protected`: that state's only control, Unprotect (`unprotectBatchItem`), deletes a Maintainerr
  exclusion and revokes a Save Intent, neither of which a watchlist keep has.
- The space policy's `minCandidates` counts deletable candidates only (not `dnd`, not watchlisted).
- An item that is not `watchlistEvaluable` is proposed normally; the sweep decides.
- The Start-a-batch preview (`previewTargetSelection`) mirrors the pick: `pendingCandidates` reports
  `watchlistFiltered` (the `propose` rule, an ok run under 24 hours old), and while it is false the preview takes
  watchlisted titles as the server will (D-25cx). Its "frees" figures count only what can go: a watchlisted title
  frees nothing while it stays listed (`freesBytes`, D-25cw).

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
  case-by-case parity test in `apps/web/lib/__tests__/trash.test.ts` grows the new cases, a `ruleEvaluationFailed`
  item among them. The server Expedite preview (`partitionPendingForExpedite` over the candidate snapshot) sees the
  flag through `trash_candidates.rule_evaluation_failed` (D-05), so the preview never counts as deletable an item
  the server keeps (the drift ADR-086 D-11 exists to prevent).
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
  watchlist", "Kept: watched recently", "Kept: couldn't be checked", "Kept: no longer a candidate", "Kept: saved",
  "Kept: its release couldn't be recorded".
- **Expedite confirm:** the protected count's breakdown includes "on a watchlist"; the protected line is
  `EXPEDITE_PROTECTED_REASON` ("recently watched, whitelisted, or on a watchlist; they are kept."), never "Maintainerr
  keeps" or "requested" (D-25bk, D-25cy).
- **Expire now confirm** (D-25cm): a watchlisted pending row is a certain keep, like recently watched: it leaves "Up
  to N will be deleted" and the typed override count, and the kept line names "on a watchlist". Its three outcome
  labels end in a colon, never a dash (`expireConfirmLines`, D-25cz).
- **The Library item page's Trash notice** (D-25co): a watchlisted pending title shows the tile note (bookmark, "On a
  watchlist. It won't be deleted while it stays there.") in place of "Save it to keep it", and keeps it after a Save
  (the title is still listed; the line never unmounts, D-25cv).
- **Sweep paused** (`trash_sweep_status.paused_since` at least 6 hours old: no sweep of a due batch has succeeded for
  6 hours, for any reason, D-14): a warning banner on the Trash page for anyone with Trash access, worded by the
  reason: gate, "Deletions are paused until watchlists can be checked."; release block, "Deletions are paused until
  removals can be done safely."; audit unsafe or *arr down, "Deletions are paused until the media apps respond
  normally." (the built copy, D-25aa). A shorter pause shows nothing: one refused hourly run is routine. The pause
  ends with the next ok sweep, or as soon as no batch is due any more (D-25bf).
- **Trash settings, a read-only "Watchlists" card (admins):** "Checked 6 minutes ago. 21 accounts read, 21 can't
  be read." with the per-class counts and a "Lists" group that splits every account the same way as the headline
  (D-25bg); never a name or a title. It also shows the Release Block and re-add counts of D-23.
- **On a phone** (480 px and narrower) the tile note is the bookmark alone; the tooltip and aria-label carry the
  words (D-25bi).

### D-11 — The Deleted-Release Record: what identity exists

Recorded for every item the sweep or Expedite is about to delete, before the handle (D-14). Sources, in order of
preference:

**Movies (Radarr)**

1. `GET /api/v3/moviefile?movieId={id}`: `id`, `relativePath` (the renamed file name, e.g. `101 Dalmatians (1996)
   {imdb-tt0115433} [WEBRip-1080p][EAC3 2.0][x264]-NTb.mkv`), `sceneName` (the release name, when imported from a
   download), `originalFilePath` (the original release folder or file name, when Radarr kept it; set on 7 of the
   170 pool files), `releaseGroup`, `quality.quality` (`name`, `resolution`, `source`, `modifier`), `size`. The
   movie's own `year` and `secondaryYear` come from the movie record (21 of the 170 pool movies have a
   `secondaryYear`).
2. `GET /api/v3/history/movie?movieId={id}` with `eventType` 1 (grabbed) and 3 (`downloadFolderImported`). The file
   resource carries no `downloadId`, so the link runs through the import: the import record whose `data.fileId`
   equals the file's `id` (or, when that is absent, whose `data.importedPath` ends with the file's `relativePath`,
   or whose `sourceTitle` equals `sceneName`) gives the `downloadId`, and the grab with that `downloadId` gives
   `sourceTitle`, `data.indexer`, `data.releaseGroup`.
3. The ledger: the latest `imported` `ledger_events` row for the media item before the delete, and the `grabbed` row
   with its `downloadId` (`payload.sourceTitle`, `releaseGroup`, `quality`, `indexer`); these outlive the delete
   (research §5). Taking the latest import, not any grab, means an upgraded title blocks the release that was
   deleted, not one it superseded.

The item is read by `media_items.arr_item_id`, which an *arr rebuild can reassign until the next sync, while
Maintainerr deletes by tmdb (Radarr) or tvdb (Sonarr): the item read must carry the ledger's external id, otherwise it
is another title and the survivor is kept `release_unrecorded` (`id_mismatch`, D-25ci).

The release name used for the term is, in order: the grab's `sourceTitle`, `sceneName`, the last path segment of
`originalFilePath`, the ledger's `sourceTitle`. `identity_source`: `arr_grab_history` (1+2), `arr_file` (the file's
`sceneName` or `originalFilePath`, or, when both are null, only group and quality from the file), `ledger_grab` (3),
`none` (the movie has no file: nothing to re-fetch). Live today (pool 1, 170 movies): 7 carry a `sceneName`; 163
came from disk in July and carry only the renamed file name, group, quality and size (research §5).

**Shows (Sonarr)**

1. `GET /api/v3/episodefile?seriesId={id}`: per file `id`, `seasonNumber`, `relativePath`, `sceneName`,
   `originalFilePath`, `releaseGroup`, `quality`, `size`.
2. `GET /api/v3/history/series?seriesId={id}` with `eventType` 1 and 3, joined the same way (the import's
   `data.fileId` to the file, its `downloadId` to the grab's `sourceTitle`).
3. The ledger, as for movies.

One record per distinct (season, release group, resolution) of the series' files, with a matching release name
when one is known. Season 0 (specials) is skipped. A ledger import whose name carries no season (a daily episode, a
complete-series pack) gets an exact record per name, and one with no name or no term keeps the series (D-25ct).

**No recordable term, no delete.** When a survivor's group and release name are both unknown, or D-12's self-check
rejects every form, no term can block its release, and deleting it would let a later re-request fetch the same
release, which ruling 2 forbids. Such an item is **kept**: the sweep and Expedite skip it with `keep_reason =
'release_unrecorded'` (the same keep as a failed identity read, D-14), and it is counted `unblockable` (Q-12). It
stays in the pool and comes back in later batches, each time re-checked, so a file that gains a group (an
upgrade, a rename) becomes deletable. If PLAN-072 S6(e) finds this keeps a material share of the pool, the owner is
asked then (Q-13) whether those titles may be deleted unblocked; until he answers they are kept.

### D-12 — Deriving the "must not contain" term

Tokens: the double-escaped entities `&amp;`, `&#39;` and `&apos;` read as their character (D-25di), apostrophes
removed (before NFKD as well, so `´` is one and not a space and an accent), Unicode NFKD, combining marks removed,
`&` read as `and`, lowercase, split on `[^a-z0-9]+`. The title tokens come from the known release name (the tokens before its year) when there is one,
else from the *arr's title. Each term is a Perl-style regex Radarr and Sonarr accept (`/pattern/i`, matched against
the release title; research §5). `SEP` below is `[^a-z0-9]`, not `[\W_]`: .NET's `\W` is Unicode-aware and
JavaScript's (without `u`) is ASCII-only, while `[^a-z0-9]` under `/i` matches identically in both on release
titles, so the in-app self-check tests exactly what Radarr and Sonarr will run.

**A term is written from the raw names (D-25dd).** The tokens decide what a name's title, year and season are, but
Radarr and Sonarr test a term against the release title as it is, so each title word (and each word of the exact
form) is written back with what the raw names show there:

- an apostrophe inside a word is an optional separator or apostrophe entity: `(?:SEP|&(?:#39|apos);)?` in the title
  (`bob(?:[^a-z0-9]|&(?:#39|apos);)?s` matches "Bob's", "Bob’s", "Bob´s", "Bobs" and a double-escaped "Bob&#39;s"),
  `(?:SEP|&(?:#39|apos);)*` in the exact form (one more word boundary);
- an accented letter is an alternation of the folded letter and the accented ones (`pok(?:e|é)mon`), each a single
  letter in U+00C0..U+024F or U+1E00..U+1EFF that folds to that letter;
- an `and` that is neither the first nor the last word may be absent, or be the `amp` of a double-escaped `&amp;`
  (`(?:(?:and|amp)[^a-z0-9]+)?`, `(?:(?:and|amp)[^a-z0-9]*)?` in the exact form): the fold reads `&` as `and`, and a
  raw `&` is a separator, so "Fast & Furious", "Fast.and.Furious", "Fast&Furious" and "Fast.&amp;.Furious" all
  match.

The apostrophes and accents come from the name the title tokens came from and from every other raw form that starts
with the same words: the record's other release names, its renamed file and the *arr's title (Radarr's renamed file
writes "Fools Gold" and "Vita and Virginia", its title "Fool's Gold" and "Vita & Virginia"). A term therefore only
ever matches more spellings of the same words than the folded tokens alone would.

**The year is an alternation.** Release names often carry another year than the *arr (the Terrifier release says
2016, the ledger 2018), and a disk-imported movie's only name is Radarr's own renamed file, built from Radarr's year.
`Y` is therefore `(?:y1|y2|…)` over the distinct years of: Radarr's `year`; its `secondaryYear`; and the year parsed
from each known release name (the grab's `sourceTitle`, `sceneName`, `originalFilePath`, a ledger or legacy SAB
name). When the record's only name is the renamed `relativePath`, the window is widened to year − 1 .. year + 1, except
at a year where the ledger holds another title of the same *arr with the same title tokens (The Killer 2024 next to
The Killer 2023): that year is left out, so the term never blocks the namesake's releases (D-25cr; the S6(e) report
counts these, `namesakeNarrowed`). The years are stored on the record (`years`).

**Movie, release group known** (the usual case): the title, the year, the resolution, `remux` when the quality is
a Remux, and the group:

```
/^{T}SEP+{Y}SEP(?=.*(?<![a-z0-9]){R}p(?![a-z0-9])){X}.*SEP{G}(?:SEP|$)/i
   T = title words joined by SEP+ (written as above)     Y = one year, or (?:y1|y2|…)     R = 2160 | 1080 | 720 | 480
   X = (?=.*(?<![a-z0-9])remux(?![a-z0-9]))  only for a Remux quality     G = group tokens joined by SEP*
```

Example (Babygirl's deleted file):
`/^babygirl[^a-z0-9]+2024[^a-z0-9](?=.*(?<![a-z0-9])2160p(?![a-z0-9]))(?=.*(?<![a-z0-9])remux(?![a-z0-9])).*[^a-z0-9]framestor(?:[^a-z0-9]|$)/i`
matches `Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR` and its space-separated repost,
and not `Babygirl-2024-2160p iT WEB-DL … -HONE` or the 1080p `-APEX` release. It blocks every post and every indexer
of that group's release at that resolution: "the same title, different index" (ruling 2) is any other release.
Terrifier (Radarr year 2018, release name `Terrifier.2016.Uncut…REMUX-FraMeSToR`) gets `Y = (?:2016|2018)`.

**Movie, no group but a release name:** the exact name, separator-insensitive:
`/^{all words of the name, written as above, joined by SEP*}(?:SEP|$)/i`.

**Show, per (season, group, resolution):**

```
/^{T}SEP+(?:{Y}SEP+)?s0*{S}(?:e[0-9]+)*(?![0-9a-z])(?=.*(?<![a-z0-9]){R}p(?![a-z0-9])).*SEP{G}(?:SEP|$)/i
```

This covers season packs and single episodes of that season from that group. Absolute (anime) and daily numbering
are not covered (documented; Q-05).

**The grammar is a whitelist.** Radarr 6.4.4 and Sonarr 4.0.20 do not validate a term on POST or PUT (the
`ReleaseProfileController` only rejects an empty one); a regex term is compiled at decision time
(`PerlRegexFactory.CreateRegex`), and `DownloadDecisionMaker.EvaluateSpec` turns a compile error into a
`DecisionError` rejection of that release. The profile applies to every title on every indexer, so **one term that
does not compile in .NET rejects every release of every movie or series on that *arr** and stops all grabs, visible
only in an error log (ADR-093 C-19). So a term is stored and written only when it equals `renderTerm(parts)` for
parts that are exactly the templates above: every year and group token matches `^[a-z0-9]+$`; every title word and
exact-form word is letters and digits, an accented position being `(?:x|é…)` (one ASCII letter, then single letters
from the ranges above), with the apostrophe join only inside a word and an optional `and` only before a following word
(D-25dd, D-25di); `R` is one of 2160 / 1080 / 720 / 480, `S` is digits, and the only flag is `i`. None of the D-25dd
constructs can fail to compile: a literal letter, an optional group of a character class or literal entities, and an
optional literal group. The
sentinel is the one plain term. The writer re-checks every desired term against this grammar before any POST or PUT
(D-13) and refuses the write otherwise.

**Self-check before recording:** the term is compiled in the app and must match every release name of its record;
a group term that fails falls back to the exact form, and a term that matches nothing it came from is not recorded
(no term, so the item is kept, D-11). The exact form is one name's own prefix, so a record with several distinct real
names whose term falls back to exact gets one record per name, each with its own term, and a name that yields no
term keeps the item (D-25bp for movies and a movie's ledger names; D-25bb and D-25bc for series). A record whose only
name is Radarr's renamed `relativePath` cannot validate its term, because that path is built from the same Radarr
title and year the term is: its term is written with `term_confidence = 'low_confidence'` (otherwise `verified`) and
reported in PLAN-072 S6(e)'s dry run, so the share that blocks nothing real is known before S7. A real release name
the term matches only in its folded form is a release Radarr and Sonarr will not block, since they test the raw
title: that term is `low_confidence` too, and the S6(e) report counts it (`foldOnly`, D-25bq). Since D-25dd the words
carry the raw apostrophes, accents and `&`, so only what the grammar cannot write is left (a decomposed accent inside a
word, a doubled apostrophe, an entity other than `&amp;`, `&#39;` and `&apos;`); over the ledger's 20,594 real names
that is none (348 before).

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
  1. rows past `expires_at` become `expired`. `in_flight` rows older than one hour (a sweep that died between Phase
     A and settling its records, D-14) are settled against the *arr: `GET` the item by `arr_item_id`; a 404, or
     another title at that id (D-25ci), makes them `active` (the delete happened), a live item makes them
     `abandoned` (it did not), and an unreachable *arr
     leaves them `in_flight` with their terms in place (fail closed). Desired = sentinel + the distinct terms of
     `in_flight` and `active` rows, newest first; beyond **3,000** terms the oldest `active` rows become `pruned`
     (WARN);
  2. **validate** every desired term against the D-12 grammar; any failure throws `ReleaseBlockError` (step
     `validate`) before any write, so a malformed term can never reach the *arr;
  3. `GET` the profiles; find ours by exact name. None: `POST`. One: compare the `ignored` sets; equal means no
     write; otherwise `PUT` the whole object. More than one: throw (step `duplicate_profile`; someone copied it; a
     person resolves it, and the paused sweep says so, D-10);
  4. `GET` again and verify every desired term is present (read-back); otherwise throw `ReleaseBlockError` (step
     `read_back`).
- **Idempotent:** a set comparison, so a repeat does nothing; two deletions that derive the same term share it. A
  hand edit is overwritten on the next reconcile, and a deleted profile is re-created; the upkeep's drift check makes
  that reconcile happen within 15 minutes (D-25ce).
- **On schedule (D-25br, D-25ce, D-25cf):** besides the delete paths' reconciles, `reconcileReleaseBlockIfDue` runs
  in the `trash-batch-sweep` job every hour after the sweep and in the `watchlist-registry` job at the end of every
  run (every 15 minutes, so it goes on while the sweep CronJob is suspended), whether or not a batch was due. For each
  *arr it reconciles when an `in_flight` record is older than the hour or an `active` record is past `expires_at`
  (step 1's settle and expiry never wait for the next batch of that kind), when the live terms exceed the cap, or when
  one `GET /releaseprofile` shows the profile drifted from the records: missing while a term is live, duplicated,
  disabled, hand-edited, or an `ignored` set that differs from the sentinel plus the live terms (an abandoned
  record's leftover term, a hand deletion, a restore from an older backup), logged `[release-block] drift`. With no
  live term and no profile, nothing is created. A failure logs `[release-block] upkeep_failed` (warn), never fails
  either job and never pauses the sweep.
- **Growth:** a term lives **365 days** from its record (`expires_at`, extended when the same term is recorded
  again); at about 50 movie deletions a week the profile settles near 2,600 movie terms. The cost of that many regex
  terms per release decision is Q-04.

### D-14 — The sweep, step by step

`sweepExpiredBatches({ registry: 'refresh' | 'gate-only', … })`: the input is required. The `trash-batch-sweep`
mode passes `refresh`; the web `expire` mutation (the manual Expire now, with or without `forceOverride`) passes
`gate-only`, like Expedite. Both need the *arr read and write clients (the sync job builds them; the web mutations
take `resolveArrBundle(ctx)`, D-22). For the due batches (the batch list is read first; with none due, the sweep
does nothing and records nothing, except that a scheduled sweep ends a pause left by a batch that has since gone,
D-25bf):

1. Maintainerr safety audit (ADR-023 C-04, now including the D-16 flags). Unsafe: refuse as today (it throws
   `MaintainerrUnsafeError` and the job fails, the existing signal); nothing is written but the outcome
   `paused_audit_unsafe`.
2. `refresh` only: `refreshWatchlistRegistry({ trigger: 'sweep' })`. Then the gate (D-07, `delete`). Refused:
   nothing is written; the batch stays open; outcome `paused_gate` (reason `stale` or `account_unverified`).
3. Per batch, `expireOneBatch`: the fresh pending read (with the registry join, a `delete` snapshot, D-06) and live
   exclusions, as today. Items gone from the pool or live-excluded: `skipped` with `not_in_pool` / `live_excluded`.
   Guardian keeps: `skipped` with the reason.
4. **Identity** for each survivor (D-11). An *arr read that fails (network, 5xx) counts toward the existing
   consecutive-failure breaker (`HANDLE_FAILURE_LIMIT`, 3): three in a row mean the *arr is down, so the sweep aborts
   before Phase A and leaves the batch `leaving_soon` for the next hourly run (the existing abort path, nothing
   deleted; outcome `aborted_arr`). A single failure between successes skips only that item (`skipped`,
   `release_unrecorded`); it comes back in a later batch. So does a survivor with no recordable term (D-11). An item
   never loses protection for want of a record: no term, no delete.
5. **Phase A, before any delete:** one transaction inserts `in_flight` records for every survivor; then
   `reconcileReleaseBlock` for each *arr involved (at most one PUT each) with its validation and read-back. Failure:
   the `in_flight` rows become `abandoned`, no item is claimed, the batch stays `leaving_soon`, the run logs
   `release-block failed`; outcome `paused_release_block` (reason = the step). A best-effort reconcile then removes
   the abandoned terms from every *arr that may hold them: those that took them, and the one that failed when its
   write may have landed (a `read_back`, or a POST or PUT whose answer was lost; D-25cd). Whatever it leaves, the
   upkeep's drift check removes (D-25ce).
6. **Phase B, per item (unchanged claim discipline):** first the owner's Watchlist Changes made since the
   snapshot's overlay start are re-read (D-19, D-25ay): an item added to his watchlist while the sweep runs is kept
   `watchlisted` and its records are `abandoned`. Then one transaction does the guarded claim (`pending` →
   `deleted`), the `trash_expedited` event and the deletion audit (ADR-034/035), and stamps the item's records with
   `batch_item_id`; they stay `in_flight`. A lost claim (Saved mid-sweep) flips them to `abandoned`. Then the
   Maintainerr handle.
7. **Settle each record after its handle, always by the *arr's own answer** (D-25ax). Whatever the handle
   returned, a `GET` of the *arr item follows: a 404 flips the records to `active` (`activated_at` now), even when
   the handle's answer was lost after Maintainerr had deleted the item (a client timeout, a dropped socket, a 5xx;
   `handleMedia` deletes the *arr item first and only then does the rest). An item still present flips them to
   `abandoned`, logged `handle_not_effective`, after a 2xx handle or a definite refusal (an HTTP 4xx such as the 409
   Maintainerr answers while its rule or collection executor holds the lock, or a `code: 0` ReturnStatus): a 365-day
   term must never block the current release of a title that is still in the *arr. The item stays in the pool and
   comes back in a later batch, where it is recorded again. After an ambiguous failure an item still present leaves
   the records `in_flight` (the delete may still be running), and so does a `GET` that cannot be answered: their
   terms stay and the stranded settle decides by presence an hour later (D-13 step 1, run by the upkeep in the sweep
   and registry jobs, D-25br, D-25cf). An item the *arr answers with another title at the same id (an *arr rebuild)
   reads as gone (D-25ci). One `[trash] deleted` line per
   delete follows the settle (D-21, D-25az).
8. After the loop, if any record was abandoned, reconcile again so the orphan terms leave the profile.

A 404 proves the *arr record is gone, not that the files are: Never Let Go (2024) and Sleeping Beauty (2011),
marked deleted on 2026-08-22, have no Radarr record but their files are still on HaynesOps and HaynesTower (research
§3). The term is right for them either way (a re-add would search again); the orphaned files are a Maintainerr
cleanup matter outside this design.

**The sweep pauses cleanly.** `sweepExpiredBatches` catches `WatchlistRegistryUnverifiedError` and
`ReleaseBlockError` and returns a report with `paused: { reason, step }` instead of throwing; the
`trash-batch-sweep` mode logs it and exits 0, so job-failure alerting does not fire every hour for a pause the Loki
alert (D-21) reports after 6 hours. (An unsafe audit keeps today's throw, step 1.) When at least one batch was due,
the scheduled sweep writes its outcome to `trash_sweep_status` (`ok`, or the `paused_*` / `aborted_arr` outcome with
its reason; `paused_since` set on the first non-ok outcome and cleared by the next ok one). Any other throw while a
batch is due (Maintainerr's pending read failing, a database error) records `aborted_arr` with reason `error` and logs
`[trash] sweep_failed` before it rethrows, so the banner and the page fire after 6 hours like any other pause
(D-25cg). The web `expire` mutation maps a paused report to `PRECONDITION_FAILED` with the reason and writes no status
row (the scheduled sweep owns it).

While the web pod runs with `TRASH_WEB_DELETES_HELD` set (PLAN-072 S4 until S6 is green, and the rollback), Expedite
(both scopes) and the manual Expire now refuse before reading anything (`TrashWebDeletesHeldError`,
`PRECONDITION_FAILED`, appCode `TRASH_WEB_DELETES_HELD`, D-25cc).

Expedite (both scopes) runs the same order per call: audit, gate (without an inline refresh), guardian, identity,
Phase A, the late watchlist re-read, claim, handle, settle. It throws instead of pausing:
`WatchlistRegistryUnverifiedError` and `ReleaseBlockError` map to `PRECONDITION_FAILED` (the gate's message is the
banner's wording exactly, D-25bv), and three failed identity reads throw `ReleaseIdentityUnavailableError`
(`RELEASE_BLOCK_ARR_UNAVAILABLE`, `BAD_GATEWAY`, D-25bu). The write paths share one
helper, `recordAndBlockReleases` in `release-block.ts` (identity, the unrecordable survivors handed back before Phase
A, then Phase A), and one settle, `settleReleaseRecords`, so they cannot drift (D-25bl).

Ordering guarantee (ADR-084 E-6): the term is in the *arr's profile, read back, before the handle that deletes the
record, and it stays there (`in_flight`, then `active`) unless the item is proven still present, whatever the
handle answered (D-25ax). A re-add seconds later meets the block on its first search.

### D-15 — Seeding the block: backfill and the three remediation titles

A one-off script, `packages/sync/src/scripts/release-block-seed.ts` (not a sync mode), with `--dry-run` (counts only,
per source) and `--apply`. Its population is every `trash_batch_items` row in state `deleted`, **except** rows whose
*arr record still exists (a live `media_items` row with that `arr_item_id`, confirmed by a `GET` of the *arr item
that answers the same tmdb or tvdb id, D-25ci):
"deleted" overstates reality when a handle failed (The Devil's Mouth is still Radarr 9555 with its file, research
§3), and a term would block the current release of a title that is still there. Each row takes the first identity
that exists, in order:

- **Ledger backfill:** the media item's latest `imported` `ledger_events` row before `deleted_at` and the `grabbed`
  row with its `downloadId` (D-11 source 3) become a record (`origin` `backfill`, `identity_source` `ledger_grab`,
  `expires_at` = `deleted_at` + 365 days, so old deletions age out on the same clock). About 76 movies and 7 series
  qualify (research §5).
- **Legacy SAB backfill** (`--legacy-sab <file>`): every row the ledger cannot identify is matched against the two
  legacy HaynesTower SABnzbd histories (`binhex-sabnzbdvpn`, 2023-09 to 2026-09, and `linuxserver-sabnzbd`, to
  2026-07-03), exported read-only over `hw-ssh` by the coordinator as a file of completed job names, sizes and
  completion times (never committed; it holds no URL). A match needs the normalized title tokens and a year within
  ±1 of the item's (the release's own year is what the term then uses, D-12), a completion before `deleted_at`, and
  the deleted file's size (`deleted_size_bytes`) between 90 % and 100 % of the download's (the three titles below are
  96.8 to 96.9 %, par and container overhead). Several matches of one row (two groups of one size) all become
  records, one per distinct term (the job with the closest size names it, D-25ch: a title fetched 40 times in the
  #576 loop is one record per group, not 40); none leaves the row unidentified. `origin` `backfill`,
  `identity_source` `legacy_sab`. The ledger backfill keeps one draft per term too. The research found a
  completed legacy record for 331 of the 416 deleted movies, 284 of them with no cluster record (research §5).
- **What stays unblockable:** deleted rows with no ledger identity and no legacy match, about 43 movies today (and
  the series the ledger misses). They were deleted before this design and cannot be recorded; they are counted in
  the dry run and the S8 log, and ADR-093 C-21 records them as the known limit of ruling 2.
- **Named checks:** Silent Night and The Unholy Trinity had a friend's add before deletion and no ledger grab or
  import (0 rows each), so only the legacy SAB can seed them; the dry run lists both explicitly, and if the bulk
  match misses either, it is added through `--manual` after the same size check.
- **Remediation** (`--manual <file>`: tmdb id, title, the release's own year, release names): `origin`
  `remediation`, `identity_source` `legacy_sab`. The term's years also take the matched batch row's year, the
  ledger's year for the tmdb id and Radarr's `year` / `secondaryYear` when it still has the movie, so Terrifier's term
  is `(?:2016|2018)` as D-12 says; a batch row a manual entry covers is counted `manual.covered`, not unblockable
  (D-25cs). The names come from the legacy HaynesTower SABnzbd history (read-only
  over `hw-ssh`), matched to `trash_batch_items.deleted_size_bytes` by size. The 2026-09-26 read of a copy gives:
  - Babygirl (2024, tmdb 1097549): `Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR`
    (55.01 GB downloaded, 53.31 GB deleted).
  - Terrifier (tmdb 420634; the ledger says 2018, the release says 2016):
    `Terrifier.2016.Uncut.UHD.BluRay.2160p.DTS-HD.MA.5.1.HEVC.REMUX-FraMeSToR` (41.33 GB, 40.05 GB deleted).
  - Another Simple Favor (2025, tmdb 974573): `Another.Simple.Favor.2025.2160p.AMZN.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265`
    from `-FLUX` or `-Kitsune` (both about 14.57 GB, 14.11 GB deleted; size cannot tell them apart), so both groups
    are blocked. The bulk legacy match also blocks `-BYNDR` (14.56 GB, 0.969 of the size, inside the same window, and
    fetched in the same loop; ruling 2 supports it, D-25ch); other groups remain.
  Q-11 confirms these on the live host before the terms are written.

Every source runs through the same record-and-reconcile writer (the D-12 grammar and self-check included), then a
read-back of the Radarr and Sonarr profiles. The seed runs `--dry-run`, then `--apply`, in PLAN-072 S8, and S9
depends on it.

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
  gains the two fields (present in `GET /api/collections`). An episode pool is not held to `forceSeerr` (D-25bt):
  Maintainerr 3.29.0 never stores it on an episode collection, which the drift check already accounts for.
- **Rolling back past this fix** brings the defect back: the older image's Rules tab toggle drops `listExclusions`
  and `forceSeerr`, and the older audit does not check them. PLAN-072's rollback and OPS-017 §8 forbid Rules-tab
  Arm/Disarm while the older image runs and check the flags before the sweep resumes (D-25cu).

### D-17 — Everyone's Seerr watchlist: enrollment

- **Setting:** `seerr_watchlist_enroll` = `{ enabled, onlyUserIds }`, off until PLAN-072 S9. `onlyUserIds` limits a
  canary.
- **Step:** at the end of each `watchlist-registry` run while enabled, for every Seerr user of type Plex (`userType`
  1) with no confirmed `seerr_watchlist_enrollments` row (and in `onlyUserIds` when set):
  1. `GET /api/v1/user/{id}/settings/main` → the settings body;
  2. both `watchlistSyncMovies` and `watchlistSyncTv` already true: insert the row with `already_on` (the owner),
     confirmed; a PENDING row (the app wrote before and never saw the answer) is confirmed instead, `already_on`
     false (D-25bs);
  3. otherwise the write client's own `GET` of the settings body answers, then the row is inserted pending
     (`already_on` false, `confirmed_at` null, the user's own flags in `movies_before` / `tv_before`, D-25cj) BEFORE
     the write, then `POST /api/v1/user/{id}/settings/main` with **the whole GET body echoed** plus
     `watchlistSyncMovies: true, watchlistSyncTv: true`; the response must show both true; then confirm the row. A
     failure logs and retries next run (the pending row stays, so a lost answer is never read back as `already_on`);
     a GET that fails sent nothing and records nothing. An `already_on` row records both flags true.
- **Enroll once, respect an opt-out** (driver decision, Q-08; the driver's reading of ruling 3, which names whose
  lists request, not whether a user may later turn theirs off): an enrolled user is re-checked once a day; if their
  flags are off, `optout_observed_at` is set and logged once, and the app never turns them back on.
- **Anime series carry `mediarequests` too** (driver decision). Seerr 3.4.1 tags a Sonarr add with the server's
  `tags` (`[1]`, `mediarequests`) but an anime series with `animeTags`, which is empty on this install, so anime a
  watchlist requests would download on SABnzbd main and stay in the TV Trash pool (Boruto and Attack on Titan are
  Seerr-requested and untagged today). PLAN-072 S9's preflight sets Seerr's Sonarr `animeTags` to `[1]` (one
  `PUT /api/v1/settings/sonarr/{id}` echoing the whole GET body, by the coordinator, logged and read back). Two
  paths still add no tag, and C-11 says so: a request-level override chosen by an admin in Seerr's request form, and
  a request of a movie Radarr already has (Seerr only searches it). The watchlist keep covers both while listed.
- **Why the whole body:** Seerr 3.4.1's route assigns `username`, `locale`, `discoverRegion`, `streamingRegion`,
  `originalLanguage` and, for a target without `MANAGE_USERS`, the four quota fields from the body; echoing the GET
  keeps them. The API key acts as Seerr user 1, the only user allowed to edit user 1. For a user with no settings
  row Seerr creates one (`new UserSettings({ user: req.user, … })`); Q-09 checks it lands on the target user, which
  the canary and the read-back prove.
- **Confined surface:** `@hnet/arr/write` gains `SeerrWriteClient.setWatchlistSync(userId, { movies, tv },
  { beforeWrite })` (the hook runs after its GET answered and before the POST, where the pending row goes in,
  D-25cj), import-confined to `packages/domain`; the domain writer `enrollSeerrWatchlistSync` counts the enrollment only once
  both flags are seen on (the Authentik-apply precedent, ADR-045), from the write's response or, when that answer was
  lost, from the next run's read of the pending row's user (D-25bs).
- **Why in the app:** a Plex user who signs in to Seerr later (`newPlexLogin` is on) is enrolled within 15 minutes,
  which "Everyone's" implies; a one-shot script would miss them.
- **Expected first-enable volume:** Seerr reads each user's 20 newest titles, so at most about 34 movies and 48 shows
  (an upper bound computed over every readable list, research §5), all auto-approved (every user holds
  `AUTO_APPROVE`), TV as whole-series requests. Seerr quotas (Q-10) may hold some back.

### D-18 — Rollout order and the remediation re-requests

The order is ADR-093 C-13 and PLAN-072's step order:

1. Ship the registry, gate, guard, Release Block and the Arm/Disarm fix with enrollment off; the sweep CronJob stays
   suspended from the deploy until the read-only checks pass (PLAN-072 S4..S6).
2. Verify read-only, then on the first real guarded sweep (terms written and read back before the first handle).
3. Seed the block (D-15): the ledger and legacy SAB backfill and the three remediation titles' terms. The enable
   depends on this seed.
4. Preflight the enable: Seerr's Sonarr `animeTags` carries `mediarequests` (D-17); a read-only join of every Seerr
   user's 20 newest titles (what the first enable requests) against deleted titles with no active term. Each match
   is seeded from the legacy SAB first; a match with no recoverable identity holds the enable, and the owner is
   asked (AskUserQuestion) whether to enable anyway.
5. Enable Seerr enrollment for one user (Seerr user 2, the full Home member), watch one 3-minute sync, then all.
6. Re-request whatever the enable did not: for Babygirl, Another Simple Favor and Terrifier,
   `GET /api/v1/movie/{tmdbId}`; if `mediaInfo` shows no request, `POST /api/v1/request`
   `{"mediaType":"movie","mediaId":<tmdbId>}` with the API key (the owner; ADMIN, auto-approved). Babygirl is on
   Radarr's import-list exclusions, which a Seerr add ignores (research §5). Each is a one-off operation by the
   coordinator, not app code.
7. Verify each grab chose a release outside the blocked terms (Radarr history `sourceTitle`; the decision log's
   "Contains these ignored terms" on the blocked one) and imported.

Silent Night and The Unholy Trinity are on no watchlist today (research §4) and are not re-requested. They have no
ledger grab or import, so only the legacy SAB seed (D-15, checked by name) gives them terms; if anyone lists them,
Seerr requests them and those seeded terms apply. A deleted title that no source can identify (C-21) would be
re-fetched as it was: the step 4 join catches the ones on a list at the enable, and D-23's re-add check reports any
later one.

### D-19 — The owner's Watchlist Changes count at once

The gate's snapshot adds the owner's `watch_marks` rows with action `watchlist_add` (state `written` or `pending`, or
`failed` with an `unknown:` outcome, which plex.tv may have applied, D-25ca; not reverted), and every
`watchlist_remove` whose undo was written (the undo sent an add; counted at `max(reverted_at, created_at)`, as
DESIGN-051's own overlay does, D-25cb), made since five minutes before the newest ok run started (DESIGN-051 D-05's margin: `set_watchlist` inserts
its mark before the plex.tv write lands, and the mark's time is the database's clock while the run's start is the job
pod's), keyed by the mark's discover guid (ADR-092 D-03). A delete re-reads those changes just before each claim, so a
change made after the snapshot, while a sweep or Expedite is running, protects every item not yet reached (D-25ay). A
`watchlist_remove` never subtracts (fail closed); the next read settles it. So "add it to my watchlist" by voice or
ChatGPT protects a Leaving Soon title from that moment.

### D-20 — Sync mode, CronJob, configuration, stubs

- `--mode=watchlist-registry`: `refreshWatchlistRegistry({ trigger: 'schedule' })`, then the enrollment step when
  enabled, then the Release Block upkeep (D-25cf; skipped without RADARR_/SONARR_API_KEY). It writes its own runs table and no `sync_runs` row (the `smart-alerts` shape); it joins `SYNC_RUN_KINDS`
  so the CLI accepts it (the CHECK rebuild in 0081).
- haynes-ops: a `sync-watchlist-registry` CronJob in `kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`,
  schedule `14,29,44,59 * * * *` (free minutes; `:44` lands a minute before the sweep, `:14` three before the space
  policy), `concurrencyPolicy: Forbid`, `backoffLimit: 0` (D-25dc), the `sync-watch` resources, `envFrom`
  `haynesnetwork-secret`. Its `suspend`, and the sweep CronJob's, is set only in haynes-ops git (D-25db).
- Credentials already in `haynesnetwork-secret` (verified in `externalsecret.yaml`): `PLEX_HAYNESOPS_TOKEN`,
  `PLEX_HAYNESTOWER_TOKEN`, `SEERR_API_KEY`, `RADARR_API_KEY`, `SONARR_API_KEY`, `MAINTAINERR_API_KEY`. The sweep job
  mounts the same secret; it now also builds the Plex read, Seerr read and Radarr/Sonarr read and write clients.
  The web pod already holds them (`resolveArrBundle`).
- Egress: the `frontend` namespace has no CiliumNetworkPolicy for haynesnetwork; plex.tv, community.plex.tv and
  discover.provider.plex.tv answered from the web pod (research §2). S6 confirms the CronJob pods.
- `pnpm dev:local`: stub plex.tv (`/api/v2/user`, `/api/users`, `/api/home/users`), community GraphQL (a fixture
  roster including a hidden-empty friend and a `User not found:` managed user; node `type` in the live upper-case
  `MOVIE` / `SHOW`), discover metadata, Seerr (users, watchlist pages, settings main GET/POST, and a switch that
  makes a user's watchlist answer Seerr's error body, 200 `{totalPages: 0, totalResults: 0, results: []}`, on any
  page) and the *arrs (`releaseprofile`, one list per *arr told apart by the distinct stub keys the stack gives
  Radarr and Sonarr, D-25da; `moviefile`, `episodefile`, `history/movie` with The Fixture's grab and
  import linked by `downloadId` and `data.fileId`, `history/series` empty, and a GET that 404s a deleted item);
  stub Maintainerr's `GET /collections` carries the `listExclusions` / `forceSeerr` the last rule PUT stored on each
  pool, so a dropped flag makes the local audit unsafe (D-25cp).

### D-21 — Logging

Never logged: tokens, uuids, usernames, emails, a person's titles, which account lists a title. Accounts appear only
as their class and `acct:<first 8 hex of sha256(account id)>` for correlation. Trash item titles (our library) are
fine.

- `[watchlist-registry] run_complete {trigger, status, durationMs, roster, byClass, byStatus, bySourceOutcome,
  emptyUnverified, accountHidden, entries, distinctTitles, mapped, unmapped}`; `run_failed {trigger, failure}`;
  `account_failed {class, source, errorClass, acct}` (warn; `errorClass` includes `inconsistent` and
  `empty_after_titles` for Seerr); `account_hidden {class, source, acct}` (warn, once per transition: a source that
  had titles answered empty or not found); `community_mass_empty {before, now}` (warn, D-04);
  `account_unreadable {class, source, acct, failingSinceH}` (warn, once).
- `[watchlist-registry] gate {purpose, verified, reason, ageMin, blocking, filtered}`.
- `[trash] kept {batchId, maintainerrMediaId, title, reason}` per skip; the sweep summary gains per-reason counts.
- `[trash] deleted {batchId, maintainerrMediaId, title, handled, records}` after each delete's settle, and
  `[trash] expedited {scope, maintainerrMediaId, title, handled, records}` for Expedite (`records`: `active`,
  `abandoned`, `in_flight` or `none`), so the order of Phase A, the reconcile and the handles reads from the log
  (D-25az, PLAN-072 S7); `[trash] sweep_pause_cleared {via}` when a pause ends without an ok sweep (D-25bf).
- `[trash] sweep_paused {reason, step, pausedForH}` (warn) on every run with a batch due while paused, and
  `sweep_outcome {outcome, reason}` when the outcome changes (D-14).
- `[release-block] pool_identity_read_failed {title, error}` (warn; the read-only S6(e) report, D-25bj);
  `seed_manual_year_read_failed {title, error}` (warn; the seed's Radarr read of a `--manual` title's years, D-25cs).
- `[release-block] recorded {arrKind, origin, identitySource, shape: group|exact|none, confidence}`; `reconciled
  {arrKind, total, added, removed, expired, pruned, settled, wrote, ms}`; `failed {arrKind, step}` (error; step
  `validate`, `put`, `read_back` or `duplicate_profile`); `handle_not_effective {arrKind, recordId, title}` (warn,
  D-14 step 7); `readd {arrKind, recordId, title, grabs, sameRelease}` (D-23; error when `sameRelease`).
- `[release-block] drift {arrKind, reason, missingTerms, extraTerms}` (warn, D-25ce; `reason` missing, duplicate,
  disabled, edited or terms); `upkeep_failed {arrKind, stranded, expiring, drift, error}` (warn);
  `upkeep_skipped {error}` (warn: the registry job has no *arr key, D-25cf).
- `[trash] sweep_failed {error}` (error) when a scheduled sweep with a batch due throws for any other reason, before
  its `aborted_arr` / `error` outcome (D-25cg).
- `[watchlist-registry] roster_read_failed {server, errorClass}`, `owner_read_failed {server, errorClass}` and
  `seerr_users_failed {errorClass}` (warn) carry the status class (`http_401`, `timeout`, `network`), never an error
  class name (D-25ck).
- `[seerr-enroll] enrolled {seerrUserId, alreadyOn, moviesBefore, tvBefore}`; `optout_observed {seerrUserId}`;
  `failed {seerrUserId, status}`.
- `[trash] rule_save_drift {ruleGroupId, fields}` (error).
- Loki alerts in haynes-ops (with the CronJob PR):
  - `sweep_paused` with `pausedForH >= 6`, any reason, pages the owner that reclaim is paused and why (gate,
    release block, audit unsafe, *arr down), so a persistent `ReleaseBlockError` (a copied profile, a rotated key) or
    an unsafe audit pages like a gate refusal;
  - `readd` with `sameRelease=true` pages at once (ruling 2 breached);
  - `account_unreadable` notifies once per source (coverage lost; not a page);
  - `run_failed` on 8 consecutive registry runs (2 hours) notifies before the gate's own pause reaches 6 hours.

### D-22 — Code map

| Package | Change |
|---|---|
| `@hnet/db` | migration 0081; schema files for the eight tables (registry runs, accounts, sources, items; `plex_discover_ids`; `trash_deleted_releases`; `seerr_watchlist_enrollments`; `trash_sweep_status`) and the three columns (`trash_batch_items.keep_reason`, `trash_candidates.plex_guid`, `trash_candidates.rule_evaluation_failed`); `SYNC_RUN_KINDS` + `watchlist-registry`; enums for statuses, sources, outcomes, keep reasons, identity sources, term confidence, sweep outcomes |
| `@hnet/plex` | roster reads (`getAccount`, `listUsers`, `listHomeUsers`), `communityWatchlist(uuid)` (upper-case `type` mapped, any `errors` entry failed), `discoverMetadata(id)`; the switch call behind a flag (Q-01) |
| `@hnet/arr` | `maintainerrMediaSchema` + `mediaData.guid`, `ruleEvaluationFailed`; collection schema + `listExclusions`, `forceSeerr`; Seerr read `listUsers`, `userWatchlist` (the D-02 content rules); Radarr/Sonarr reads `movieFiles`/`episodeFiles` (with `originalFilePath`), history with event types 1 and 3, the item GET by id, the import-list exclusion count; `/write`: release-profile methods on Radarr/Sonarr, `SeerrWriteClient` |
| `@hnet/domain` | `watchlist-registry.ts` (refresh, per-source outcomes, gate, typed snapshot), `release-block.ts` (identity, terms and grammar, reconcile with settle and validate, `checkReleaseBlockReadds`), `seerr-enroll.ts`; `trash-flow.ts` (guardian, pending shape with the required snapshot, `upsertTrashRule`, invariant); `trash-batches.ts` (proposal filter, sweep phases and settle, the `registry` input, the paused report and `trash_sweep_status`, keep reasons); `trash-candidates.ts` (`plex_guid`, `rule_evaluation_failed`); `space-policy.ts` (`minCandidates`) |
| `@hnet/sync` | the `watchlist-registry` mode, with the Release Block upkeep at the end of every run (D-25cf); the sweep's client wiring, `registry: 'refresh'`, a paused report exits 0; the hourly Release Block upkeep (D-25br) and the D-23 re-add check after the sweep; `release-block-seed.ts` (`--legacy-sab`, `--manual`, and the read-only `--pool` report of `release-block-pool.ts`, D-25bj); `seerr-watchlist.ts` (`--enroll`, `--anime-tags`, `--show`, D-25ar) |
| `@hnet/api` | `expediteItem`, `expediteAll` and `expire` take `resolveArrBundle(ctx)` besides the Maintainerr bundle, and refuse first while `TRASH_WEB_DELETES_HELD` is set (`assertTrashWebDeletesAllowed`, D-25cc); `expire` passes `registry: 'gate-only'`; `WatchlistRegistryUnverifiedError`, `ReleaseBlockError`, `TrashWebDeletesHeldError` and a paused sweep report map to `PRECONDITION_FAILED`; `ReleaseIdentityUnavailableError` maps to `BAD_GATEWAY` (`RELEASE_BLOCK_ARR_UNAVAILABLE`, D-25bu); `trash.status` gains the sweep status (the paused banner); a new admin query, `trash.watchlists`, serves the Watchlists card (the registry summary, the D-23 Release Block and re-add counts, the enrollment counts) |
| `apps/web` | `previewGuardian` mirror, the wall note, skip-reason tooltips (`batchTileView`, D-25cn), the Expire now preview (`expirePreview`, D-25cm), the Library notice's watchlist keep (`trashNoticeText`, D-25co), the paused banner (from the sweep status), the Watchlists card |
| haynes-ops | the CronJob, the Loki alerts, the image tag |
| CLAUDE.md | hard rule 4 (ADR-093 C-08) |

### D-23 — Re-add evidence and exclusion visibility (ADR-084 E-4, E-5)

ADR-084's errata E-4 (the exclusion list needs an admin surface, "or at least visibility", its C-04) and E-5 (the
sync is blind to a title re-added after a Trash delete) were obligations of the D-1 build this design replaces, so
they are delivered here. E-5's signal is also the standing evidence that ruling 2 holds after PLAN-072 closes.

- **The re-add check (E-5).** `checkReleaseBlockReadds` runs hourly in the `trash-batch-sweep` mode after the sweep,
  whether or not a batch was due; a failure is a warning and never changes the job's exit. While that CronJob is
  suspended nothing is deleted, so no new record can be re-added (D-25cf).
  1. It finds records in state `active` or `expired` with no verdict yet (`readd_seen_at` null, or seen with
     `readd_same_release` null within the last 7 days) whose title is live again in the ledger: a `media_items` row
     with `deleted_from_arr_at` null, the record's `arr_kind`, the same tmdb id (movies) or tvdb id (series), and an
     `arr_item_id` other than the record's (a re-add is always a new *arr id, whether the ledger inserts a row or
     re-matches the old one by external id).
  2. It reads that item's grabs from the *arr (`history/movie` or `history/series`, event type 1), because the
     ledger does not reliably receive a re-added id's grab events (E-5).
  3. It tests each grab's `sourceTitle` against the record's term (the self-check's compiled regex) and stamps
     `readd_same_release` (true when any grab matches). A re-added title with no grab yet is stamped `readd_seen_at`
     at the check's first sighting (no verdict) and checked again each hour for 7 days from that sighting (D-25bo),
     never from the ledger row's `first_seen_at`, which the sync keeps from the title's original first sync when it
     re-matches the re-add onto the old row.
  4. It logs `[release-block] readd` (D-21); `sameRelease=true` means the block failed and pages at once.
- **Visibility (E-4; driver decision: the "at least visibility" floor).** The Watchlists card (D-10) shows, per
  *arr, the Release Block's live term count against its cap and the oldest term's age; the import-list exclusion
  count, read live through `@hnet/arr` when the card loads, both *arrs at once and each given 4 seconds ("not
  available" when the *arr does not answer in time, D-25cl); and the
  re-adds of the last 30 days ("Re-added after Trash: 4, all with a different release"). No prune surface is built:
  exclusions stop only Kometa and list re-adds, a Seerr request ignores them (ADR-084 D-3), and an admin who needs
  one removed does it in Radarr or Sonarr.

### D-24 — Rulings from the design review (PR #594, 2026-09-26)

An Opus review of this design against the code, the live install and the deployed upstream sources (Seerr 3.4.1,
Radarr 6.4.4, Sonarr 4.0.20, Maintainerr 3.29.0) found two blocker issues (four reports), a set of should-fix
items and some nits, several reported by more than one reviewer. Every finding was accepted and folded into the sections named; where
two reviewers proposed different fixes, the ruling says which was taken and why.

| ID | Finding | Ruling |
|----|---------|--------|
| D-24a | **Blocker:** Seerr answers a failed plex.tv read as HTTP 200 with an empty list, on any page, so an ok-by-status rule strips lists and truncates paging (three reviewers). | D-02 classifies Seerr answers by content: page 1's totals are fixed; a later page with other totals or `totalPages: 0`, an empty page before the last, or a repeated `ratingKey` makes the read inconsistent, repeated once, then failed. An empty answer for a source whose last ok read had titles is failed (D-04). One reviewer proposed accepting a repeated empty answer after 24 h; not taken, because a revoked token is exactly the failure that repeats, and accepting it would strip that list a day later. The source stays carried and turns `unreadable` with its titles frozen; the cost (a list truly emptied pauses reclaim from 24 h to 72 h) is recorded in D-04 and ADR-093 C-05. Results are not summed against `totalResults` (Seerr drops no-tmdb and 404 items, C-05); items insert `ON CONFLICT DO NOTHING`. Research §2 and the PLAN-072 evidence now say the zero-result user's token is unverified; S6(h) compares registry runs with Seerr's `Failed to retrieve watchlist items` log lines. |
| D-24b | Community answers that drop a list at once (an empty list after titles, `User not found:` after titles, a partial answer with `errors`) and account-level state that a per-source failure distorts (three reviewers). | State is per (account, source) (D-04, D-05 `watchlist_registry_sources`); the account status is derived. Empty or not found after titles is failed, logged `account_hidden`; not found with nothing ever read is `not_applicable`; any `errors` entry is failed. One reviewer keyed the rule on "read ok before", another on "read with titles"; "with titles" was taken, since a source with nothing to carry gains no protection from blocking the gate and would only pause reclaim. When the same account's Seerr source reads ok with titles, a community transition turns that source `unreadable` at once (frozen, not blocking), so a Seerr-linked friend who hides a list never blocks. `not_applicable`, `unresolvable` and `unreadable` never delete stored items. The optional whole-run check was not adopted (D-04 says why); it is logged instead. |
| D-24c | Community `type` is the upper-case enum `MOVIE` / `SHOW`, not `movie` / `show`. | D-02 maps it; any other value fails that read; the dev:local fixture uses the live values (D-20). |
| D-24d | The manual Expire now (`trash.batches.expire`, `forceOverride`) calls `sweepExpiredBatches` in the web pod, where D-14's inline refresh contradicted D-07 and the *arr clients were missing (two reviewers). | `sweepExpiredBatches` takes a required `registry: 'refresh' \| 'gate-only'`; the sync mode refreshes, the web `expire` mutation and Expedite take the gate on the CronJob's run and map refusals to `PRECONDITION_FAILED`; the three mutations get `resolveArrBundle` (D-07, D-14, D-22). An integration test forces Expire now with a stale registry and asserts nothing is deleted. |
| D-24e | Eight callers share `shapePendingItems`; an absent snapshot would read every item as deletable. | The snapshot is a required, typed parameter with its purpose; absent or unverified-for-delete means `unevaluable` (D-06). Tests: no snapshot yields `unevaluable` for every item; a guard test asserts every delete-path caller passes a `delete` snapshot. |
| D-24f | A disk-imported movie's term used only Radarr's year, which often differs from the release's (Terrifier 2016 vs 2018), and a self-check against Radarr's renamed path proves nothing. | `Y` is an alternation of Radarr's `year`, `secondaryYear` and every release name's year, widened by ±1 only when the renamed file is the only name; such terms are `low_confidence` and reported by S6(e) (D-12). A Terrifier fixture covers the 2016/2018 case. |
| D-24g | A record with no term was deleted with no block, against ruling 2 and R-257 (two reviewers). | Fail closed: such an item is kept (`release_unrecorded`, counted `unblockable`), so every delete this design performs is blocked (D-11). If S6(e) shows this keeps a material share of the pool, Q-13 goes to the owner then. |
| D-24h | **Blocker:** the backfill covered only the ledger's 76 of 416 deleted movies; the legacy SAB histories identify about 284 more, and Silent Night and The Unholy Trinity have no ledger grab at all (three reviewers). | D-15 adds a bulk `--legacy-sab` source over both legacy histories (title, year ±1, size 90 to 100 %), checks the two titles by name, and skips deleted rows whose *arr record still exists. What no source identifies (about 43 movies) is ADR-093 C-21, a driver-decision limit; C-15 and R-257 are scoped to match. S9 depends on the seed and its preflight joins every Seerr user's 20 newest titles against deleted titles with no term (D-18 step 4). D-18's sentence on the two titles is corrected. |
| D-24i | `trash_candidates` lacked `ruleEvaluationFailed`, so the Expedite preview could count a flagged item as deletable. | `rule_evaluation_failed` joins `trash_candidates` in 0081 and flows into `shapePendingItems`; the parity test gains a flagged case (D-05, D-09). |
| D-24j | The paused banner had no state to read, a thrown refusal failed the Job every hour, and a persistent Release Block failure paused reclaim with no banner or page (two reviewers). | `trash_sweep_status` records each scheduled sweep's outcome (D-05); a gate or Release Block refusal returns a clean `paused` report and the Job exits 0 (an unsafe audit keeps today's throw); the banner and the Loki page fire when no sweep of a due batch has succeeded for 6 hours, for any reason, naming it (D-10, D-14, D-21). `account_unreadable` and a 2-hour `run_failed` streak notify. |
| D-24k | An untargeted batch snapshotted a watchlisted item `protected`, whose only control, Unprotect, means nothing for a watchlist keep. | It is snapshotted `pending`; the sweep's guardian keeps it (D-08). |
| D-24l | "The grab whose `downloadId` matches the file's import" could not be computed from grab events alone, and the backfill did not say which ledger row wins (two reviewers). | History is read with event types 1 and 3; the import's `data.fileId` (or `importedPath`, or `sceneName`) links the file to its `downloadId` and grab; `originalFilePath` is a fallback name; the backfill takes the latest import before the delete and its grab (D-11, D-15). |
| D-24m | ADR-093 C-11's "everything Seerr requests carries `mediarequests`" is false for anime series (empty `animeTags`) and for searches of movies Radarr already has (two reviewers). | S9's preflight sets Seerr's Sonarr `animeTags` to `[1]` and its done-when checks it (D-17, D-18); C-11 names the two paths that still add no tag, which the watchlist keep covers while listed. |
| D-24n | Radarr and Sonarr never validate a term, and one that does not compile in .NET rejects every release on that *arr; `[\W_]` differs between .NET and JavaScript. | Terms follow a whitelist grammar, re-validated before every POST or PUT (D-12, D-13 step 2); `SEP` is `[^a-z0-9]`; S7 confirms an ordinary search still accepts a non-blocked release after the first PUT; C-19 names the failure mode. |
| D-24o | Records turned `active` in the claim transaction, before a handle that can fail (a 409 while Maintainerr's executor holds its lock), so a 365-day term could block a title still in the *arr; the backfill seeded from such rows. | Records stay `in_flight` through the handle and turn `active` only after a 2xx handle and an *arr `GET` that 404s; otherwise `abandoned` (D-14 step 7); a stranded `in_flight` row is settled against the *arr by the reconcile (D-13 step 1); the seed skips rows whose *arr record exists (D-15). The orphaned-file case (Never Let Go, Sleeping Beauty) is noted in D-14 and research §3. |
| D-24p | ADR-093 C-07 and the ADR-084 note listed different surviving items, D-4 appeared in neither, and E-4/E-5 lost their owner. | Both now say D-2, D-3, D-4 and errata E-2..E-6 stand. D-4 is met by the Deleted-Release Record (inserted before the PUT, tied to the deletion audit in the claim transaction) and hard rule 4's amendment in the writer's PR. E-4 and E-5 are delivered by D-23. |
| D-24q | The rollback reverted the image first, which restores deleting watchlisted titles and, after S9, #576's loop for every user. | PLAN-072's rollback is ordered: suspend the sweep, restart S0's manual check, disable enrollment, revert the image, and only then delete the profiles; 0081 is additive and stays. |
| D-24r | Nothing held the first real deletions until the read-only checks passed. | The sweep CronJob is suspended (declared activity) from S4 until S6 is green; S0 runs until S7 (PLAN-072). |
| D-24s | The interim check ran the day before an expiry, leaving the last day uncovered. | S0 adds a final cross-check in the 1 to 2 hours before the sweep that closes each batch. |
| D-24t | The managed-user switch (Q-01, PRD Q-15) had no step that asks the owner. | PLAN-072 S6a puts Q-15 to the owner, tests the switch on one managed user on a yes, and records the ruling here. |
| D-24u | ADR-025, ADR-036, DESIGN-010 and DESIGN-014 lacked the status lines this change owes them. | Status-only "Amended by: ADR-093" (ADR-025 C-03, ADR-036 C-10) and "Extended by: DESIGN-052" lines are added; S11 turns all of them to "in effect since". |
| D-24v | Three driver decisions in ADR-093 were not marked. | C-06, C-10 and C-11 carry "(driver decision)"; C-11 states that the opt-out rule is the driver's reading of ruling 3 (Q-08). |
| D-24w | Nits: DESIGN-048's "Extended by" cited a D-11 it does not have; Q-01 and PRD Q-15 said "unreadable" for what D-04 calls `unresolvable`. | DESIGN-048 cites "D-06 here (ADR-086 D-11)"; Q-01 and Q-15 say `unresolvable`. |

### D-25 — Rulings made while building (PLAN-072 S2)

PLAN-072 S2 part 1 built migration 0081 and every table of D-05, the registry readers and state machine (D-01..D-04),
the `watchlist-registry` mode, the gate and the typed snapshot (D-06, D-07, D-19), the proposal and deletion guard
with keep reasons and `ruleEvaluationFailed` (D-08, D-09), the sweep's `registry` input and `trash_sweep_status`
(D-14, as it concerns the gate), the D-10 surfaces, and the registry half of the D-20 stubs. Part 2 built the
Deleted-Release Record and its terms (D-11, D-12), the Release Block writer (D-13), the two-phase sweep and Expedite
(D-14), the seed script (D-15), the Arm/Disarm fix and the grown invariant (D-16), the Seerr enrollment and the
anime-tags preflight (D-17), the D-21 lines, the D-23 re-add check and counts, and the *arr and Seerr half of the D-20
stubs, with no further migration. The rulings below were made while building; none changes a D-24 ruling. Rows
D-25ax..D-25bm record the rulings of the PR #595 code review (each with a test that fails without it), rows
D-25bn..D-25bz those of its second review pass, rows D-25ca..D-25cq those of its third and rows D-25cr..D-25da
those of its fourth (the same way). Rows D-25db and D-25dc record the review of the PLAN-072 S4 deploy (haynes-ops
#3223). Rows D-25dd..D-25dh record PLAN-072 S6's results (2026-09-27, v0.101.0) and the rulings they needed; D-25di
records the review of D-25dd's fix (PR #599).

| ID | Question | Ruling |
|----|----------|--------|
| D-25a | D-05 said the `seerr_watchlist_enroll` setting needs no DDL, but `app_settings.key` has a CHECK. | 0081 rebuilds `app_settings_key_enum` with the key (and `sync_runs_run_kind_enum` with `watchlist-registry`), so part 2 needs no migration. The setting's code default is `{ enabled: false, onlyUserIds: null }`. |
| D-25b | A refresh that throws after its run row was inserted would leave a `running` row. | `watchlist_registry_runs.failure` also admits `error`: the run is closed `failed` / `error` and the error rethrown. |
| D-25c | How the `watchlist-registry` advisory lock is held across a refresh of many transactions. | A transaction-scoped `pg_try_advisory_xact_lock` held by a transaction that stays open for the refresh (it takes no row lock and writes nothing); every registry write runs in its own transaction on another pool connection. The CronJob answers `busy` and exits 0; the sweep polls every 2 s for up to 120 s and reuses a run that finished `ok` while it waited. |
| D-25d | A roster account with no uuid (no `thumb`, none in the Home list). | Its community source is `not_applicable` (`no_uuid`): it cannot be read, so it never blocks (like a managed user), and a stored list is kept. |
| D-25e | Which Seerr users the registry reads. | Plex users with a plex id only: a local Seerr user (type 2) has no Plex watchlist. A plex id outside the roster is a `seerr_only` account keyed by that id. The owner's Seerr link is recorded, but the owner reads only through discover (D-04's "every other account"). |
| D-25f | A Seerr read with `totalResults > 0` whose every item Seerr dropped (no tmdb guid, a metadata 404). | Empty for the D-04 rules: it lists nothing, so it removes nothing, and after a list with titles it is a failed read. |
| D-25g | Does an ok read that lists nothing remove stored titles? | No (D-04: a title leaves only when an ok read no longer lists it while still listing something), with one exception: the owner's discover read replaces even when empty, since discover reports its own failures and answers the owner's whole list. |
| D-25h | A stored source an account no longer reads (a Seerr link removed, a class change). | It turns `not_applicable` (`not_linked`) and keeps its items. |
| D-25i | Does a frozen (`unreadable`) source fall back to `carried` when it fails again? | No: `unreadable` holds until an ok read, for the 72-hour rule and the community exception alike. Otherwise a community source frozen by a Seerr read would fall back to blocking the first run Seerr failed. A Seerr source failing after that still blocks through its own carry, as D-24b says. |
| D-25j | `seerr_only` accounts and a failed Seerr user list. | A `seerr_only` account is marked left only when a successful user list no longer has it. A failed user list keeps every stored link and reads every Seerr source as failed (`seerr_users`); Seerr not configured does too (`seerr_unconfigured`), so both carry and then block. |
| D-25k | What "unmapped" means for the evaluable rule (D-06). | A movie counts as mapped with a tmdb id, a show with a tvdb id (each kind's key in the pool); a show known only by tmdb id is unmapped (fail closed). The discover-id map (D-03) therefore looks up every title that lacks its kind's key, including a Seerr show that carries only a tmdb id. |
| D-25l | A pool item whose `plex://` guid names the other kind. | It is not a discover key; the item is still matched by its external ids and is evaluable only if nothing of its kind is unmapped. |
| D-25m | The D-19 overlay's keys. | A `watchlist_add` mark with result `pending` or `written`, not reverted, made since the newest ok run started, adds its discover id and also its tmdb / tvdb ids (only ever adding protection). |
| D-25n | An owner discover row with no valid discover id (neither the `plex://` suffix nor a 24-hex ratingKey). | Skipped and counted (`ownerSkipped`), not a run failure; discover has not been seen to serve one. |
| D-25o | Pruning runs older than 7 days. | The newest ok run is never pruned, so the Watchlists card can always say when watchlists were last checked. |
| D-25p | When `community_mass_empty` logs (D-04). | When the previous ok run had at least 2 community sources with titles and this run has half as many or fewer. |
| D-25q | The Watchlists card's "n accounts read, m can't be read". | An account is read when one of its sources holds a verified list (`read` or `carried`, not `empty_unverified`); every other current account can't be read (unresolvable, unreadable, not read yet, or answering only empty and unverified). This reproduces the research's 22 / 20 split. _(D-25dg: it does not; live it gives 21 / 21, and the rule stands.)_ |
| D-25r | Which `trash_sweep_status` outcome the existing handle breaker records (3 consecutive Maintainerr handle failures). | `aborted_arr` with reason `handle_breaker`: the media apps did not answer, and the banner reads "the media apps". Part 2's *arr identity breaker records the same outcome. |
| D-25s | The scheduled sweep with nothing due. | It does nothing at all: no audit, no registry refresh, no status row (D-14). Before, an unsafe audit failed the job every hour even with nothing due. |
| D-25t | The `watchlist-registry` job's exit code. | 0 for a clean `failed` run (roster, owner) and for `busy`; only a thrown error fails the Job. The run row and `run_failed` (the Loki alert after 8 in a row) are the signal, so a plex.tv outage does not fire the job-failure alert every 15 minutes. |
| D-25u | How the web paths surface a refusal. | Expedite's gate refusal is `WatchlistRegistryUnverifiedError` (appCode `WATCHLIST_REGISTRY_UNVERIFIED`); a manual Expire now that paused throws `TrashSweepPausedError` (appCode `TRASH_SWEEP_PAUSED`); both are PRECONDITION_FAILED and their messages are the banner's wording. _(D-25bv: exactly the wording; the gate's reason and detail are logged, never appended to the message.)_ |
| D-25v | Where the paused banner lives (D-10). | Inside the Maintainerr safety banner's reserved row, recoloured to warn (ADR-015: no new row under the page), shown only while Maintainerr itself checks out (its own warnings take precedence). `trash.status` carries `sweepPause`, set only once the pause is 6 hours old. |
| D-25w | The "On a watchlist" note's footprint. | A bookmark and the short visible label on the tile's meta line, the long wording in the tooltip and aria-label; the size and rating text ellipsizes first, so the tile's geometry is unchanged. On the batch wall the note shows on every row except `deleted`. |
| D-25x | The space policy's reported candidate count (D-08). | It now reports the deletable candidates `minCandidates` is compared against (not `dnd`, not on a watchlist). |
| D-25y | The Start-a-batch preview (the client mirror of `selectBatchCandidates`). | A targeted pick leaves watchlisted candidates out; an untargeted count includes them, since they are snapshotted `pending`. |
| D-25z | The managed-user Home switch (D-02, Q-01). | Not built until Q-01 is answered: the `switch` source is always `not_applicable` (`switch_disabled`), so managed users are `unresolvable`. _(D-25de: answered, "Leave them out"; it is never built.)_ |
| D-25aa | The copy of D-10. | The driving session's UX pass supersedes the proposed copy: the note "On a watchlist" (tooltip "On a watchlist. It won't be deleted while it stays there."); kept tooltips "Kept: on a watchlist / watched recently / couldn't be checked / no longer a candidate / saved / couldn't be removed safely" (`tag` and `live_excluded` both read "saved"); the confirm's term "on a watchlist"; the banner "Deletions are paused until watchlists can be checked." / "… until removals can be done safely." / "… until the media apps respond normally."; the card's "Checked {relative time}. {n} accounts read, {m} can't be read." |
| D-25ab | The retry policy of D-02 on the existing clients. | `PlexHttp` and `ArrHttp` gained `retryStatus` and `retryBackoffMs` options (defaults unchanged); the registry's plex.tv and Seerr clients use 10 s, 3 attempts on 429 / 5xx / network, 2 s × attempt. The owner's discover list is read by the registry client with that policy, through the paging loop `getWatchlist` uses (extracted, unchanged). |
| D-25ac | `pnpm dev:local` and e2e with a gate that needs a fresh run. | The stubs gained the registry half of D-20 (the plex.tv roster with a hidden-empty friend and a `User not found:` managed user, community GraphQL with upper-case `MOVIE` / `SHOW`, discover metadata, Seerr users and watchlist pages with the error-body switch); the stack runs the `watchlist-registry` mode at boot and the Trash spec re-runs it before it deletes. No default stub list holds a deletable Trash pool title (the owner's holds Stub Runner, already kept by its `dnd` tag); `POST /_stub/seerr-watchlist` puts one on the member's Seerr list (the Trash e2e, D-25bi). The *arr and Seerr settings stubs are part 2's. |
| D-25ad | What the D-12 self-check compares a term against. | Each release name as it is and folded the way the tokens are (accents and apostrophes removed, `&` read as `and`): scene names carry neither, while Radarr's renamed file keeps them ("Don't Look Up (2021) …"), so a raw-only check would reject every such title's term and keep it forever. A release posted with an apostrophe in its name is not matched by the group term (counted by S6(e)). A renamed file is checked by its own name: a Sonarr relative path carries its season folder (`Season 03/…`), which the anchored term never matches. _(D-25bq: such a real name now makes the term `low_confidence`, and the S6(e) report counts it as `foldOnly`.)_ _(D-25dd: the group term now matches it: the term writes the raw apostrophe.)_ |
| D-25ae | What counts as a release name (`originalFilePath`, the exact form). | A name that names a RELEASE: title tokens, a year or a season, and a resolution or a group. `originalFilePath` gives its last segment when that is one, else the folder above it (an obfuscated file inside a release folder must not defeat the self-check), else nothing. The exact form is built only from such a name: the exact form of a bare "Babygirl (2024)" would block every release of the title. |
| D-25af | When the ledger's names join a record whose file the *arr still has. | Only when the *arr has no release name for the file (no grab, no `sceneName`, no usable `originalFilePath`); otherwise a stale ledger import could push the group term into its exact fallback. The ledger alone identifies an item the *arr no longer has before the delete. |
| D-25ag | An item with nothing to re-fetch, and one already gone. | A movie with no file (a series with no file in a season ≥ 1) is deletable with a term-less `none` record, kept as evidence. A movie or series the *arr answers 404 for before the delete is identified from the ledger (`ledger_grab`), else kept `release_unrecorded` (`gone`). |
| D-25ah | A series (season, resolution) whose files name no group. | One exact record per distinct release name of that key; if any file of it has no release name, the whole series is kept (a delete removes every season). The legacy SAB seed matches movies only: a series is many downloads, so the size rule does not apply; series the ledger cannot identify are counted unblockable. |
| D-25ai | How identity failures count (D-14 step 4). | Consecutively, per survivor, in the order read; three in a row abort the batch before Phase A with nothing written (the batch stays `leaving_soon`), outcome `aborted_arr`, reason `arr_identity`. A single failure between successes keeps that item `release_unrecorded`, written only after the loop completes without tripping. Expedite throws `ArrUpstreamError` (BAD_GATEWAY) on the breaker and counts every unrecordable item as skipped (`unrecordedCount`, part of `skippedCount`). _(D-25bu: Expedite now throws `ReleaseIdentityUnavailableError`, its own appCode, instead of `ArrUpstreamError`.)_ |
| D-25aj | Expedite `all` and a failed handle. | Phase A covers every survivor before the first handle. A failed handle still stops the run and rethrows, as before; the survivors not reached have their in-flight records abandoned and the profile reconciled, so no term blocks a title that is still there. |
| D-25ak | The sweep's handle breaker (3 failed handles) and the survivors it did not reach. | Their in-flight records are abandoned (they stay `pending` and come back next run), and the final reconcile removes their terms. |
| D-25al | A Phase A failure after one *arr already took its terms (a sweep or Expedite touching both). | Every record of the call is abandoned and the *arr that succeeded is reconciled again, best effort, so no term of an item that was not deleted stays in its profile. |
| D-25am | The reconcile's transaction, and what counts as "no write". | The advisory lock, the expiry, the stranded in-flight settle and the cap prune share one transaction, so a failed write rolls them back too (the next reconcile repeats them). The profile is rewritten whenever it differs from the desired shape (disabled, a `required` term, an indexer, a tag, or another `ignored` set), not only on a different `ignored` set. |
| D-25an | How a record is tied to its deletion (ADR-084 D-4). | The claim transaction stamps `batch_item_id` on the sweep's records, and the `trash_expedited` event of both paths carries `releaseRecordIds` (Expedite has no batch item). |
| D-25ao | The re-add check's 7 days (D-23). | They run from the re-added ledger row's `first_seen_at`. With no grab by then the record is stamped with `readd_same_release` null (seen, no verdict) and not checked again. _(Superseded by D-25bo: the ledger row is re-matched, so its `first_seen_at` is the original sync; the window now runs from the check's own first sighting.)_ |
| D-25ap | What the Watchlists card counts (D-23). | Per *arr: the distinct live terms (in flight or active) against the cap, the oldest live term's age in days, and the import-list exclusion count read live (Radarr `exclusions/paged`, Sonarr `importlistexclusion/paged`; "not available" when it does not answer); the re-adds stamped in the last 30 days and how many matched a blocked release. No enrollment UI: the script's `--show` covers PLAN-072 S9. |
| D-25aq | What the D-16 read-back compares. | `arrAction`, `listExclusions`, `forceSeerr` (not expected on an episode pool), `tagInArr`, the Radarr and Sonarr server ids, and `collection.deleteAfterDays`. `cleanupLeftoverFolders` and `keepInMaintainerrOnly` are lifted but not compared (Maintainerr stores them only for some collection types). A rule group the live read does not have refuses the save before any PUT. |
| D-25ar | How the coordinator turns enrollment on and sets the anime tags (PLAN-072 S9). | A one-off script, `packages/sync/src/scripts/seerr-watchlist.ts` (`--show`, `--enroll=off\|all\|<ids>`, `--anime-tags=<server>:<tags>`); the setting write is audited through `setAppSetting` with actor null. The enrollment step reads Seerr Plex users only (`userType` 1); the daily re-check covers every enrolled user, not only the canary. |
| D-25as | Which credentials the sweep job's Release Block needs. | Only RADARR_ and SONARR_ keys (`releaseBlockArrClientsFromEnv`), so the sweep CronJob does not also need the Lidarr and Bazarr keys the web bundle requires. The web paths use the web pod's full *arr bundle. |
| D-25at | Seed idempotency and doubtful presence (D-15). | A live ledger row whose *arr presence cannot be confirmed (a failed GET) is skipped (`skippedUnverified`), never seeded blind. Backfill records are written `active` with `batch_item_id`, so a re-run skips the row; a remediation name whose term is already live for that tmdb id is skipped. |
| D-25au | The *arr and Seerr half of the D-20 stubs, and a shared test seam. | `createStaticReleaseBlockArr` (an in-memory Release Block *arr that synthesizes one recordable release per unknown id) serves the domain, API and sync tests. The e2e / `pnpm dev:local` stub *arr serves `releaseprofile`, `moviefile`, `episodefile` with identity fields, `history/series`, the exclusion counts and Seerr `settings/main` and `settings/sonarr`; it answers 404 for an item a stub Maintainerr handle deleted until either stub resets (the Trash spec resets after its last test). |
| D-25av | User-visible copy added beyond the UX pass (for the driving session's review). | The Expedite report's Skipped bullet ("… could not be verified safe, couldn't be removed safely, or its protection could not be applied …"); the card's "Blocked releases", "Oldest block" and "Import list exclusions" groups ("{n} of {cap}", "{d} days", "not available") and the re-add line ("Re-added after Trash: none in the last 30 days." / "{n}, all with a different release." / "{n}, {s} with the same release."); the two invariant violations; the rule drift and `useRules` refusals; Expedite's *arr-down refusal. |
| D-25aw | Does the Expedite preview predict `release_unrecorded`? | No: it would need the *arr's identity reads for every pending item on every wall paint. The confirm can therefore count as deletable an item the run keeps because its release cannot be recorded; the report counts it skipped. The guardian's own keeps still come from the one shared derivation (ADR-086 D-11). |
| D-25ax | A handle that fails after Maintainerr already deleted the item (a client timeout, a dropped socket, a 5xx): Maintainerr's `handleMedia` deletes the *arr item first and only then removes downloads, the Seerr request and the Plex collection entries. | The settle always asks the *arr, whatever the handle returned: a 404 makes the records `active`, so the term stays and a later re-request cannot fetch the release. An item still present is `abandoned` after a 2xx handle or a definite refusal (an HTTP 4xx such as the executor lock's 409, or a `code: 0` ReturnStatus: `classifyHandleFailure` → `refused`); after an ambiguous failure it stays `in_flight` with its term, because the delete may still be running, and the stranded settle (D-13 step 1) decides by presence an hour later. A `GET` that cannot be answered leaves `in_flight` too. The sweep and Expedite share `settleReleaseRecords`. |
| D-25ay | The D-19 overlay's two blind spots: a change made just before the run started that the run's discover read did not see yet, and a change made after the snapshot, during a sweep or Expedite. | The overlay starts five minutes before the run started (`REGISTRY_OVERLAY_MARGIN_MS`, DESIGN-051 D-05's `WATCHLIST_OVERLAY_MARGIN_SECONDS`), for every snapshot purpose; it only ever adds protection. The `delete` snapshot carries `overlaySince`, and the sweep and Expedite re-read the owner's `watchlist_add` changes since then just before each claim (`isOnLateWatchlist`): a match is kept `watchlisted` (the sweep; Expedite counts it protected), its records are abandoned and the profile reconciled, and nothing is claimed or handled. |
| D-25az | How PLAN-072 S7 proves "the handles, each record turning `active` after its *arr GET 404s" from the log. | One `[trash] deleted {batchId, maintainerrMediaId, title, handled, records}` line per sweep delete after its settle, and `[trash] expedited {scope, maintainerrMediaId, title, handled, records}` for Expedite (D-21). `records` is the settle's answer: `active`, `abandoned`, `in_flight` or `none`. |
| D-25ba | A `seerr_only` account while Seerr's user list fails (or Seerr is not configured). | It stays current: not marked left, and its Seerr source is decided as failed (`seerr_users` / `seerr_unconfigured`) on every run, so it carries, blocks the gate after 24 hours and freezes `unreadable` at 72 hours exactly like a roster-linked Seerr source (D-25j), instead of never being re-decided and blocking without end. It is marked left only when a successful user list no longer has it. |
| D-25bb | A series key whose group term fails the self-check with exactly one named file (an SD name with no resolution token, such as `Show.S01E01.HDTV.x264-LOL`) and a nameless sibling. | Whenever the group branch falls back to the exact form, every name of the key gets its own exact record and a nameless file of the key keeps the whole series `release_unrecorded` (D-25ah), however many names happen to be known. Before, one named file gave one exact record and the nameless sibling's release went unblocked. |
| D-25bc | The ledger path (D-15 seed; a series already gone from Sonarr) kept only the newest import per (season, group, resolution). | Every import of a key counts. The key's group term must match every import name of the key (one record); otherwise each distinct release name gets its own record, and a key where any name yields no term fails the series closed (kept `release_unrecorded`, or counted unblockable by the seed). |
| D-25bd | A movie whose file the *arr cannot name, with a ledger import that no longer describes that file (replaced by a disk copy or a rescan outside the *arr's history). | The ledger's names join only when its latest import agrees with the file: the same group when both name one (compared by tokens), and the same resolution when both carry one. Otherwise the file's own renamed-path group term (`low_confidence`) is used, so the file actually deleted is the one blocked. |
| D-25be | An exact term built from a short name ("Trap.2024.1080p": a title, a year and a resolution, no group). | The exact form is a prefix match, so it needs a parsed group or at least one token past the title, the year or season marker and the resolution (a source, a codec, anything else). Otherwise there is no exact term and the item is kept `release_unrecorded`: the term would block every 1080p release of the title, as the bare "Title (Year)" of D-25ae would block every release. |
| D-25bf | A pause (the banner, `pausedForH`) outlived its batch: only an ok scheduled sweep of a due batch cleared `paused_since`, so a batch cancelled or expired by hand left the banner up until some later batch swept. | A scheduled sweep with nothing due ends a recorded pause with one conditional UPDATE (`paused_since` null, no outcome row, D-25s otherwise holds), and so does a manual Expire now that swept cleanly (it still writes no outcome row). Both log `[trash] sweep_pause_cleared {via}`. No due batch means reclaim is not paused. |
| D-25bg | The Watchlists card's "Lists" group mixed the derived account status (an account answering only empty was still "Read") with a count of sources, so it contradicted the headline. | The group counts every current account once, split the same way as the headline (D-25q): Read (= the headline's n), then "Empty or hidden", "Not read yet", "Kept from an old check" and "Not supported" (managed users), which sum to the headline's m. `computeCounts` records it as `byList`; no label reuses "can't be read". |
| D-25bh | The re-add line counted records (a series, or a remediated movie, has several) and read a no-grab stamp as "a different release". | It counts re-added titles (distinct kind and tmdb or tvdb id) over 30 days, and a title whose every stamp has no grab is "not grabbed yet". The line reads "Re-added after Trash: {n}, all with a different release." or "{n}, not grabbed yet." when one kind covers them all, else the parts that apply in this order: "{n}, {s} with the same release, {d} with a different release, {g} not grabbed yet." |
| D-25bi | The "On a watchlist" note on a phone: the ~76 px label beside the eye and requester chips squeezed the size text to nothing on the 3-column wall and pushed the meta line past the tile at 375 px and narrower. | At 480 px and narrower the note is the bookmark alone (the label is hidden; the tooltip and aria-label carry the words), so D-25w's "the tile's geometry is unchanged" holds at 320 px. An e2e step checks every meta-line chip stays inside its tile at 390, 360 and 320 px. |
| D-25bj | PLAN-072 S6(e) needs a read-only run of the D-11 / D-12 derivation over the pending pool before the sweep resumes; the seed's dry run reads only past deletions. | `release-block-seed.ts --pool` (`reportPoolReleaseIdentity`, `release-block-pool.ts`) reads each kind's pending pool and runs `identifyRelease` as the sweep would, then prints counts by shape, confidence and identity source, the records with no group (Q-12), and the items D-11 would keep with their reasons and share (Q-13). It writes nothing (no record, profile, batch item or status row). |
| D-25bk | User-visible copy added or changed by the review (for the driving session's copy pass; no em dashes). | The Expedite confirm's protected line "{n} protected: recently watched, whitelisted, or on a watchlist; they are kept." (a watchlisted item is kept by the app, never by Maintainerr, and a request is no keep) with "Includes {n} on a watchlist."; "{n} will be deleted NOW: immediate and permanent, …"; "{n} kept, can't be verified safe: unknown to the ledger, …"; the report's "Deleted:", "Protected: kept on purpose because it was recently watched, is on a watchlist, or is whitelisted or saved (…)", "Skipped:", "No longer pending:"; the "Lists" labels of D-25bg; the re-add lines of D-25bh. Already in the build and listed here for the same review: the item confirm's "This item is on a watchlist, so it won't be deleted while it stays there. Nothing will be deleted."; the card's "Accounts", "Lists", "Not checked yet.", "Couldn't load the watchlist check." and "The latest check didn't finish. The counts are from the one before." _(D-25by replaces "unknown to the ledger" and the item confirm's "it isn't in our ledger"; D-25bx adds "The watchlist check hasn't finished yet.")_ |
| D-25bl | D-14's shared helper was an Expedite-only private function; the sweep composed identity and Phase A itself. | `recordAndBlockReleases` (exported from `release-block.ts`) is the one seam: identity with the three-failure abort, each unrecordable survivor handed back before Phase A (`onUnrecorded`), then Phase A for every recordable survivor. The sweep's `expireOneBatch` and Expedite (through a thin `recordAndBlockExpediteReleases` that maps the abort to `ArrUpstreamError`) both call it; T-264 names it. |
| D-25bm | How an operator runs and answers the new pieces (the CronJob, the paging alerts, the in-cluster scripts). | OPS-017 (`docs/ops/017-watchlist-protection.md`) is the runbook: the `sync-watchlist-registry` CronJob and a manual run, each `sweep_paused` reason and step with its remedy, the `readd` page, the S6(e) pool report, the S8 seed with its never-committed legacy SAB file, the S9 enrollment script, and the rollback with the CronJob suspended first. _(D-25bz: its reason column now uses the logged values, and it gains the `account_unreadable` and `run_failed` sections.)_ |
| D-25bn | The owner's discover list is paged by offset, and `readAllContainerPages` believed each page's `totalSize`: a title removed from the pages already read moved an unread title back across the page boundary, the read ended short with `truncated: false`, and the registry replaced the owner's list without a title still on it. | The first page's `totalSize` is the listing's total; a later page reporting another one means the list shifted. The whole read is repeated once from `start=0`, and a second inconsistent read returns `truncated: true`, which fails the run `owner_truncated` and keeps the stored list (D-02, D-04). The rule lives in the shared helper, so the Watch Companion's `getWatchlist` and `listAllLeaves` get it too (harmless there). |
| D-25bo | The re-add check's window started at the ledger row's `first_seen_at`, but the media sync re-matches a re-added title onto its old row (updating `arr_item_id`, keeping `first_seen_at`), so a re-add with no grab yet was closed on its first check and a later grab of the same release was never seen. | The window runs from the check's own first sighting: with no grab, the first match stamps `readd_seen_at` (verdict null); the check selects records never seen, or seen with no verdict within the last 7 days, and stamps the verdict (`readd_same_release`) once a grab appears, keeping the sighting time. No migration; the card's "not grabbed yet" reads the same rows. Supersedes D-25ao. |
| D-25bp | A movie's exact fallback: `deriveTerm` builds it from the FIRST real name and checks it against that name only, so a grab title and a different scene name (or a ledger grab and import name) left the file's own name unblocked, the "same title, different index" case of ruling 2. | `deriveTermsPerName`: when the combined derivation comes back `exact` and the record has more than one distinct real name, each name gets its own derivation (its own group term when it carries a group and passes the self-check, else its own exact form), one record each; a name that yields no term keeps the movie `release_unrecorded`. `identifyMovie` and the Radarr branch of the ledger path use it; the series path keeps D-25bb and D-25bc. |
| D-25bq | The self-check accepted a real release name that matches only when folded (an apostrophe, an accent or `&`), labelled the term `verified`, and the S6(e) count D-25ad relied on did not exist, although Radarr and Sonarr test the raw title. | A real name (not the renamed file, which is what the fold is for) that the term matches only folded makes the term `low_confidence` (`foldOnly` on the derivation and the draft). The S6(e) pool report counts `foldOnly` and `foldOnlyShare` per kind. The grammar is unchanged: an accent or `&` cannot be matched by the D-12 templates, and joining an apostrophe-split word would need a template change (ADR-093 C-19), so the share is measured instead. _(D-25dd: S6(e) measured it at 1.8% of Sonarr's names, and the templates now write the raw apostrophes, accents and `&`; `foldOnly` counts only what they cannot write.)_ |
| D-25br | The stranded settle and the 365-day expiry (D-13 step 1) ran only inside a delete path's reconcile, so after an ambiguous handle failure "an hour later" (D-14 step 7) meant the next batch of that kind, and a still-present title's current release stayed blocked for days. | `reconcileReleaseBlockIfDue` runs in the `trash-batch-sweep` job every hour after the sweep, before the re-add check, whether or not a batch was due: for each *arr with an `in_flight` record older than the settle age or an `active` record past `expires_at`, one reconcile. Nothing due makes no *arr call; a failure logs `[release-block] upkeep_failed` (warn), never changes the exit and never pauses the sweep. The job report carries `releaseBlockUpkeep`. |
| D-25bs | An enrollment whose POST answer was lost (a 10 s timeout; POSTs are not retried) or whose row insert failed after the POST left no row, so the next run read both flags on and recorded the app's own enrollment `already_on`; a rollback that turns off `already_on = false` users would miss them. | The row is inserted PENDING (`already_on` false, `confirmed_at` null, a new column in 0081) BEFORE the write and confirmed from the response; a pending user whose flags read on at the next run is confirmed as the app's enrollment, never `already_on`, and one still off is written again. The daily re-check reads confirmed rows only; the summary reports `pending` separately. |
| D-25bt | The grown invariant required `forceSeerr` on every armed rule pool, but Maintainerr 3.29.0 never stores it on an episode collection (`rules.service.ts`), so an armed episode pool would keep the audit unsafe forever while the save's drift check expects it off. | An episode pool (`type` `episode` or 4) is exempt from the `forceSeerr` requirement, like `ruleGroupDrift`; it is still held to `listExclusions`, `arrAction` Delete and the horizon. An episode delete leaves the series and its Seerr record in place, so the re-request path is not involved. |
| D-25bu | Expedite's *arr-down refusal was an `ArrUpstreamError`, whose appCode `ARR_UPSTREAM_UNAVAILABLE` maps to the Fix path's copy ("… recorded as failed …"), so the D-25av sentence never reached the user. | `ReleaseIdentityUnavailableError` (appCode `RELEASE_BLOCK_ARR_UNAVAILABLE`, `BAD_GATEWAY`) carries the D-25av sentence as its message, and the web copy maps the code to the same sentence. |
| D-25bv | Expedite's gate refusal appended a technical clause ("no watchlist check within the last 30 minutes; the newest is 45 minutes old") to the banner's wording, against D-25u, and the API test only matched a prefix. | The message is exactly "Deletions are paused until watchlists can be checked."; the reason and detail stay on the error and on the gate's own log line. The API tests assert the exact string. |
| D-25bw | The manual Expire now report blamed Maintainerr for every abort, including the *arr identity abort (D-25ai), which happens before any delete. | The wire and client types carry `abortReason`; `arr_identity` reads "Nothing was deleted: Radarr or Sonarr did not answer. The batch stays in Leaving Soon and will try again on the next sweep." and `handle_breaker` keeps the Maintainerr wording (`sweepAbortCopy`). |
| D-25bx | With no ok run yet and a failed latest run, the Watchlists card said "Not checked yet." and "The counts are from the one before." together. | The "from the one before" note shows only when an earlier ok check exists; with none, the headline is one line, "The watchlist check hasn't finished yet." (no run at all stays "Not checked yet."). |
| D-25by | The Expedite confirms gave "unknown to the ledger" as the reason for every unverifiable item, though since ADR-093 an item is also kept when its watchlist status is not evaluable or Maintainerr flags `ruleEvaluationFailed`. | The item confirm names its cause (`unverifiableReason`: "it isn't in our ledger", "its watchlists can't be checked right now", "Maintainerr couldn't check its rules"), and the all confirm reads "{n} kept, can't be verified safe: not in our ledger, their watchlists can't be checked right now, or Maintainerr couldn't check their rules, so they are skipped, never deleted." For the driving session's copy pass, with D-25bw and D-25bx. |
| D-25bz | OPS-017's `sweep_paused` table named a reason `media_apps` that the log never carries (it logs `audit_unsafe` or `arr`), sent the unsafe remedy to an app control that cannot change those flags, and had no section for two of D-21's four alerts. | The table uses the logged reasons (`gate`, `release_block`, `audit_unsafe`, `arr`) and notes the banner groups the last two as "the media apps"; the unsafe remedy is Maintainerr's own rule editor; new sections cover `account_unreadable` (the source frozen, its titles still protecting; the `errorClass` that tells a hidden list from a revoked Seerr key) and the `run_failed` streak (each `failure` value and its remedy). PLAN-072 S4 links each alert to its section. |
| D-25ca | The D-19 overlay left out an owner `watchlist_add` whose outcome plex.tv never confirmed (`failed` with `unknown:`: a PUT that timed out after it went out, or a change closed as abandoned after 60 s), which may have landed; until the next registry run read the list, Expedite, Expire now and a running sweep's late re-read treated the title as not listed and deleted it. | The overlay also takes a `watchlist_add` that is `failed` with an `unknown:` outcome (DESIGN-051's unsettled call), not reverted, made since the overlay start: fail closed, it only ever adds protection. A change never sent (`not sent:`) or refused outright adds nothing, and an undone add never does. |
| D-25cb | "Undo that" after a written `watchlist_remove` sends an add to plex.tv but writes no `watchlist_add` row, only `reverted_at` / `revert_result` on the remove, so the overlay never saw the title back on the owner's watchlist, while DESIGN-051's own overlay replays it as an add. | The overlay also takes a `watchlist_remove` whose revert is `written`, at `max(reverted_at, created_at)` on or after the overlay start, as an add (DESIGN-051's `watchlistEvents` rule). A failed revert, including one whose outcome plex.tv never confirmed, carries no time and adds nothing; the next registry run (15 minutes) reads the list. A remove still never subtracts. |
| D-25cc | PLAN-072 S4 suspended only the sweep CronJob, but Expedite (item and all) and the manual Expire now ship in the same image and take the gate on the CronJob's run, so an admin could delete on an unverified registry before S6 and make the first real Release Block write before S7's search check. Revoking grants holds nothing: the admin role holds every Trash action. | The web pod reads `TRASH_WEB_DELETES_HELD` (`1`, `true` or `yes`): while it is set, `trash.expediteItem`, `trash.expediteAll` and `trash.batches.expire` refuse before reading anything with `PRECONDITION_FAILED`, appCode `TRASH_WEB_DELETES_HELD`, "Deleting from Trash is on hold while watchlist protection is being verified. Nothing was deleted." (for the driving session's copy pass). PLAN-072 S4 sets it in the haynes-ops change that deploys the image, S6's resume removes it in the change that resumes the sweep, and the rollback sets it first while an image that knows it still runs. |
| D-25cd | A Phase A that failed after its write reached the *arr (a read-back that failed, or a POST or PUT whose answer was lost) abandoned its records but reconciled only the *arrs that had succeeded, never the one that failed; a sweep or an Expedite covers one *arr, so the cleanup ran for none and the terms stayed, blocking the current release of titles the *arr still has. | `ReleaseBlockError.mayHaveWritten` (a `read_back`, or a `put` whose POST or PUT was sent) puts the failing *arr in the same best-effort cleanup reconcile; a `validate`, a `duplicate_profile` and a profile list that never answered wrote nothing and are not retried. Whatever a failed cleanup leaves, D-25ce removes. |
| D-25ce | The upkeep reconciled only when a record was stranded or expiring, so a hand-disabled or deleted profile, a restore from an older backup, or an abandoned record's leftover term stayed until the next delete of that kind, against D-13's "a hand edit is overwritten" and C-15. | Every upkeep run reads each *arr's profiles once and reconciles when the managed profile is missing while a term is live, duplicated, disabled or hand-edited (required terms, an indexer, tags), or when its `ignored` set differs from the sentinel plus the live terms, and when the live terms exceed the cap; it logs `[release-block] drift {arrKind, reason, missingTerms, extraTerms}` (warn). With no live term and no profile nothing is created (the first write stays a delete path's, PLAN-072 S7). This reverses D-25br's "nothing due makes no *arr call": two GETs a run. |
| D-25cf | The upkeep and the re-add check ran only in the `trash-batch-sweep` job, which PLAN-072 keeps suspended from S4 to S6 (and rollback step 1 suspends with no end date), so an ambiguous handle failure's in-flight term, the expiry and the drift fix would wait for the next delete of that kind. | The `watchlist-registry` mode runs the upkeep at the end of every run too (every 15 minutes, best effort: it never changes the exit; a missing RADARR_/SONARR_API_KEY skips it with `[release-block] upkeep_skipped`); both jobs serialize on the per-*arr advisory lock. The re-add check stays hourly in the sweep job: while it is suspended nothing is deleted, so no new record can be re-added. |
| D-25cg | A scheduled sweep that threw for any reason other than the gate, the Release Block or an unsafe audit (Maintainerr's pending read failing, a database error) recorded no outcome, so D-24j's 6-hour banner and `sweep_paused` page never fired; only the job failure alert did. | While a batch is due, any other throw records `aborted_arr` with reason `error` (the banner's "media apps" line) and logs `[trash] sweep_failed {error}` before it rethrows, so the job still fails too; the next ok sweep clears it. No new outcome value, so 0081's CHECK is unchanged. |
| D-25ch | The bulk legacy SAB seed wrote one record per matching job (Another Simple Favor: 47 in-window jobs, 3 distinct terms), and D-15 told the owner BYNDR "remains", though BYNDR's download (0.969 of the deleted size) is inside the same window and was fetched in the #576 loop. | The seed keeps one draft per distinct term (per *arr and season), the job with the closest size first, for the legacy SAB and the ledger alike, so records and the dry run's `records` count terms. Every in-window legacy job is blocked, BYNDR included, which ruling 2 supports; D-15 is corrected. |
| D-25ci | Identity and the settles read the *arr item by `media_items.arr_item_id`, which is not stable across an *arr rebuild until the next sync, while Maintainerr deletes by tmdb / tvdb; after a rebuild the id could name another title, whose term was recorded while the real delete's release went unblocked. | `identifyMovie` and `identifySeries` require the item's tmdb id (Radarr) or tvdb id (Sonarr) to equal the ledger's; otherwise the survivor is kept `release_unrecorded` (reason `id_mismatch`, counted by the S6(e) report). The settle, the stranded settle and the seed's presence check read another title at the id as gone. An id unknown on either side (null, or the *arr's 0) never disagrees. |
| D-25cj | An enrollment row did not record the user's own flags, so the rollback's "flags false" would also turn off a flag the user had on; and the pending row went in before the write client's own GET, so a GET that failed (nothing sent) left a row that a later self-enable would confirm as the app's. | 0081's `seerr_watchlist_enrollments` gains `movies_before` and `tv_before` (both true on an `already_on` row); `[seerr-enroll] enrolled` carries them, and the rollback restores exactly them. `SeerrWriteClient.setWatchlistSync` takes a `beforeWrite` hook, run after its GET answered and before the POST, where the pending row is inserted; the confirm is an upsert. |
| D-25ck | `roster_read_failed`, `seerr_users_failed` and `owner_read_failed` logged the error's class name (`PlexHttpError`, `ArrHttpError`), so OPS-017's "a 401 means a token was revoked" could not be read from the logs, and a rotated Seerr key, which fails the user list first, showed only as every source's `seerr_users`. | The three lines log `plexErrorClass` / `seerrErrorClass` (`http_401`, `timeout`, `network`, …). OPS-017 §5 sends a rotated key to the `seerr_users_failed` line's `errorClass`. |
| D-25cl | The Watchlists card read the two exclusion counts one after the other through the web pod's *arr bundle (a 30 s timeout and three attempts each), so one hung *arr held the whole card, the registry headline included, for about 90 seconds. | Both counts are read at once, each given 4 seconds (`EXCLUSION_COUNT_DEADLINE_MS`); a late or failed count is "not available" and the card renders. |
| D-25cm | The Expire now confirm still counted watchlisted pending rows in "Up to N will be deleted" and in the typed override count, though their tiles say they won't be deleted. | `expirePreview` (lib/trash-batches) treats an `onWatchlist` pending row as a certain keep, like recently watched, not in the ledger and not in the live pool, and the kept line adds "on a watchlist" (`EXPIRE_KEPT_REASONS`). For the driving session's copy pass. |
| D-25cn | No test covered the batch wall's D-10 wiring: a mutation that dropped the "Kept: …" tooltip or the note on batch tiles passed every test. | `batchTileView` (lib/trash-batches) derives a tile's label, hover title and note (every row but a deleted one), unit-tested; the tile only renders it. |
| D-25co | The Library item page's Trash notice said "Save it to keep it" for a watchlisted pending title, while its wall tile said it won't be deleted. | `trashNoticeText` gives a watchlisted title the tile note (bookmark, "On a watchlist. It won't be deleted while it stays there.") in place of the Save line; the schedule line stays. For the driving session's copy pass. |
| D-25cp | The dev:local stubs served empty `history/*`, so the walk only ever recorded `arr_file` identities, and stub Maintainerr always reported both rule-pool flags on, so an Arm/Disarm that dropped one never made the local audit unsafe. | Stub Radarr serves The Fixture's grab and import linked by `downloadId` and `data.fileId` 9601; stub Maintainerr's `GET /collections` carries the flags the last rule PUT stored on each pool; a stub smoke test (`lib/__tests__/stub-release-block.test.ts`) covers both. |
| D-25cq | Hard rule 4's amendment named only the pre-delete write of the Release Block, while the single writer also runs after deletes, in the upkeep and from the seed; and ADR-093, its C-08 and glossary T-265 named one ADR-093 write-back where CLAUDE.md names the Release Block and two Seerr writes. ADR-093 C-10, PRD R-259 / AC-36 and T-74 still held an episode pool to `forceSeerr` after D-25bt. | Hard rule 4 lists every occasion (before each Trash delete, after deletes to remove abandoned terms, the upkeep in both jobs, the one-off seed) and both Seerr writes (the enrollment `settings/main` POST and the one-off `animeTags` PUT); ADR-093's Amends line and C-08 and T-265 name the same three; C-10, R-259, AC-36 and T-74 exempt an episode pool from `forceSeerr` (D-25bt). |
| D-25cr | A renamed-only record (163 of the 170 pool movies are disk imports) widened its years to y − 1 .. y + 1 without looking at the library, so The Killer (2024)'s term covered 2023 and blocked the FLUX 2160p release (and its repack) of Fincher's The Killer (2023), a different film in the library, for 365 days; the live pool has two more such pairs (The Conference, Stolen). ADR-093 C-18 accepts over-blocking only for that title. | `deriveTerm` takes `namesakes` (the ledger's other titles of the *arr) and leaves out a widened year (never one of the *arr's own) at which one has the term's title tokens; `identifyMovie` and `identifySeries` read them from `media_items` (tombstones included, the subject's own tmdb / tvdb id excluded) only when a term is renamed-only. The record keeps `namesakeYears`; the S6(e) pool report counts `namesakeNarrowed` and lists the titles and years left out. ADR-093 C-18 says so. |
| D-25cs | The `--manual` seed derived its term from the entry's year alone, which D-15 defines as the release's own year, so Terrifier (release 2016, Radarr and the ledger 2018) got `2016` only: its term missed the `Terrifier.2018…FraMeSToR` repost D-12 says it blocks, which S9's re-request could then fetch; and the run still counted Terrifier's batch row unblockable. | The manual term's years add the matched batch row's year, every ledger row's year for the tmdb id and Radarr's `year` / `secondaryYear` when the ledger says Radarr still has it (a failed read is `[release-block] seed_manual_year_read_failed`, and the ledger's years stand). A batch row no other source identified that a manual entry covers (a record written or already present) is `manual.covered`, not `unblockable`. |
| D-25ct | The ledger path skipped any series import whose name has no season marker (a daily episode, a complete-series pack), so it never entered a key, the D-25bc fail-closed check never saw it, and the series still counted as identified while that release stayed re-fetchable; the live path blocks the same file through its per-name exact fallback. | `ledgerDrafts` (Sonarr) gives such an import one exact record per name (season null), and an import with no name or a name with no term fails the series closed (kept, or unblockable in the seed). Season 0 stays skipped, as on the live path. No deleted series in today's ledger has one (latent). |
| D-25cu | PLAN-072's rollback reverts to an image whose Rules tab Arm/Disarm PUTs the group without its top-level flags, so Maintainerr 3.29.0 stores `listExclusions` and `forceSeerr` false, which the older audit never checks: after one toggle the resumed sweep would delete with no import-list exclusion and no Seerr clear, silently. | Rollback step 4 forbids Rules-tab Arm/Disarm while the older image runs (Maintainerr's own rule editor saves the whole rule), and step 6 resumes the sweep only after `GET /api/collections` shows the flags (and `arrAction`) on every active pool; OPS-017 §3 and §8 say the same. |
| D-25cv | `trashNoticeText` dropped the watchlist note once the title was saved, so a Save on the Library page unmounted the line and the panel shrank (hard rule 9), while the walls keep the note whatever the glyph. | The note stays whenever the title is on a watchlist, saved or not (a Save does not take it off the list). For the driving session's copy pass. |
| D-25cw | The Start-a-batch "All current candidates" option summed every non-`dnd` candidate into "frees X", though a watchlisted one frees nothing while it stays listed (the sweep keeps it); D-25y accepts the count, not the space. | `previewTargetSelection` returns `freesBytes` (the picked or snapshotted bytes that are not on a watchlist); the "All current candidates" figure, the targeted preview's "frees" and the Start button read it. The open batch wall's running header is left as it is: under the owner's standing ruling (2026-07-09, re-affirmed 2026-09-19) an item the sweep keeps by a signal of its own (recently watched, and now watchlisted) still counts as slated there, and the Expire now confirm's "up to N" covers the difference (D-25cm). |
| D-25cx | The Start-a-batch preview read `onWatchlist` from the `display` snapshot (the newest ok run, any age) and always skipped listed titles, while `createBatchFromPending`'s `propose` gate stops filtering once that run is 24 hours old, so after a long registry outage the preview showed a different pick than the server made. | `listTrashPendingCandidates` (and `trash.pendingCandidates`) report `watchlistFiltered` (`isProposalWatchlistFiltered`, the `propose` rule without its snapshot); while it is false the preview's pick takes watchlisted titles as the server's will, and `freesBytes` still shows they free nothing. |
| D-25cy | D-25bk's Expedite-all protected line had no test that failed without it: the "report never credits Maintainerr" assertion ran against a report that never said so, and no test rendered the confirm. | The line is `EXPEDITE_PROTECTED_REASON` (lib/trash), unit-tested (names the watchlist, "they are kept", no Maintainerr, no request, no dash), and the Trash e2e asserts the rendered confirm; the vacuous report assertion is dropped. |
| D-25cz | The Expire now confirm's kept line, rewritten by D-25cm, still rendered "(skipped) — …" (the no-dash test covered only the constant), and its two sibling lines kept their dashes, while the Expedite-all confirm uses colons. | `expireConfirmLines` (lib/trash-batches) renders all three labels with a colon ("1 rescued item is untouched:" singular), unit-tested on the rendered text; the Trash e2e asserts no dash in the list. For the driving session's copy pass. |
| D-25da | The dev:local / e2e stack points Radarr and Sonarr at one stub with one key, and the stub kept one release profile list, so since D-25ce / D-25cf every upkeep run's Sonarr pass read the Radarr term as drift and rewrote it away (and back), logging drift every run. | The stack gives Radarr and Sonarr their own stub keys and the stub keeps a list per key; `/_stub/release-profiles` answers `{radarr, sonarr}` (OPS-003). A stub smoke test on embedded PG runs the upkeep twice after a Radarr write: the term stays, no drift. |
| D-25db | PLAN-072 suspended the sweep CronJob with `kubectl` at S4 (with a declaration and a daily check that it stayed suspended), resumed it the same way at S6, and suspended it and the registry CronJob by hand in the rollback. The chart renders `suspend` on every CronJob and a Helm upgrade patches the live value back to the rendered one, so the S4 deploy itself would lift a hand-set suspend; in a rollback after S6 (git says `suspend: false`) the hold PR's or the image revert's upgrade would lift it and the older image would delete watchlisted titles without recording or blocking the release; and a hand resume while git says `true` is re-suspended by the next release with no alert (CronJobNotSucceeding skips a suspended CronJob, and a sweep that never runs logs no `sweep_paused`). Found in the haynes-ops #3223 review. | Every sweep and registry CronJob suspend and resume goes through haynes-ops git (`cronjob.suspend`), never `kubectl`: S4 sets the sweep's `suspend: true` in the deploy PR; S6 sets `suspend: false` in the PR that removes `TRASH_WEB_DELETES_HELD`; the rollback's suspend lands before the image revert or in it, the revert keeps it (the tag is edited, the S4 change never reverted wholesale), and the registry CronJob is removed in the revert's change (the same Helm upgrade) or suspended in git before it; the rollback's resume is a PR too. With nothing hand-set, S4 needs no declaration and no daily check. PLAN-072 S4, S6 and Rollback steps 1, 3, 4 and 6 and OPS-017 §1 and §8 say so. |
| D-25dc | A registry run that throws logs `run_failed` (`failure: error`) and exits 1; with `backoffLimit: 1` the Job retried in the same slot and logged a second scheduled `run_failed`, so the 8-line `WatchlistRegistryRunsFailing` streak (D-21: 8 runs, 2 hours) could fill in 4 slots, about 1 hour. | The `sync-watchlist-registry` CronJob runs `backoffLimit: 0` (D-20): the next slot is 15 minutes away, so each slot logs at most one scheduled `run_failed` and 8 lines are 8 slots. A Job run by hand from the CronJob (OPS-017 §2) logs trigger `schedule` too and counts as one more. |
| D-25dd | PLAN-072 S6(e) (2026-09-27, v0.101.0): over the ledger's real grabbed and imported names, 345 of 19,434 Sonarr names (1.8%) and 3 of 1,159 Radarr names keep an apostrophe, an accent or `&` (Bob's Burgers, It's Always Sunny in Philadelphia, Los Pingüinos de Madagascar, Lilo & Stitch, episode titles such as "Don't Ruin the Basketball Game"), so their D-12 term matched them only folded (`foldOnly`) and Radarr and Sonarr, which test the raw title, would not have blocked them. D-25bq had measured that share rather than change the grammar. | The terms are written from the raw names (D-12): an apostrophe inside a word is `SEP?` (`SEP*` in the exact form), an accented letter an alternation of the folded letter and the accented ones (single letters in U+00C0..U+024F and U+1E00..U+1EFF that fold to it), an `and` between two words optional; the apostrophes and accents come from the record's names, its renamed file and the *arr's title when they start with the same words (`termWords`, `mergeTermWords`). The whitelist grows by exactly these three constructs, none of which can fail to compile (ADR-093 C-19); `isGrammarTerm`, the self-check and the fold-tolerant `termMatches` are otherwise unchanged. A term only ever matches more spellings of the same words, so no term is lost: re-run off-cluster over a read-only dump of the same ledger (20,594 names on 2026-09-27), the shapes are unchanged (Radarr group 1,110, exact 40, none 10; Sonarr 17,466, 1,763, 205) and `foldOnly` falls from 348 to 0; over the 164 pool movies (their D-11 inputs dumped read-only, the old derivation reproducing all 164 live identities) the counts are unchanged (162 group: 6 verified, 156 `low_confidence`; 2 `no_term`; 3 namesake-narrowed; 0 `foldOnly`), and 12 renamed-only terms now also match their title's own spelling ("The Killer's Game", "Vita & Virginia"). `foldOnly` stays as the backstop for what the grammar cannot write (a decomposed accent inside a word). Tested with 35 of the real fold-only ledger names (one or two per title, every character class), the new accepts and refusals of the grammar, and the pool report's `foldOnly` count on a decomposed accent. _(D-25di: the fold reads `´` as an apostrophe too, `İ` is written, the apostrophe join also takes `&#39;` / `&apos;` and the optional `and` an `amp`.)_ |
| D-25de | Q-01 / PRD Q-15: may the app sign in as a managed Home user (the switch token) to read their watchlist for the Trash guard? | Owner, 2026-09-26: "Leave them out just make sure to automatically pickup new users. I'll move everyone on Plex Home to their own account linked with the server." The switch path is never built (D-25z) and the three managed users stay `unresolvable`: they never block. New users are picked up with no change: every run re-reads the roster from plex.tv `/api/users` and `/api/home/users` (D-01), so a new account (a member moved to their own account, a new friend) is in the registry at the next run, starting `never_read` (D-04); once enrollment is on (PLAN-072 S9), every run enrolls each Seerr Plex user without a confirmed row (D-17), so a person gets auto-requests once they have signed in to Seerr once. PLAN-072 S6a is done with this answer. |
| D-25df | Q-12 / Q-13: is the share of pool items PLAN-072 S6(e) keeps `release_unrecorded` material? | No (driver ruling). 2 of 164 pool movies (1.2%) have no term: Whaledreamers (2006, `aAF`) and The Specials (2000, `HANDJOB`), DVD files whose renamed name carries no resolution token, so the 480p group term fails its self-check, and a renamed file gets no exact form. The 158 disk imports in the pool have no null group (Q-12). The two stay kept (D-11) and come back in later batches; Q-13 is not put to the owner. |
| D-25dg | D-25q said the Watchlists card's headline reproduces the research's 22 / 20 split. | Live at PLAN-072 S6 the rule gives 21 read and 21 can't be read (`byList`: read 21, empty 18, unresolvable 3): the friend whose community read is empty and whose Seerr list answers 0 is `empty_unverified`, where the research counted that friend as read. The rule stands (0 is also Seerr's error answer, D-02); the count is corrected. Seerr now has 17 Plex users (user 17, the second full Home member, joined 2026-09-26T18:27Z); the owner's link is recorded but read through discover (D-25e), so there are still 16 Seerr sources. |
| D-25dh | Q-05's remaining limit: a renamed-only term (156 of the 162 pool terms) is built from Radarr's title, year, quality and group, never from a real release name, so it cannot be verified. | Accepted and recorded in ADR-093 (C-22). Simulated over the ledger's real Radarr names (each name's renamed-only term built as the pool's are, then tested raw against that real name): 1,027 of 1,123 blocked (91.5%) at S6; with D-25dd, 1,035 of 1,124 (92.1%) over the next dump (one more name), where the old derivation still blocks 1,028. The 89 misses left: a different title (an alternate or foreign title, or a mis-grab; 43), an edition or cut between the title and the year (15), a release title shorter than the *arr's (12), another resolution token (1080i, none, or a mislabelled quality; 12), a year outside the window (5), a Remux with no `remux` token (1), and a name that opens with a quotation mark (1). A re-request of such a title could fetch the deleted release; D-23's re-add check reports it (`readd_same_release`). |
| D-25di | PLAN-072 S8–S10 live (2026-09-28). (a) Seerr 3.4.1's `PUT /api/v1/settings/sonarr/{id}` rejects the echoed GET body with 400 `request/body/id is read-only`, so the whole body is echoed minus `id` (the coordinator's preflight did this by hand; `SeerrWriteClient.setSonarrAnimeTags` is fixed the same way, with a fake that answers `id` with 400). The user settings route has no `id` in its body and enrolled all 18 users with the whole body echoed. (b) A file piped into a pod over `kubectl exec` stdin can arrive truncated (the legacy SAB export arrived as 2,115 of 75,046 lines and matched nothing); copy it compressed and compare a checksum before a seed. (c) Silent Night (2023, 65.3 GB) has no release in any of the five HaynesTower SABnzbd histories, so it stays unblockable (ADR-093 C-21). | Recorded; the `id` fix ships with this close-out. |
| D-25di | The review of D-25dd's fix (PR #599): (1) NFKD turns `´` (U+00B4) into a space and an accent, so the fold, which removed apostrophes only after NFKD, read "d´Amélie" as two words where `termWords` read one, and on any disagreement `termWords` returned the plain tokens for the WHOLE name: every accent and apostrophe of a name with a `´` anywhere (an episode title's "Don´t" included) was lost and its term matched only folded. `İ` lower-cases to two characters, so it was never written. (2) A double-escaped name (the ledger holds "Lilo.&amp;.Stitch…" beside "Lilo.&.Stitch…" for the same release, so an indexer serves both) got a term that blocks only its own spelling, and a plain name's term missed the `&amp;` spelling. (3) The older image's grammar rejects every D-25dd term. | Driver rulings. (1) The fold removes apostrophes before NFKD as well as after it (so `´` is an apostrophe, as its place in the apostrophe set always meant, and a letter whose decomposition carries one, `ŉ` or a fullwidth apostrophe, loses it too), and `termWords` folds each character with `foldReleaseName` itself, so the two readings agree on every character; should a word still differ, that word alone falls back to its plain token (the whole name only when the word counts differ). `İ` is kept as itself, `(?:i\|İ)`. A name with a `´` now has one word where it had two ("d´Amélie" is `damelie`, like "d'Amélie"); the ledger holds none. (2) `&amp;`, `&#39;` and `&apos;` (any case) are read as `&` and an apostrophe, in one pass, before the tokens and the words are built, and the term writes them back: the apostrophe join is `(?:SEP\|&(?:#39\|apos);)?` (`*` in the exact form) and the optional `and` is `(?:(?:and\|amp)SEP+)?` (`SEP*` in the exact form), so a term built from any of the spellings matches all of them, and the Sonarr per-key path no longer needs two terms for one release. Any other entity stays as written (a word that matches its own spelling). (3) Recorded in OPS-017 §8 and PLAN-072's Rollback: once a record holds a D-25dd or D-25di term, never roll back to v0.101.0, the only earlier image with the Release Block writer; its writer refuses the whole profile write (`validate`) on every run. Checked off-cluster against the same ledger dump (20,594 names): against the base and against D-25dd, no term lost, none outside the grammar, no raw miss on its own name, no shape change, and no term matching another title's name that the base term did not; over 40,000 random names (accents, apostrophes, `´`, `&`, `and`), no throw and none outside the grammar, `foldOnly` left only for doubled apostrophes (743), and the only spellings a base term matched that the new one does not are 742 names with a `´` beside another separator, which the base read as two words; over 20,000 random titles written in every spelling (`'`, `’`, `´`, `&#39;`, `&apos;`, none; `&`, `&amp;`, `and`), each group and exact term matches every spelling of its title; every rendered term and the grammar check ran in under a millisecond on 5,000-character near misses. Tested with the review's Amélie, Élite and İstanbul names, both Lilo & Stitch spellings and a double-escaped Bob's Burgers, in group and exact terms. |

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
- **Believe an empty answer once it repeats for a day** (D-24a): a revoked Seerr token repeats forever, so the list
  would be stripped a day after the token died. Carrying the list and freezing it at 72 hours costs a bounded pause
  instead.
- **Delete an item with no recordable term, unblocked** (D-24g): the re-request would fetch the deleted release,
  which ruling 2 forbids; the item is kept and counted instead, and the owner decides if the count is material
  (Q-13).
- **One release profile per title, or tag-scoped profiles:** a profile per title multiplies API objects; a re-added
  title carries no app tag, so tag scoping cannot reach it.
- **Exact release-name terms only:** misses reposts under other names and every disk-imported file, which has no
  release name.
- **A unique index on the term:** each deletion keeps its own evidence row; the reconcile deduplicates.

## Test strategy

- **Pure units:** roster XML parsing and classification (owner, full, managed, friend; uuid from `thumb`);
  community answer classification (data, empty, `User not found:`, a 200 with data **and** an `errors` entry, other
  errors, non-JSON, an upper-case `MOVIE` / `SHOW` node, an unknown `type`); the Seerr shapes (a consistent multi-page
  read; 200-empty after a non-empty read; a page 2 answering `totalPages: 0`; a later page with other totals; an empty
  page before the last; a page repeating an earlier page's `ratingKey`, read again once and then failed; a short page
  from dropped items, still ok; a duplicate that must not abort the transaction); the per-source state machine (read,
  carried at 1 h and 25 h, unreadable at 72 h and back to read, never_read, `empty_unverified`; community empty or
  not found after titles is failed and logged `account_hidden` once, the same answers with nothing ever read are
  `empty_unverified` / `not_applicable`; a Seerr ok read with titles turns a community transition `unreadable` at
  once; a Seerr source failing after the community source froze still blocks; `not_applicable` and `unresolvable`
  keep stored items; the derived account status); the gate (G1..G3 boundaries at 30 min and 24 h per source,
  `propose` never refusing, the D-19 overlay adding and never subtracting); the typed snapshot (`shapePendingItems`
  with no snapshot, or an unverified `delete` one, yields `unevaluable` for every item); the match rule (guid, tmdb,
  tvdb, the evaluable rule with an unmapped entry); `classifyGuardian` order and the new reasons; term derivation
  fixtures (the Babygirl example and its reposts, the Annabelle FLUX dotted/spaced names, a remux vs WEB-DL of the
  same group, apostrophes and `&`, a TV season pack and a single episode, a different group not matching, Terrifier's
  2016 release against Radarr's 2018 year, a renamed-path-only record marked `low_confidence` with its ±1 window)
  plus the self-check fallback; the term grammar (every rendered term passes; a term with a non-alphanumeric token, an
  unknown construct or another flag is refused before any write); the history join (import `data.fileId` →
  `downloadId` → grab, the `importedPath` and `sceneName` fallbacks, an upgraded file picking the latest import); the
  reconcile set diff, sentinel, cap, expiry and the `in_flight` settle (404 → active, live → abandoned, unreachable →
  kept); the Arm/Disarm payload builder (the live 3.29.0 GET shape in, a PUT with the top-level flags out; `useRules`
  rules); the re-add check (a new *arr id with a same-release grab, with a different release, with no grab yet); the
  second review pass (D-25bn..D-25bz): an owner list that loses a title between page reads is read again and never
  returned short and "complete", a second shift is truncated; a movie whose grab title and scene name differ gets a
  term per name; a Tigole-style name with an apostrophe, `&` or an accent is `low_confidence` and `foldOnly` (verified
  since D-25dd); an
  episode pool is not held to `forceSeerr`; the Expire report's abort copy per reason; the card's first-failed
  headline; the unverifiable reason per cause. The third pass (D-25ca..D-25cq): the Expire now preview keeps a
  watchlisted pending row; a tile's kept tooltip, projected skip and note (`batchTileView`); the Library notice's
  watchlist keep; the seed's one record per term; `isSameArrTitle`; `releaseProfileDrift`; the card's exclusion
  deadline; the env hold flag. The fourth pass (D-25cr..D-25da): a renamed-only term leaves out a namesake's year
  (The Killer 2024 / 2023) but never the *arr's own; the Library notice keeps the watchlist note on Save; the
  Start-a-batch `freesBytes` and the unfiltered pick; the Expedite-all protected line; the Expire now outcome lines.
  PLAN-072 S6 (D-25dd): 35 real ledger names that used to match only folded (apostrophes, accents, `&`, `&amp;`, in
  group and exact terms) each get a verified term that matches the raw name and its folded spelling, and the ledger
  pass over them counts no fold-only term; a group term still blocks only its season, resolution and group; a
  renamed-only pool term matches its title's own apostrophe and `&`; the grammar accepts the apostrophe join, the
  accented alternation and the optional `and` and refuses any other alternation, a join in a group, an `and` with no
  word after it; a decomposed accent inside a word is still `foldOnly` (the report counts it). The review (D-25di): a
  `´` is an apostrophe to both readings (Amélie, an Élite episode "Don´t"), `İ` is written, fullwidth and Greek
  apostrophe forms agree with the tokens, and a term from the `&amp;`, `&`, `and`, `&#39;` or plain spelling of Lilo &
  Stitch and Bob's Burgers matches all of them and nothing of another season, resolution or group.
- **Integration (embedded Postgres, stub HTTP):** migration 0081 applies and replays; the refresh writes and carries
  forward; a Seerr stub that answers 200-empty after a non-empty read, and one whose page 2 answers the error body,
  leave the registry's items for that user unchanged; a community friend going hidden keeps their items; a sweep with
  a watchlisted item skips it with `watchlisted`; a stale registry makes the scheduled sweep return `paused_gate`,
  write nothing but `trash_sweep_status`, and exit 0; a forced manual Expire now with a stale registry deletes nothing
  and answers `PRECONDITION_FAILED`; a recording stub proves the order *arr identity GETs → release-profile PUT →
  read-back GET → claim → Maintainerr handle → *arr GET → record `active`; a failed PUT, or a term that fails the
  grammar, deletes nothing and returns `paused_release_block`; a 409 handle, or an item the *arr still has after the
  handle, leaves the record `abandoned` and the final reconcile removes its term; a claim lost to a mid-sweep Save
  abandons the record likewise; an item with no recordable term is kept `release_unrecorded`; an untargeted batch
  snapshots a watchlisted item `pending` and the sweep keeps it; a watchlist add made while the sweep runs keeps the
  items not yet reached; a handle that deletes and then loses its answer leaves the record `active`; Expedite item
  and all follow the same order; the
  Arm/Disarm toggle sends `listExclusions`/`forceSeerr` back unchanged; the invariant refuses a pool with either
  false; enrollment echoes the GET body, skips `already_on`, never re-enables an opt-out, honours `onlyUserIds`; the
  seed script's dry run writes nothing, skips a deleted row whose *arr record still exists, and matches a legacy SAB
  row by title, year and size. The second review pass adds: the real `PlexRegistryClient` over a list that shifts
  between pages never drops a title still on it (D-25bn); a re-add the sync re-matches onto its old ledger row is
  watched 7 days from its first sighting (D-25bo); a TV pool whose shows are listed by discover id and by tvdb id is
  kept by the sweep and by Expedite (AC-33); the note is matched through `trash_candidates.plex_guid` for a title
  known only by discover id, and a deleted row never carries it (D-10, D-25w); a nothing-due sweep job settles a
  stranded record and drops an expired term (D-25br); a lost enrollment answer is confirmed as the app's (D-25bs);
  the identity abort and the gate refusal on the wire (D-25bu, D-25bv). The third pass adds: through the real
  DESIGN-051 change and undo paths, an undone remove and a timed-out add made after the run are kept by the gate and
  the late re-read (D-25ca, D-25cb); held web deletes refuse before the gate (D-25cc); a read-back or a lost POST
  after the write landed leaves no term in the failing *arr (D-25cd); the upkeep re-enables, re-creates and
  overwrites a hand-edited profile and removes an abandoned term (D-25ce); the registry job runs the upkeep
  (D-25cf); a pending crawl that fails for 7 hours shows the banner and the next ok sweep clears it (D-25cg); another
  title at the ledger's *arr id is never recorded and reads as gone at the settle (D-25ci); an enrollment keeps the
  user's own flags and a failed write GET records nothing (D-25cj); the registry failure lines carry `http_401`
  (D-25ck); the stubs' Fixture history and stored pool flags (D-25cp). The fourth pass adds: identity of a
  renamed-only movie and series next to a namesake in the ledger, and the pool report's `namesakeNarrowed` (D-25cr);
  the `--manual` Terrifier term blocks the 2018-named repost, takes Radarr's secondary year and survives a failed read
  (D-25cs); a season-less ledger import is blocked by its exact name, and a nameless one keeps the series (D-25ct);
  `pendingCandidates` reports an unfiltered proposal after 24 hours (D-25cx); the dev:local stub keeps a Radarr term
  through two upkeep runs with no drift (D-25da).
- **Web:** the `previewGuardian` parity test with the new cases, a `ruleEvaluationFailed` item among them; the tile
  note and tooltip render without moving neighbours (ADR-015); the paused banner appears only after 6 hours and
  names its reason. Built as render tests (`lib/__tests__/trash-watchlist-render.test.ts`: the banner per reason and
  Maintainerr's precedence, the tile note, the item confirm and the report), the API's `trash.status` after a 7-hour
  pause, and one e2e step (`trash.spec.ts`, a pool title on the stub member's Seerr list): the note and its tooltip,
  every meta-line chip inside its tile at 390, 360 and 320 px, the Expedite confirm's "1 on a watchlist" and the
  Watchlists card's headline and "Lists" group.
- **Guards:** `@hnet/arr/write` import confinement covers the new methods; the no-direct-state-writes guard covers the
  new tables; every delete-path caller of `shapePendingItems` / `listTrashPending` passes a `delete` snapshot
  (D-06).
- **Live (PLAN-072 S6..S10):** read-only checks, the first guarded sweep, the seed, the canary and the re-requests,
  each with its evidence in the plan log.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Managed Home users: does `POST plex.tv/api/home/users/{id}/switch` with the owner token work without side effects (a new device or session record, disturbing the owner token), and do managed users have a discover watchlist at all? | **Answered by the owner, 2026-09-26 (D-25de):** "Leave them out just make sure to automatically pickup new users. I'll move everyone on Plex Home to their own account linked with the server." The switch is never built or probed; managed users stay `unresolvable` (D-04) and do not block; new accounts are read from the next run. PRD Q-15. |
| Q-02 | May the guard use friends' **private** watchlists read through Seerr's stored tokens? | **Resolved by the driver decision recorded in ADR-093 C-01/C-06:** yes, as guard input only, never shown or logged. |
| Q-03 | Seerr caches one watchlist response per token with its ETag, whatever the offset. Can our sequential page reads interleave badly with Seerr's own 3-minute sync of the same user (a 304 answered with another page's cached body)? Only sequential reads were tested. | **Answered for today's load (PLAN-072 S6(d), 2026-09-27):** after two registry runs (01:29Z and 01:44Z), each of the 16 Seerr sources equalled a direct sequential Seerr read (the same `ratingKey` sets; the owner's Seerr list equalled the discover list, 151 titles), no page was inconsistent, and Seerr logged no `Failed to retrieve watchlist items` after the registry started (its last two, 2026-09-26 02:30Z and 05:18Z, came from the owner-only sync). S6(h) then lined a day of registry runs up with Seerr's error lines (2026-09-28; 13 plex.tv 503 lines in the 24 hours to 2026-09-29T02:38Z, one tied to a registry `account_failed` that failed closed and cleared on the next run, PLAN-072 addendum). Real contention began at S9, when Seerr syncs every enrolled user every 3 minutes; D-02 keeps detecting the symptom. |
| Q-04 | What does a release profile with about 2,600 regex terms cost Radarr and Sonarr per release decision (RSS sync, a search)? | **Answered for today's counts (PLAN-072 log, 2026-09-29 addendum):** 437 Radarr and 64 Sonarr terms added 0.74 ms per release to Radarr's decision phase (4.09 to 4.83 ms median, +18%, about 0.3 s per 400-release RSS pass) and nothing measurable to Sonarr's (0.93 to 0.97 ms); no search was run. A linear reading puts the 3,000-term cap at about +5 ms per release, about +2 s per RSS pass, so the cap stays 3,000. The measurement is repeatable from the *arr logs ("Processing N releases" to "RSS Sync Completed"). |
| Q-05 | Do the derived terms match real release names: title normalization (apostrophes, `&`, punctuation), the year alternation, remux detection, TV season naming? Anime absolute and daily numbering are out of scope. | **Answered (PLAN-072 S6(e), 2026-09-27):** all 162 pool terms match their own names (0 self-check misses), the 6 verified ones their real names raw. Over the ledger's 20,593 real names, a known group fell back to the exact form 13 times (Radarr) and 164 (Sonarr), 10 and 205 names got no term, and 85 Sonarr names carry no season (exact terms, D-25ct). Names with an apostrophe, an accent or `&` (1.8% of Sonarr's) matched only folded: fixed by D-25dd (none left). A renamed-only term blocks about 92% of real names in simulation, an accepted limit (D-25dh, ADR-093 C-22). |
| Q-06 | "Index" read as the release (all posts and indexers of one group's release at one resolution), not one NZB post or one indexer. | Driver interpretation (ADR-093 C-07); it matches "the same title, different index". |
| Q-07 | Is a 365-day term life right, or should a block last as long as the title exists anywhere? | **Answered (owner, 2026-09-29): keep 365 days.** Asked with the S7 cost measurement in hand (Q-04: about 2 s per RSS pass at the 3,000-term cap); the owner chose the bounded life over never expiring or a longer fixed life. `RELEASE_TERM_LIFETIME_DAYS` stays 365 (PRD Q-16). |
| Q-08 | Should a user's own later opt-out of Seerr watchlist sync be respected? | Driver decision: yes (enroll once). Revisit if the owner wants it enforced. |
| Q-09 | Seerr 3.4.1 creates a missing settings row with `user: req.user` (the API key's user 1). Does TypeORM's cascade from the target user still link it to the target? | **Answered (PLAN-072 S9, 2026-09-28):** canary user 2 (no settings row before) was enrolled; its settings read back with both watchlist flags true and user 1's settings unchanged, so the cascade links the row to the target user. |
| Q-10 | Do Seerr's default quotas hold back first-enable auto-requests (a `QuotaRestrictedError` is logged only at debug)? | **Answered (PLAN-072 S5, recorded 2026-09-29):** Seerr's `defaultQuotas` are movie `quotaLimit 0` / `quotaDays 7` and TV the same, and 0 means no limit, so the defaults hold nothing back. A per-user override was not read; the first full cycle after the enable (S9, 2026-09-28) created 15 requests from 18 enrolled users. |
| Q-11 | The remediation releases were inferred by size from a copy of the legacy HaynesTower SAB history; Terrifier's ledger year (2018) differs from its release's (2016). | **Answered (PLAN-072 S8, 2026-09-28):** the live legacy SAB histories were re-read read-only and the names confirmed by size (0.969 of the download) with tmdb 1097549 (Babygirl), 420634 (Terrifier) and 974573 (Another Simple Favor); the manual terms took the *arr's years too (Terrifier `(?:2016|2018)`). Silent Night (2023) has no release in any of the five histories and stays unblockable. |
| Q-12 | What does `releaseGroup` look like for the 163 disk-imported pool movies (how many are null, so only an exact name or nothing can be blocked)? | **Answered (PLAN-072 S6(e), D-25df):** of the 164 in the pool on 2026-09-27, 158 are disk imports and none has a null group; 156 get a group term (`low_confidence`, renamed-only) and 2 none (DVD files with no resolution token), kept `release_unrecorded`. |
| Q-13 | If many pool items have no recordable term, may they be deleted unblocked (a re-request would then fetch the same release), or do they stay kept? | **Not asked (D-25df):** S6(e) kept 2 of 164 (1.2%), not a material share, so they stay kept (`release_unrecorded`, D-11, D-24g). It is asked if a later pool shows a material share. |
