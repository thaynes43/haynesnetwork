# DESIGN-051: Plex watchlist tools — `watchlist`, `set_watchlist`, "on your watchlist" in `watch_status`, and undoable watchlist changes

- **Status:** Draft
- **Last updated:** 2026-09-25
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
           6 finalize written | failed; answer with the title, year, and the Seerr line
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

### D-02 — Spoken answers (no markdown, no URLs, no em-dashes; ≤ 1,200 characters)

- `watchlist`: *"Your watchlist has 150 titles. Newest first: Slow Horses, a 2022 show, on Plex,
  started. The Toxic Avenger, a 2023 movie, not on Plex yet. … And 145 more."* With `kind`: "Your
  watchlist has 61 shows. …". Each entry: title, year, kind, `on Plex` or `not on Plex yet`, then
  `started` when the Title State is in progress or stalled, `watched` when it is Ever Watched and not
  unfinished. Empty: "Your watchlist is empty." Past the end: "That's the end of your watchlist." The
  "on Plex" rule is `recommend`'s (DESIGN-049 D-17: a ledger item with the same external id and a
  `media_plex_matches` row, or a Title State with `on_plex`).
- `set_watchlist` add: *"Added The Matrix (1999 movie) to your watchlist. It's on Plex."* / *"Added
  Dune: Part Three (2026 movie) to your watchlist. It isn't on Plex yet, so Seerr will request it."*
  Remove: *"Removed The Matrix (1999 movie) from your watchlist."* No change: *"The Matrix (1999 movie)
  is already on your watchlist."* / *"… isn't on your watchlist."* The title and year said back are
  plex.tv's (the discover match), so the agent can verify the change.
- Ambiguous: *"Did you mean Dune (2021 movie) or Dune (2000 show)?"* (D-13's candidate list). Not found
  (for a remove, not found **on the watchlist**): *"I couldn't find X on your watchlist."* / *"I couldn't
  find X."* A title with no discover match: *"I found X (year) but not in Plex's catalog, so your
  watchlist didn't change."* Plex failure: *"I couldn't reach Plex, so your watchlist didn't change."*
- `watch_status` ends with one availability sentence instead of today's "On Plex." / "Not on Plex.":
  "On Plex and on your watchlist." · "On Plex, not on your watchlist." · "Not on Plex, but on your
  watchlist." · "Not on Plex or your watchlist." Explicit both ways, so an agent never has to infer.
- A principal that is not the Server Owner (ADR-091 C-04): `watchlist` and `set_watchlist` answer
  *"Your Plex watchlist isn't set up for your account yet."*; `watch_status` keeps today's sentence.

### D-03 — `set_watchlist` flow (`@hnet/domain` `changeWatchlist`, beside the mark writers)

1. **Principal.** `assertTrackedWatchAccount`; a role other than `owner` returns the D-02 non-owner
   answer, with no row and no Plex call.
2. **Resolve** (DESIGN-049 D-13, unchanged scoring). `add`: the normal pool, then the one TMDB
   `search/multi` fallback. `remove`: the pool is **only the overlaid watchlist** (D-05), so "remove
   Dune" can only pick a title that is on it, and no TMDB fallback. `kind` filters as for marks.
   Ambiguous and not-found never write.
3. **Discover id.** If the resolved identity has a `plex_guid` of the form
   `plex://{movie|show}/<24 hex>` whose type is the kind, the id is the suffix (verified live: the
   suffix equals the discover `ratingKey`). Otherwise `matchDiscover` with the kind's `type` (movie 1,
   show 2) and the first of `tmdb://`, `tvdb://` (shows), `imdb://` that the identity has; the match
   must be of the same type. No id → the D-02 not-in-catalog answer. The discover match's title and
   year are what the answer says back (step 3 always runs `matchDiscover` for the read-back when the
   guid path skipped it and the title has an external id; a failed read-back falls back to the
   resolved title).
