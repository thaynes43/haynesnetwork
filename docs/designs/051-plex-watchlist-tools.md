# DESIGN-051: Plex watchlist tools — `watchlist`, `set_watchlist`, "on your watchlist" in `watch_status`, and undoable watchlist changes

- **Status:** Draft
- **Last updated:** 2026-09-25 (D-15 records the rulings from the PR #580 code review, folded into D-02..D-12 and
  D-14, D-15i/D-15j those of its second pass: the undo replay guard across clocks, and the Seerr sentence on a
  repeated or unconfirmed add, and D-15k..D-15p those of its third: an unsettled change when plex.tv cannot be
  read, several watchlist titles under one name, a failed clear, a write that may still land, a pending change
  in undo, and a per-attempt timer that covers the body, and D-15q..D-15s those of its fourth: a remove finds a
  pending add and every add the cache cannot have seen, an undo plex.tv never confirmed leaves its title
  unsettled, and the unsettled check reads the title's whole run of changes, and D-15t..D-15w those of its fifth:
  undo never walks past a pending `watched` mark, a revert is never stamped before its change, a named year
  settles an add's TMDB ambiguity, and TMDB titles that read the same are not a question; D-14 the rulings made
  while building; D-13 the rulings from the PR #577 design review, folded into D-02..D-11).
- **Satisfies:** PRD-001 R-252, R-253, R-245 (amended), US-15, AC-29..AC-31; governed by ADR-092; extends
  DESIGN-049 (the Watch Companion: D-05 tool contract, D-12..D-15 marks and undo, D-13 resolver, D-17
  candidates) and DESIGN-050 D-07 (the principal, owner-only Plex write-back).
- **Context:** DDD-002 BC-06 Watch Companion; glossary T-248 (amended), T-253 (amended), T-260.

## Overview

```
agent ─▶ set_watchlist {title, action, kind?}            (watch:write, owner only)
           1 resolve (D-13 pool; remove: the watchlist only)
           2 discover id  ← plex:// guid suffix | plex.tv matches?type=&guid=tmdb|tvdb|imdb://
           3 live userState → already in the wanted state? say so, write nothing
           4 watch_marks row (watchlist_add | watchlist_remove, pending)
           5 PUT discover.provider.plex.tv/actions/{add|remove}ToWatchlist?ratingKey=<id>
           6 finalize written | failed (unknown: said so); answer with the title, year, and the Seerr line
agent ─▶ watchlist {kind?, limit?, offset?}               (watch:read)
agent ─▶ watch_status {title}  … "On Plex and on your watchlist."
                ▲
   every watchlist read = watch_reco_signals(source=watchlist)  ⊕  overlay of watchlist marks and
   their reverts since the last sync (D-05)
sync-watch */15 ─▶ replaceRecoSignals(source=watchlist)  (unchanged)
Seerr */3 ─▶ the 20 newest watchlist titles ─▶ auto-approved request for anything not available
```

## Detailed design

### D-01 — Tools (the D-05 contract gains two rows)

| Tool | Scope | Description (as served) | Parameters |
|---|---|---|---|
| `watchlist` | read | The user's Plex watchlist, newest first, each title with whether it is on Plex; pass offset for more. | `kind` `show`\|`movie`\|`any` (default `any`); `limit` 1–10 (5); `offset` 0–2000 (0) |
| `set_watchlist` | write | Add a title to the user's Plex watchlist or remove it; says back the title it found. Adding a title not on Plex makes Seerr download it. | `title` (**required**); `action` `add`\|`remove` (**required**); `kind` `show`\|`movie` |

Changed descriptions: `watch_status` becomes "Whether the user has seen a title, how far along he is,
and whether it is on Plex and on his watchlist."; `undo_last_change` becomes "Undo the user's last
mark_watched, dismiss or set_watchlist from the past day." The server `instructions` (≤ 600
characters) gain: "watchlist: the Plex watchlist. set_watchlist adds or removes; adding a title not on
Plex makes Seerr download it."

Annotations: `watchlist` `readOnlyHint`; `set_watchlist` `destructiveHint: false`,
`idempotentHint: true`. Schemas follow DESIGN-049 D-05's rules (flat, property-level enums, no
defaults, bounded integers) and are hand-written like the others.

### D-02 — Spoken answers (no markdown, no URLs, no em or en dashes; ≤ 1,200 characters)

