# DESIGN-052: Watchlist protection for Trash — the Watchlist Registry, the Registry Gate, the Watchlist Keep, the Release Block, and everyone's Seerr watchlist

- **Status:** Draft
- **Last updated:** 2026-09-26 (D-25 records the rulings made while building PLAN-072 S2 part 1: the registry, the
  gate and snapshot, the guard and the D-10 surfaces). Prior: 2026-09-26 (D-24 records the rulings from the PR #594
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
   managed     plex.tv home switch token, only once Q-01 proves it safe
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
pages; a truncated read is a failure). Rows carry the discover id (the `plex://` guid suffix) and tmdb/tvdb/imdb.

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

**Seerr users** (all 16 today, including the owner):

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
prove theirs works, and the one that answered 0 is unverified, because 0 is also the error answer (research §2).

**Managed Home users.** `POST https://plex.tv/api/home/users/{id}/switch` returns an `authenticationToken` for the
managed user, which could read that user's discover watchlist like the owner path. It is a POST that mints a token
and a session and is **disabled until Q-01 is answered** (PRD Q-15). When enabled, the token lives in memory for one
refresh, is never stored or logged, and a failed switch is **failed** for that source. Until then a managed user's
only source is `not_applicable`, so the account is `unresolvable` (D-04). PLAN-072 S6a puts Q-01 to the owner.

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
  `already_on` bool, `optout_observed_at` null, `last_checked_at`.
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
- **Expedite confirm:** the protected count's breakdown includes "on a watchlist".
- **Sweep paused** (`trash_sweep_status.paused_since` at least 6 hours old: no sweep of a due batch has succeeded for
  6 hours, for any reason, D-14): a warning banner on the Trash page for anyone with Trash access, worded by the
  reason: gate, "Deletion is paused until watchlists can be checked."; release block, "Deletion is paused until
  deleted releases can be recorded."; audit unsafe or *arr down, "Deletion is paused until Maintainerr and the
  media apps check out." A shorter pause shows nothing: one refused hourly run is routine.
- **Trash settings, a read-only "Watchlists" card (admins):** "Checked 6 minutes ago. 22 accounts read, 20 can't
  be read." with the per-class and per-status counts; never a name or a title. It also shows the Release Block and
  re-add counts of D-23.

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
when one is known. Season 0 (specials) is skipped.

**No recordable term, no delete.** When a survivor's group and release name are both unknown, or D-12's self-check
rejects every form, no term can block its release, and deleting it would let a later re-request fetch the same
release, which ruling 2 forbids. Such an item is **kept**: the sweep and Expedite skip it with `keep_reason =
'release_unrecorded'` (the same keep as a failed identity read, D-14), and it is counted `unblockable` (Q-12). It
stays in the pool and comes back in later batches, each time re-checked, so a file that gains a group (an
upgrade, a rename) becomes deletable. If PLAN-072 S6(e) finds this keeps a material share of the pool, the owner is
asked then (Q-13) whether those titles may be deleted unblocked; until he answers they are kept.

### D-12 — Deriving the "must not contain" term

Tokens: Unicode NFKD, combining marks removed, apostrophes removed, `&` read as `and`, lowercase, split on
`[^a-z0-9]+`. The title tokens come from the known release name (the tokens before its year) when there is one,
else from the *arr's title. Each term is a Perl-style regex Radarr and Sonarr accept (`/pattern/i`, matched against
the release title; research §5). `SEP` below is `[^a-z0-9]`, not `[\W_]`: .NET's `\W` is Unicode-aware and
JavaScript's (without `u`) is ASCII-only, while `[^a-z0-9]` under `/i` matches identically in both on release
titles, so the in-app self-check tests exactly what Radarr and Sonarr will run.

**The year is an alternation.** Release names often carry another year than the *arr (the Terrifier release says
2016, the ledger 2018), and a disk-imported movie's only name is Radarr's own renamed file, built from Radarr's year.
`Y` is therefore `(?:y1|y2|…)` over the distinct years of: Radarr's `year`; its `secondaryYear`; and the year parsed
from each known release name (the grab's `sourceTitle`, `sceneName`, `originalFilePath`, a ledger or legacy SAB
name). When the record's only name is the renamed `relativePath`, the window is widened to year − 1 .. year + 1.
The years are stored on the record (`years`).