4. **Live state.** `getDiscoverUserState(id)`: on the watchlist ⇔ `watchlistedAt` present. If the
   wanted state already holds, answer "already on" / "isn't on" with **no row and no write**; so a
   retried call (HA's trailing `tools/list` failure, DESIGN-049 D-05) is a truthful no-op and never
   becomes the "last change". If the userState read fails, the overlaid cache decides instead.
5. **Row.** Insert a Watch Mark: `action` `watchlist_add` | `watchlist_remove`, `scope` = the kind
   (`movie` | `show`), the resolved identity with `plex_guid = plex://<kind>/<id>`, `query`,
   `consumer`, `actor_user_id`, `flipped = []`, `plex_result = 'pending'`.
6. **Write.** `PUT {discover}/actions/addToWatchlist|removeFromWatchlist?ratingKey=<id>` with the owner
   token (HaynesOps, else HaynesTower, the sync's order). Any 2xx is success (the provider answers 200
   whether or not anything changed); a 404 is "not in Plex's catalog"; anything else, or a timeout, is a
   failure. Finalize `written` or `failed` (`plex_error` trimmed, never the token).
7. **Answer** per D-02. For an add, "on Plex" uses the D-02 rule; when not on Plex the answer adds the
   Seerr sentence (ADR-092 C-03).

Budget: three sequential plex.tv calls, about 250 ms measured; the DESIGN-049 per-attempt write
timeout and the 3 s end-to-end budget apply. The discover id is validated against `^[0-9a-f]{24}$`
before it is put in any URL.

### D-04 — Undo

`undo_last_change` picks the newest unreverted mark of the last 24 hours as today, now including
watchlist marks, **except** a watchlist mark whose `plex_result` is `failed` (it changed nothing). It
applies the inverse call (`removeFromWatchlist` for an add, `addToWatchlist` for a remove) and records
`revert_result` `written` | `failed`. Answers: *"Removed The Matrix (1999 movie) from your watchlist
again."* / *"Put The Matrix (1999 movie) back on your watchlist."* When the title is not on Plex, undoing
an add adds "Seerr may already have requested it." and undoing a remove adds "Seerr will request it."
The inverse is idempotent, so it is applied even if the owner changed the watchlist in the Plex app
meanwhile.

### D-05 — The watchlist overlay (read time, pure)

Every watchlist read (the `watchlist` tool, `watch_status`, the resolver pool, `recommend`'s
candidates) goes through one query, `selectWatchlist(db, plexAccountId)`, which returns the account's
`source = 'watchlist'` rows with a pure overlay from `@hnet/watch` applied:

- **Base:** the rows in `rank` order; `fetchedAt` = their `fetched_at` (the sync run's start, taken before
  its plex.tv read). With no rows, `fetchedAt` = now − 24 h.
- **Events:** the account's watchlist marks with `plex_result = 'written'` and `created_at > fetchedAt −
  5 min` (an add or remove at `created_at`), and those with `revert_result = 'written'` and
  `reverted_at > fetchedAt − 5 min` (the inverse at `reverted_at`), applied oldest first.
- **Apply:** an add of a title not present puts a synthetic row (the mark's identity) at the top; a
  remove drops the row with the same identity (plex guid, else tmdb/tvdb/imdb id). Both are set
  operations, so re-applying an event the sync already saw changes nothing, which is why the 5-minute
  margin (covering the gap between a mark's insert and its Plex write) is safe.

No write-through into `watch_reco_signals`: the sync stays the table's only writer and a sync that
read plex.tv just before a change cannot erase it from the answers.

### D-06 — `@hnet/plex` surface

- Read (`PlexReadClient`): `matchDiscover({ kind, guid })` → `{ ratingKey, guid, kind, title, year,
  ids } | null` via `GET {discover}/library/metadata/matches?type=&guid=`; `getDiscoverUserState(id)`
  → `{ watchlistedAt: number | null }` via `GET {discover}/library/metadata/<id>/userState` (the
  `UserState` may be an object or a one-element array; both seen live).
- Write (`PlexWriteClient`, import-confined to `packages/domain`, ADR-017): `addToWatchlist(id)`,
  `removeFromWatchlist(id)`; the constructor accepts `plexDiscoverBaseUrl` like the read client. The
  sanctioned write list at the top of `write.ts` gains both.
- Headers stay exactly today's (`X-Plex-Client-Identifier` and `X-Plex-Product` `haynesnetwork`, no
  `X-Plex-Version`; ADR-092 C-08). No retries on a write beyond the existing client policy.

### D-07 — Data

- Migration **0079**: `watch_marks_action_enum` CHECK gains `watchlist_add`, `watchlist_remove`
  (`WATCH_MARK_ACTIONS`). No new table or column.
- Every reader of `watch_marks.action` is audited so the new actions are ignored where they mean
  nothing: exclusions and the Taste Profile (DESIGN-049 D-16, D-18), the `dismissed` flag of
  `watch_status`, the replay rule (D-14 step 7), Unfinished. Only the overlay and undo read them.
- `watch_reco_signals` is unchanged; the sync is unchanged.

### D-08 — Voice Budget

The `tools/list` cap becomes **4,096 bytes** (ADR-092 C-09); the pinned byte count in the OAuth e2e test
moves to the new exact size. Estimated about 3.5 KB (two tools about 760 bytes plus the longer
descriptions). The 1,200-character result cap and the 500 ms p95 server-side target stay. R-245's
0.5 s voice-turn bound is re-measured live with the hass-sandbox bench (PLAN-071).

### D-09 — Consent copy (ADR-092 C-11)

`SCOPE_DESCRIPTIONS['watch:write'].owner` becomes "Mark titles watched or dismissed, change your Plex
watchlist, and change them in Plex". The `other` form is unchanged (a non-owner cannot change a
watchlist). The Connected apps chip stays "Mark titles".

### D-10 — Logging

`set_watchlist` logs `[mcp] watchlist_changed` with the consumer, action, kind, result (`written`,
`failed`, `unchanged`, `not_found`, `ambiguous`, `not_in_catalog`, `not_owner`) and `onPlex`, like the
mark lines. Never a token; titles as the mark lines already log them.

### D-11 — Stubs and the local stack

`apps/web/e2e/support/stub-plex.ts` keeps the discover watchlist in memory and serves
`/actions/addToWatchlist`, `/actions/removeFromWatchlist`, `/library/metadata/matches` and
`/library/metadata/<id>/userState` against it, so `pnpm dev:local` round-trips an add, a list and an
undo. The seeded watchlist keeps its current items.

### D-12 — Home Assistant and the other consumers

HA re-reads `tools/list` on every call, so the Movie Room agent sees the tools after the deploy with no
HA change. hass-sandbox's WATCH HISTORY prompt block gains one line (use `watchlist` / `set_watchlist`
for the Plex watchlist; adding a title not on Plex downloads it) through its own short PR, and the
attach helper's byte-identical copy with it. dev-env and ChatGPT need nothing.

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
  5-minute margin, no base rows); the watchlist formatter (entries, kind, started/watched, empty, past
  the end, cap); the new `watch_status` availability sentence (four cases).
- `@hnet/plex` (fixtures): `matchDiscover` (type param, empty result, `Video` vs `Metadata`),
  `getDiscoverUserState` (object and array forms, absent `watchlistedAt`), the two writes (2xx, 404,
  timeout; the id check rejects a non-hex id before any request).
- `@hnet/domain` (embedded Postgres, recording fake Plex): add on Plex, add not on Plex (Seerr line),
  remove, already-on and already-off (no row, no write), ambiguous, remove of a title not on the
  watchlist, no catalog match, Plex failure (`failed`, not undoable), non-owner (no row, no call);
  undo of an add and of a remove (inverse call, `revert_result`), and the new actions ignored by
  exclusions, the Taste Profile and Unfinished; the migration's CHECK.
- `@hnet/mcp` e2e: `tools/list` ≤ 4,096 bytes and the pinned exact size, nine tools, scope filtering
  (a `watch:read`-only token sees `watchlist` but not `set_watchlist`), each new tool's happy path and
  1,200-character cap, the non-owner connector answers.
- `apps/web` stack: a Playwright-free `dev:local` smoke via the stub (D-11) is enough; no UI changes.
- Live (PLAN-071): the hop checks, one add/undo on a title already on Plex, the voice bench.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Should a household member's connector see their own watchlist? | Deferred with PLAN-070: it needs each person's plex.tv token (research note §5 item 5); until then D-02's non-owner answer. |
| Q-02 | Should `recommend` weight the owner's Plex star ratings (`userState.userRating`)? | Open follow-up (research note §5 item 3); not part of this design. |
