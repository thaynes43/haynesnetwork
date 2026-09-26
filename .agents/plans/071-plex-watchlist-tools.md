# PLAN-071: Plex watchlist tools (`watchlist`, `set_watchlist`, "on your watchlist"): build, deploy, live-verify

- **Status:** In progress — S1 done (#577); S2 built on `feat/plex-watchlist-tools`, in review (each pass is in
  the log below)
- **ADRs:** ADR-092 (Proposed; Accepted at S6) · **Design:** DESIGN-051 · **PRD:** R-252, R-253,
  R-245 (amended), US-15, AC-29..AC-31, Q-13 resolved · **Glossary:** T-260, T-248 and T-253 amended
- **Owner:** whoever holds the session; this plan is the tracked owner.
- **Owner rulings:** 2026-09-25 request (agents should add and remove watchlist titles); 2026-09-25
  ruling on the Seerr coupling, asked on his phone: **"Add it, say it downloads"** (ADR-092 C-03).
- **Depends on:** PLAN-068 (completed), PLAN-069 (the public connector; its live gate S8–S9 is
  independent of this plan).
- **Cross-repo:** haynes-ops (image tag only), hass-sandbox (one prompt line, DESIGN-051 D-12).
- **Research:** `.agents/context/2026-09-25-plex-agent-interactions-research.md` (live API probes,
  the Seerr finding, the ranked follow-ups).

## Evidence (2026-09-25)

- Live from `haynesnetwork-main` (owner token, nothing printed): `PUT …/actions/addToWatchlist` and
  `removeFromWatchlist` are 200 and idempotent (a repeat add and removing an absent title are 200), a
  bogus id is 404; `matches?type=&guid=tmdb|tvdb|imdb://` returns the discover id, title, year and ids;
  `userState.watchlistedAt` answers membership; the `plex://` guid suffix equals the discover
  `ratingKey`. One add/remove round trip on The Matrix (1999, on Plex), watchlist restored (150).
- Seerr (`media/seerr` v3.4.1): watchlist sync every 3 minutes; the owner is the only user with it on,
  ADMIN, auto-approved; 20 newest titles; 0 auto-requests so far.