**Movie, release group known** (the usual case): the title, the year, the resolution, `remux` when the quality is
a Remux, and the group:

```
/^{T}SEP+{Y}SEP(?=.*(?<![a-z0-9]){R}p(?![a-z0-9])){X}.*SEP{G}(?:SEP|$)/i
   T = title tokens joined by SEP+     Y = one year, or (?:y1|y2|…)     R = 2160 | 1080 | 720 | 480
   X = (?=.*(?<![a-z0-9])remux(?![a-z0-9]))  only for a Remux quality     G = group tokens joined by SEP*
```

Example (Babygirl's deleted file):
`/^babygirl[^a-z0-9]+2024[^a-z0-9](?=.*(?<![a-z0-9])2160p(?![a-z0-9]))(?=.*(?<![a-z0-9])remux(?![a-z0-9])).*[^a-z0-9]framestor(?:[^a-z0-9]|$)/i`
matches `Babygirl.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR` and its space-separated repost,
and not `Babygirl-2024-2160p iT WEB-DL … -HONE` or the 1080p `-APEX` release. It blocks every post and every indexer
of that group's release at that resolution: "the same title, different index" (ruling 2) is any other release.
Terrifier (Radarr year 2018, release name `Terrifier.2016.Uncut…REMUX-FraMeSToR`) gets `Y = (?:2016|2018)`.

**Movie, no group but a release name:** the exact name, separator-insensitive:
`/^{all tokens of the name joined by SEP*}(?:SEP|$)/i`.

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
parts that are exactly the templates above: every title, year and group token matches `^[a-z0-9]+$`, `R` is one of
2160 / 1080 / 720 / 480, `S` is digits, and the only flag is `i`. The sentinel is the one plain term. The writer
re-checks every desired term against this grammar before any POST or PUT (D-13) and refuses the write otherwise.

**Self-check before recording:** the term is compiled in the app and must match every release name of its record;
a group term that fails falls back to the exact form, and a term that matches nothing it came from is not recorded
(no term, so the item is kept, D-11). A record whose only name is Radarr's renamed `relativePath` cannot validate
its term, because that path is built from the same Radarr title and year the term is: its term is written with
`term_confidence = 'low_confidence'` (otherwise `verified`) and reported in PLAN-072 S6(e)'s dry run, so the share
that blocks nothing real is known before S7.

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
     A and settling its records, D-14) are settled against the *arr: `GET` the item by `arr_item_id`; a 404 makes
     them `active` (the delete happened), a live item makes them `abandoned` (it did not), and an unreachable *arr
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
  hand edit is overwritten on the next reconcile, and a deleted profile is re-created.
- **Growth:** a term lives **365 days** from its record (`expires_at`, extended when the same term is recorded
  again); at about 50 movie deletions a week the profile settles near 2,600 movie terms. The cost of that many regex
  terms per release decision is Q-04.

### D-14 — The sweep, step by step

`sweepExpiredBatches({ registry: 'refresh' | 'gate-only', … })`: the input is required. The `trash-batch-sweep`
mode passes `refresh`; the web `expire` mutation (the manual Expire now, with or without `forceOverride`) passes
`gate-only`, like Expedite. Both need the *arr read and write clients (the sync job builds them; the web mutations
take `resolveArrBundle(ctx)`, D-22). For the due batches (the batch list is read first; with none due, the sweep
does nothing and records nothing):

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
   `release-block failed`; outcome `paused_release_block` (reason = the step).
6. **Phase B, per item (unchanged claim discipline):** one transaction does the guarded claim (`pending` →
   `deleted`), the `trash_expedited` event and the deletion audit (ADR-034/035), and stamps the item's records with
   `batch_item_id`; they stay `in_flight`. A lost claim (Saved mid-sweep) flips them to `abandoned`. Then the
   Maintainerr handle.
7. **Settle each record after its handle.** A 2xx handle is followed by a `GET` of the *arr item: a 404 flips the
   records to `active` (`activated_at` now). A failed handle (Maintainerr answers 409 while its rule or collection
   executor holds the lock, or when `handleMedia` returns 'failed', which the sweep tolerates as today) or an item
   still present flips them to `abandoned`, logged `handle_not_effective`: a 365-day term must never block the
   current release of a title that is still in the *arr. The item stays in the pool and comes back in a later batch,
   where it is recorded again. A `GET` that cannot be answered leaves the records `in_flight` (their terms stay);
   the next reconcile settles them (D-13 step 1).
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
its reason; `paused_since` set on the first non-ok outcome and cleared by the next ok one). The web `expire`
mutation maps a paused report to `PRECONDITION_FAILED` with the reason and writes no status row (the scheduled sweep
owns it).

