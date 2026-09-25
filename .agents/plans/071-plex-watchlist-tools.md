# PLAN-071: Plex watchlist tools (`watchlist`, `set_watchlist`, "on your watchlist"): build, deploy, live-verify

- **Status:** In progress — S1 (docs) on branch `docs/plex-watchlist-tools`
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
| S5 | Live verify through the hop from dev-env (JSON-RPC to `haynesnetwork-mcp-hop`): `tools/list` ≤ 4,096 bytes with nine tools; `watchlist` lists the newest titles; `watch_status` "FROM" says "on your watchlist"; `set_watchlist` add on a title already on Plex and not on the watchlist (so Seerr skips it), confirmed by `watchlist` and by plex.tv `userState`; a repeat add answers "already on"; `undo_last_change` removes it; a remove of a title not on the watchlist answers "isn't on". **Never add a title that is not on Plex in a live test** (it downloads). Web logs show `watchlist_changed` lines. | All pass; results recorded here. |
| S6 | hass-sandbox: the WATCH HISTORY prompt line (DESIGN-051 D-12), then the voice bench on the Movie Room agent: R-245's 0.5 s bound against the 2026-09-23 "Assist only" medians. Close out: ADR-092 → Accepted, DESIGN-051 → Accepted, OPS-015 (the watch tools runbook) gains the watchlist tools, HANDOFF, this plan → `completed/`. | Bench within bound (or the regression recorded and the cap revisited); docs PR merged. |

## Log

- 2026-09-25: research + live probes done; owner ruling on the Seerr coupling; S1 docs written.
