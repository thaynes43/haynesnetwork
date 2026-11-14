# DESIGN-052: Watchlist protection for Trash — the Watchlist Registry, the Registry Gate, the Watchlist Keep, the Release Block, and everyone's Seerr watchlist

- **Status:** Accepted (2026-09-28; live since v0.101.0, PLAN-072 S6–S10 verified)
- **Last updated:** 2026-11-14 (proposed D-33, ADR-122: permanent Release Block terms; implementation held by Q-37). Prior: 2026-11-14 (D-30: the notes boundary is the marker ` | Notes: `; a description with no marker is all notes). Prior: 2026-11-14 (integration with main: the Request Keep stays before `unevaluable`; `release_unverified` stays after it; migration 0111 is journal index 109 after 0110; the Request Keep's open question is Q-31 because main holds Q-23) Prior: 2026-11-13 (ADR-118 review corrections: the keep reads the 04:30 full-sync copy, up to 24 hours; a new batch leaves a requested title out; the audit fails closed on the clause, D-30). Prior: 2026-11-13 (ADR-117, D-29, story 838: a library id token does not verify a file, and a grab or failed download that carries one is termed or keeps the title). Prior: 2026-11-13 (ADR-117, D-29, story 838: a media extension and a library id token do not verify a release name). Prior: 2026-11-13 (ADR-117, D-29, story 838, owner ruling: Trash deletes a title only when each file on disk has a verified posted release name, and writes a term for every posted name of the title first; the legacy release names of the old Radarr and Sonarr databases are loaded into the app; a delete never prunes an older term; migration 0110 is journal index 108 after 0109; Q-19..Q-22 decided, Q-23 and Q-26..Q-30 open. The second review of PR 1070: a current-path original name or scene name is not verified, and the 17:00 ET pool read is recorded beside the earlier one). Prior: 2026-11-13 (ADR-119, D-31: a library-fill Plex date does not extend the Age Guard when the setting is on and that *arr's ledger covers 180 days; a title with no Plex match is unknown, the one change that alters today's behaviour, and it only ever keeps more). Prior: 2026-11-13 (ADR-118, owner ruling: a title tagged `mediarequests` is a guardian keep). Prior: 2026-11-13 (D-26 cross-reference: DESIGN-014 D-15's TV predicates include the votes floor, and the removed TV date-added clause is what a title with no Plex match relied on). Prior: 2026-11-13 (D-10 amendment, story 821: the Show protected checkbox becomes the Library's segmented control, Deletable | All; in All a kept tile says why in plain words; Q-18 opened). Prior: 2026-11-13 (D-10 amendment, story 832: Wall Protection, one definition of a title the pending wall will not offer; the default view holds none, and a title saved from it keeps its tile until the view is opened again; Q-15, Q-16, Q-17 opened). Prior: 2026-10-03 (Q-14 answered: the Age Guard moves into `classifyGuardian`, so Expedite never deletes a title inside it, and the pending walls show such a title kept, D-26). Prior: 2026-10-03 (ADR-097, owner ruling "Block automation only": D-27 adds the Title Exclusion, an import-list exclusion the app writes on Radarr or Sonarr for every title Trash is about to delete, after identity and before Phase A; D-28 adds its one-off backfill for the titles deleted before; D-14, D-21, D-22, D-23, the overview and the test strategy updated). Prior: 2026-10-03 (D-26 — the Age Guard, owner ruling "Yes, newest date wins": Trash never deletes a title downloaded, upgraded or added to any Plex server in the last 180 days; enforced at batch build and the sweep; migration 0086; Q-14 opened for Expedite). Prior: 2026-09-28 (PLAN-072 S8–S10 done live: D-25di records the rulings; the Seerr Sonarr settings PUT must omit the read-only `id`). Prior: 2026-09-27 (PLAN-072 S6 (a)..(g) passed live on v0.101.0; D-25dd..D-25dh record its results and
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
 sweep :45 ─ refresh ─ gate ─ guardian keeps `watchlisted` (D-09) ─ identity ─ Title Exclusion POST
            + read-back (D-27) ─ record release ─ Release Block PUT + read-back ─ claim  │
            ─ Maintainerr handle ─ *arr GET ─ record active (D-14)                     │
            (a refusal is a clean `paused` outcome, trash_sweep_status)                 │
 Expedite, manual Expire now ─ same gate (no refresh), guardian and release steps       │
 Trash wall ─ "On a watchlist" (D-10)  ◄───────────────────────────────────────────────┘

 Radarr / Sonarr   one app-owned release profile each: "must not contain" terms (D-12, D-13); an import-list
                   exclusion per title Trash deleted, so Kometa and import lists never add it again (D-27, D-28)
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
GuardianInput = protectedByTag, recentlyWatched, mediaItemId, onWatchlist, watchlistEvaluable, ruleEvaluationFailed,
                ageGuard (D-26, since Q-14)
tag              if protectedByTag
recently_watched if recentlyWatched
watchlisted      if onWatchlist
recently_added   if ageGuard is recent                       (D-26, Q-14)
unevaluable      if mediaItemId is null, or !watchlistEvaluable, or ruleEvaluationFailed, or ageGuard is unknown
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
  "Kept: its release couldn't be recorded", and (D-26) "Kept: added or upgraded recently".
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

#### D-10 amendment — visible years and watchlist visibility (Tom, 2026-10-30; #300)

Trash cards keep a fixed **Size · Year · Rating** row below the title. The release year
is always in that row, including on touch screens and when a long title ellipsizes;
unknown facts use an em-dash placeholder. Requester, watch, watchlist and failed-action
status use compact labelled icons over the bottom of the poster, outside the action
and navigation corners. Their accessible names and tooltips retain the explanation.
An action failure keeps the facts visible and retains the wall's fixed error slot.
These supersede the meta-line text/chip placement above and D-25bi at every width.

The pending and future-candidate walls hide known watchlisted titles by default.
**Show protected** includes them for inspection; the control explicitly describes
watchlisted titles. Filtering happens before pagination, and the displayed count and
bytes follow the visible set. The complete candidate population, Expedite preview
and guardian checks are unchanged. This is a view preference, never deletion authority.
Batch audit walls retain their saved/kept records. Saved tiles do not disappear after
an in-place Save; other protection types retain their existing presentation.

#### D-10 amendment — one definition of a title the wall will not offer (2026-11-13, story 832)

The sentence above that the walls hide known watchlisted titles only is superseded for the
pending wall and the future-candidate strip. ADR-035 and ADR-096 are unchanged: the read
model stays display-only, and a Save is still only a confirmed save.

`trashWallProtection` (DDD-001 T-333) is why a pending title cannot be deleted. It follows
`classifyGuardian`'s order and names which check failed when that verdict is `unevaluable`:

1. no Maintainerr id → `unactionable`
2. an open save intent → `saved`
3. the `dnd` tag → `tag`
4. watched within 30 days → `recently_watched`
5. on a watchlist → `watchlisted`
6. Age Guard `recent` → `recently_added`
7. the `mediarequests` tag → `media_request` (D-30)
8. no ledger row → `not_in_ledger`
9. the watchlist cannot be decided → `watchlist_unknown`
10. Maintainerr `ruleEvaluationFailed` → `rules_unknown`
11. Age Guard `unknown` → `age_unknown`
12. otherwise the title may be offered (`null`)

After the page is read, a live Maintainerr exclusion on a title that is otherwise deletable
sets `live_excluded`. ADR-035 keeps that read page-scoped. `protectionReason` is on every
item the page returns, for story 821 to show. A personal requester tag is not a reason. The exact tag `mediarequests` is `media_request` (D-30), after the Age Guard and before the unevaluable names, so the default view omits it.

`includeWatchlisted: false` (Show protected off, on the wall and on the strip's own checkbox)
keeps a title only when the reason is null. The displayed count and bytes follow that set,
except a live exclusion on a later page can still be inside the count (Q-15). `true` and an
omitted flag return every title, each with its reason. The library page omits the flag and
keeps seeing every pending title.

The checkbox label stays **Show protected**. Its description covers every held title. This
change does not restyle the control. Story 821 replaces it (the amendment below).

Corner glyphs stay as already ruled. The inert skip is the Age Guard
(`protectionReason === 'recently_added'`) and the Request Keep (`protectionReason === 'media_request'`). Two cases still read the Age Guard from the item
itself (the previous client check), so they keep the badge they had: a missing field (an
older server), and a title with no Maintainerr id, whose reason is `unactionable` because
that check comes first. A `dnd` tag and a recent watch stay a tappable
trash can (ADR-086 D-5 and the 2026-07-09 ruling). A live exclusion and a Save stay the
check. The complete candidate population, the Expedite preview, `allActionableIds`, and
every delete-path guard are unchanged. `release_unrecorded` stays a delete-time keep (Q-16).

A Save never moves a tile (hard rule 9, ADR-015). On the protected view the saved title is
still in the result set. On the default view it is not: the Save makes the title undeletable,
so the read that follows the Save no longer returns it. The wall therefore keeps that tile at
the place it had, wearing the saved shield and one two-step tap from un-saving, until the
view is opened again (another filter, sort or search, the other view, or a new visit
to the page). The counts bar follows the server at once, so it stops counting the saved
title. A freshly opened default view does not contain a saved title. This is the client's
`usePinnedSaves` over the pure `withPinnedTiles` (`apps/web/lib/trash.ts`), used by the
pending wall and the future-candidate strip; the server read is unchanged by it (Q-17).

Measured 2026-11-13 on the movie snapshot (replica `postgres16-11`; `refreshed_at`
2026-11-13 12:30:04-05, 524 movie rows, 0 TV; the same counts at 12:15:05-05). The previous
filter hid 34 watchlisted titles and left 55 Age Guard titles and 4 recently watched titles
on the default wall. The six titles named in story 832 were Age Guard, not watchlisted.
Evidence:
`.agents/context/2026-11-13-trash-wall-protection.md`.

#### D-10 amendment — the view is the Library's segmented control, and a kept tile says why (2026-11-13, story 821)

The owner's words (2026-11-13): "the UX calls for selection done like ... Library -> Movies
where you select one of the two and it switches what is green". Display only: which titles a
sweep or Expedite may delete does not change, and the server read is the one story 832 left.

**The control.** The **Show protected** checkbox is retired, on the pending wall and on the
future-candidate strip. In its place is the Library's view selector ("Collections | All
movies"): the same `.seg` pill, the same labelled group of two pressed-state buttons, first
in the controls row before the search (`PendingViewSelector`, `apps/web/components/pending-wall.tsx`).
The selected segment is the green one, as in the Library.

| Segment | Lists | Sent to the read |
| ------- | ----- | ---------------- |
| **Deletable** (the default) | only the titles with no Wall Protection (T-333) | `includeWatchlisted: false` |
| **All** | every title the rules flagged, each kept one saying why | `includeWatchlisted: true` |

The labels are the two the owner gave as his example. A view is a way of looking, never a
release of protection: a title kept in one view is kept in the other.

The URL is unchanged: no parameter is Deletable, and `?protected=show` is All. That is the
parameter the checkbox wrote, so every saved link, and the back-link that returns to the wall
with its state, still opens the same view. A tab switch still keeps only `?tab`, so the other
tab opens on Deletable. The strip's selector is local state, as its checkbox was.

**A kept tile says why.** In All, every tile carries one more line under its facts
(`TrashCard` `keptNote`, class `bwall-kept`). A kept title's line is its reason in a few plain
words, in the kept amber of the skip badge; a Save's is in the Save's green. A title that can
be deleted has the line empty. The full sentence is the line's tooltip, leads the tile's
tooltip, and is in the tile's accessible name, which no longer calls a kept title "slated to
delete". Deletable tiles carry no such line: there is nothing to explain.

| Reason the read returns | On the tile | In full (tooltip, screen reader) |
| ----------------------- | ----------- | -------------------------------- |
| `saved`, `live_excluded` | Saved | Kept: saved |
| `tag` | Marked to keep | Kept: marked do not delete |
| `recently_watched` | Watched recently | Kept: watched recently |
| `watchlisted` | On a watchlist | Kept: on a watchlist |
| `recently_added` | Added recently | Kept: added or upgraded recently |
| `not_in_ledger` | Not in the library | Kept: not in the library, so it can't be checked |
| `watchlist_unknown` | Can't be checked | Kept: its watchlists can't be checked right now |
| `rules_unknown` | Can't be checked | Kept: its rules couldn't be checked |
| `age_unknown` | Can't be checked | Kept: its dates can't be checked right now |
| `unactionable` | Can't be removed | Kept: not linked to Plex, so it can't be removed |
| a reason this build does not know | Kept | Kept: it can't be deleted right now |

The words are for a household member, so none of them says ledger, guardian, exclusion,
Maintainerr or `dnd`. Where the batch wall already has a sentence for the reason (the "Kept:
..." tooltips of D-10), the full text is that same sentence, so one reason has one wording
on both walls. The line on the tile is at most 18 characters, which fits a tile a third of a
390 px phone wide. `WALL_REASON_COPY` in `apps/web/lib/trash.ts` is the one copy of these
words; a unit test compares its keys with the server's list of reasons.

A tap the server has answered moves the line at once: a confirmed Save reads **Saved**, and a
confirmed un-save clears a Save's line. An un-save never clears another reason: the title is
still on the watchlist, or still recently watched, and the line says so again.

**The counts bar.** Deletable keeps its line: "Reclaiming 2.0 GB across 1 item". All lists
kept titles too, so it no longer says "Reclaiming": "4 titles in all · 15 GB". When nothing
can be deleted while the rules still flag titles, Deletable says "Nothing to delete", not
"Nothing pending", and the empty wall reads "Nothing here can be deleted right now. Choose
All to see what is kept, and why." The Expedite confirm is unchanged: it always counted the
whole set, whatever the view.

**Corner glyphs and taps are unchanged** (as ruled, and as the amendment above records): the
inert kept badge for the Age Guard, the check for a Save, and the tappable trash can for a
tag, a recent watch, a watchlisted title and a title that cannot be checked. Whether a kept
title's corner should change now that the tile says it is kept is Q-18.

**Nothing moves on a switch** (hard rule 9, ADR-015). Measured 2026-11-13 on the local stack
at 390, 760, 999, 1000 and 1280 px: choosing a segment changes the pill's color and the
wall's tiles, and no other box on the page. Three things made that true:

- A segment's label is bold only while selected, and bold text is wider. The plain `.seg`
  pill changed width by 0.6 px on a switch and moved the search box with it. `.seg--steady`
  holds each segment at the width of its bold label. (The Library's own pill moves its search
  box by 0.08 px, measured the same day; it is left as it is.)
- The total's words change with the view, and on a wide screen the "as of" line and Refresh
  sat after it, so they moved 37 px. The total now has a slot that never depends on its text:
  a fixed one from 1000 px up, where the bar is one line, and a line of its own below that.
  A total too long for its slot ellipsizes and keeps its full text in its tooltip.
- Every tile of the All wall carries the reason line, empty or not, so the rows are one
  height and a reason that appears after a Save moves no row.

The e2e case asserts the boxes at 1280 and 390 px, in both themes, and that the selected
segment's color is the Library's and the theme's accent token.

### D-11 — The Deleted-Release Record: what identity exists

**Amended by D-29 (ADR-117, 2026-11-13).** The file's own identity below gains one source (a legacy file record of
the title's id with the identical byte size), and a file with no verified name at all is no longer deletable: the
renamed-file term below is never a basis for a delete. The file is also no longer the only record. Before the delete
the app records every posted name it can show was grabbed for the title, including a grab that failed or was
replaced.

Recorded for every item the sweep or Expedite is about to delete, before the handle (D-14). Sources, in order of
preference, for the file's own identity:

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
5. **The Title Exclusion, then Phase A, before any delete** (ADR-097, D-27): each recordable survivor's title is
   put on its *arr's import-list exclusion list and read back, one writer call per *arr; a failure stops here with
   nothing recorded or deleted and no profile touched (`ReleaseBlockError`, step `exclusion`; outcome
   `paused_release_block`), and a survivor with no tmdb or tvdb id is kept `release_unrecorded`. Then Phase A:
   one transaction inserts `in_flight` records for every survivor; then
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
A, then the Title Exclusion, D-27, then Phase A), and one settle, `settleReleaseRecords`, so they cannot drift
(D-25bl).

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
- `[title-exclusion] excluded {arrKind, origin, title, year}` per exclusion written (D-27); `failed {arrKind,
  origin, step, written}` (warn; step `validate`, `read`, `write`, `read_back`, or `database` when the audit insert
  itself failed); `backfill {apply, radarr, sonarr}` and
  `backfill_done {radarr, sonarr}` from the one-off backfill (D-28). On the delete paths a failure also surfaces as
  `[trash] sweep_paused {reason: release_block, step: exclusion}`, so the existing `sweep_paused` alert covers it.
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
| ADR-097 (D-27, D-28) | `@hnet/arr`: the exclusion schemas, `listImportListExclusions` on the Radarr and Sonarr read clients (every page of `exclusions/paged` / `importlistexclusion/paged`, oldest id first) and `addImportListExclusion` on their write clients. `@hnet/db`: migration 0087, `trash_title_exclusions` and its enums. `@hnet/domain`: `title-exclusion.ts` (`ensureTitleExclusions`, `backfillTitleExclusions`, `titleExclusionArrClientsFromEnv`), `TitleExclusionError` and the `exclusion` step, `ReleaseBlockArrClients` grown by the two methods, `recordAndBlockReleases` and `resolveTitleExclusionTarget`, the `no_exclusion_key` reason (also counted by the `--pool` report), the in-memory *arr's exclusion lists and library lists; the single-writer guard covers the table. `@hnet/sync`: `title-exclusion-backfill.ts`. `apps/web` e2e stub-arr: the two exclusion lists. CLAUDE.md: hard rule 4. |

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
  one removed does it in Radarr or Sonarr. Since ADR-097 the app writes the exclusion itself before every Trash
  delete (D-27) and audits each one in `trash_title_exclusions`; the re-add check still runs, and a re-add it reports
  is a person's request (or a title excluded by hand and then un-excluded).

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
| D-25bd | A movie whose file the *arr cannot name, with a ledger import that no longer describes that file (replaced by a disk copy or a rescan outside the *arr's history). | The ledger's names join the file's own identity only when its latest import agrees with the file: the same group when both name one (compared by tokens), and the same resolution when both carry one. Otherwise the ledger does not name the file. Before D-29 the file's own renamed-path group term (`low_confidence`) was then used; since D-29 such a file has no verified name unless a legacy file record of its exact size names it, and the title is kept (`release_unverified`). The ledger's grabbed and failed names are still termed when the title is deleted, even where they disagree with the file. |
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

### D-26 — The Age Guard: nothing new is deleted (owner ruling 2026-10-03)

**Ruling (owner, AskUserQuestion 2026-10-03, verbatim choice "Yes, newest date wins"):** Trash never deletes a title
that was downloaded, upgraded or added to any Plex server in the last 180 days. The guard checks the Radarr/Sonarr
import history and every Plex server's date added, and takes the NEWEST. It must ignore the 2026-07-03 Radarr rebuild
(8,988 movies re-added that hour from files already on disk), so the pool does not empty out. Like the Watchlist Keep
(T-263) it is an owner-ruled exception to the 2026-07-09 principle that the app never overrules the rules on what is
deleted.

**Why.** The 2026-09-14 ruling put "Plex date added older than 180 days" into both Maintainerr rule pools, but
Maintainerr reads one Plex server (HaynesOps), and HaynesOps sets date added from the file's mtime at first scan and
never resets it when an upgrade replaces the file. The 2026-10-03 movie batch (expiring 2026-10-04 23:17) held four
titles inside the window: Troll (upgraded 69 days earlier) and The Babysitter: Killer Queen (upgraded to 4K 58 days
earlier) by import history, Ponyboi (124 days) and Fool's Gold (150 days) by HaynesTower's date added.

**The dates (`packages/domain/src/trash-age-guard.ts`).** For each pending item resolved to the ledger:

```
newestImportAt    = max(ledger_events.occurred_at) where event_type = 'imported', source = the item's *arr,
                    payload.rawEventType = 'downloadFolderImported'          (a download: new or upgrade)
newestPlexAddedAt = max(media_plex_matches.plex_added_at) over every library holding the title (any server)
newest            = the later of the two
recent   if newest is younger than TRASH_AGE_GUARD_DAYS (180)
unknown  else if the item is not in the ledger, or any of its Plex matches carries no date yet,
         or no Plex library is matched to it
clear    otherwise (every matched library is dated and the newest date is outside the window)
```

When `age_guard_ignore_library_fill` is on and that *arr's first download import is at least 180 days old,
[D-31](#d-31--a-library-fill-date-does-not-extend-the-age-guard-adr-119) changes which Plex dates enter
`newestPlexAddedAt`. A stamp from a library whose type does not fit the title never counts as the older date.
Off, when the setting is absent or not the boolean true, and when the ledger does not cover the window, the
max above is exact. A title with no Plex match is `unknown` in every case (the line above). That is the one
change from the 2026-10-03 rule, and it only ever keeps more.

- **The rebuild is excluded by the data, not by a date or a title list.** The rebuild stamped Radarr's movie `added`
  (`media_metadata.arr_added_at`) and its movie file's `dateAdded` on nearly every movie; the guard reads neither.
  The only *arr signal is a download import: a folder import (`movieFolderImported` / `seriesFolderImported`, the
  shape a library scan or a re-add of files already on disk takes) never counts. On 2026-10-03 the ledger held no
  folder import at all and its Radarr download imports ran at a steady 5 to 10 an hour across the rebuild, so no
  cutoff is needed. The ledger's synced *arr history starts 2026-07-02 (Radarr) and 2026-07-03 (Sonarr); an upgrade
  before that is invisible to both sources, an accepted limit (the window reaches back to April).
- **TV.** The ledger row is the series, so any episode imported in the window protects the series the pool holds (a
  season-level pool item maps to the same series). The Plex date is the show's.
- **Plex dates.** `media_plex_matches.plex_added_at` (migration 0086) is the title's `addedAt` in that library,
  stamped by the hourly plex-match sync (`52 * * * *`) from the section listing it already reads, re-stamped every run
  (a replaced file Plex re-dated is picked up). A library that could not be read keeps its last stamp.
- **Fail closed.** `unknown` keeps the item `unevaluable` at the sweep (P4). It covers the window after migration
  0086 until the first plex-match run stamps the existing rows, so a sweep that runs first deletes nothing it cannot
  date. A recent date wins over an undated match: one fresh signal is enough to keep a title.

**Where it is enforced (in the app, so a hand edit of the Maintainerr rules cannot loosen it):**

- `shapePendingItems` adds `ageGuard` (`recent` / `clear` / `unknown`) and `newestAddedAt` to every
  `TrashPendingItem`: two grouped reads per pending read, no *arr or Plex call.
- **Batch build** (`selectBatchCandidates`), as D-08 treats a watchlisted title: a `recent` item never takes a slot in
  a **targeted** batch (every space-policy batch, and the admin's "Target an amount"), whatever the registry says. An
  untargeted ("All current candidates") batch snapshots it `pending` and the sweep keeps it `recently_added`, so the
  wall shows it in Kept with its reason. An `unknown` item is proposed normally and the sweep decides. The space
  policy's `minCandidates` counts a `recent` item out; `trash.pendingCandidates` carries `recentlyAdded`, and the
  Start-a-batch preview (`previewTargetSelection`) leaves it out of a targeted pick and out of every "frees" figure
  (D-25cw). _(The first cut also dropped it from untargeted batches; the e2e run on PR #641 showed that diverged from
  D-08 and dropped The Fixture, re-downloaded by an earlier spec's Fix, from a manual batch the lifecycle spec walks.
  Aligned with D-08 before merge.)_
- **The guardian** (`classifyGuardian`, since Q-14; the first cut ran a separate check after it in the sweep only):
  after `tag`, `recently_watched` and `watchlisted`, `recent` ⇒ keep `recently_added`; `unknown` joins the
  `unevaluable` causes. So the sweep, both Expedite scopes and the server preview share one derivation (ADR-086 D-11).
- **Sweep** (`expireOneBatch`, pass 1): `recent` ⇒ kept `recently_added`, `unknown` ⇒ kept `unevaluable`, each with
  the sweep's `[trash] kept` log line. The verdict is re-derived from live data at the sweep, so a title upgraded or
  added to another server after its batch was built is kept.
- **The batch wall:** a kept row's tooltip names the reason in the D-10 language, "Kept: added or upgraded recently".
  No new UI.
- **Expedite** (both scopes, Q-14 ruling): a `recently_added` keep is refused like a watchlisted one, counted
  `protected`, never auto-saved (it lapses when the title ages out); `unknown` is skipped (`unverifiable`).
  `ExpediteVerdict` gains `protected_recent`; the client mirror `previewGuardian` follows and the case-by-case parity
  test grows an `ageGuard` axis. The Expedite-all confirm's protected line is "recently watched, added or upgraded
  recently, whitelisted, or on a watchlist; they are kept." with an "added or upgraded recently" breakdown
  (`TrashExpeditePreview.recentlyAdded`, `trash-expedite-recent`); the unverifiable line names "dates" among its
  causes. The single-item confirm (Delete now…) says "This item was added or upgraded recently, so it won't be
  deleted yet. Nothing will be deleted." and its report's protected line names the reason.
- **The pending walls** (Q-14 ruling): a title the Age Guard keeps reads as the batch wall's kept row, the inert
  `skip` glyph whose label and tooltip lead with "Kept: added or upgraded recently", never the slated trash-can or a
  delete date. Only when the Age Guard is the guardian's FIRST keep reason (`recentlyAddedKeep`): a lapsed `dnd`
  tile stays tappable to re-save, and a recently watched or watchlisted tile keeps its own note, so the corner never
  contradicts the reason the sweep records. A Save stays one tap away on the title's Library page, whose Trash
  notice carries the same line ("Kept: added or upgraded recently", `trash-recent-note`) in place of "Save it to keep
  it", kept on a Save like the watchlist note (D-25cv). The glyph swap is the existing fixed-size corner, so nothing
  reflows (hard rule 9); no new colors.
- **The Maintainerr rules stay as they are** (requirement 3 of the ruling's work order, optional): Maintainerr reads
  only HaynesOps' date added, and its Radarr dates carry the rebuild, so no rule clause can express the guard
  without emptying the pool. The app check is the guarantee. **Later ruling (2026-11-13, story 835,
  [DESIGN-014 D-15](014-rules-tuning-space-policy.md)):** the TV pool's own predicates change (rating
  below 6.0, rating votes greater than 99, not tagged `mediarequests`, ended, and the last episode
  HaynesOps holds in its highest-numbered season aired at least 180 days ago; the HaynesOps views
  clause and the HaynesOps date-added clause removed). That change does not express this guard and
  does not replace it. Removing the TV date-added clause removed the cover the old `judgeAge` comment
  assumed for a title with no Plex match. [ADR-119](../adrs/119-age-guard-library-fill.md) makes that case
  `unknown` (kept), with the library-fill setting on or off. It only ever keeps more. The movie pool's
  added-date clause stays. D-15 is the spec; it is not applied to the live Maintainerr in story 835.

**Data:** migration **0086** (`0086_trash_age_guard.sql`, journal idx 85): `media_plex_matches.plex_added_at`
(nullable) and `trash_batch_items.keep_reason` admitting `recently_added`. The previous image runs unchanged against
it.

**Dry run (2026-10-03, read-only, the open movie batch):** of its 50 items (49 pending, 1 saved) the guard keeps
exactly the four above: Troll and The Babysitter: Killer Queen by a download import 69 and 57 days old, Ponyboi and
Fool's Gold by HaynesTower's date added (124 and 150 days). Of the 129 movies in the pool, 5 have a download import
inside the window.

**Tests** (`packages/domain/__tests__/trash-age-guard.test.ts`, embedded PG16, the Maintainerr stub and the
in-memory Release Block *arr): an upgrade 60 days ago takes no targeted slot, an untargeted batch snapshots it and the
sweep keeps it, and the Start-a-batch wire says so; a title already in a batch when it is upgraded, or added to a second server 120 days ago, is kept
`recently_added` at the sweep and the batch detail carries the reason; a folder import 20 days ago and an *arr
`added` 92 days ago (the rebuild's shape) do not protect; an undated Plex match keeps the title `unevaluable`; an
episode import protects the series; `judgeAge` at the window's edges. The plex-match sync test asserts the date is
carried and re-stamped.

### D-27 — The Title Exclusion (ADR-097)

The owner's ruling of 2026-10-03, **"Block automation only"**: a title deleted through Trash must never be added again
by automation. Kometa and the *arrs' own import lists skip a title on the *arr's import-list exclusion list (Kometa's
ArrAPI client respects it on every add, for Radarr and Sonarr); a person's Seerr request still adds it (Seerr's `POST
/movie` / `POST /series` never reads the list; ruling 2 of 2026-09-26 stands), and the Release Block still stops the
deleted release. Maintainerr writes the exclusion on its own delete while its pools carry `listExclusions` (D-16), but
only after the delete, and only while that setting holds; the app now writes it itself, first.

- **The surface** (`@hnet/arr`; Radarr 6.4.4 and Sonarr 4.0.20 `ImportListExclusionController`): Radarr `GET
  /api/v3/exclusions/paged` and `POST /api/v3/exclusions {tmdbId, movieTitle, movieYear}` (`movieYear` 0 or more; an
  unknown year is sent as 0); Sonarr `GET /api/v3/importlistexclusion/paged` and `POST /api/v3/importlistexclusion
  {tvdbId, title}`. The list is read page by page (1,000 per page, `sortKey=id`, oldest first, so an exclusion added
  during the read lands on a later page; more than 50 pages throws rather than act on a partial list). Both POSTs
  answer 201 with the created resource; both validators refuse a key that is already excluded (400), so the writer
  reads first. The list GET is on the read clients, the POST on the write clients (import-confined to
  `packages/domain`).
- **The writer** (`ensureTitleExclusions({ arrKind, targets, origin })`, `title-exclusion.ts`, the only writer): every
  target needs a positive key and a non-blank title (`validate`). Under `pg_advisory_xact_lock('title-exclusion:<kind>')`,
  in one transaction: read the list (`read`); `POST` each target not on it, one at a time (`write`; POSTs are never
  retried), and insert its `trash_title_exclusions` row as soon as the *arr acknowledges it (key, title, year, the
  exclusion id from the 201 answer, `origin` `sweep` / `expedite` / `backfill`, the media item, the batch item when
  there is one); when anything was written, read the list again and require every target on it (`read_back`). The
  read-back is the gate for the delete, not for the audit: a failure throws `TitleExclusionError(arrKind, step)`
  only after the transaction commits the rows of the writes that landed, so every exclusion the app wrote keeps its
  row (a retry finds those titles excluded and writes only the rest; review of PR #643). The one gap is a POST whose
  answer was lost after Radarr or Sonarr applied it: no id came back, so no row, and the retry counts it
  `alreadyExcluded`. A database error rolls the transaction back (logged `step: database`). A title already excluded
  gets no `POST` and no row; a second call with the same titles reads once and writes nothing. It never deletes or
  edits an exclusion; removing one stays a person's act in Radarr or Sonarr (D-23).
- **Its place in the delete paths** (D-14 step 5, the shared seam `recordAndBlockReleases`, so the sweep, Expedite
  item and all, and the manual Expire now cannot drift): after identity and the hand-back of the unrecordable
  survivors, and before Phase A. The target of each recordable survivor comes from its records (the *arr's title and
  year, its tmdb id on Radarr or tvdb id on Sonarr), the ledger's key where the *arr answered none
  (`resolveTitleExclusionTarget`); a survivor with neither is kept `release_unrecorded` (internal reason
  `no_exclusion_key`, counted by the `--pool` report). One writer call per *arr per batch. A `TitleExclusionError`
  becomes `ReleaseBlockError(arrKind, 'exclusion')` with `mayHaveWritten` false: nothing was recorded, no profile was
  touched, nothing is claimed or deleted; the sweep pauses (`paused_release_block`, reason `exclusion`), Expedite and
  Expire now answer `PRECONDITION_FAILED` with the banner's wording.
- **Ordering guarantee:** the title is on the exclusion list, read back, before the Release Block's records and
  profile write and before the handle; a Kometa run during or right after the delete finds it excluded.
- **What stays** after a delete that does not happen (the Release Block fails after the exclusion, a late watchlist
  add keeps the item, a refused or failed handle): the exclusion. It is inert while the title is in the library, and
  Trash writes the same one on a later delete (no write, no row). ADR-097 C-06 accepts it.
- **Maintainerr's `listExclusions` stays required** by the safety audit (D-16, ADR-093 C-10). Both write the same
  fact; Radarr's and Sonarr's delete handlers skip a title already excluded, so Maintainerr's delete never conflicts
  with the app's exclusion.
- **TV:** Trash's TV pool is a whole-show pool (live, 2026-10-03: Maintainerr's TV rule pool is type `show`), so the
  series exclusion matches the delete, as the Release Block's series identity does. A season or episode pool would
  leave the series in place with an inert exclusion; revisit before arming one (ADR-097 C-07).

### D-28 — The Title Exclusion backfill

A one-off script, `packages/sync/src/scripts/title-exclusion-backfill.ts` (not a sync mode), run in the web pod like
the D-15 seed (OPS-017 §7), with `--dry-run` (reads only) and `--apply`. `backfillTitleExclusions`:

1. **Population:** every `trash_batch_items` row in state `deleted` with a `deleted_at`, one per title: a movie by its
   tmdb id, a show by its tvdb id; the newest deletion names it (title, year, media item and batch item for the audit
   row). A row with no key is counted `noKey` and listed by name.
2. **Every read before any write:** Radarr's library (`GET /movie`) and Sonarr's (`GET /series`), and each exclusion
   list. A title whose key is in the library now is **left out** (`present`, listed by name): it was added again
   since, by Kometa or by a person, and the owner ruled on 2026-10-03 that those are kept as fresh downloads with no
   special handling; Trash writes its exclusion when it deletes it again. A title already excluded is counted
   `alreadyExcluded`. A failed read throws before anything is written.
3. `--dry-run` stops here and prints, per *arr, `population`, `present`, `alreadyExcluded`, `noKey` and `toExclude`,
   and the present and no-key titles by name.
4. `--apply` writes the rest through `ensureTitleExclusions` (origin `backfill`), 25 titles per transaction, Radarr
   then Sonarr. A failed chunk stops that *arr (`failed` names the step, the script exits 1) and keeps what earlier
   chunks wrote; running it again picks up the rest. A second complete run writes nothing.

The dry run of 2026-10-03, computed with the same rules from the database replica and Radarr's and Sonarr's own lists
(read-only): Radarr population 443, present 33 (the 32 titles re-added since their delete, and The Devil's Mouth,
whose 2026-08 delete never happened, D-15), already excluded 86, **to exclude 324**; Sonarr population 13, present 0,
already excluded 0, **to exclude 13**; no row without a key.

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
- **The Title Exclusion (ADR-097, D-27, D-28)** — `@hnet/arr` against fetch stubs: every page of the Radarr list read
  oldest first and normalized, the Sonarr paging query, the two POST bodies (Radarr's unknown year as 0), a refused
  POST thrown. `@hnet/db`: migration 0087, its kind and origin CHECKs matching `enums.ts` and the key CHECK (a tmdb id
  on Radarr, a tvdb id on Sonarr, never null). `@hnet/domain` on embedded Postgres with the in-memory *arr
  (`title-exclusion.test.ts`): the writer POSTs each missing title, reads it back and writes one audit row; an
  existing exclusion is a no-op (no POST, no row) and a second call writes nothing; a failed read throws `read` with
  no row; a POST that fails part-way throws `write` and keeps the rows of the writes that landed, and the retry writes
  only the rest; a POST that does not stick throws `read_back` and keeps its row; an invalid target is refused before
  any read. The sweep writes every exclusion before Phase A and the handle (the call order), its rows naming the batch
  items; an exclusion Maintainerr already wrote changes nothing and the delete goes on; a failed exclusion pauses the
  sweep with step `exclusion` and nothing recorded, blocked or deleted; Expedite writes it first (origin `expedite`)
  and refuses with `ReleaseBlockError` `exclusion` when it cannot; a show gets its Sonarr exclusion by tvdb id. The
  backfill: the dry run writes nothing; a title in the library now is left out and listed; a title deleted twice
  counts once; a row with no key is counted; `--apply` writes the rest, and a second run writes nothing; a failed
  library read writes nothing; a failed chunk stops that *arr only. The D-14 call-order tests in
  `release-block.test.ts` include the exclusion's three calls. `@hnet/sync`: the script's arguments.

### D-29 — A verified name for the file, and a term for every posted name (ADR-117)

Amends D-11, D-13, D-14 and D-25bd. Owner rulings, 2026-11-13: "We cannot, however, re-grab an index we already
grabbed EVER" (story 818), and, asked what Trash should do with a title whose release name is known only from the
renamed file: "You should just do this and not ask so many questions. The SAB instances on HaynesTower were what
added. most of the media, then we migrated to k8s SAB instances. Can't you just go fetch what you need there? Get it
done right don't ask if I want you to hack around something critical we absolutely cannot re-grab an index we grabbed
before" (story 838, comment 8158). A person can still request a deleted title again in Seerr: the block is on the
release, never on the title.

**The rule.** Trash deletes a title only when each file it has on disk has a verified posted release name, and a term
for every posted name of the title is written and read back first. A name rebuilt from the renamed file is never a
basis for a delete. The 365-day life (D-13), which titles Maintainerr proposes, and the pace are unchanged.

**1. What names a file on disk** (`identifyRelease`, the delete path's own read of the *arr):

- the *arr's own record of the file: the grab its import history joins it to, its scene name, or its original path.
  A scene name or an original path whose base name is the file's current relative path is the renamed file, not a
  verified name. The comparison ignores case and surrounding space on that base name, and one trailing media or
  container extension, so none of those differences verifies a delete. The library's rename template includes a
  resolution and a group, so `looksLikeRelease` accepts the rebuilt name (the second review of PR 1070, 2026-11-13,
  compared the base names with their extensions: the original base name equals the relative base name on 0 of 1,176
  files, and the same equality is 0 for `sceneName`; all 468 renamed base names in the pool pass `looksLikeRelease`);
- the ledger's newest download import of the title, with its grab, when it agrees with the file (D-25bd, unchanged).
  A folder import (`movieFolderImported`, `seriesFolderImported`) is a library scan: its name is the renamed file,
  so it is no import here. The ledger holds none today (measured below);
- a legacy file record of the same title id (TMDB on Radarr, TVDB on Sonarr) with the **identical byte size** and an
  original release name. For a series the record's season must be the file's too. Exact, never a ratio.

**Compared without the file extension (2026-11-13).** The base-name comparison strips one trailing media or
container extension from each side before it compares, without regard to case. The extensions are the ones this
code already treats as a file extension, the union of `releaseBaseName` (`mkv`, `mp4`, `avi`, `m4v`, `ts`, `wmv`,
`mov`, `iso`, `nzb`) and the Title Check's dropped video extension (`mpg`, `mpeg`, `m2ts`, `webm`, and the ones
they share). A dotted release group is not among them and is left in place. A scene name equal to the current
file's base name without that extension is the renamed file, and so is an original path that differs from the
current path only by that extension. Neither verifies a movie or an episode file. This only keeps titles the
previous comparison would have deleted.

**A library id token is a renamed file (2026-11-13).** Radarr's naming template here is
`{Movie CleanTitle} {(Release Year)} {tmdb-{TmdbId}} ...`, so a renamed movie file carries a token such as
`{tmdb-12345}`. A name containing `{tmdb-`, `{imdb-` or `{tvdb-` does not verify a file when it is the *arr's scene
name or original path, the ledger's import name, or a legacy file record, and a grab or a failed download that
carries one is termed when the grammar can write the term and otherwise keeps the title and is counted. The
Release Name Check uses the same prefixes, so a token-only import or legacy file record does not read `verified`.
Measured by the coordinator on
2026-11-13 on a replica (story 838, comment 8265; this session did not re-run the query): 0 of 1,823 Radarr grab
names, 0 of 28,056 Sonarr grab names, and 0 of the import names in the ledger contain those prefixes. A bracket
run and Sonarr's ` - S01E02 - ` shape are not this rule. That same measurement found a bracket run on 1,777
Sonarr grab names and the ` - S01E02 - ` shape on 2,696, and both occur in real posted names, so rejecting them
would keep titles for no reason.

A movie whose file has none of these is `unverified_name`: kept `release_unverified`. A series needs a name for
**every** episode file in a season of 1 or more; one file without is enough to keep the series (a group term
guessed from its siblings is not a verified name).

**Open (Q-28).** `identifySeries` does not use the ledger's import to name an episode file, which the design says it
does, so a series the ledger could name is kept; required before TV Trash resumes.

**Open (Q-29).** A second file on one movie is not checked (0 of 9,630 titles have one today). `identifyMovie` reads
the file Radarr names, or else the first file.

A title with no file on disk has nothing to name and is deletable
as before (D-25ag), with a term for every posted name it has. A title already gone from the *arr has no file to
read: it is recordable only when the ledger's imports name its release (as before ADR-117), else kept `gone`.

**2. Every posted name of the title gets a term** (`withEveryPostedName`): each `grabbed` and `downloadFailed` event
in the *arr's history; each `grabbed` and `download_failed` event in the ledger at or before the delete; each legacy
row of the title's id, of every kind (grabbed, imported, failed, file). A failed grab counts. For a movie, an old
download job that the D-15 size rule matches adds a term too (point 5). One record per distinct term.

- A term is built from the name **as stored**, never trimmed, and must match that stored name the way the *arr tests
  it (`termMatchesRaw`). A name that names a release and yields no such term is `untermed`: the title is kept
  (`release_unrecorded`). So is a title when a term matches one of the file's own names only when folded.
  One live Radarr name is stored with a leading and a trailing space; trimmed, its term began `^title` and could not
  match what Radarr tests (review F3).
- A name that names nothing a term could hold is skipped and counted (`skippedNames`): a Sonarr season-0 special
  (D-11), or a name with no mark of a release anywhere (no resolution, source, codec or episode marker). A name that
  carries such a mark and still yields no term (a leading bracket or quote, a part counter, a fansub layout) keeps
  the title: it is a release the grammar cannot write (Q-26).
- The ledger read pages by keyset (`occurred_at`, `id`), 500 rows a page, at most 40 pages; the old bound of 200 rows
  kept a long series for good. Past 20,000 rows, past 20,000 legacy rows for one title, or past 100,000 old jobs in
  one file's size window (the two histories hold 60,581 in all), the read is `truncated` and the title is kept: a
  name not read is a release not blocked.
- A name containing `://` is never a name, in any source. A name containing `{tmdb-`, `{imdb-` or `{tvdb-` does
  not verify a file (above). On a grab or a failed download it is a fetched release: it is termed, or the title
  is kept and the name is counted. It is not dropped.

**3. The legacy tables** (migration 0110). `legacy_release_names`: one row per record of the Radarr and Sonarr
databases from before the 2026-07-03 move, keyed by the title's own id: `arr_kind`, `external_id`, `record_kind`
(`grabbed`, `imported`, `failed`, `file`), `release_name` (as stored), `size_bytes`, `occurred_at`, `release_group`,
`season`, `quality`, `title`. `legacy_download_jobs`: the two old SABnzbd histories: `source`, `name`, `bytes`,
`completed_at`, `category`, `status`. Both refuse a name containing `://` by CHECK, hold no indexer, download id,
setting or path, and carry a `dedupe_key` (a hash of the row's own fields) so a second load adds nothing. Their only
writer is the loader (`legacy-release-load.ts`, run by `legacy-release-names-load.ts`; `docs/ops/017`). The
coordinator's extract is private and never enters git.

**4. The cap never prunes on a delete** (review F7). Before anything is written, `recordAndBlockReleases` counts
each survivor's new terms against the live ones, in order: a survivor whose terms would not all fit under 3,000 is
kept `release_block_full`, and a later one that fits still goes. Phase A's reconcile runs with `prune: false`: over
the cap it throws `cap` and rolls back, so a concurrent delete cannot make it prune either. The hourly upkeep keeps
D-13's prune; no delete and no backfill can now push the profile over the cap.

**Open (Q-30).** The hourly upkeep still prunes the oldest terms once the profile passes 3,000 and still expires
terms after 365 days, and story 845 (terms never expire) owns both. A series yields 3 terms at the median,
15 at the 90th percentile and 165 at most from the ledger alone, and every series with a ledger name sums to 4,528
against the cap of 3,000 (review F7, 2026-11-13), so a long series can be kept for want of room. A whole-name term
for TV and the cap's successor are a later story.

**5. A size match only adds** (review F1, F2). `matchLegacySab` (title tokens, year within one, completed before the
delete, file 90 to 100 percent of the job) cannot tell two releases of one title apart, or two films of one name: in
the pool it matched a film to another film's download. So a matched job from `legacy_download_jobs` adds a term, never
makes a file count as named, and never removes another term. The live download client is no longer read on any
delete path. What each source could name for the 468 pool movies the ledger cannot (review F2, 2026-11-13):

| Source | Reaches back to | Names for those 468 |
| --- | --- | ---: |
| Ledger `grabbed` and `download_failed` | 2026-07-02 | 0 of these 468 (its import names 55 other pool movies at 17:00 ET, 54 in the earlier read) |
| Live download client | 2026-07-03 (19,951 jobs, 401 named by a URL) | 1, and that match is wrong |
| Radarr's file record (`sceneName`, `originalFilePath`) | set on 1,175 of 5,243 files | 0 |
| Radarr history | empty for 6 of 6 sampled | 0 |
| Indexer manager history | 7 days | 0 |
| The old Radarr database (the coordinator's extract) | before the move | 468: every pool movie is known to it |

**6. One verdict for the wall, batch build and the guardian** (the Release Name Check, `trash-release-name.ts`).
`release_unrecorded` is decided when a delete runs, from the *arr's files, and the wall cannot know it (Q-16). The
new keep would have hidden nothing either, and the default view would have offered hundreds of titles the sweep
keeps. So the check in point 1 has a second form that needs no *arr read. A pending movie is `verified` when it has
no file (`on_disk_file_count = 0`), or the ledger's newest download import carries a release name (its own or its
grab's), or a legacy file record of its TMDB id has exactly `media_items.size_on_disk` bytes; else `unverified`.
A name containing `{tmdb-`, `{imdb-` or `{tvdb-` is not a release name in that import or that file record. A
series is `unchecked` (it has many files and the database holds no per-file size; Q-23), and so is an item with no
ledger row.

- `shapePendingItems` sets `releaseName` on every pending item (three grouped reads).
- `classifyGuardian` keeps an `unverified` title, reason `release_unverified`, after every other keep. So the sweep,
  Expedite (item and all) and Expire now keep it before any *arr read; the Expedite preview counts it `unverifiable`
  (`releaseUnverified` says how many), and the client mirror `previewGuardian` follows (parity test).
- `trashWallProtection` returns `release_unverified`: the default Deletable view omits the title, and All shows it
  with "Download unknown" ("Kept: the name of its download isn't on record"). No new layout.
- `selectBatchCandidates`, the proposal filter the space policy and Dynamic Pace share (`isPaceDeletable`, ADR-120:
  the candidate count and the pool's bytes) and the Start-a-batch preview leave it out: it takes no slot and is not
  counted as space a batch can free, as with the Age Guard.

The delete path then reads the *arr and decides again by point 1. It can only keep more: a file replaced outside the
*arr's history, a name with no term, no room under the cap. Such a title was offered and is kept at the sweep with
its reason on the batch tile, as `release_unrecorded` always was.

**7. Counts** (review F6). A delete with no verified name for its file no longer exists, so the count is of keeps:

| Where | What |
| --- | --- |
| `BatchSweepResult.keptByReason` | `release_unverified`, `release_block_full`, `release_unrecorded`, per batch |
| `[trash] sweep_summary` log | `releaseUnverifiedKept`, `releaseBlockFullKept`, `skippedNames`, beside `kept` |
| Batch-close event payload | `keptByReason`, `skippedNames` |
| `ExpediteDeletionResult` | `unverifiedNameCount`, `blockFullCount`, `skippedNames` (both scopes) |
| `trash.status` (the read the Trash page makes on load) | `lastSweepKept`: what the most recently swept batch kept (`releaseUnverified`, `releaseBlockFull`), read from the batch, so Expire now counts too |
| First pending page (`expeditePreview`) | `releaseUnverified`: pool titles the guardian keeps for want of a name |
| Batch wall | each kept tile's reason (`keepReason`) |
| `release-block-seed.ts --pool` | per reason, what the delete path would keep; live and added terms against the cap |

**8. The backfill** (`release-block-backfill.ts`, review F5). One candidate per title Trash deleted that is still
gone, in one class: `lowConfidence` (a live renamed-file record), `movies` / `shows` (no term at all), `otherNames`
(every other title: it has a term, and may have an earlier grab, a failed download or an upgrade's predecessor that
no live term matches). Names: the ledger's up to the delete, every legacy row of the id, and for a movie the size-
matched old jobs. A name a live term already matches (tested raw) is `alreadyBlocked`; each other name that terms
gets a record, 365 days from the original delete. A title back in the library is never termed (`skippedLive`). A
title whose terms would not fit under the cap is left out whole (`capRefused`): nothing is pruned. Apply writes the
records `in_flight`, reconciles with `prune: false` and reads back, and only then turns them `active`; a failure
abandons them and takes their terms back out, so a second apply starts clean. `--dry-run` reads the database only and
builds no *arr client. One of the two flags is required.

**Measured 2026-11-13**, replica `postgres16-11`, `SELECT` only (queries in `docs/ops/017`). Two reads the same day.
The earlier one is the figures this decision first recorded; no clock time was written with them. The later one is
the review of the corrected PR, the ops/017 statement with the `by_legacy` arm omitted, at 17:00 ET. The kept count
did not change. The extra movie is one the ledger names. A cell the later read did not restate stays in the earlier
column only.

| What | Earlier the same day | 17:00 ET |
| --- | ---: | ---: |
| Pool movies (`trash_candidates`, all in the ledger) | 524 | 525 |
| No file on disk | 2 | 2 |
| File on disk, the ledger names its import | 54 | 55 |
| File on disk, no verified name (kept until the legacy load) | 468 | 468 |
| **Deletable by the Release Name Check with the legacy tables empty** | **56** | **57** |
| Pool movies with any ledger grab or failed download | 56 | not restated |
| TV pool | 0 | 0 |
| Ledger imports that are folder imports (Radarr 1,611 and Sonarr 25,352 imports read) | 0 | not restated |
| Live terms, Radarr (rows / distinct) | 638 / 619 | 638 / 619 |
| Live terms, Sonarr | 63 / 63 | 63 / 63 |

Rule for the two pool columns: the ops/017 statement, legacy arm omitted. 525 = 55 + 2 + 468, and 57 = 55 + 2.
The live-term rows in the later column are that review's same replica read at 2026-11-13 17:00:01 America/New_York.
The earlier 56 and the 54 + 2 are different sets of the same size: two pool movies have a failed download and no
import (not named), and two have no file. At 17:00 ET the deletable 57 are the 55 the ledger names plus the 2 with
no file, and those two movies with a grab and no import are in the 468 the check keeps. After the load the
coordinator's measurement on the extract gives 472 pool files named by exact size, 523 pool movies with a grab name
and 1,012 distinct grabbed or failed names (median 2, at most 8), so about 1,012 terms beside the 619, under the
cap. The loader's dry run prints the same three figures from the files it is given (`pool.movies`), to be compared
before the load is applied.

The backfill's classes, mirrored by `SELECT` (not a run of the script):

| Class (titles still gone) | Titles | With a ledger name up to the delete |
| --- | ---: | ---: |
| `lowConfidence` (Radarr) | 191 | 0 |
| `movies` (no term) | 45 | 11 |
| `otherNames`, Radarr | 324 | 64 |
| `otherNames`, Sonarr | 6 | 6 |
| `shows` (no term) | 6 | 0 |
| Back in the library, skipped | 66 movies, 1 show | |

None is 365 days old. The review measured the names among these that no live term matches: 11 on the 11 movies with
no term, 13 on 11 `otherNames` movies and 1 on 1 series, so a dry run with the legacy tables empty should report
about 25 new records. The 191 `lowConfidence` titles and the 6 shows get names only from the legacy tables.

**What the grammar cannot write** (review F4, 2026-11-13; distinct title and name pairs in the ledger):

| | Radarr | Sonarr |
| --- | ---: | ---: |
| Pairs | 1,717 | 20,714 |
| Termed, and the term matches the stored name | 1,704 | 20,286 |
| Termed from a trimmed name that the term did not match (F3; now `untermed`) | 1 | 0 |
| Skipped before this change, delete went ahead | 7 names on 3 titles | 253 names on 8 series |
| `untermed`: the title is kept | 5 names on 5 titles | 175 names on 13 series |
| Kept by the old 200-row bound (now paged) | 0 | 35 series |

None of these movies is in today's pool and the TV pool is empty. Most of the skipped names carry a mark of a
release, so they now keep their title (point 2). The whole-name template the janitor already has
(`renderWholeNameTerm`, ADR-094) matched all 441 names of the last three name rows in the review's test; whether the
Release Block's grammar takes that form is the later story's (Q-26).

**Tests.** `release-block.test.ts`: a file with only its renamed name is kept on the sweep, Expedite (item and all)
and Expire now, and no batch proposes it; each name source, the legacy tables included; exact size against one byte
off; a size-matched job from another group and from the same group adds a term and names nothing; a failed grab is
termed; an untrimmed name; a name with a release mark and no term; the ledger read across pages and past its bound;
the cap keeps a title and prunes nothing; a failed write or read-back deletes nothing. `release-name-rule.test.ts`:
an original path or scene name equal to the current file keeps a movie and an episode file; a scene name or original
path that matches the current file apart from a media extension keeps a movie and an episode file, and a dotted
release group still verifies; a library id token does not verify from the *arr record, the ledger import or a
legacy file record, and a real name beside it does; a token-bearing grab is termed or the title is kept, on the
delete path and in the backfill, and a file verified by a real name is not deleted without a term for that grab;
a different original name still verifies; a failed read of the
legacy tables keeps the title. `release-block-backfill.test.ts`:
each class, the F5 class, the cap refusal, a failed reconcile, a second apply. `legacy-release-load.test.ts`: every
file format and line outcome, a URL refused, the dry run, a second load. `trash-release-name.test.ts`: the check's
three ways to verify and its `unverified` and `unchecked` answers.

## D-30: a requested title is a guardian keep (ADR-118, 2026-11-13)

**Ruling (the owner, 2026-11-13, recorded on story 818 comment 8041 and story 844).** A title a person requested is protected, so Trash cannot remove it. This supersedes, for the `mediarequests` tag only, the 2026-07-09 line that a requester is informational. A personal requester tag (`<n>-name`) stays informational. The retired auto-save is not restored. Accepted ADR-025 and ADR-093 are not edited; ADR-118 supersedes the conflicting sentences. The same day's adversarial review of PR 1068 corrected how the clause is recognised, how a batch treats the title, and what the audit refuses. The coordinator accepted the fail-closed rules read (review Q-R3) on story 844 comment 8203. That is wider than the story's sentence that nothing else about the audit changes, and this decision follows the coordinator.

**What was measured, read-only, on 2026-11-13.** The first read (the implementation, 18:08Z) used the replica `pod/postgres16-11` in recovery (`pg_is_in_recovery` true, time zone America/New_York, `now()` 2026-11-13 13:08:28-05). Present ledger rows (`deleted_from_arr_at` is null) whose `arr_tags` contain `mediarequests`: 507 Radarr and 507 Sonarr. Present and tombstoned denominators: Radarr 9630 and 562, Sonarr 1085 and 12. The same query returned no tombstoned row with the tag. `GET /api/v3/tag/detail` the same minute: Radarr tag id 1, label `mediarequests`, 507 movie ids (2026-11-13T18:08:39Z); Sonarr tag id 1, 507 series ids (2026-11-13T18:08:43Z). The candidate snapshot refreshed at 2026-11-13 13:00:22.334-05 held 524 movies and 0 shows; joining it to present ledger rows found 0 of the 524 carrying the tag. Maintainerr `GET /api/rules` at 2026-11-13T18:08:52Z: both armed rule groups still have an active NOT_CONTAINS clause (`action` 9, operator 0, value `mediarequests`; movies `firstVal` [1, 2], shows [2, 2]). The two Leaving Soon groups have `useRules` false and no clauses. This correction did not repeat those reads.

**Known limits (the review's measurements, session haynesnetwork-1113-203601, 2026-11-13; not re-read here).** M6, replica, 20:46Z: 12 present titles (4 movies, 8 shows) carry a personal requester tag (`^\d+-`) and do not carry `mediarequests`. Of those, 10 have files, 1 is saved, 2 are anime, and 0 are in the pool. The review's arithmetic against the 18:08Z tagged counts is Radarr 504 − 4 + 7 = 507 and Sonarr 507 − 8 + 8 = 507. M7, 20:54Z: of 67 Trash-deleted titles present again, 5 carry the tag and 62 do not, and 0 of the 67 carry only a personal tag (5 + 0 + 62 = 67). A request for a movie Radarr already has is searched and never tagged.

**ADR-093 C-11 names three untagged cases, not two.** Anime series (Seerr applies its `animeTags`; C-11 says PLAN-072 S9 sets them to `mediarequests`; the review could not confirm that, because no Seerr key was in a pod variable, and this correction did not read Seerr), a request an admin overrides in Seerr's request form, and a request of a movie Radarr already has (Seerr only searches it). The historical D-24m row is left as it was accepted.

**The keep.** `classifyGuardian` returns `media_request` when `arr_tags` contains the exact label `mediarequests`. Order, after the keeps that already exist and before `unevaluable`: Save, the `dnd` tag, a recent watch, the Watchlist Keep, the Age Guard, then this. ADR-117's `release_unverified` (D-29) stays after `unevaluable`, where that decision placed it. A title that carries `mediarequests` and whose file has no verified release name is kept, and the reason reported is `media_request`, because this keep is earlier. A title kept today is kept for the same reason. The keep lasts while the ledger copy contains the tag and ends when the tag is gone from that copy. There is no timer. The app does not remove the tag. `media_items.arr_tags` is written by the full sync once a day at 04:30, so the keep can lag the live tag by up to 24 hours, at that 04:30 full sync. Reading the tag live at the delete is a follow-up story (review Q-R2), not this decision. The tag stays the one rule (review Q-R1): adding `mediarequests` to the 12 personal-tag titles is a write for story 823 or the owner, not this decision. Restore routes stay with story 843 (review Q-R4).

**Where.** The guardian is the one decision. Creating a batch leaves a requested title out, the way a Save is left out, for every batch including a space-policy batch: it is not snapshotted, not posted to Leaving Soon, and not counted as deleting. A row that is already pending is still kept at the sweep, at Expedite (one item and the whole set) and at Expire now. None of those auto-save it. The client preview, the Start-a-batch preview, the pending-wall skip glyph and the single-item confirm mirror it. The whole-set confirm's protected line names this keep with the others (`or requested`). Wall Protection (T-333) includes `media_request` after the Age Guard, so the default pending view omits the title. A personal requester tag still changes none of those.

**The audit.** `auditMaintainerr` appends a violation, and so refuses the sweep, Expedite and Expire now, when an armed group whose `useRules` is not false no longer excludes requested titles, or when `GET /api/rules` cannot be read. The clause matches the way Maintainerr compares it: `Number` of the operator is 0, `Number` of the action is 9, each `firstVal` element through `Number`, the value lower-cased, and a JSON list that contains `mediarequests` accepted. A string operator `"0"` is the same clause. Every clause after the first must be joined by AND after `Number`. A null or absent operator on a later clause is OR in Maintainerr, so it fails. The group's first clause may have no operator: null, undefined and a missing key all match, because `Number(undefined)` is `NaN` and a JSON round-trip can drop the key (advisory review of PR 1068, 2026-11-14). Which section the clause sits in is not part of the check: a second section joined by AND passes, and a second section joined by OR fails. An armed group is exempt only when `useRules` is false (a Leaving Soon shell is that; the name alone does not exempt it). A missing or non-array `rules` list is a violation. An unknown group type is a violation. A season or episode group is held to the Sonarr show-tag pair `[2, 2]` (Q-31). A disarmed group is not checked. The horizon, `arrAction`, `listExclusions`, `forceSeerr` and the integration checks are otherwise unchanged. The thrown error and the `sweep_paused` log line name the violations. The page banner heading is unchanged.

**Descriptions.** When the app writes a rule group that has clauses, `buildRuleGroupUpdate` sets the description from those clauses and keeps the person's notes after the marker ` | Notes: ` (space, vertical bar, space, the word Notes, colon, space). Only that exact string is a boundary. A description that does not contain it is all notes, whatever dashes it contains, and is kept whole, character for character, after the new generated sentence and the marker, once. A later save replaces only the generated sentence before the marker and keeps the notes after it unchanged. If the notes contain the marker more than once, the first occurrence is the boundary and the rest is notes. An empty description is the generated sentence alone, with no marker. A later save of the same clauses leaves the text unchanged. Measured 2026-11-14, read-only `GET /api/rules` (`kubectl exec -n media deploy/maintainerr -c app -- wget -qO- http://127.0.0.1:6246/api/rules`, counts only): both armed groups (id 1, movie, 872 characters; id 2, show, 748 characters) contain ` — ` (U+2014, space on each side) once and the marker zero times, so an em-dash boundary would discard the text before that dash. The two Leaving Soon groups (ids 17 and 18, `useRules` false, 60 characters each) contain neither. ADR-118 C-06 does not name a separator, and that Accepted record is not edited. The sentence names the properties it writes, including `2,20` (Sonarr show vote count), `2,7` (Sonarr show ended) and `0,27` (Plex last episode aired), action 2 as equals, a date comparison (action 5) as a number of days, and the second property of a two-property clause. An empty list, which is how Leaving Soon is written, keeps the description the caller wrote. This change does not write to the live Maintainerr. The live movie description says a rating of 6.0 while the body says 6.5, and both armed descriptions say the app guardian enforces requester protection, which it does for `mediarequests` and still does not do for a personal requester tag. That drift is left for story 823. A write of only the rating and the votes, which is the cut-short form of DESIGN-014 D-15, leaves the request clause out and the audit refuses it.

**Q-31 (open).** An armed season or episode group is held to the Sonarr show-tag clause (`firstVal` [2, 2]), because that is the tag the show carries and because refusing deletes less. No such group was active on 2026-11-13. An armed group whose type is none of movie, show, season or episode is refused until it can be checked. Recommendation: keep the fail-closed rule unless a later ruling names a different property for seasons and episodes. Main already holds Q-23 for the Release Name Check (D-29), so this question is Q-31.

### D-31 — A library-fill date does not extend the Age Guard (ADR-119)

**Amends D-26 in two places.** When `age_guard_ignore_library_fill` is on and that *arr's ledger covers the
window, it changes which Plex dates enter the newest date. In every case, a title with no Plex match is
`unknown` instead of `clear`. The 180-day window, the download-import signal, the ignored folder imports,
fail-closed for an undated match, the guardian order, Expedite and the pending walls are otherwise unchanged.
Save, `dnd`, the watchlist and recent watch are not read by this decision and are not weakened.

The first draft said "D-26 is not edited." That was wrong in a narrow way: a paragraph inside D-26 already
pointed at this rule, while the formula's rule text was unchanged. This correction does edit the formula's
no-match line, which now says `unknown`. The rest of the 2026-10-03 formula is unchanged.

**Setting.** `age_guard_ignore_library_fill`, a boolean app setting, default **false**. Migration 0109 admits
the key and inserts no row. The journal index is 107, the next index after 0107; the filename
is 0109. The Request Keep that had reserved 0108 is migration 0111 at journal index 109, after 0110. `setAgeGuardIgnoreLibraryFill` refuses a non-boolean
and calls `setAppSetting`, which writes the value and an `update_app_setting` audit row in the same transaction.
The admin mutation `trash.settings.set` accepts `{ ageGuardIgnoreLibraryFill: boolean }` and calls that writer.
This change adds no control on the settings page. Absent, or any stored value that is not the boolean `true`,
the fill query does not run. This story does not turn the setting on.

**The rule, when the setting is on.** First, `applyLibraryFill` reads `min(occurred_at)` of
`downloadFolderImported` for this *arr only. If that first import is missing, or is younger than 180 days
(`now - first < 180 days`, the same comparison as `judgeAge`), every stamp stays and the fill query does not
run. The other *arr's history does not open the window. With that guard the rule does nothing for the July 2026
fill. Those stamps stop protecting on their own on 2026-12-29 (the 869 fill stamps run from 2026-07-02 22:00:21
to 2026-07-03 00:36:12, so they age out between 2026-12-29 21:00:21 and 23:36:12; the review of PR 1067,
2026-11-13). The Sonarr ledger covers a full window only from 2026-12-30 10:20:40. The rule works for any later
fill.

When the ledger does cover the window, a library-day is one Plex library and one America/New_York calendar
date. It is a fill day when it has at least 100 titles and at most 5% of them (`nearImports * 20 <= titles`,
both integers) have a `downloadFolderImported` event of that title's own *arr kind within 6 hours of that
title's added time, inclusive. A fill stamp is left out of `newestPlexAddedAt` only when that title has no such
nearby import of its own and a **different Plex server** has a strictly older dated added time in a library
whose type fits the title (a movie library for Radarr, a show library for Sonarr). A stamp from a library whose
type does not fit never counts as that older date. It can still be a stamp of its own. The oldest dated stamp
that can retire another always stays. An undated match is not an older date. Two libraries on the same server
are not two servers. Equal timestamps are not strictly older. A download import inside 180 days still protects
the title whether or not a Plex stamp was left out. Match counts are unchanged: an ignored fill stamp is still
a dated match.

**A title with no Plex match.** `judgeAge` returns `unknown` when `plexMatches` is 0, or any match is undated,
and no date inside the window already made the title `recent`. This holds with the setting on or off. The old
comment said Maintainerr's HaynesOps date-added clause still covered a title no library is matched to, and
`judgeAge` returned `clear`. DESIGN-014 D-15 removes that clause for TV. `unknown` keeps the title. This is the
one change in this decision that alters today's behaviour, and it only ever keeps more. Measured 2026-11-13 on
replica `postgres16-11` (`SELECT` joining `trash_candidates` to `media_plex_matches`;
`trash_candidates_state.refreshed_at` 2026-11-13 15:15:05.495-05): 0 of 524 movie candidates have no Plex match,
and the TV pool has 0 members. The ten shows that pass story 835's predicates all have a Plex match and a
Sonarr download import inside 180 days (same replica, same day). The review of story 835 measured the same zero
on the pools earlier that day (18:32Z–18:50Z).

**Why the data separates fills from arrivals.** Measured 2026-11-13 on the replica `postgres16-11`
(`SELECT` only; clock `2026-11-13 12:51:41.238254-05`; the 180-day cutoff is
`2026-05-17 12:51:41.238254-04`, exactly 180 × 24 hours). The day tables and the query shapes are in
`.agents/context/2026-11-13-age-guard-library-fill.md`.

- HaynesOps TV Shows: 1,013 matches over 69 days, largest day 638. The two days of 2026-07-02 (638 titles, 0 nearby
  imports, 120-minute span) and 2026-07-03 (232 titles, 1 nearby import) are the fill. The next HaynesOps TV day is
  8 titles. Of the 953 live Sonarr shows on that library, 824 sit on those two days.
- Movie mass days in the same week, on both movie libraries, are the opposite shape: 2026-07-03 through 2026-07-06,
  2026-07-15, 2026-10-01, 2026-10-17 and 2026-11-01 each have a download import within 6 hours for every title. D-26
  already recorded Radarr's steady 5 to 10 imports an hour. Those days are not fills.
- Inside the window, every movie or show day of at least 5 titles and under half nearby imports, other than the two
  TV days, is a May 17 through June 30 movie trickle of at most 12 titles. The ledger's Radarr history starts
  2026-07-02 22:27:34-04 and its Sonarr history starts 2026-07-03 11:20:40-04, so those days have no import to show.
  The cutoff of 100 leaves them protected. A per-title "no nearby import" rule would not (option A in ADR-119).
- On this replica, any integer cutoff from 13 through 232, with the same 5% test, changes the same verdicts
  (the review of PR 1067, 2026-11-13, the review's SQL with `minT` varied: the same 389 shows and 40 movies).
  At 12, 46 movies change; at 9, 65; at 8, 70. Not 9 through 232. 100 is the cutoff. It also sits above the
  39-title movie day of 2026-05-05, which is already outside the window. The same review's flat ranges, not
  re-run here: the share from 1% through 50% changes the same verdicts, and 0% changes 280 shows and 30 movies;
  the near window from 1 hour through 48 hours changes the same verdicts, and 7 days changes 109 shows and 10
  movies; a minimum of 233 through 638 changes 280 shows and 30 movies, and 639 or more changes none.

**The 5% test had no power on the July fill.** The last scan stamp plus 6 hours is 2026-07-03 06:36. The
ledger's first Sonarr import is 2026-07-03 11:20:40. "0 of 638" and "1 of 232" would read the same had every
show been downloaded that night (review of PR 1067, 2026-11-13). The sentence "same overnight scan, now inside
Sonarr history" is wrong: only one stamp, at 11:31, is inside history, and it is a real arrival. With a
24-hour window the counts are 7 and 2. The label is still right, on evidence the rule does not use: 869 stamps
in 2 hours 36 minutes, 866 of them with a date on the other server more than a day older. That is one more
reason for the ledger-coverage guard.

**Paper census of the fill rule alone, as if the ledger already covered the window.** Live Radarr and Sonarr
titles with a movie or show Plex match and `deleted_from_arr_at` null. "Changes protection" means today's
verdict is recent and the new verdict is not. No row in this table moved from recent to unknown, because every
row already has a movie or show Plex match. These figures are the Age Guard alone (worker census 2026-11-13
12:51:41-05, reproduced by the review the same day: 389 shows, 85,031,322,181,927 bytes; 40 movies,
1,368,757,512,491 bytes). With the ledger-coverage guard, none of these verdicts change today. The July stamps
lapse on 2026-12-29, as above.

Under the pools the switch changes no deletion today (review of PR 1067, 2026-11-13, `trash_candidates`
refreshed 14:00:13):

- Live pools: TV 0 members; movies 524, of which 464 are clear before and after, 60 recent before and after,
  0 change.
- Story 835's rule (ended, last aired over 180 days ago, rating below 6.0, no `mediarequests` tag), the
  review's projection counting unrated shows as passing: 0 of the 389.
- Today's live TV rule without its age and views clauses: 2 of the 389, both continuing: The Masked Singer
  (US), 380.3 GB, and Squid Game: The Challenge, 45.8 GB.
- 379 of the 389 are rated 6.0 or higher; 182 carry `mediarequests`.

| Kind | Transition | Titles | Bytes (`size_on_disk`, one row per title) |
|------|------------|--------|--------------------------------------------|
| Radarr | clear → clear | 3,783 | 121,192,914,574,090 |
| Radarr | recent → clear | 40 | 1,368,757,512,491 |
| Radarr | recent → recent | 1,370 | 43,611,721,155,978 |
| Sonarr | clear → clear | 3 | 104,700,881,687 |
| Sonarr | recent → clear | 389 | 85,031,322,181,927 |
| Sonarr | recent → recent | 567 | 130,776,036,718,854 |

That is **429 titles, 86,400,079,694,418 bytes** (86.400 decimal TB, bytes ÷ 10^12). Other keeps still apply and
were not subtracted here. The 389 shows are every show that is recent only by a Plex date against an older Plex
date and has no download import inside the window. Of the 157 movies in that same shape (5,155,985,257,336 bytes),
40 change and 117 stay (3,787,227,744,845 bytes, the difference of those two measured totals). The 117 are days
under 100 titles.

The 40 movies are Radarr rows whose only in-window Plex date is a tmdb match into HaynesOps TV Shows on 2026-07-02
or 2026-07-03. Thirty-three have movie-library dates, all outside the window, and their listed bytes add to
1,368,757,512,491 (checked by summing the table, 2026-11-13). Seven have `size_on_disk` 0 and matches only on show
libraries: Black Gunn (1972), Kiss of the Dragon (2001), The Finishers (2013), Christmas Every Day (1996), The Man
Who Came Back (2008), A Nightmare on Elm Street: The Dream Child (1989), P.O.W. The Escape (1986). Be Cool (2005)
has the same TV-fill stamp and stays recent, because its other server's show date is 2026-06-07, still inside the
window.

**Twenty largest shows the fill rule would release once the ledger covers the window.** With the guard they stay until the stamps lapse on 2026-12-29. All HaynesOps dates are 2026-07-02 except the five marked
July 3. Bytes are `size_on_disk`. None of the 33 movies reaches this list.

| Title | Year | Bytes | tvdb | Other server's show day |
|-------|------|-------|------|-------------------------|
| Live PD | 2016 | 2,447,841,409,349 | 318451 | 2024-08-04 |
| Game of Thrones | 2011 | 2,074,757,574,282 | 121361 | 2023-10-02 |
| Seinfeld | 1989 | 1,937,068,550,813 | 79169 | 2024-01-10 |
| Friends | 1994 | 1,888,726,482,497 | 79168 | 2023-09-20 |
| Supernatural | 2005 | 1,860,411,199,739 | 78901 | 2023-11-21 |
| 24 | 2001 | 1,812,167,153,236 | 76290 | 2024-01-09 |
| The Walking Dead | 2010 | 1,446,865,128,256 | 153021 | 2023-09-20 (HaynesOps 2026-07-03) |
| Doctor Who (2005) | 2005 | 1,434,245,503,352 | 78804 | 2023-09-20 |
| House | 2004 | 1,403,631,227,457 | 73255 | 2023-10-22 |
| Star Trek: The Next Generation | 1987 | 1,302,180,638,930 | 71470 | 2025-08-29 |
| Marvel's Agents of S.H.I.E.L.D. | 2013 | 1,198,196,915,930 | 263365 | 2023-10-16 |
| Suits | 2011 | 1,183,766,587,816 | 247808 | 2023-10-24 |
| Psych | 2006 | 1,078,367,567,804 | 79335 | 2025-07-13 |
| The Office (US) | 2005 | 1,075,982,742,077 | 73244 | 2023-10-15 (HaynesOps 2026-07-03) |
| WWE Raw | 1993 | 1,029,765,156,027 | 76779 | 2024-04-02 (HaynesOps 2026-07-03) |
| Dexter | 2006 | 1,025,614,745,157 | 79349 | 2023-10-22 |
| The Sopranos | 1999 | 1,020,562,062,589 | 75299 | 2023-11-07 (HaynesOps 2026-07-03) |
| The West Wing | 1999 | 1,012,159,246,393 | 72521 | 2023-10-24 (HaynesOps 2026-07-03) |
| Lost | 2004 | 975,059,261,064 | 73739 | 2023-10-22 |
| Glee | 2009 | 974,126,983,734 | 83610 | 2023-10-15 |

**The 33 movies the fill rule would release once the ledger covers the window.** With the guard they stay until the stamps lapse. tmdb id, bytes, then the two movie-library days (HaynesOps, then
the other server).

| Title | Year | tmdb | Bytes | Movie-library days |
|-------|------|------|-------|--------------------|
| A Simple Plan | 1998 | 10223 | 85,239,155,760 | 2026-05-05, 2026-05-05 |
| Donnie Darko | 2001 | 141 | 84,447,656,230 | 2021-04-24, 2023-10-16 |
| Paris, Texas | 1984 | 655 | 80,467,419,230 | 2024-11-25, 2024-03-25 |
| Citizen Kane | 1941 | 15 | 78,356,974,315 | 2023-12-13, 2023-09-24 |
| 2001: A Space Odyssey | 1968 | 62 | 77,358,146,060 | 2020-11-22, 2023-09-19 |
| The Matrix Reloaded | 2003 | 604 | 75,203,194,023 | 2022-05-03, 2023-09-20 |
| Back to the Future | 1985 | 105 | 74,776,450,258 | 2026-01-01, 2023-09-20 |
| The Departed | 2006 | 1422 | 70,820,325,271 | 2024-04-25, 2023-09-18 |
| The Sum of All Fears | 2002 | 4614 | 58,893,521,776 | 2021-02-03, 2023-09-18 |
| Pan's Labyrinth | 2006 | 1417 | 54,751,785,901 | 2025-01-16, 2023-09-18 |
| The Empire Strikes Back | 1980 | 1891 | 52,582,080,307 | 2023-10-02, 2023-09-20 |
| The Evil Dead | 1983 | 764 | 52,109,254,878 | 2021-10-07, 2023-09-18 |
| It's a Wonderful Life | 1946 | 1585 | 50,104,359,697 | 2023-12-25, 2023-09-24 |
| Hellboy | 2004 | 1487 | 49,388,589,524 | 2026-02-09, 2026-02-09 |
| Das Boot | 1981 | 387 | 40,319,763,579 | 2018-06-06, 2023-10-10 |
| David | 1997 | 2734 | 37,799,011,256 | 2022-06-07, 2024-09-26 |
| Armageddon | 1998 | 95 | 35,560,995,734 | 2024-02-03, 2023-09-18 |
| 28 Weeks Later | 2007 | 1562 | 29,984,721,480 | 2022-10-06, 2023-09-27 |
| Amélie | 2001 | 194 | 29,867,047,297 | 2020-10-24, 2023-10-10 |
| All Star Superman | 2011 | 56590 | 29,654,426,351 | 2023-04-26, 2023-09-23 |
| Reign Over Me | 2007 | 2355 | 26,754,919,860 | 2019-01-22, 2023-09-25 |
| Diary of a Mad Housewife | 1970 | 31677 | 25,571,139,014 | 2022-08-19, 2024-03-26 |
| History of the World: Part I | 1981 | 10156 | 24,503,423,609 | 2023-04-11, 2025-10-28 |
| The Passion of the Christ | 2004 | 615 | 24,081,961,866 | 2026-03-02, 2026-03-02 |
| Planet Terror | 2007 | 1992 | 22,201,320,136 | 2018-11-25, 2025-01-27 |
| On Her Majesty's Secret Service | 1969 | 668 | 20,996,093,465 | 2022-02-06, 2023-09-16 |
| Sister Act | 1992 | 2005 | 20,636,310,845 | 2020-03-28, 2026-02-02 |
| The Bridges of Madison County | 1995 | 688 | 15,823,603,583 | 2026-02-15, 2026-02-15 |
| Fracture | 2007 | 6145 | 15,311,227,249 | 2025-04-30, 2025-11-01 |
| Green Lantern: Emerald Knights | 2011 | 65291 | 14,260,606,395 | 2025-12-28, 2023-09-23 |
| Porgy and Bess | 1959 | 1940 | 5,754,483,053 | 2025-12-15, 2025-12-16 |
| Rock Hudson's Home Movies | 1992 | 124101 | 3,362,167,927 | 2021-07-19, 2024-05-15 |
| Odd Obsession | 1959 | 43095 | 1,815,376,562 | 2026-02-16, 2026-02-16 |

A Simple Plan is the closest keep-or-release case: both movie libraries added it on 2026-05-05, twelve days before
the cutoff, so the movie arrival has already aged out and the TV-library fill is the only remaining recent date.
Once the ledger covers the window, the rule releases it, because the date that kept it recent belongs to another
title. With the guard, it stays until that stamp ages out on its own. A person checking the list should look at
that one first.

The review of PR 1067 (2026-11-13) read the 40 rows as wrong-type matches: the date that kept them recent belongs
to another title, and their own movie dates are past 180 days, so releasing them once the ledger covers is the
intended result. Be Cool stays because another show's date is still inside the window. The reverse, a wrong-type
stamp used as the older date, is what the fitting-type test stops. The review found that shape on 7 Radarr rows,
all with no file. This decision does not change the matcher (story 847, Q-24).

**Where the rule can be wrong, and what happens.**

| Case | What happens |
|------|----------------|
| A real download burst of at least 100 titles in one library on one calendar day, with at most 5% recorded as download imports. | Titles in that burst that are older on another server, and have no import inside 180 days, lose the Plex date. A title with an import inside 180 days stays. A day under 100 is not a fill. No in-window day on this replica has this shape except the TV fill. |
| A fill split across midnight into two days of under 100 titles. | Not a fill. Today's behaviour. The July fill was 638 and 232, so it was not hidden. The next HaynesOps TV day is 8. |
| The other server is older, but that date is still inside 180 days. | That date still protects. Live example: Be Cool, other server 2026-06-07. |
| The title is on one server only. | The stamp stays. Two HaynesOps shows on the fill have no other server. |
| The other server holds the title with no date. | No strictly older date. The stamp stays, and recent still wins over undated. |
| A download import is inside 180 days but more than 6 hours from the stamp. | The stamp may be left out. The import still protects. |
| One title on a fill day has its own import within 6 hours. | That stamp stays, and the import protects. |
| A day of at least 100 titles where every title has an import within 6 hours. | Not a fill. The July movie days are this shape. |
| The same timestamp on the other server. | Not strictly older. The stamp stays. |
| Two libraries on the same server, and no other server. | The stamp stays. |
| A movie's only in-window date is the show-library fill, and another server is older. | The Age Guard clears. This is the 40 movies. It is intentional: the fill date is not a download. |
| A day of 12 or 60 titles with no imports and an older other server. | Not a fill. The recent date protects. This is the 117 movies. |
| The setting is off. | Newest Plex date, exactly the max in D-26. A title with no Plex match is `unknown` either way, which only ever keeps more. |
| One title arrives on a second server inside the window (a day of one). | Not a fill. The date protects. |
| This *arr's first download import is missing, or younger than 180 days. | Every stamp stays. The July 2026 fill is this case until the Sonarr ledger covers a full window on 2026-12-30. |
| The only older date is on a library whose type does not fit the title. | That stamp does not retire the newer one. The matcher that creates the row is story 847 and is not fixed here. |

Historical movie days on the other server of 100 or more titles with no nearby import (2023-09-18, 2023-09-19,
2023-09-20, 2023-09-24, 2023-09-26, 2025-05-31) are labeled fills. They are already outside 180 days and only get
older, so the label does not remove a protection that exists today or later. The ledger cannot see imports from
those years. Music-library days are large and are not read by the Age Guard.

**Before the setting may be turned on (story 823).** All five, from the review of PR 1067 (2026-11-13):

1. The ledger-coverage guard above is in the code. With it, the rule does nothing for the July 2026 fill and works for any later fill.
2. A census against the Trash pool the TV rule in force would build, read by a person. The review's census against today's pools found no deletion change (the pool figures above). Story 823 repeats it against the rule that is live then.
3. No open batch holds a title whose verdict would flip. An untargeted batch snapshots a recent title and its tile says "Kept: added or upgraded recently"; a flip mid-window deletes it at the sweep. The review: today's open movie batch held 50 items and none was affected (2026-11-13).
4. An audited way to set the value and to set it back. `setAgeGuardIgnoreLibraryFill` is that way, through `trash.settings.set`. It writes the row and an `update_app_setting` audit row in one transaction, and the same call sets the value back. This change does not turn the setting on and does not add a settings-page control.
5. A stamp from a library whose type does not fit the title never counts as the older date. It is in the code. The matcher is a separate story.

**Limits of the label.** The fill label is recomputed from the titles still matched. 2026-07-03 has 232 titles; once 133 leave Plex, that day stops being a fill and its remaining shows are protected again (109 of the 389 are on that day; review of PR 1067, 2026-11-13). The setting is read once per pending read: once per batch and kind in a sweep, once per Expedite, once per wall page. The reads are separate statements, not one snapshot. A change between two batches of one run applies to the second.

## D-33 — Release Block terms are permanent (story 845, ADR-122)

**Source implementation: ADR-122 / D-33; deployment and acceptance pending coordinator review.** This amendment supersedes D-13's age expiry and oldest-term pruning, D-15's seed expiry origin, D-25br/D-25ce/D-25cf's expiry/prune upkeep, D-29's fixed-life backfill, Q-07's earlier bounded-life ruling and Q-30's permission for upkeep pruning. It does not change release-name coverage, restore routes, the Trash pace or the other blocks. The Accepted ADR-093 body remains untouched; ADR-122 records the newer owner ruling.

The [measurement note](../../.agents/context/2026-11-14-release-block-permanence.md) contains the read-only commands, distributions, weekly growth, upstream source review and a projection with reproducible arithmetic. All observed totals there are measured on 2026-11-14. Forecasts are estimates, not deletion budgets or proof of upstream capacity.

### Retention and historical states

- Desired terms are the distinct non-null terms of `in_flight`, `active`, legacy `expired` and legacy `pruned` records, plus the sentinel. There is no age predicate. `abandoned` records contribute nothing. A shared term stays while any protected record carries it.
- `expired` and `pruned` become historical labels: they explain why a previous writer stopped carrying the term. Preserve the row, `ended_at`, `activated_at` and old `expires_at`; the normal writer restores their terms, without rewriting history. No new record enters those states. Source measurements found none in either state; tests must nevertheless cover both.
- Make `trash_deleted_releases.expires_at` nullable (migration `0112_permanent_release_block`, journal idx 110, per Q-38). Existing finite values remain historical metadata. New records use null; no runtime retention decision uses the column. Remove `RELEASE_TERM_LIFETIME_DAYS` and the seed/backfill `expiresFrom` argument rather than substituting a distant deadline.
- The backfill currently reconstructs an old deletion time from `expires_at` minus the former lifetime, and skips old deletions. Remove the age skip and its `expired` counters. For existing rows, a narrowly named legacy conversion can still recover that historical time for bounding ledger evidence; it must not decide retention. For new rows, use the actual deleted batch item's time or the ledger tombstone's deletion time. Do not silently substitute a new record time for an older deletion. Preserve the seed's own actual deletion-time inputs where they bound evidence; remove only the expiry origin. The implementation must prove these paths with old and new rows.

### The cap and the single writer

Retain `RELEASE_BLOCK_TERM_CAP` at its existing value, measured from source as 3,000 **release terms excluding the sentinel**. Every reconcile, including the hourly and registry upkeep, fails before a profile write if the complete permanent set is too large. Remove the optional prune behavior and all slicing, pruning transitions and oldest-term removal. Under the existing per-service advisory lock:

1. Settle stranded `in_flight` records by the *arr's own presence answer, as today. An ambiguous or unreadable answer keeps the terms. A definitive ineffective delete abandons its records.
2. Read the complete protected set, including legacy `expired`/`pruned`. If it is over the cap, throw `ReleaseBlockError` with step `cap`; no profile mutation and no transaction commit. Do not replace a partially covered profile with a clipped set, including while recovering legacy omissions. Preserve the current profile and report the refusal.
3. Grammar-check every desired term, compare the exact managed profile, write if needed and read back, through `reconcileReleaseBlock` only. Repeating a completed reconcile performs no PUT. Existing duplicate/disabled/edited/missing-profile handling remains.
4. Delete preflight and reservations count that same complete protected set. Admit a title only when **all** its fresh terms fit; duplicates consume no extra room. An item that does not fit is kept, reported and counted as `release_block_full`, with no handle call. A race that overfills before reconcile still fails closed in the writer. Never drop an older term to admit it.
5. Cleanup after a failed or ineffective delete still reconciles abandoned-term removal. A term also supported by a protected record remains. If restoring missing historical terms would exceed capacity, the writer refuses and leaves the existing profile in place; the resulting over-block is reported, not weakened to make room.

Upkeep remains in both schedules, with stranded settling and drift repair. It also detects missing legacy protected terms and an over-cap desired set, regardless of record age. Remove `expiring`, `expired` and `pruned` work/result counters from Release Block reports and their consumers; status should report permanent term totals, cap refusals and stranded work. Retain unrelated Trash batch expiry and the other blocks' expiry.

**Capacity successor (Q-35):** recommend investigating stable additional app-owned profiles with the same term grammar and single writer. Preserve existing membership; allocate only new terms to a further profile, read all desired profiles back before any delete, and treat any partial write as an unverified block with no delete. No owned term is removed to migrate or compact profiles. This needs an isolated experiment and a further reviewed implementation: multiple profiles do not reduce the total matcher work, and current read-back and ownership assume exactly one profile. Do not implement it or raise the cap here. Shorter terms require equivalence proof and are outside this story's release-name scope.

### Rollback (Q-39)

**coordinator, 2026-11-14:** after this release, do not run the previous image's one-off posted-name backfill (`release-block-backfill.ts`): it reads `expires_at` as a date and new rows hold null. An image rollback remains safe for the app, the sweep and the reconcile; use the corrected backfill or a forward fix for that maintenance.

### Implementation and acceptance sequence

**coordinator, 2026-11-14: design PR first, code PR second** (story 845, comment 8512). Both PRs are reviewed together before either merges; PR 1080 supplies the design, and the implementation PR is stacked on it. The coordinator owns merge, the required independent adversarial review and acceptance. Source implementation does not claim deployment or acceptance.

The bounded source change covers `release-block.ts`, seed/backfill, the database column/schema, all report consumers and tests. The identified test fixture uses `indexer A` / `indexer B`. No live system is written to perform or test this work.

Required PostgreSQL 16 embedded-harness cases, one suite at a time, at most the work order's two workers:

- Old active terms at the former age boundary and ten years remain in the profile; a second run performs no PUT. Test both schedules' due/drift path so the next job cannot undo permanence.
- Legacy `expired` and `pruned` records regain profile coverage with historical row fields preserved; an over-cap recovery refuses before writing or committing.
- Failed/ineffective deletes still abandon and remove only their orphan terms; a shared protected term stays. Ambiguous deletes retain terms until a verified settle.
- Exactly-at-cap succeeds; adding a duplicate succeeds; one additional distinct term refuses. Neither direct reconcile nor upkeep silently drops a term. No call site can opt back into pruning.
- A multi-term title that cannot fit stays `release_block_full` in the shared delete seam and its report, with no Maintainerr handle or lost older term.
- Seed and posted-name backfill include old deletions with null new expiry metadata; legacy timestamp interpretation continues to bound evidence by the actual delete rather than resetting it. Report conservation tests use the new non-expiring classes.

Run the touched packages' tests, full typecheck and lint, then wait for every required PR check including `e2e-gate`. Record independent adversarial review on the PR and obtain the coordinator's review before merge/deploy. Built, installed and accepted remain separate evidence states.

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
| Q-14 | Should Expedite (item and all) honor the Age Guard (D-26), and should the pending walls mark or hide a title inside the window? The 2026-10-03 work order scoped the guard to batch build and the sweep; Expedite is an admin's deliberate delete, and covering it means a new `ExpediteVerdict`, the client mirror `previewGuardian`, its parity test and the Expedite confirm copy; a wall note is new UI. | **Answered (2026-10-03, by the owner's ruling itself, relayed by the coordinator):** "Trash ignores anything downloaded, upgraded or added to any server in the last 180 days", and Expedite is part of Trash. Expedite never deletes a title inside the window, and the pending walls show it kept ("Kept: added or upgraded recently") instead of offering it for deletion. Built as D-26's Expedite and pending-wall bullets. The 2026-11-13 amendment then also omits that title from the default view (T-333). |
| Q-15 | A live Maintainerr exclusion is known only for the page just read (ADR-035). The default view omits those titles from the page it returns. The reported count can still include a live-excluded title on a later page, and a page made entirely of them can come back empty while a later page still holds a deletable title. | **Open. Recommendation, shipped with story 832:** keep the page-scoped read. Do not crawl every exclusion for the whole pool. The cursor walks the list from before the drop, so a dropped title is not repeated and a later deletable title is not skipped. |
| Q-16 | `release_unrecorded` is decided when a delete runs, from the *arr's files. The wall cannot know it without that read, so a title can look deletable and still be kept at the sweep. | **Open. Recommendation, shipped with story 832:** leave it on the delete path. Do not copy it into the wall filter, and do not change the guard. |
| Q-17 | The default view holds no undeletable title (the owner's report, 2026-11-13), and a tap must not move its neighbours (hard rule 9). A title saved from the default view is undeletable from that moment. Should its tile leave at once, which moves every tile after it and takes the un-save tap away, or stay until the view is opened again? | **Open. Recommendation, shipped with story 832:** it stays in place, shown as saved, until the view is opened again; a freshly opened default view never contains it. Hard rule 9 allows no exception for this, and the tile is one the viewer has just saved, not one the wall offered as deletable. Removing the tile at once is a one-line change (drop `usePinnedSaves`) if the owner rules the other way. |
| Q-18 | In All, a kept title now says in words that it is kept, but four kinds still wear the red trash can in the corner, because the corner is the Save tap (owner ruling 2026-07-09): a `dnd` tag, a recent watch, a watchlisted title, and a title that cannot be checked. Only the Age Guard wears the kept badge and only a Save the check. Should a kept title's corner change, and if so to what? | **Open. Recommendation, shipped with story 821:** leave the corners as ruled in this change, which is display of the reason only, and ask the owner with the screenshots in hand. The option to weigh: every kept title wears the kept badge and stays one tap from a Save, so the trash can means "will be deleted" and nothing else. That would retire part of the 2026-07-09 ruling, so it needs his word. |
| Q-19 | When a title has a verified grab and the file on disk has no verified name of its own, is the renamed-file term still written? | **Decided (owner ruling 2026-11-13, Q-22):** the question no longer arises. A title whose file has no verified name is kept, so no delete writes a renamed-file term. The earlier grabs of such a title are termed when it is deleted, after its file is named. |
| Q-20 | The 6 tombstoned shows with no term have no posted ledger name, and the size match does not apply to a series. What names them? | **Answered in part (D-29):** the old Sonarr database, loaded into `legacy_release_names` by TVDB id. The backfill terms whatever names it holds for those 6. If it holds none they stay without a term; a name is never guessed from the show title. The count is the backfill's dry run after the load. |
| Q-21 | 401 jobs of the live download history (review of PR 1070, 2026-11-13) have a URL for the name and for the alternate name field. May any other field supply a name? | **Decided with the rule that a URL is never stored:** no. D-29 no longer reads the live download client at all, and the loader refuses any line of the legacy files in which a field contains `://`. |
| Q-22 | A delete can have no verified name for its file: 468 of the 524 pool movies on 2026-11-13, and every one of the 183 deletions since 2026-10-04 took its term from the renamed file, a term measured to miss 5.4 percent of real names (61 of 1,129). What should Trash do with such a title? | **Decided by the owner, 2026-11-13** (story 838, comment 8158): "Get it done right don't ask if I want you to hack around something critical we absolutely cannot re-grab an index we grabbed before". The title is kept (`release_unverified`) on every path that deletes, until a verified name for its file is on record. The names come from the old Radarr and Sonarr databases (D-29 point 3). Built as D-29. |
| Q-23 | The Release Name Check cannot judge a series from the database: a series has many files and the ledger holds no per-file size. So the TV wall can offer, and a TV batch can propose, a series the sweep then keeps `release_unverified`, in every later batch too. | **Open. Recommendation, shipped with story 838:** leave a series `unchecked` (the delete path decides, and keeps it). The TV pool is empty today. Before TV Trash resumes, give the check per-file sizes (a read model of Sonarr's episode files), in the story that designs the TV whole-name term and the cap's successor. |
| Q-24 | Why do live Radarr rows match into a TV library, and can that match retire a real stamp? The review of PR 1067 (2026-11-13) measured all 60 Radarr rows in one TV library and all 61 in the other sharing a Plex item with a Sonarr show, and four Sonarr shows matching a movie by the same kind of shared number. | **Answered for this decision, and it does not block it.** The matcher is story 847 and is not fixed here. A stamp whose library type does not fit the title never counts as the older date (D-31). The 40 movies the fill rule would release once the ledger covers are released because the date that kept them recent belongs to another title and their own movie dates are past 180 days. |
| Q-25 | The 2026-10-30 Trash catch-up counted 7 movies kept "recent only". Which titles were they, and were they a library fill? | **Not re-identified, and it does not block.** That row means kept by the Age Guard and not by a watchlist, not kept by a fill. The review of PR 1067 measured, the same day, 60 pool movies kept by the Age Guard: 54 by an import, 6 by a Plex date, none by a fill day. |
| Q-26 | A posted name that carries a mark of a release and that the grammar cannot write (a leading bracket or quote, a part counter, a fansub layout) now keeps its title for good. The review counted 7 such names on 3 movies and 253 on 8 series that were skipped before, none in today's pool. | **Open. Recommendation, shipped with story 838:** keep the title, because a skipped name is a grabbed release with no block. The same holds for a legacy `imported` name, which can be the name of the file inside the download and not the posted name; how many pool titles that keeps is not known until the load, and `release-block-seed.ts --pool` then lists them under `no_term`. The later story decides whether the Release Block takes the janitor's whole-name form (ADR-094), which matched every such name in the review's test and would let these titles go. |
| Q-27 | After the legacy load, a pool movie can have grab names in the old database and no file record with the file's exact size (the coordinator's measurement leaves 52 of 524 without an exact-size record; some of those the ledger names). Its file was replaced, re-encoded or never recorded. | **Open. Recommendation, shipped with story 838:** it stays kept. Do not fall back to a size ratio, a title match or the grab names alone to name the file. The coordinator reads the count from `release-block-seed.ts --pool` after the load and decides whether the remainder is worth a per-title look. |
| Q-28 | `identifySeries` does not use the ledger's import to name an episode file, which the design says it does, so a series the ledger could name is kept; required before TV Trash resumes. | **Open.** Recorded from the review of the corrected PR, 2026-11-13. The TV pool is 0. This does not delete on a rebuilt name. |
| Q-29 | A second file on one movie is not checked (0 of 9,630 titles have one today). | **Open.** `identifyMovie` reads `movieFileId`, or else the first file. Measured by that review, 2026-11-13, replica `postgres16-11`: 0 of 9,630 Radarr titles have `on_disk_file_count` greater than 1. No change while that count is 0. |
| Q-30 | The hourly upkeep still prunes the oldest terms once the profile passes 3,000 and still expires terms after 365 days, and story 845 (terms never expire) owns both. | **Open.** A delete and the backfill still reconcile with `prune: false`. Recorded from the review of the corrected PR, 2026-11-13. |
| Q-31 | Which tag property does an armed season or episode rule group have to exclude? | **Open.** D-30 holds it to the Sonarr show-tag clause (`firstVal` [2, 2], value `mediarequests`), which refuses the sweep if that clause is missing. A second section joined by AND still passes. No such group was active on 2026-11-13. Recommendation: keep that fail-closed check. Main holds Q-23 for the Release Name Check, so this question is Q-31. |
| Q-35 | What measured capacity replaces the single Release Block profile once permanent terms fill it? | **Open. Recommendation:** keep the current cap and `release_block_full` refusal now; investigate stable additional owned profiles using an isolated instance of each installed version, with synthetic terms only, no live search/grab, serial CPU-limited runs and a saved disk budget. Measure write/read-back acceptance, encoded bytes, matcher memory, cold/warm nonmatching and matching decisions at the existing cap and the projected larger totals; compare a single profile with the same total terms split over profiles. Source inspection finds no explicit term-count cap in the inspected controllers, not an unlimited performance guarantee. Current measured release terms: Radarr 1,151, Sonarr 195. The current-pool exact new-term report and the coordinator's earlier 518-title/994-term figure were not re-verified by this worker; do not promote them to measured worker evidence or size a new limit from them. See the note for measured observed pace, projection limits and the full-batch sensitivity. |
| Q-36 | Should permanence also apply to the Janitor Release Block and Mislabel Block? | **Open for the owner; no change here.** Measured on 2026-11-14 from replica aggregates and in-pod profile GETs: Lidarr has 203 release terms plus its sentinel; first expiry 2027-09-29T15:25:02.924Z. Sonarr's Mislabel Block has 35 terms plus its sentinel; first expiry 2027-10-13T02:38:16.282Z. Recommendation: assess separately. Janitor permanence would remember a proved failing whole-name grab even after a corrected repost; Mislabel permanence would retain group/series and name-pattern restrictions after a group fixes its numbering, potentially excluding future good releases. Either also needs an evidence-sized capacity policy; neither inherits Release Block authority from this story. |
| Q-37 | Story acceptance requires the superseding ADR and DESIGN merged before code; the work order requires one PR with docs committed before code. Which sequence should be used? | **Answered — coordinator, 2026-11-14: design PR first, code PR second** (story 845, comment 8512). Both are reviewed together before either merges. The implementation PR stacks on PR 1080 and must merge after it; the coordinator owns review, merge and acceptance. |
| Q-38 | The unmerged migration reservation leaves a gap after main's last journal entry. How is the contiguous-journal prerequisite supplied? | Measured on 2026-11-14 with `git show origin/main:packages/db/migrations/meta/_journal.json` after a fresh fetch: main ends at idx 109, `when` 1791480000000. <br>**coordinator, 2026-11-14:** the reservation of idx 111 was a coordinator error; this migration takes the next index on main, idx 110, tag `0112_permanent_release_block`, keeping its later `when` 1791500000000. Of this PR and PR 1079, the one that merges second merges main in and takes idx 111 with a later `when`. Keep the contiguous-journal guard; no dummy entry or migration already on main is changed. |
| Q-39 | Does the work order's unchanged-previous-image requirement include its one-off posted-name backfill after the new writer creates null expiry rows? | Source inspection recorded on 2026-11-14: the old CLI calls `expiresAt.getTime()` and cannot read new null rows; migration 0112 itself creates no null rows. The compatibility test proves old finite-row SQL, not that CLI after new writes. <br>**coordinator, 2026-11-14:** accepted as recommended. After this release the previous image's one-off posted-name backfill is not run: it reads `expires_at` as a date and new rows hold null. An image rollback remains safe for the app, the sweep and the reconcile; use the corrected backfill or a forward fix for maintenance, preserving permanence metadata. No rollback or production command is run here. |