Expedite (both scopes) runs the same order per call: audit, gate (without an inline refresh), guardian, identity,
Phase A, claim, handle, settle. It throws instead of pausing: `WatchlistRegistryUnverifiedError` and
`ReleaseBlockError` map to `PRECONDITION_FAILED`. The write paths share one helper (`recordAndBlockReleases`) so they
cannot drift.

Ordering guarantee (ADR-084 E-6): the term is in the *arr's profile, read back, before the handle that deletes the
record, and it stays there (`in_flight`, then `active`) unless the item is proven still present. A re-add seconds
later meets the block on its first search.

### D-15 — Seeding the block: backfill and the three remediation titles

A one-off script, `packages/sync/src/scripts/release-block-seed.ts` (not a sync mode), with `--dry-run` (counts only,
per source) and `--apply`. Its population is every `trash_batch_items` row in state `deleted`, **except** rows whose
*arr record still exists (a live `media_items` row with that `arr_item_id`, confirmed by a `GET` of the *arr item):
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
  records; none leaves the row unidentified. `origin` `backfill`, `identity_source` `legacy_sab`. The research found a
  completed legacy record for 331 of the 416 deleted movies, 284 of them with no cluster record (research §5).
- **What stays unblockable:** deleted rows with no ledger identity and no legacy match, about 43 movies today (and
  the series the ledger misses). They were deleted before this design and cannot be recorded; they are counted in
  the dry run and the S8 log, and ADR-093 C-21 records them as the known limit of ruling 2.
- **Named checks:** Silent Night and The Unholy Trinity had a friend's add before deletion and no ledger grab or
  import (0 rows each), so only the legacy SAB can seed them; the dry run lists both explicitly, and if the bulk
  match misses either, it is added through `--manual` after the same size check.
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
  mounts the same secret; it now also builds the Plex read, Seerr read and Radarr/Sonarr read and write clients.
  The web pod already holds them (`resolveArrBundle`).
- Egress: the `frontend` namespace has no CiliumNetworkPolicy for haynesnetwork; plex.tv, community.plex.tv and
  discover.provider.plex.tv answered from the web pod (research §2). S6 confirms the CronJob pods.
- `pnpm dev:local`: stub plex.tv (`/api/v2/user`, `/api/users`, `/api/home/users`), community GraphQL (a fixture
  roster including a hidden-empty friend and a `User not found:` managed user; node `type` in the live upper-case
  `MOVIE` / `SHOW`), discover metadata, Seerr (users, watchlist pages, settings main GET/POST, and a switch that
  makes a user's watchlist answer Seerr's error body, 200 `{totalPages: 0, totalResults: 0, results: []}`, on any
  page) and the *arrs (`releaseprofile`, `moviefile`, `episodefile`, `history/*` with grab and import records
  linked by `downloadId` and `data.fileId`, and a GET that 404s a deleted item).

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
- `[trash] sweep_paused {reason, step, pausedForH}` (warn) on every run with a batch due while paused, and
  `sweep_outcome {outcome, reason}` when the outcome changes (D-14).
- `[release-block] recorded {arrKind, origin, identitySource, shape: group|exact|none, confidence}`; `reconciled
  {arrKind, total, added, removed, expired, pruned, settled, wrote, ms}`; `failed {arrKind, step}` (error; step
  `validate`, `put`, `read_back` or `duplicate_profile`); `handle_not_effective {arrKind, recordId, title}` (warn,
  D-14 step 7); `readd {arrKind, recordId, title, grabs, sameRelease}` (D-23; error when `sameRelease`).