- Voice Budget: `tools/list` 2,712 bytes of 3,072; two tools estimated at about 760 bytes.
- Next free ids at authoring: ADR-092, DESIGN-051, PLAN-071, R-252, US-15, AC-29, Q-15, T-260,
  migration 0079. The Haynes Quest portal card (PR #578) shipped 0079 first, so this plan's migration is
  **0080**.

## Steps

| Step | What | Done when |
|---|---|---|
| S1 | Docs: research note, ADR-092, DESIGN-051, this plan, PRD (R-252, R-253, R-245 amended, US-15, AC-29..AC-31, Q-13 resolved), glossary (T-260; T-248, T-253 amended), DESIGN-049 cross-references, ADR-087/088 status notes, HANDOFF. File the Seerr re-request issue (research note §2). | Docs PR merged to main. |
| S2 | Build per DESIGN-051: `@hnet/plex` (D-06), migration 0080 + enum (D-07), `@hnet/watch` overlay + formatters (D-02, D-05), `@hnet/domain` `changeWatchlist` + undo (D-03, D-04) and the action-reader audit (D-07), `@hnet/mcp` tools, instructions, budget (D-01, D-08), consent copy (D-09), logging (D-10), stubs (D-11), tests (DESIGN-051 test strategy). | PR green on `lint-and-typecheck`, `test`, `build`; an Opus review's findings fixed; squash-merged. |
| S3 | Release: merge the release-please PR. | `v0.99.0` (or the next minor) image published. |
| S4 | Deploy: haynes-ops image tag bump (short PR). | Flux rolled `haynesnetwork-main`; migration 0080 applied (the `init-db`/`migrate` init containers succeeded). |
| S5 | Live verify through the hop from dev-env (JSON-RPC to `haynesnetwork-mcp-hop`): `tools/list` ≤ 4,096 bytes with nine tools; `watchlist` lists the newest titles; `watch_status` "FROM" says "on your watchlist"; `set_watchlist` add on a title already on Plex and not on the watchlist (so Seerr skips it), confirmed by `watchlist` and by plex.tv `userState`; a repeat add answers "already on"; `undo_last_change` removes it; the same add and undo for a long-running show on Plex and not on the watchlist (Law & Order: Special Victims Unit or CSI, whose catalog lookup plex.tv answers in up to 1.3 s: it must answer "Added …", DESIGN-051 D-15ab); a remove of a title that is not on the watchlist (never added, or that add just undone) answers "I couldn't find X on your watchlist." with no row and no call (DESIGN-051 D-02, D-03 step 2: a remove resolves only among watchlist titles, with no TMDB fallback); a title on Plex and on the watchlist removed twice within 10 minutes answers "Removed …" and then "X isn't on your watchlist." with no second row and no second PUT, then `undo_last_change` puts it back. **Never add a title that is not on Plex in a live test** (it downloads). Web logs show `watchlist_changed` lines. | All pass; results recorded here. |
| S6 | hass-sandbox: the WATCH HISTORY prompt line (DESIGN-051 D-12), then the voice bench on the Movie Room agent: R-245's 0.5 s bound against the 2026-09-23 "Assist only" medians. Close out: ADR-092 → Accepted, DESIGN-051 → Accepted, OPS-015 (the watch tools runbook) gains the watchlist tools, HANDOFF, this plan → `completed/`. | Bench within bound (or the regression recorded and the cap revisited); docs PR merged. |

## Log

- 2026-09-25: research + live probes done; owner ruling on the Seerr coupling; S1 docs written.
- 2026-09-25: S1 merged (#577) after an Opus design review (1 blocker, 9 should-fix, all ruled: DESIGN-051 D-13).
- 2026-09-25: S2 built (Opus): nine tools, `tools/list` 3,633 bytes, full workspace 3,292 tests green, a
  `pnpm dev:local` round trip through `/api/mcp` (list, add, list, watch_status, repeat add, undo, remove).
  Build rulings in DESIGN-051 D-14; migration renumbered 0080 (#578 took 0079).
- 2026-09-25: S2 Opus code review of PR #580 (2 blockers, should-fix items), all ruled and fixed on the branch:
  DESIGN-051 D-15 (a change that could not be sent is recorded; unknown outcomes said; undo shaped by what a
  call can do; undos serialized per account; one name with several watchlist titles asks; paging never skips;
  a single TMDB attempt; consent names the watchlist only to the owner). D-12 corrected: dev-env's CLAUDE.md
  gains the two tools and a Seerr test warning through the held-draft haynes-ops PR #3192 (bounces the pod).
- 2026-09-25: second review pass on PR #580 (findings verified by independent skeptics), fixed on the branch:
  the undo replay guard now counts a revert stamped after the call's own clock as a replay (two copies of one
  undo on two replicas no longer walk back to the older change, DESIGN-051 D-15i); a repeated ("already on")
  or unconfirmed add of a title not on Plex, and an unconfirmed undo of a remove, carry the Seerr sentence
  (D-15j); tests pin which TMDB client `set_watchlist` uses and that `defaultDeps` builds it single-attempt;
  the web e2e asserts the exact nine tools (it expected seven, which failed the e2e job); OPS-003 and OPS-015
  give the 3,633-byte list, and OPS-003 walks a watchlist add, list and undo on `dev:local` (verified).
- 2026-09-25: third review pass on PR #580 (findings E1..E6, verified by independent skeptics), fixed on the
  branch: with plex.tv's state unreadable, a change after one plex.tv never settled goes out instead of a false
  "isn't on" / "already on" from the cache, and a remove sent so over an unsettled add is never re-added by undo
  (DESIGN-051 D-15k); several watchlist titles under one name answer "can't tell them apart", not a question
  nothing can answer (D-15l); a failed clear is not "still on" (D-15m); a write that may still land (a timeout,
  a dropped connection or a 504 on any attempt) is never "didn't change" (D-15n); undo picks a pending
  Watchlist Change (under a minute: "still working on it"; older: closed and undone) instead of reverting the
  older change (D-15o); each attempt's timer in `PlexHttp` covers the body, the MCP's TMDB searches opt in on
  `ArrHttp`, and an undo waits for the lock at most 9 s (D-15p). The other HTTP wrappers' header-only timers
  are parked in `.agents/plans/TODO.md`.
- 2026-09-25: fourth review pass on PR #580 (findings F1..F10, verified by independent skeptics), fixed on the
  branch: a remove finds an add left `pending` after its PUT landed and every failed or pending add the cache
  cannot have seen, not only the failed adds of the last 10 minutes (DESIGN-051 D-15q); an undo plex.tv never
  confirmed leaves its title unsettled, and a remove finds a title whose undo may have put it back (D-15r); the
  unsettled check walks the title's whole run of changes, so a change in between neither drops the
  `after unsettled:` marker nor hides an older unsettled add (D-15s). Docs made current: PRD AC-23, R-244 and the
  connector intro (nine tools, 4,096 bytes), BC-06's Outbound list, DESIGN-050 D-14 (the owner's consent lines),
  the comments naming the watchlist marks' readers, and HANDOFF.
- 2026-09-25: fifth review pass on PR #580 (findings G1..G9, verified by independent skeptics), fixed on the
  branch: undo never walks past a pending `watched` mark to an older change (an older watchlist remove's undo
  re-adds and downloads); under ten minutes it answers "still working", older it closes the mark and unscrobbles
  its planned keys, and the mark's own late finalize leaves it alone (DESIGN-051 D-15t); a revert is never stamped
  before the change it reverts, so the overlay and the replay guard see them in order (D-15u); a year in
  parentheses settles an add's TMDB ambiguity, and the first-hit mode honours a named year too (D-15v); TMDB titles
  that read the same are answered "can't tell them apart", never a question (D-15w). Docs made current: S5 above
  (a remove of a title not on the watchlist answers "I couldn't find X on your watchlist."), the parked TODO entry
  on header-only timers, the `@hnet/mcp` header and README, the `@hnet/arr` README; code comments cite DESIGN-051
  IDs instead of ruling numbers.
- 2026-09-26: sixth review pass on PR #580 (findings H1, H2, verified by independent skeptics), fixed on the
  branch: a lone pool title of another year, and a title only a TMDB recommendation knows, no longer decide an add
  on the pool's word (the 1980 Shōgun recommendation won "Shōgun (2024)" and "shogun", and Seerr downloaded it): a
  named year settles same-name pool titles, a pool title of another year sends every mode on to TMDB (a remove
  answers not found), a recommendation is checked against TMDB before an add, and a TMDB hit the pool knows is the
  pool's title (DESIGN-051 D-15x); an add reaches TMDB past a near title in the pool, so "add Dune: Part Three"
  works with Part Two known, and a near title TMDB cannot settle is asked about, never taken (D-15y). Docs made
  current: DESIGN-051 D-02, D-03 step 2 and D-14f, DESIGN-049 D-13, ADR-092 C-07, PRD AC-30, the `@hnet/watch`,
  `@hnet/domain` and `@hnet/mcp` READMEs, and HANDOFF.
- 2026-09-26: seventh review pass on PR #580 (findings I1..I7, verified by independent skeptics), fixed on the
  branch: a failed undo counts toward the unsettled check only when it may have moved the title away from the
  asked state, so a remove after a refused add whose undo also failed is the cache's "isn't on" and is never
  re-added by undo (DESIGN-051 D-15z); a TMDB check made with the pool's answer in hand is one attempt, so a
  `mark_watched` of a named year no longer spends TMDB's retries before its Plex work (D-15aa); plex.tv's catalog
  lookup, which takes up to 1.3 s for a long-running show and so always missed the 300 ms budget ("add Law & Order
  SVU" always failed), and the re-read after a failed PUT get one 1.5 s attempt on a discover bundle of their own
  (`PlexHttp` `getRetries`; D-14a re-derived: 8.0 s worst case, D-15ab); a dash in a title or query is said as a
  hyphen. Docs made current: DESIGN-051 (D-02, D-03, D-06, D-14a, D-15b/c/g/o/r, the quoted ambiguity answers),
  DESIGN-049 (the ADR-092 amendment on its overview, D-05 table, D-13 and D-15 undo text), ADR-092's context, PRD
  AC-30, the `@hnet/mcp`, `@hnet/domain`, `@hnet/arr` and `@hnet/watch` READMEs, this plan's status line and S5
  (a long-running show's add), and HANDOFF.
- 2026-09-26: eighth review pass on PR #580 (findings J1..J7, verified by independent skeptics), fixed on the
  branch: an add never takes a TMDB title of another year than the one named ("Road House (2024)" added the 1989
  film when TMDB's page listed only it; now "Did you mean Road House (1989, movie)?"), and the pool's own title
  named exactly counts among TMDB's hits when TMDB's page leaves it out ("Shōgun (1980)" added the 2024 show over
  the 1980 recommendation, and "shogun" added it without asking) (DESIGN-051 D-15ac). Tests now pin the undo
  replay guard's "no mark made since" (a second undo after a new change inside 30 seconds undoes it, at the domain
  and MCP levels), the Seerr sentence on the cleared undo of an add not on Plex, and the run walk's stop at a live
  change the cache has read. Docs made current: DESIGN-051 (D-03 step 2, D-15v and D-15x notes), DESIGN-049 D-13,
  ADR-092 C-07, PRD AC-30, the glossary's T-260 (D-15z), the `WatchPlexReaders` comment, the `@hnet/domain` and
  `@hnet/mcp` READMEs, the PR description, and HANDOFF.
