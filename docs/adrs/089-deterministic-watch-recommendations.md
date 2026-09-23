# ADR-089: Recommendations are scored in the app — deterministic, explainable, exclusion-enforced; the voice model only chooses and phrases

- **Status:** Proposed
- **Date:** 2026-09-23
- **Deciders:** Tom Haynes (owner request 2026-09-23: *"since it has my history it can give me curated
  recommendations that don't duplicate what I already watched"*) · drafted by Opus 5.5
- **Relates:** ADR-088 (Title State, Watch Events and Watch Marks — the exclusion set and the taste
  signal), ADR-087 (the voice budget), ADR-018/DESIGN-008 (ledger ratings and genres). PLAN-043 point
  2 "Predictions" (parked "until data phases land") is realized here. Realized by DESIGN-049 D-16..D-20.
  PRD-001 R-242.

## Context and problem statement

"What should I watch next?" has two failure modes the owner named: suggesting something he has
already seen, and suggesting something generic. Three ways to produce the list exist:

- let the voice model recommend from its own knowledge and check each title afterwards;
- hand the model the whole history and library and let it pick;
- score candidates in the app and hand the model a short, explained list.

The first costs a tool round trip per checked title (about a second each on the Movie Room's OpenAI
agent) and still leaks a watched title whenever the model skips the check. The second breaks the
voice budget: the owner has about 1,900 plays and the library holds about 10,000 titles. The app
already holds the inputs for the third: ledger genres and IMDb/TMDB/Rotten Tomatoes ratings
(`media_metadata`), availability per server (`media_plex_matches`), the owner's complete history
(ADR-088), a TMDB token, and the owner token that reads his plex.tv watchlist (151 titles on
2026-09-23). The app runs no LLM inference today and this ADR keeps it that way.

## Decision drivers

- **Never repeat a watched title** — a guarantee enforced in code, not a prompt instruction.
- **Explain every pick** in a few spoken words ("because you finished The Expanse").
- **Fast and small**: one tool call, compact output, no model inference in the app.
- **Available now first**: the Movie Room plays from Plex, so in-library titles lead.
- **Testable**: the same inputs give the same list.

## Considered options

1. **Model-side recommendation with a `watch_status` check per title.** Rejected: one extra round
   trip per title, and the guarantee depends on the model remembering to check.
2. **Ship history and catalog to the model.** Rejected: tens of thousands of tokens per turn, the
   exact failure ADR-087 exists to avoid.
3. **Server-side scoring over the library, the watchlist and TMDB recommendations, with hard
   exclusions and a reason per pick** (chosen).
4. **Collaborative filtering across the household or friends.** Rejected for now: the friends' data
   is not the owner's to mine for this, and the household (Q-12) is deferred.

## Decision outcome

Chosen option: **3**.

- **Taste profile.** Genre weights from the owner's ever-watched titles, weighted by recency
  (12-month half-life) and completion. Children's titles feed a separate profile used only when the
  caller asks for kids' picks.
- **Candidates.** (a) In-library titles the owner has never watched or started; (b) his plex.tv
  watchlist, in the library or not; (c) TMDB `recommendations` for his most recent finished or
  well-progressed titles (up to 15 seeds, refreshed daily and cached).
- **Hard exclusions**, applied last and in code: ever watched, started (those belong to
  "unfinished"), `not_interested`, and children's titles unless asked. A title the owner says he has
  watched disappears from the very next answer, because marks write through (ADR-088).
- **Score.** Genre affinity, quality (the ledger ratings), and boosts for watchlist membership, TMDB
  seed agreement (more seeds, stronger) and recent arrival on Plex. Ties break on rating, then title,
  so the output is stable.
- **Output.** At most five picks by default: title, year, kind, whether it is on Plex, and one reason
  in plain words. Titles not on Plex are listed separately as "not on Plex yet". The model chooses
  which to say and how.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the no-repeat promise is structural; a unit test asserts no ever-watched, started, dismissed or not-mine title can appear. |
| C-02 | Good: one call returns a spoken-size answer; inputs are cached, so scoring is a database read plus arithmetic. |
| C-03 | Good: explainable and deterministic, so the owner can challenge a pick and a test can pin the ordering. |
| C-04 | Bad/accepted: genre affinity is coarse. The TMDB seeds and the watchlist carry most of the specificity; a better similarity signal is a follow-up, not v1. |
| C-05 | Neutral: TMDB and watchlist inputs are at most a day and 15 minutes old respectively. A title added to the watchlist a minute ago may be missing. |
| C-06 | Neutral: requesting a not-on-Plex title through Seerr by voice is out of scope (PRD Q-13); the answer only says it is not on Plex yet. |

## More information

- DESIGN-049 D-16..D-20 (profile, candidates, exclusions, score, output format).
- TMDB: `GET /3/tv/{id}/recommendations`, `GET /3/movie/{id}/recommendations` (v4 bearer already in
  the web and sync env as `TMDB_API_READ_ACCESS_TOKEN`).
- plex.tv watchlist: `GET https://discover.provider.plex.tv/library/sections/watchlist/all` with the
  owner token.