- `[seerr-enroll] enrolled {seerrUserId, alreadyOn}`; `optout_observed {seerrUserId}`; `failed {seerrUserId, status}`.
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
| `@hnet/sync` | the `watchlist-registry` mode; the sweep's client wiring, `registry: 'refresh'`, a paused report exits 0; the D-23 re-add check after the sweep; `release-block-seed.ts` (`--legacy-sab`, `--manual`) |
| `@hnet/api` | `expediteItem`, `expediteAll` and `expire` take `resolveArrBundle(ctx)` besides the Maintainerr bundle; `expire` passes `registry: 'gate-only'`; `WatchlistRegistryUnverifiedError`, `ReleaseBlockError` and a paused sweep report map to `PRECONDITION_FAILED`; Trash status gains the registry summary, the sweep status and the D-23 counts |
| `apps/web` | `previewGuardian` mirror, the wall note, skip-reason tooltips, the paused banner (from the sweep status), the Watchlists card |
| haynes-ops | the CronJob, the Loki alerts, the image tag |
| CLAUDE.md | hard rule 4 (ADR-093 C-08) |

### D-23 — Re-add evidence and exclusion visibility (ADR-084 E-4, E-5)

ADR-084's errata E-4 (the exclusion list needs an admin surface, "or at least visibility", its C-04) and E-5 (the
sync is blind to a title re-added after a Trash delete) were obligations of the D-1 build this design replaces, so
they are delivered here. E-5's signal is also the standing evidence that ruling 2 holds after PLAN-072 closes.