- `watchlist`: *"Your watchlist has 150 titles. Newest first: Slow Horses, a 2022 show, on Plex,
  started. The Toxic Avenger, a 2023 movie, not on Plex yet. … And 145 more."* With `kind`: "Your
  watchlist has 61 shows. …". Each entry: title, year, kind, `on Plex` or `not on Plex yet`, then
  `started` when the Title State is in progress or stalled or is a Taster (D-14g), `watched` when it is
  Ever Watched and not unfinished. The entries are fitted to the 1,200-character cap first; a later page,
  or a first page the cap cut short, then says the range it holds ("Numbers 6 to 10:", "Newest first,
  numbers 1 to 4:"), and "And N more." counts from the last title said, so an agent paging by `offset`
  never skips one (D-15). Empty: "Your watchlist is empty." Past the end: "That's the end of your watchlist." The
  "on Plex" rule is the one the code already applies to watchlist signals (a ledger item with the same
  external id and a `media_plex_matches` row), or the Title State's `on_plex` when the title has one.
- `set_watchlist` add: *"Added The Matrix (1999 movie) to your watchlist. It's on Plex."* / *"Added
  Dune: Part Three (2026 movie) to your watchlist. It isn't on Plex yet, so Seerr will request it."*
  Remove: *"Removed The Matrix (1999 movie) from your watchlist."* No change: *"The Matrix (1999 movie)
  is already on your watchlist."* / *"… isn't on your watchlist."* An "already on" add of a title not on
  Plex adds *"It isn't on Plex yet, so Seerr will request it if it hasn't already."* (D-15j: a client
  retrying an add that landed hears this answer, not the first one). The title and year said back are
  plex.tv's (the discover match), so the agent can verify the change.
- Ambiguous: *"Did you mean Dune (2021 movie) or Dune (2000 show)?"* (D-13's candidate list). Several
  watchlist titles under one spoken title (D-15e) are not a question, since nothing the owner can say picks one
  (D-15l): *"Your watchlist has more than one Dark Matter (2024 show), and I can't tell them apart, so I left it
  as it is. You can change it in the Plex app."* (titles that read differently are named: *"Dark Matter (2024
  show) and Dark Matter (2023 show) on your watchlist look like the same title to me, so I left your watchlist as
  it is. …"*). The same holds for an add whose TMDB titles all read the same (D-15w): *"I found more than one Alone (2020
  movie) and can't tell them apart, so I left your watchlist as it is. You can add it in the Plex app."* Not found
  (for a remove, not found **on the watchlist**): *"I couldn't find X on your watchlist."* / *"I couldn't
  find X."* A title with no discover match: *"I found X (year) but not in Plex's catalog, so your
  watchlist didn't change."* A guid that disagrees with the external-id match: *"I couldn't confirm X in
  Plex's catalog, so your watchlist didn't change."* Plex failure: *"I couldn't reach Plex, so your
  watchlist didn't change."* A write plex.tv never confirmed either way (D-03 step 6): *"Plex didn't answer
  in time, so I can't tell whether X changed."*, plus, for an add of a title not on Plex, *"It isn't on
  Plex yet, so if it was added, Seerr will request it."* (D-15j).
- `watch_status` ends with one availability sentence instead of today's "On Plex." / "Not on Plex.":
  "On Plex and on your watchlist." · "On Plex, not on your watchlist." · "Not on Plex, but on your
  watchlist." · "Not on Plex or your watchlist." Explicit both ways, so an agent never has to infer.
- A principal that is not the Server Owner (ADR-091 C-04): `watchlist` and `set_watchlist` answer
  *"Your Plex watchlist isn't set up for your account yet."*; `watch_status` keeps today's sentence (the
  watchlist clause is the owner's only).

### D-03 — `set_watchlist` flow (`@hnet/domain` `changeWatchlist`, beside the mark writers)

1. **Principal.** `assertTrackedWatchAccount`; a role other than `owner` returns the D-02 non-owner
   answer, with no row and no Plex call.
2. **Resolve** (DESIGN-049 D-13, unchanged scoring). `add`: the normal pool, then the one TMDB
   `search/multi` fallback. `remove`: the pool is **the overlaid watchlist** (D-05) plus the titles a
   watchlist mark removed in the last 10 minutes (so a retried remove reaches step 4 and answers "isn't
   on your watchlist"), and no TMDB fallback. Since D-15 that pool also holds the titles a `watchlist_add`
   failed to add (it may have landed) or never finalized (D-15q), for every such add the cache cannot have
   seen (made since its fetch less the D-05 margin, or in the last 10 minutes, whichever reaches further
   back), and the titles a written remove took off whose undo plex.tv never confirmed, within the undo
   window (D-15r); plex.tv's live state (step 4) decides. `kind` filters as for marks. **An add's TMDB
   fallback collects every exact normalized-title hit of the eligible kind(s); two or more distinct TMDB
   ids are ambiguous** (listed with their years), since an add can download (ADR-092 C-07); the fallback
   makes a single attempt (D-15). A year the title names keeps only the hits of that year whenever one has it,
   the parenthesized form ("Shōgun (2024)") included, in D-13's first-hit mode too (D-15v). The question lists
   each title that reads differently once; hits that all read the same (one name, year and kind) are answered
   that it can't tell them apart, never a question (D-15w). A
   same-name group whose watchlist titles carry **different discover ids** writes nothing either and answers
   that it can't tell them apart (D-15e, D-15l).
   Ambiguous and not-found never write: no row, no Plex call.
3. **Discover id.** If the resolved identity has a `plex_guid` of the form
   `plex://{movie|show}/<24 hex>` whose type is the kind, the id is the suffix (verified live: the
   suffix equals the discover `ratingKey`). Otherwise `matchDiscover` with the kind's `type` (movie 1,
   show 2) and the first of `tmdb://`, `tvdb://` (shows), `imdb://` that the identity has; the match
   must be of the same type. No id → the D-02 not-in-catalog answer. If the catalog lookup fails, or no
   Plex client is configured, the change is still recorded (D-15): a `failed` Watch Mark with no plex guid
   and a `plex_error` starting `not sent:`, so "undo that" closes this change instead of reverting an older
   one. When the id came from a guid and the identity has an external id,
   `matchDiscover` also runs and **must return the same id**, else nothing is written (the D-02
   "couldn't confirm" answer). When the identity came from a watchlist row, no read-back runs: its title
   and year are already plex.tv's. The match's title and year are what the answer says back; its
   tmdb/tvdb/imdb ids are merged into the identity before the on-Plex check and the mark insert.
4. **Live state.** `getDiscoverUserState(id)`: on the watchlist ⇔ `watchlistedAt` present. If the
   wanted state already holds, answer "already on" / "isn't on" with **no row and no write**; so a
   retried call (HA's trailing `tools/list` failure, DESIGN-049 D-05) is a truthful no-op and never
   becomes the "last change". If the userState read fails, the overlaid cache decides instead, unless the
   title's changes end in a call plex.tv never settled: a change since the cache's fetch (less the D-05
   margin) that is `pending`, or `failed` with an `unknown:` error, and not cleared by a written undo
   (D-15k), or a change whose undo failed (D-15r). The title's changes are walked newest first, past those
   that failed definitively, back to the newest one still live whose own call was written or that the cache
   has read (D-15s). The cache cannot show such a call, so the write goes out (both calls are idempotent). A
   remove sent that way over a run holding an unsettled **add** is finalized `written` with a `plex_error`
   starting `after unsettled:` (D-15k, D-15s).
5. **Row.** Insert a Watch Mark: `action` `watchlist_add` | `watchlist_remove`, `scope` = the kind
   (`movie` | `show`), the resolved identity with `plex_guid = plex://<kind>/<id>` and `title_key`
   recomputed from it (`titleKeyFor`, as `withPlexIdentity` does), plex.tv's title and year, `query`,
   `consumer`, `actor_user_id`, `flipped = []`, `plex_result = 'pending'`.
6. **Write.** `PUT {discover}/actions/addToWatchlist|removeFromWatchlist?ratingKey=<id>` with the owner
   token (HaynesOps, else HaynesTower, the sync's order). Any 2xx is success (the provider answers 200
   whether or not anything changed); a 404 is "not in Plex's catalog". Both PUTs are idempotent
   (verified live), so they use the idempotent retry policy; if the last attempt still fails (timeout,
   dropped connection or 5xx), `userState` is read once more **on the write budget** (D-15) and decides:
   the wanted state ⇒ `written`; no answer ⇒ the outcome is unknown, recorded `failed` with a `plex_error`
   starting `unknown:` and said as such (D-02); the other state ⇒ `failed` only when plex.tv answered every
   attempt (a 5xx other than 504), and unknown when any attempt timed out, lost its connection or met a 504,
   since that attempt may still land after the re-read (D-15n). A 4xx after such an attempt is re-read the
   same way; a 4xx on the first attempt (a 429, a revoked token) is `failed` with no re-read. Finalize `written`
   or `failed` (`plex_error` trimmed, never the token), and only while the row is still `pending` (D-15o).
7. **Answer** per D-02. For an add, "on Plex" uses the D-02 rule; when not on Plex the answer adds the
   Seerr sentence (ADR-092 C-03).

Budget: three sequential plex.tv calls, about 250 ms measured. `matchDiscover` and `getDiscoverUserState`
before the write use the short live-revalidation read budget (DESIGN-049 D-11), the PUT and its re-read the
mark write budget; the worst case is in D-14a (as amended by D-15), inside the 9 s MCP deadline. The
discover id is validated against `^[0-9a-f]{24}$` before it is put in any URL.

### D-04 — Undo

`undo_last_change` picks the newest unreverted mark of the last 24 hours as today, now including
watchlist marks. A `failed` watchlist mark is picked too (as a failed `watched` mark already is), since
skipping it would make "undo that" after a failure revert an older, unrelated change. What its undo does
depends on the change (D-15):

- a change that was **never sent** (D-03 step 3): no Plex call, `revert_result = 'none'`: *"Your last
  change, adding X to your watchlist, never reached Plex, so there was nothing to undo."*;
- a failed **add** that went out: `removeFromWatchlist` anyway (it may have landed; a removal is idempotent
  and never downloads), answered from that call: *"Your last change, adding X to your watchlist, may not
  have reached Plex, so I made sure it's off your watchlist."* (plus the Seerr sentence below);
- a failed **remove**: no Plex call (its inverse is an add, which could download), `revert_result =
  'none'`: *"Your last change, removing X from your watchlist, never confirmed with Plex, so I left your
  watchlist as it is."*;
- a **remove sent over an unsettled add** (D-03 step 4, `after unsettled:`): no Plex call either, since
  nothing ever showed the title on the list and an add could download it, `revert_result = 'none'`: *"Your
  last change, removing X from your watchlist, came after an add Plex never confirmed, so I left it off your
  watchlist. To put it back, ask me to add it."* (D-15k);
- a change still **`pending`** is picked too (its row carries its whole plan), and so is a pending `watched`
  mark: undo never walks past a pending mark to an older one (D-15o, D-15t). A Watchlist Change under a minute
  old is going through: *"Plex is still working on your last change, adding X to your watchlist. Say undo again
  in a moment."*, and nothing is reverted, the older change neither. Older, its replica died or its finalize
  failed: it is closed `failed` with `unknown: never finalized` and undone like any unconfirmed change (D-15o). A
  `watched` mark is going through for ten minutes (*"Plex is still working on your last change, marking X as
  watched. Say undo again in a moment."*); older, it is closed the same way and its planned keys are unscrobbled,
  and its own finalize, should it ever run, leaves the closed row and the Title State alone (D-15t).

Otherwise it applies the inverse call (`removeFromWatchlist` for an add, `addToWatchlist` for a remove) and records
`revert_result` `written` | `failed`. Answers: *"Removed The Matrix (1999 movie) from your watchlist
again."* / *"Put The Matrix (1999 movie) back on your watchlist."* When the title is not on Plex, undoing
an add adds "Seerr may already have requested it." and undoing a remove adds "Seerr will request it."
The inverse is idempotent, so it is applied even if the owner changed the watchlist in the Plex app
meanwhile. An inverse call that fails leaves the change live for the next undo; one whose outcome plex.tv
never confirms (D-03 step 6's re-read gets no answer, or an attempt may still land) says *"Plex didn't answer
in time, so I can't tell whether X changed."* and leaves it live too. A failed add's removal that fails says
*"I couldn't reach Plex, so I couldn't make sure X is off your watchlist. Say undo again to retry."*, never
"still on": the add itself never confirmed (D-15m). When that unconfirmed call is the add that undoes a remove and
the title is not on Plex, it adds *"It isn't on Plex yet, so if it was put back, Seerr will request it."*
(D-15j).

**Undo replay guard (all marks).** An undo within 30 seconds of the account's last completed undo, with
no mark created since, repeats that undo's answer and reverts nothing. A client retry (HA's trailing
`tools/list` failure, DESIGN-049 D-05; a ChatGPT retry) would otherwise walk back to the next older mark,
which for a watchlist remove can re-add and download. A person asking twice within 30 seconds waits
that long for the second undo. Undos of one account run one at a time across replicas (a
transaction-scoped advisory lock around the guard, the pick, the Plex call and the revert, D-15), so two
copies of one retried undo cannot both pass the guard. An undo waits for that lock at most 9 seconds (the MCP
deadline, `lock_timeout`); one still queued then errors instead of running after its caller was answered
(D-15p). Each copy reads its clock before it waits on the lock,
so the one that takes the lock first may stamp its revert later than the other's clock reads: a completed undo
stamped after the call's own clock is a replay too (D-15i). A call that changed nothing and wrote no row (a
replayed `mark_watched`, an "already on" `set_watchlist`) inside the 30 seconds leaves the guard as it is:
the next undo still repeats the last answer (accepted, D-15). A revert is stamped at the undo's clock, but never
before the `created_at` of the change it reverts (D-15u): the undo read its clock before it waited on the lock, so
the change it picks may have been made while it waited.

### D-05 — The watchlist overlay (read time, pure)

Every watchlist read (the `watchlist` tool, `watch_status`, the resolver pool, `recommend`'s
candidates) goes through one query, `selectWatchlist(db, plexAccountId)`, which returns the account's
`source = 'watchlist'` rows with a pure overlay from `@hnet/watch` applied:

- **Base:** the rows in `rank` order; `fetchedAt` = their `fetched_at` (the sync run's start, taken before
  its plex.tv read, `packages/sync/src/watch.ts`). With no rows, the last successful watchlist fetch time
  if one is recorded, else now − 24 h.
- **Events:** the account's watchlist marks with `plex_result = 'written'` and `created_at > fetchedAt −
  5 min` (an add or remove at `created_at`), and those with `revert_result = 'written'` and
  `reverted_at > fetchedAt − 5 min` (the inverse at `reverted_at`, never before the change's `created_at`, D-15u),
  applied oldest first (ties by mark id, a change before its own revert). Pending and failed marks never apply.
- **Apply:** an add of a title not present puts a synthetic row (the mark's identity) at the top; a
  remove drops the row with the same identity (plex guid, else tmdb/tvdb/imdb id). Both are set
  operations, so re-applying an event the sync already saw changes nothing, which is why the 5-minute
  margin (covering the gap between a mark's insert and its Plex write) is safe. The one exception: an
  edit in the Plex app that lands inside the margin, after a change of ours, reads wrongly until the next
  sync (at most 15 minutes).

No write-through into `watch_reco_signals`: the sync stays the table's only writer and a sync that
read plex.tv just before a change cannot erase it from the answers.

### D-06 — `@hnet/plex` surface

- Read (`PlexReadClient`): `matchDiscover({ kind, guid })` → `{ ratingKey, guid, kind, title, year,
  ids } | null` via `GET {discover}/library/metadata/matches?type=&guid=`; `getDiscoverUserState(id)`
  → `{ watchlistedAt: number | null }` via `GET {discover}/library/metadata/<id>/userState` (the
  `UserState` may be an object or a one-element array; both seen live). Only an element whose `ratingKey`
  is the asked id, or that names none, counts; a response naming only other titles is no answer (a parse
  error, which the flow treats as unknown), never another title's state (D-15).
- Write (`PlexWriteClient`, import-confined to `packages/domain`, ADR-017): `addToWatchlist(id)`,
  `removeFromWatchlist(id)`; the constructor accepts `plexDiscoverBaseUrl` like the read client. The
  sanctioned write list at the top of `write.ts` gains both.
- Headers stay exactly today's (`X-Plex-Client-Identifier` and `X-Plex-Product` `haynesnetwork`, no
  `X-Plex-Version`; ADR-092 C-08). Both PUTs are sent with the idempotent
  retry policy (D-03 step 6); both GETs with the short revalidation budget.
- The shared `PlexHttp` bounds a whole attempt with its timer, the body included: a response whose body stalls
  after the headers is a timeout at the attempt's bound (a write's 2xx stands), not a wait for undici's 300 s
  body timeout (D-15p). The error a request finally throws carries `mayStillLand` when any of its attempts
  may still be applied by the server: it timed out, lost its connection, or met a 504 (D-15n).

### D-07 — Data

- Migration **0080**: `watch_marks_action_enum` CHECK gains `watchlist_add`, `watchlist_remove`
  (`WATCH_MARK_ACTIONS`). No new table or column.
- **Structural filter:** `selectLiveMarks` (`packages/watch/src/queries/marks.ts`) returns only the watch
  statements (`watched`, `not_interested`, `not_mine`) and types them so, because its readers treat any
  action other than `watched` as a dismissal (`indexMarks` falls through to `notMine`,
  `ledgerExclusions` takes every live mark). So the new actions never reach exclusions, the Taste
  Profile, Unfinished, Ever Watched, `recent_history`, `watch_status`'s dismissal wording, the replay
  rule, or the sync's TMDB seed pick (`pickSeeds`). Watchlist marks are read only by their own queries:
  the overlay (`selectWatchlist`), undo and its replay guard, the remove pool (`selectResolverPool`'s
  `watchlist_recent`, D-03 step 2) and the unsettled check (D-03 step 4).
- `watch_reco_signals` is unchanged; the sync is unchanged.

### D-08 — Voice Budget

The `tools/list` cap becomes **4,096 bytes** (ADR-092 C-09); the pinned byte count in the OAuth e2e test
moves to the new exact size. Estimated about 3.6 KB (two tools about 890 bytes plus about 40 for the
longer descriptions). The 1,200-character result cap and the 500 ms p95 server-side target stay. R-245's
0.5 s voice-turn bound is re-measured live with the hass-sandbox bench (PLAN-071).

### D-09 — Consent copy (ADR-092 C-11)

`SCOPE_DESCRIPTIONS['watch:read']` gains the same two forms as `watch:write` (D-15): the owner's is "See
what you have watched, what is unfinished, and your watchlist", anyone else's stays "See what you have
watched and what is unfinished" (a non-owner's watchlist is not read). `['watch:write'].owner` becomes
"Mark titles watched or dismissed, update Plex to match, and add or remove titles on your Plex watchlist".
The `other` form is unchanged (a non-owner cannot change a watchlist). The Connected apps chips stay. The
tests pinning the copy (`packages/oauth/__tests__/decide.test.ts`, `apps/web/lib/__tests__/oauth-consent.test.ts`
and the connections e2e) move with it.

### D-10 — Logging

`set_watchlist` logs exactly `[mcp] watchlist_changed {consumer, action, kind, result, onPlex}` with
`result` one of `written`, `failed`, `unchanged`, `not_found`, `ambiguous` (also several watchlist titles
under one name, D-15l, and an add's TMDB titles that read the same, D-15w), `not_in_catalog`,
`unconfirmed`, `unknown` (the write's outcome plex.tv never confirmed, D-15), `not_owner`. No title, no
query, no token (DESIGN-049 D-06: arguments and results are never logged).

### D-11 — Stubs and the local stack

`apps/web/e2e/support/stub-plex.ts` keeps the discover watchlist in memory and serves
`/actions/addToWatchlist`, `/actions/removeFromWatchlist`, `/library/metadata/matches` and
`/library/metadata/<id>/userState` against it, routed before the generic metadata route (the discover
URL shares the stub Plex host, as `watchlist/all` already does), so `pnpm dev:local` round-trips an add, a list and an
undo. The seeded watchlist keeps its current items.

### D-12 — Home Assistant and the other consumers

HA re-reads `tools/list` on every call, so the Movie Room agent sees the tools after the deploy with no
HA change. hass-sandbox's WATCH HISTORY prompt block gains one line (use `watchlist` / `set_watchlist`
for the Plex watchlist; adding a title not on Plex downloads it) through its own short PR, and the
attach helper's byte-identical copy with it. ChatGPT needs nothing. dev-env does (corrected by D-15):
its GitOps-managed `CLAUDE.md` lists the `haynesnetwork` MCP tools by name, so it gains `watchlist` and
`set_watchlist` plus a warning never to test `set_watchlist` with a title that is not on Plex (Seerr
downloads it). That change is the held-draft haynes-ops PR
[#3192](https://github.com/thaynes43/haynes-ops/pull/3192): merging it restarts the dev-env pod, so the
owner merges it at a natural break.

### D-13 — Rulings from the design review (PR #577, 2026-09-25)

An Opus review of this design against the code found one blocker and nine should-fix items, all ruled
and folded in above: the add's TMDB ambiguity (D-03 step 2, ADR-092 C-07); the structural mark filter
(D-07); failed watchlist marks are undone as `none`, not skipped (D-04); idempotent PUT retries plus a
final `userState` check (D-03 step 6); the undo replay guard (D-04); the guid/match agreement and the
read-back source (D-03 step 3); the Seerr line's "on Plex" premise (ADR-092 C-03: HaynesOps mirrors
HaynesTower, partial shows are a known imprecision); logging without titles (D-10); the blast radius
(ADR-092 C-12); and the doc contradictions (C-01, R-253, AC-29, AC-30). Nits folded in: the empty-list
fetch time and tie-break (D-05), the remove pool's retry window (D-03 step 2), `title_key` and the stored
plex.tv title (D-03 step 5), the byte estimate (D-08), the read budget (D-03), stub routing (D-11), the
supersession notes, and the consent copy (D-09). An old pod treating a new watchlist mark as `not_mine`
during the rolling deploy is accepted (minutes, and only if the owner changes his watchlist mid-rollout).

### D-14 — Rulings made while building (PLAN-071 S2, 2026-09-25)

| ID | Ruling |
|---|---|
| D-14a | **Latency** (as amended by D-15). The two GETs before the write use the 300 ms revalidation budget (3 × 300 ms at worst); the PUT keeps the 800 ms mark-write budget with the idempotent retries (3 × 800 ms + 2 × 100 ms = 2.6 s at worst), then one `userState` re-read, on the same write budget since D-15 (2.6 s at worst). Normal calls take about 3 × 80 ms; if plex.tv stalls on every attempt the worst case is about 6.1 s (7.0 s when the discover id needs a catalog lookup, 8.5 s when the title also needs the add's TMDB fallback, now a single 1.5 s attempt), inside the 9 s MCP deadline and Home Assistant's 10 s. An undo's worst case is the inverse PUT and its re-read, about 5.2 s. These bounds hold when plex.tv or TMDB stalls after sending the headers too, since each attempt's timer covers its body (D-15p). A shorter PUT budget was rejected: a false "didn't change" is worse than a slow answer. |
| D-14b | **One catalog lookup.** `matchDiscover` is called once, with the first external id the title has (tmdb, then tvdb for shows, then imdb), not a fallback chain. |
| D-14c | **Wording.** Ambiguous and not-found answers reuse the existing phrasing ("More than one match for …", "I couldn't find anything called X."); a remove that finds nothing says "I couldn't find X on your watchlist."; later pages start "Numbers 6 to 10:"; counts up to twenty are words. |
| D-14d | **Logging.** `unconfirmed` is the D-10 result for a guid/catalog disagreement; `failed` is also logged when plex.tv is unreachable before the change could be sent (since D-15 that change is recorded too, as not sent). |
| D-14e | **Empty watchlist.** No fetch time is recorded for an empty list (the sync writes no rows and `watch_accounts.resolved_at` is stamped before the read), so D-05's now − 24 h fallback stands. |
| D-14f | **Same title** on the watchlist is decided by plex guid or tmdb/tvdb/imdb id, and by name and year only when one side has no id. A title known only through the watchlist leaves the resolver pool once removed, so `watch_status` then finds it through TMDB. |
| D-14g | **A Taster reads "started"** in the watchlist answer (a show tried and left is not "watched"). |
| D-14h | **Migration 0080**, not 0079: the Haynes Quest portal card (PR #578) took 0079 first. |

### D-15 — Rulings from the PR #580 code review (2026-09-25)

An Opus review of the S2 build found two blockers and a set of should-fix items; the owner-facing
behavior ones are ruled here and folded into D-02..D-12 and D-14 above. A second pass over the fixed branch
(findings C1..C7, each verified by independent skeptics) added D-15i and D-15j, a third (findings E1..E6,
verified the same way) D-15k..D-15p, a fourth (findings F1..F10, verified the same way) D-15q..D-15s, and a
fifth (findings G1..G9, verified the same way) D-15t..D-15w. Code comments cite these IDs (and D-13 for the
design review's rulings), never a ruling number.

| ID | Review | Ruling |
|---|---|---|
| D-15a | A1 | **A change that could not be sent is still a Watch Mark.** When the title resolved but the catalog lookup failed (either path of D-03 step 3) or no Plex client is configured, a `watchlist_add` / `watchlist_remove` row is inserted `failed`, with no plex guid and a `plex_error` starting `not sent:`. Before, nothing was recorded, so "undo that" after the failure reverted the previous, unrelated change (for an older remove: a re-add that can download). Its undo makes no call and says the change never reached Plex. |
| D-15b | A2 | **Unknown outcomes are said, and undo is shaped by what a call can do.** The re-read after a failed PUT goes out on the write budget, not the 300 ms one (a slow plex.tv answers the re-read too late on the short budget, turning a landed write into a false "didn't change"). If it still gets no answer, the mark is `failed` with an `unknown:` error, the D-10 result is `unknown`, and the answer is "Plex didn't answer in time, so I can't tell whether X changed." Undo of any failed `watchlist_add` that went out sends `removeFromWatchlist` anyway (idempotent; a removal never downloads) and answers from that call; undo of a failed `watchlist_remove` makes no call (its inverse is an add, which could download) and says the change never confirmed with Plex, so the watchlist was left as it is. A failed add of the last 10 minutes joins the remove pool (D-03 step 2) so a remove finds it and plex.tv's live state decides (widened by D-15q to every failed or pending add the cache cannot have seen). An undo whose inverse call cannot be confirmed uses the same unknown-outcome words. |
| D-15c | A4 | **Undos of one account are serialized.** `undoLastChange` runs in a transaction that first takes `pg_advisory_xact_lock(hashtext('watch_undo'), hashtext(<plex account id>))`, so the replay guard, the pick, the Plex call and the revert happen one undo at a time across replicas; a second copy of a retried undo waits, then sees the first one's revert and repeats its answer. The review's suggested variant (a conditional final UPDATE that re-runs the guard when another mark was reverted meanwhile) was not taken: the losing undo would already have sent its Plex call for the next-older mark, which for a watchlist remove is an add that can download. The lock stops it before any call. Costs: the transaction holds one database connection while the undo's Plex calls run (for a Watchlist Change about 5.2 s at worst, D-14a), and a crash mid-undo rolls the revert record back, so the next undo retries the same mark, whose inverse call is idempotent. |
| D-15d | A5 | **Accepted:** a call that changed nothing writes no row (a replayed `mark_watched`, D-14 step 7 of DESIGN-049; an "already on" `set_watchlist`), so inside the 30 seconds after an undo it does not reset the guard, and the next undo repeats the last answer instead of reverting an older mark. Nothing changed, so there is nothing new to undo; after 30 seconds undo works as usual. |
| D-15e | A6 | **One name, several watchlist titles, asks** (the answer is no longer a question since D-15l). When the resolved same-name group holds watchlist entries with different discover ids (two titles plex.tv lists under one name and year), `set_watchlist` answers ambiguous with those titles and writes nothing, checked before anything else (no row, no Plex call, even with no Plex client). Before, the first one was changed silently. |
| D-15f | B8 | **Paging never skips a title.** `formatWatchlist` fits the items to the 1,200-character cap first, then builds the range ("Numbers A to B:", or "Newest first, numbers 1 to B:" on a first page the cap cut short) and "And N more." from the items it kept. Before, the range named the requested page and the cap dropped titles silently, so an agent paging on by `offset` skipped them. |
| D-15g | B9 | **The add's TMDB fallback makes one attempt** (a TMDB client with no GET retries, `tmdbOnce`), so the worst case of an add that needs it (8.5 s, D-14a) stays inside the 9 s MCP deadline. With the three attempts the other tools keep, it was about 11.5 s (three 1.5 s attempts; corrected from 9.8 s in the second pass). |
| D-15h | B10 | **Consent names the watchlist only to the owner.** `watch:read` has an owner form and an other form like `watch:write` (D-09): a household member's connector does not read a watchlist, so its consent line does not offer one. |
| D-15i | C1 | **The undo replay guard trusts a revert stamped after its own clock.** An undo reads its clock (`now`) before it waits on the advisory lock (D-15c). Of two copies of one undo, the one that read its clock a few ms later, or on a replica whose clock runs ahead, can take the lock first and stamp its revert after the waiting copy's `now`. The guard rejected that stamp as "from the future", so the waiting copy went on to the next-older change: for a watchlist remove, a re-add that can download. The guard's only bound is now the age, `now − reverted_at < 30 s`, with a negative age counted as recent. Cost, accepted like D-15d: within the clock skew between replicas (milliseconds), a mark made on a replica whose clock lags that stamp is not seen as "made since", so an undo until 30 seconds after the stamp repeats the last answer instead of reverting it (nothing is written; saying undo again after that works as usual). Reading the guard's clock after the lock was not added: across replicas it still depends on their clocks, and the age rule alone covers both cases. |
| D-15j | C4 | **An add that may download says so even when its own answer is lost.** When Home Assistant's trailing `tools/list` fails after a landed add (DESIGN-049 D-05), the model retries and the owner hears only the retry's answer, "already on"; an add plex.tv never confirmed may have landed too. So, for a title not on Plex (the D-02 rule): an "already on" add adds "It isn't on Plex yet, so Seerr will request it if it hasn't already." ("if it hasn't already" because a title put on the watchlist long ago has likely been requested); an unconfirmed add adds "It isn't on Plex yet, so if it was added, Seerr will request it."; an unconfirmed undo of a remove (its inverse call is an add) adds "It isn't on Plex yet, so if it was put back, Seerr will request it." Removals and titles on Plex answer as before. The `unchanged` and `unknown` views carry `onPlex` (and `unknown` the action) for this. |
| D-15k | E1 | **When plex.tv cannot be read, an unsettled change is not the cache's to decide.** D-15b put a failed add in the remove pool so plex.tv's live state decides, but when the userState read failed too (a slow plex.tv, on the 300 ms budget, right after the write budget's attempts timed out), the overlaid cache decided, and it can never show a change that is not `written`: "remove it" after an add plex.tv never confirmed answered "isn't on your watchlist", wrote nothing, and the title stayed on the list for Seerr to download; the mirror case, an add after an unconfirmed remove, answered a false "already on". Now, with the live state unreadable, a title whose latest Watchlist Change since the cache's fetch (less the D-05 margin) is `pending` or `failed` with `unknown:`, and not cleared by a written undo, gets the (idempotent) write, answered from that call. A remove sent that way over an unsettled **add** is `written` with `plex_error` `after unsettled: mark <id>`, and its undo makes no call (nothing ever showed the title on the list, and the inverse add could download it) and says so, pointing the owner to a deliberate add. The review's alternative of recording that remove `failed` (so D-04 leaves it as it is) was not taken: the overlay would then not show a removal that happened, and its undo would say it "never confirmed with Plex" right after "Removed". Once a sync has read plex.tv after the change, the cache decides again. |
| D-15l | E2 | **Several watchlist titles under one name are never a question.** D-15e's check fires only for watchlist entries the resolver put in one group, which share a name, year and kind (or are linked by an id), so its "More than one match for dark matter: Dark Matter (2024, show), Dark Matter (2024, show). Which one?" listed identical options, and no `set_watchlist` argument could pick one (a year only scores, it never splits a group; `kind` is the same): every retry asked again. Now `changeWatchlist` returns its own `duplicate` status (logged `ambiguous`, D-10), answered "Your watchlist has more than one X, and I can't tell them apart, so I left it as it is. You can change it in the Plex app." (D-02), naming the titles when they read differently. |
| D-15m | E3 | **A failed clear is not "still on".** A failed add's undo sends the removal anyway (D-15b); when that removal fails too, the answer said "I couldn't reach Plex, so X is still on your watchlist", after the add had been answered "your watchlist didn't change". Now it is `clear_failed`: "I couldn't reach Plex, so I couldn't make sure X is off your watchlist. Say undo again to retry." "Still on" and "still off" stay for the inverse of a change that was written. |
| D-15n | E4 | **A write that may still land is never "didn't change".** After a timed-out PUT, plex.tv may still apply the aborted attempt after the re-read (verified with a fake that applies it 2.7 s after the first attempt: the re-read saw the old state, and the write landed 0.4 s later), so the old state on the re-read proves nothing. D-03 step 6 now reads "the other state ⇒ `failed`" only when plex.tv answered every attempt (a 5xx other than 504); after a timeout, a dropped connection or a 504 on any attempt (`PlexError.mayStillLand`, set by `PlexHttp` across the retries, so an earlier timeout counts even when the last attempt got a 503 or a 429) the outcome is unknown, answered with the unknown-outcome words and, for an add not on Plex, the Seerr sentence. Undo uses the same rule. Connection-refused errors count as "may still land" too (which side of sending they failed on is not known); the cost is an honest "can't tell" where "didn't change" was true. |
| D-15o | E5 | **Undo never walks past a pending Watchlist Change.** DESIGN-049 D-15 never picks a `pending` mark, which for a Watchlist Change whose finalize never ran (its replica died mid-call, the finalize UPDATE failed, or a stalled body held it) made "undo that" revert the older change instead (for an older remove: a re-add that can download), and the row could never be picked later. A pending Watchlist Change is now picked (its row carries its plan: guid and action). Under 60 seconds old (the change's own work is bounded at about 5.2 s, D-15p) it answers that Plex is still working on it and reverts nothing; older, it is closed `failed` with `unknown: never finalized` and undone like an unconfirmed change. The change's own finalize only updates a row still `pending`, so it never overwrites that close. Taking the undo lock inside `changeWatchlist` was not done: the pending row must commit before the PUT, or a crash would leave no record at all (D-15a). |
| D-15p | E6 | **Each attempt's timer covers the body.** `PlexHttp` cleared its timer once the headers arrived, so a response whose body then stalled (a half-open connection) held the watchlist PUT, the userState and match reads for undici's 300 s body timeout: a mark stayed `pending` for minutes, an undo held its advisory lock and a pooled connection, and a stalled read let a change's PUT go out minutes after its caller was answered. The timer now runs until the body has been read (a write's 2xx stands if only its body stalls; a read's stalled body is a timeout, retried like one). The MCP's TMDB searches opt into the same bound on the shared `ArrHttp` (`timeoutCoversBody`); the other `ArrHttp` callers keep today's behaviour (the syncs read list bodies that may stream past their per-attempt timeout), parked in `.agents/plans/TODO.md` with the other HTTP wrappers. An undo also waits for the lock at most 9 s (`lock_timeout`, the MCP deadline), so a stuck holder cannot queue the rest. |
| D-15q | F1, F4, F5 | **A remove finds every add the cache cannot have seen.** The remove pool (D-03 step 2) held only `failed` adds of the last 10 minutes. An add left `pending` after its PUT landed (its replica died before the finalize, D-15o), or an unconfirmed add older than 10 minutes that the cache was read just before, answered "I couldn't find X on your watchlist." with no Plex call while plex.tv listed it for Seerr to request. The pool now takes adds that are `failed` or `pending`, made since the cache's fetch less the D-05 margin or in the last 10 minutes, whichever reaches further back; plex.tv's live state then decides (unreadable, D-15k's check, which treats `pending` as unsettled). Cost, accepted: while nothing is cached (the now − 24 h fallback of D-05), a failed add of the last day is in the pool, so a remove of it costs one userState read and answers "isn't on" instead of "couldn't find". |
| D-15r | F2, F4 | **An undo plex.tv never confirmed leaves its title unsettled.** The undo of a written change whose inverse call fails records only `revert_result = 'failed'` (the change stays live), and the overlay ignores a failed undo, so the cache still shows the original change. With userState unreadable, "remove X" after an unconfirmed undo of a remove answered "isn't on your watchlist" (the undo's add may have landed, and Seerr requests it), and "add X" after an unconfirmed undo of an add a false "already on". Now a failed undo is an unsettled call, since the row cannot tell a definitive failure from an unknown one and the asked write is idempotent. That holds for a change the cache has read too, since an undo can run up to a day after its change: the check looks back one undo window before the cache's fetch. The remove pool also holds a written remove whose undo failed, within the undo window, so a remove finds its title after the 10-minute replay window too. A remove sent over such an undo is not `after unsettled:` (the undo put back a title the owner had), so its own undo puts the title back. Cost, accepted: when that undo's call failed outright (nothing landed), a later change of the title while userState is unreadable sends its idempotent write instead of the cache's "isn't on" / "already on", until a later written change settles it or the change leaves the undo window. |
| D-15s | F3 | **The unsettled check reads the title's whole run, not only its newest change.** D-15k looked at the latest Watchlist Change alone. A remove plex.tv never confirmed, sitting between an unsettled add and the remove that finally landed, dropped the `after unsettled:` marker, so undo re-added (and Seerr requested) a title nothing ever showed on the list. Likewise, a change that failed outright (a 429) hid an older unsettled add, so the next remove answered "isn't on" from the cache. Now the title's changes are walked newest first. A change that failed outright changed nothing and is walked past. The walk ends at the newest change still live (no undo closed it) whose own call was written or that the cache has read: undo reaches an older change only once every newer one is closed, so nothing older ran after it. A written call (a change or an undo) supersedes the older changes' own calls, but not an older change's failed undo, which may have run after it. The marker names any unsettled add in the run. |
| D-15t | G1 | **Undo never walks past a pending `watched` mark.** D-15o stopped undo from walking past a pending Watchlist Change, but the pick still skipped a pending `watched` mark (DESIGN-049 D-15's PR #563 ruling), and since ADR-092 the next-older mark can be a watchlist remove, whose undo re-adds a title nobody asked for and Seerr requests it. A `watched` mark stays pending while its scrobbles run (a large mark can run past the 9 s MCP deadline, so its caller hears an error while it keeps going) and for good when its replica dies or its write-through or finalize fails. The pick now takes the newest unreverted mark of the window whatever its `plex_result`. A pending `watched` mark under ten minutes old answers "Plex is still working on your last change, marking X as watched. Say undo again in a moment." and reverts nothing, the older change neither. Older (its work is its reads and at most six scrobbles at once, each attempt bounded at about 0.8 s with two retries, D-15p, so minutes only for hundreds of episode keys), it is closed `failed` with `unknown: never finalized` and undone by unscrobbling its planned keys: every one was unwatched before the mark, and unscrobble is idempotent, so the state before the mark comes back whether or not each scrobble landed. `markWatched`'s finalize now updates only a row still `pending`, and writes the Title State through only then, so a late finalize never overwrites the close. Costs, accepted: a mark still running after ten minutes that an undo closes can land a scrobble after its unscrobble, leaving that episode watched while the mark reads undone (the next sync re-reads Plex); and an abandoned mark keeps undo from reaching older changes for up to ten minutes, answered as in progress. Amends DESIGN-049 D-15's "undo never picks a `pending` mark". |
| D-15u | G2 | **A revert is never stamped before its change.** An undo reads its clock before it waits on the advisory lock (up to 9 s, D-15p), and `changeWatchlist` never takes that lock, so the undo can pick a change another consumer made while it waited and stamp `reverted_at` earlier than that change's `created_at`. The overlay (D-05) then applied the revert before the change, so the title read as off the list while plex.tv had it back (and a remove of it answered "couldn't find"), and the replay guard counted the reverted change as a mark made since its own undo, so a retried copy of the undo went on to the next-older change (for a watchlist remove, a re-add that can download: the cascade D-15c and D-15i exist to stop). Both undo branches now stamp `max(now, created_at)`: the change and its revert tie on time and sort change first (same mark id), and the guard's strict `created_at > reverted_at` no longer counts the reverted mark itself. The overlay also applies a revert no earlier than its change's `created_at`, for rows stamped before this ruling. |
| D-15v | G3 | **A named year settles an add's TMDB ambiguity, in parentheses too.** `normalizeTitle` takes a parenthesized year out of the title ("Shōgun (2024)" is `shogun`, year 2024), so every same-name TMDB hit scored an exact 1 and the year was never weighed: "Shōgun (2024)", the agent's natural retry in the answer's own format, got the same question again on every retry, and only the bare "shogun 2024" resolved. The TMDB fallback now keeps only the hits of the named year whenever one has it; when none does (the query "Blade Runner 2049" and its 2017 film), the year belonged to the title and nothing is filtered. This holds in D-13's first-hit mode too, so `mark_watched` and `watch_status` no longer take TMDB's first hit when the owner named another year. The pool path already weighed the year (D-13's year bonus). |
| D-15w | G4 | **TMDB titles that read the same are never a question.** TMDB can list different titles under one name, year and kind (two 2020 movies called "Alone"), and the add's ambiguity (ADR-092 C-07) listed them as "Alone (2020, movie), Alone (2020, movie). Which one?", which no `set_watchlist` argument can answer: D-15l's problem, on the TMDB path, and more likely once D-15v honours the year. Now the question lists each title that reads differently once, and when every hit reads the same the resolver returns `indistinct` and `changeWatchlist` its own `indistinct` status (logged `ambiguous`, D-10), answered "I found more than one Alone (2020 movie) and can't tell them apart, so I left your watchlist as it is. You can add it in the Plex app." (D-02), with no row and no Plex call. `resolveWatchTitle` is typed so that only the `'ask'` mode can return it. |

Fixed with no design change in the fifth pass: PLAN-071 S5 now expects "I couldn't find X on your watchlist." for a
remove of a title that is not on the watchlist (it expected "isn't on", the answer for a title the remove pool still
finds, such as a retried remove) and walks the retried remove as well (G5); the parked `.agents/plans/TODO.md` entry on header-only timers no longer lists
`packages/sync/src/openwebui.ts` (its body is read under the timer), says `PlexHttp`'s list reads are paged and
already body-bounded, and points the `AbortSignal` item at `runTool` in `server.ts` (G6); the code comments that cited
"PLAN-071 ruling N" or "PR #580 ruling N", a numbering no doc defined whose numbers the two sets reused, cite the
DESIGN-051 IDs instead (G7); the `@hnet/mcp` header names nine tools and its README lists `deps.test.ts` (G8); and
the `@hnet/arr` README documents `getRetries` and `timeoutCoversBody` (G9).

Fixed with no design change in the fourth pass: the PRD's AC-23, R-244 and the connector intro now carry the
ADR-092 amendment (nine tools, 4,096 bytes; review F6); DDD-002 BC-06's Outbound list names the watchlist writes
(F7); DESIGN-050 D-14 points to D-09 for the owner's consent lines (F8); the comments that said only the overlay
and undo read watchlist marks, or that undo skips a failed Watchlist Change, list the real readers and follow
D-04 (F9); and the HANDOFF entry for PLAN-071 is current (F10). F1 and F5 were one defect (D-15q).

Fixed with no design change in the second pass: a test proves `set_watchlist` resolves through the
single-attempt TMDB client and every other tool through the retrying one, and that `defaultDeps` builds them that
way (D-15g, review C5); the web e2e asserts the exact nine tools a member's connector lists (review C3); OPS-003
and OPS-015 give the nine-tool `tools/list` size, and OPS-003 walks a watchlist add, list and undo (review C6).
C1, C2 and C7 were one defect (D-15i).

Fixed with no design change: the discover `userState` read accepts only the asked title's element (D-06,
review A3); the tests (a typed Taster fixture with `onPlexFor`, row counts asserted wherever a row is
destructured, the OAuth owner path through `watchlist` and `set_watchlist`, the two new tools in the "not
ready" loops, distinct fakes for the short and the write budget in the watchlist e2e, en dashes rejected
beside em dashes); and the `@hnet/watch` README ("started" includes a Taster).

## Alternatives considered

- One `watchlist` tool with an `action` (ADR-092 option 4): one scope per tool is how the filter works
  today; a read-only connector token would lose the list.
- Write-through into `watch_reco_signals`: a second writer of a table the sync replaces wholesale
  every 15 minutes, with a race on every change; the overlay (D-05) has none.
- Answering `watch_status` from a live `userState` call: one more network call per voice turn for what
  the cache plus overlay already knows.
- Resolving titles not in the pool through plex.tv's discover search instead of TMDB: the search gives
  no external ids and fuzzy scores; the existing TMDB exact-match fallback plus the external-id match
  is stricter, which matters when an add can download (ADR-092 C-07).

## Test strategy

- `@hnet/watch` (unit): the overlay (add, remove, revert, an event the base already reflects, the
  5-minute margin, no base rows, a revert stamped before its change, D-15u); the in-progress undo of a `watched`
  mark and the indistinct TMDB answer (D-15t, D-15w); the watchlist formatter (entries, kind, started/watched, empty, past
  the end, cap); the new `watch_status` availability sentence (four cases).
- `@hnet/plex` (fixtures): `matchDiscover` (type param, empty result, `Video` vs `Metadata`),
  `getDiscoverUserState` (object and array forms, absent `watchlistedAt`), the two writes (2xx, 404,
  timeout; the id check rejects a non-hex id before any request); against a real local server whose body
  stalls after the headers, a write's 2xx stands and a read times out at the attempt bound, and
  `mayStillLand` across retries (D-15n, D-15p).
- `@hnet/domain` (embedded Postgres, recording fake Plex): add on Plex, add not on Plex (Seerr line),
  remove, already-on and already-off (no row, no write), ambiguous (pool and two exact TMDB hits),
  remove of a title not on the watchlist, a retried remove, no catalog match, a guid/match mismatch, a
  timed-out PUT that landed (`written`) and one that did not (`failed`), an outcome plex.tv never
  confirms (`unknown:`, re-read on the write budget), a repeated and an unconfirmed add of a title not on
  Plex (the Seerr sentence, D-15j), a change that could not be sent (still recorded),
  two watchlist titles of one name (no question, D-15l), non-owner (no row, no call); with userState unreadable,
  a remove after an unconfirmed add and an add after an unconfirmed remove (the write goes out, D-15k; the cache
  decides again once a sync has read plex.tv), a timed-out PUT the re-read cannot settle (unknown, D-15n);
  a remove after an add left pending once its PUT landed, and after an unconfirmed add more than 10 minutes
  old that the cache read just before (both found and sent, D-15q; a failed add the cache has read since
  leaves the pool); a remove and an add after an undo plex.tv never confirmed, also once the cache has read
  the change (sent, D-15r); an unconfirmed remove between an unsettled add and the remove that lands, and a
  refused remove after an unsettled add (the marker kept, the removal sent, D-15s), and the run walk itself;
  undo of an add, of a remove,
  of a change never sent (`none`, no call, the older change untouched), of a failed add (the removal sent
  anyway) and of a failed remove (no call), an unconfirmed undo of a remove (the Seerr sentence), the
  30-second undo replay guard, two undos at once (also when the copy that takes the lock read its clock
  later, D-15i), a failed clear (D-15m), a remove over an unsettled add (no re-add, D-15k), a pending change
  (in progress, then closed and undone, D-15o), the undo lock's bound (D-15p), a pending `watched` mark after an
  older watchlist remove (in progress, no re-add; ten minutes on, closed and its planned keys unscrobbled, its own
  late finalize leaving the row alone, D-15t), an undo whose clock reads before the change it picks (stamped at the
  change, a retry replayed, D-15u), a year in parentheses settling an add's TMDB ambiguity and the first-hit mode
  (D-15v), TMDB titles that read the same (no question, no row, no call, D-15w), and the new actions never
  reaching exclusions, the Taste Profile, Unfinished, recent history or the seed pick; the migration's CHECK.
- `@hnet/mcp` e2e: `tools/list` ≤ 4,096 bytes and the pinned exact size, nine tools, scope filtering
  (a `watch:read`-only token sees `watchlist` but not `set_watchlist`), each new tool's happy path and
  1,200-character cap (and paging past it), the non-owner connector answers, the owner's connector
  attributing a change to `oauth:<client_id>` and its user, "not ready" before the first sync, which
  bundle each watchlist call used (the short and write budgets are different fakes), a repeated and an
  unconfirmed add (D-15j), which TMDB client each tool used (D-15g, plus a `defaultDeps` unit test, which
  also proves its timer covers the body, D-15p), two watchlist titles under one name (D-15l), and an add's TMDB
  fallback settled by a year in parentheses and answering titles that read the same without a question (D-15v,
  D-15w).
- `apps/web` stack: a Playwright-free `dev:local` smoke via the stub (D-11) is enough; no UI changes.
- Live (PLAN-071): the hop checks, one add/undo on a title already on Plex, the voice bench.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Should a household member's connector see their own watchlist? | Deferred with PLAN-070: it needs each person's plex.tv token (research note §5 item 5); until then D-02's non-owner answer. |
| Q-02 | Should `recommend` weight the owner's Plex star ratings (`userState.userRating`)? | Open follow-up (research note §5 item 3); not part of this design. |