- **The re-add check (E-5).** `checkReleaseBlockReadds` runs hourly in the `trash-batch-sweep` mode after the sweep,
  whether or not a batch was due; a failure is a warning and never changes the job's exit.
  1. It finds records in state `active` or `expired` with `readd_seen_at` null whose title is live again in the
     ledger: a `media_items` row with `deleted_from_arr_at` null, the record's `arr_kind`, the same tmdb id (movies)
     or tvdb id (series), and an `arr_item_id` other than the record's (a re-add is always a new *arr id, whether
     the ledger inserts a row or re-matches the old one by external id).
  2. It reads that item's grabs from the *arr (`history/movie` or `history/series`, event type 1), because the
     ledger does not reliably receive a re-added id's grab events (E-5).
  3. It tests each grab's `sourceTitle` against the record's term (the self-check's compiled regex) and stamps
     `readd_seen_at` and `readd_same_release` (true when any grab matches). A re-added title with no grab yet is
     checked again each hour, for at most 7 days.
  4. It logs `[release-block] readd` (D-21); `sameRelease=true` means the block failed and pages at once.
- **Visibility (E-4; driver decision: the "at least visibility" floor).** The Watchlists card (D-10) shows, per
  *arr, the Release Block's live term count against its cap and the oldest term's age; the import-list exclusion
  count, read live through `@hnet/arr` when the card loads ("not available" when the *arr does not answer); and the
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
(D-14, as it concerns the gate), the D-10 surfaces, and the registry half of the D-20 stubs. Part 2 (the Deleted-Release
Record, the Release Block, the backfill, the Arm/Disarm fix, the Seerr enrollment and the D-23 counts) needs no further
migration. The rulings below were made while building; none changes a D-24 ruling.

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
| D-25k | What "unmapped" means for the evaluable rule (D-06). | A movie counts as mapped with a tmdb id, a show with a tvdb id (each kind's key in the pool); a show known only by tmdb id is unmapped (fail closed). |
| D-25l | A pool item whose `plex://` guid names the other kind. | It is not a discover key; the item is still matched by its external ids and is evaluable only if nothing of its kind is unmapped. |
| D-25m | The D-19 overlay's keys. | A `watchlist_add` mark with result `pending` or `written`, not reverted, made since the newest ok run started, adds its discover id and also its tmdb / tvdb ids (only ever adding protection). |
| D-25n | An owner discover row with no valid discover id (neither the `plex://` suffix nor a 24-hex ratingKey). | Skipped and counted (`ownerSkipped`), not a run failure; discover has not been seen to serve one. |
| D-25o | Pruning runs older than 7 days. | The newest ok run is never pruned, so the Watchlists card can always say when watchlists were last checked. |
| D-25p | When `community_mass_empty` logs (D-04). | When the previous ok run had at least 2 community sources with titles and this run has half as many or fewer. |
| D-25q | The Watchlists card's "n accounts read, m can't be read". | An account is read when one of its sources holds a verified list (`read` or `carried`, not `empty_unverified`); every other current account can't be read (unresolvable, unreadable, not read yet, or answering only empty and unverified). This reproduces the research's 22 / 20 split. |
| D-25r | Which `trash_sweep_status` outcome the existing handle breaker records (3 consecutive Maintainerr handle failures). | `aborted_arr` with reason `handle_breaker`: the media apps did not answer, and the banner reads "the media apps". Part 2's *arr identity breaker records the same outcome. |
| D-25s | The scheduled sweep with nothing due. | It does nothing at all: no audit, no registry refresh, no status row (D-14). Before, an unsafe audit failed the job every hour even with nothing due. |
| D-25t | The `watchlist-registry` job's exit code. | 0 for a clean `failed` run (roster, owner) and for `busy`; only a thrown error fails the Job. The run row and `run_failed` (the Loki alert after 8 in a row) are the signal, so a plex.tv outage does not fire the job-failure alert every 15 minutes. |
| D-25u | How the web paths surface a refusal. | Expedite's gate refusal is `WatchlistRegistryUnverifiedError` (appCode `WATCHLIST_REGISTRY_UNVERIFIED`); a manual Expire now that paused throws `TrashSweepPausedError` (appCode `TRASH_SWEEP_PAUSED`); both are PRECONDITION_FAILED and their messages are the banner's wording. |
| D-25v | Where the paused banner lives (D-10). | Inside the Maintainerr safety banner's reserved row, recoloured to warn (ADR-015: no new row under the page), shown only while Maintainerr itself checks out (its own warnings take precedence). `trash.status` carries `sweepPause`, set only once the pause is 6 hours old. |
| D-25w | The "On a watchlist" note's footprint. | A bookmark and the short visible label on the tile's meta line, the long wording in the tooltip and aria-label; the size and rating text ellipsizes first, so the tile's geometry is unchanged. On the batch wall the note shows on every row except `deleted`. |
| D-25x | The space policy's reported candidate count (D-08). | It now reports the deletable candidates `minCandidates` is compared against (not `dnd`, not on a watchlist). |
| D-25y | The Start-a-batch preview (the client mirror of `selectBatchCandidates`). | A targeted pick leaves watchlisted candidates out; an untargeted count includes them, since they are snapshotted `pending`. |
| D-25z | The managed-user Home switch (D-02, Q-01). | Not built until Q-01 is answered: the `switch` source is always `not_applicable` (`switch_disabled`), so managed users are `unresolvable`. |
| D-25aa | The copy of D-10. | The driving session's UX pass supersedes the proposed copy: the note "On a watchlist" (tooltip "On a watchlist. It won't be deleted while it stays there."); kept tooltips "Kept: on a watchlist / watched recently / couldn't be checked / no longer a candidate / saved / couldn't be removed safely" (`tag` and `live_excluded` both read "saved"); the confirm's term "on a watchlist"; the banner "Deletions are paused until watchlists can be checked." / "… until removals can be done safely." / "… until the media apps respond normally."; the card's "Checked {relative time}. {n} accounts read, {m} can't be read." |
| D-25ab | The retry policy of D-02 on the existing clients. | `PlexHttp` and `ArrHttp` gained `retryStatus` and `retryBackoffMs` options (defaults unchanged); the registry's plex.tv and Seerr clients use 10 s, 3 attempts on 429 / 5xx / network, 2 s × attempt. The owner's discover list is read by the registry client with that policy, through the paging loop `getWatchlist` uses (extracted, unchanged). |
| D-25ac | `pnpm dev:local` and e2e with a gate that needs a fresh run. | The stubs gained the registry half of D-20 (the plex.tv roster with a hidden-empty friend and a `User not found:` managed user, community GraphQL with upper-case `MOVIE` / `SHOW`, discover metadata, Seerr users and watchlist pages with the error-body switch); the stack runs the `watchlist-registry` mode at boot and the Trash spec re-runs it before it deletes. No default stub list holds a Trash pool title. The *arr and Seerr settings stubs are part 2's. |

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
  rules); the re-add check (a new *arr id with a same-release grab, with a different release, with no grab yet).
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
  snapshots a watchlisted item `pending` and the sweep keeps it; Expedite item and all follow the same order; the
  Arm/Disarm toggle sends `listExclusions`/`forceSeerr` back unchanged; the invariant refuses a pool with either
  false; enrollment echoes the GET body, skips `already_on`, never re-enables an opt-out, honours `onlyUserIds`; the
  seed script's dry run writes nothing, skips a deleted row whose *arr record still exists, and matches a legacy SAB
  row by title, year and size.
- **Web:** the `previewGuardian` parity test with the new cases, a `ruleEvaluationFailed` item among them; the tile
  note and tooltip render without moving neighbours (ADR-015); the paused banner appears only after 6 hours and
  names its reason.
- **Guards:** `@hnet/arr/write` import confinement covers the new methods; the no-direct-state-writes guard covers the
  new tables; every delete-path caller of `shapePendingItems` / `listTrashPending` passes a `delete` snapshot
  (D-06).
- **Live (PLAN-072 S6..S10):** read-only checks, the first guarded sweep, the seed, the canary and the re-requests,
  each with its evidence in the plan log.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Managed Home users: does `POST plex.tv/api/home/users/{id}/switch` with the owner token work without side effects (a new device or session record, disturbing the owner token), and do managed users have a discover watchlist at all? | (open; PRD Q-15, owner's call because it signs in as a managed user) Disabled until answered; managed users are `unresolvable` (D-04) and do not block. PLAN-072 S6a asks the owner and, on a yes, tests the switch on one managed user; the ruling is recorded here as a D-NN. |
| Q-02 | May the guard use friends' **private** watchlists read through Seerr's stored tokens? | **Resolved by the driver decision recorded in ADR-093 C-01/C-06:** yes, as guard input only, never shown or logged. |
| Q-03 | Seerr caches one watchlist response per token with its ETag, whatever the offset. Can our sequential page reads interleave badly with Seerr's own 3-minute sync of the same user (a 304 answered with another page's cached body)? Only sequential reads were tested. | (open) D-02 now detects the symptom (a page repeating an earlier page's `ratingKey` is inconsistent, read again once, then failed). PLAN-072 S6 compares a registry read of each Seerr user with a direct read, compares registry runs with Seerr's `Failed to retrieve watchlist items` log lines, and watches Seerr's sync logs for errors after enrollment. |
| Q-04 | What does a release profile with about 2,600 regex terms cost Radarr and Sonarr per release decision (RSS sync, a search)? | (open) PLAN-072 S7 records Radarr's RSS-sync and search durations before and after; the 3,000 cap is lowered if it hurts. |
| Q-05 | Do the derived terms match real release names: title normalization (apostrophes, `&`, punctuation), the year alternation, remux detection, TV season naming? Anime absolute and daily numbering are out of scope. | (open) PLAN-072 S6 runs the derivation over the 170 pool movies and the ledger's grabbed names read-only and reports the self-check misses and the `low_confidence` share. |
| Q-06 | "Index" read as the release (all posts and indexers of one group's release at one resolution), not one NZB post or one indexer. | Driver interpretation (ADR-093 C-07); it matches "the same title, different index". |
| Q-07 | Is a 365-day term life right, or should a block last as long as the title exists anywhere? | (open; PRD Q-16) 365 days bounds the profile; the owner may lengthen it. |
| Q-08 | Should a user's own later opt-out of Seerr watchlist sync be respected? | Driver decision: yes (enroll once). Revisit if the owner wants it enforced. |
| Q-09 | Seerr 3.4.1 creates a missing settings row with `user: req.user` (the API key's user 1). Does TypeORM's cascade from the target user still link it to the target? | (open) The S9 canary targets a user with no settings row and reads the settings back, and user 1's settings are checked unchanged. |
| Q-10 | Do Seerr's default quotas hold back first-enable auto-requests (a `QuotaRestrictedError` is logged only at debug)? | (open) S9 reads `GET /api/v1/settings/main` `defaultQuotas` before the enable. |
| Q-11 | The remediation releases were inferred by size from a copy of the legacy HaynesTower SAB history; Terrifier's ledger year (2018) differs from its release's (2016). | (open) S8 re-reads the live history read-only and confirms each name and the Radarr ids before writing terms. |
| Q-12 | What does `releaseGroup` look like for the 163 disk-imported pool movies (how many are null, so only an exact name or nothing can be blocked)? | (open) Measured by the S6 dry run; a null group with no name is counted `unblockable` and kept (D-11). |
| Q-13 | If many pool items have no recordable term, may they be deleted unblocked (a re-request would then fetch the same release), or do they stay kept? | (open; asked only if S6(e) shows a material share) Until the owner answers they are kept (`release_unrecorded`, D-11, D-24g). |
