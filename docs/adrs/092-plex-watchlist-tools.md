# ADR-092: The owner's Plex watchlist through the MCP surface — list it, add and remove titles, and say "on your watchlist"

- **Status:** Accepted (2026-09-26 — live as haynesnetwork v0.100.0, haynes-ops #3205; verified through the hop and on the Movie Room agent, PLAN-071 S5–S6)
- **Supersedes (in part):** ADR-087 C-07 (the 3 KB `tools/list` cap, C-09 here) and
  ADR-088 C-03 (Plex written only by a `watched` mark, C-02 here).
- **Date:** 2026-09-25
- **Deciders:** Tom Haynes (owner request 2026-09-25: agents should *"add and remove things from my
  watchlist"*; **owner ruling 2026-09-25**, asked on his phone: *"Adding a title to your Plex watchlist
  already makes Seerr request and download it … How should a watchlist add treat a title that isn't on
  Plex?"* → **"Add it, say it downloads"**) · drafted by Opus 5.5
- **Relates:** ADR-087 (the MCP surface; **supersedes its C-07 cap in part**, C-09 here), ADR-088
  (Watch Marks; **supersedes its C-03 in part**, C-02 here), ADR-089 (the watchlist as a
  recommendation input), ADR-091 (connectors; owner-only Plex write-back, C-04), ADR-017 (the confined
  `@hnet/plex/write` surface, extended here). Realized by DESIGN-051; built by PLAN-071. PRD-001
  R-252..R-253, R-245 (amended), US-15, AC-29..AC-31; Q-13 resolved. Research:
  `.agents/context/2026-09-25-plex-agent-interactions-research.md`.

## Context and problem statement

The watch tools (ADR-087) reach the owner from the Movie Room voice agent, ChatGPT (ADR-091) and the
dev-env agents. The owner's plex.tv watchlist is already read every 15 minutes into
`watch_reco_signals` and used by `recommend` (ADR-089), but no tool lists it, none changes it, and
`watch_status` does not say whether a title is on it. A ChatGPT session asked for exactly those three
things. The owner wants every agent to be able to add and remove watchlist titles.

Verified live on 2026-09-25 (research note §3): plex.tv's discover provider adds and removes a title
with one idempotent `PUT` keyed by the title's discover id (the suffix of its `plex://` guid), resolves
an external id to that discover id, and reports per-title watchlist state, each in under 300 ms for the
titles tried then (DESIGN-051 D-15ab later measured the external-id match at 0.3 to 1.3 s for a long-running
show), with the owner server token the app already uses for the watchlist read.

Also verified live (research note §2): **Seerr auto-requests the owner's watchlist.** Every 3 minutes it
reads his 20 newest watchlist titles and requests, auto-approved, any that are not available or already
requested, and Sonarr/Radarr search at once. A watchlist add of a title that is not on Plex is therefore
a download request. Removing it later does not cancel that request.

## Decision drivers

- **One surface, every agent** (R-246): the same tools for voice, connectors and dev-env; no second hop
  consumer.
- **Voice first:** plain spoken answers, flat schemas HA can convert, a small `tools/list`, idempotent
  writes (HA may report a failure for a write that happened and the model then retries).
- **Explicit, attributed, reversible** (ADR-088 C-03's spirit): every change is a row, says back the
  title and year it resolved, and `undo_last_change` reverses it.
- **Honest about Seerr:** an add that will download says so (owner ruling).
- **No new credential:** the owner's server token only; other people's watchlists need their own
  tokens, which the app does not hold.

## Considered options

1. **Do nothing; point agents at Seerr or the Plex app.** Leaves the ChatGPT gaps.
2. **Read-only: list and `on your watchlist`, no writes.** Half the ask.
3. **List + add/remove as two tools, `watch_status` says "on your watchlist", changes recorded as Watch
   Marks and undoable; the cap raised to fit.**
4. **One combined `watchlist` tool with `action: list|add|remove`.** About 280 bytes cheaper, but one
   tool would need both scopes (a read-only connector token could not list), and a single description
   has to explain three behaviours.
5. **Answer watchlist questions live from plex.tv on every call.** Always fresh, but one more network
   dependency on every voice turn; the 15-minute cache plus a write overlay is enough (DESIGN-051 D-05).

## Decision outcome

Chosen option: **3**, in BC-06 Watch Companion. Option 4 saves bytes but tangles scopes; option 5 buys
freshness the overlay already gives.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **Two new tools.** `watchlist` (`watch:read`) lists the watchlist newest first with each title's kind, year and whether it is on Plex; `set_watchlist` (`watch:write`) adds or removes one title and says back the title and year it resolved. `watch_status` always says whether the title is on the watchlist, alongside whether it is on Plex. Nine tools in all. |
| C-02 | **Supersedes ADR-088 C-03 in part.** Plex is written by an owner-issued `watched` mark (unchanged) **and by an owner-issued watchlist change**, which writes plex.tv's watchlist only (never view state, never a library). A watchlist change is a **Watch Mark** (T-248) with action `watchlist_add` or `watchlist_remove`, so it is attributed (consumer, actor), audited by its row and undone by `undo_last_change`. A change that would change nothing (the title is already on, or already off) writes no row and no Plex call. |
| C-03 | **Seerr coupling, by ruling.** Adding a title that is not on Plex answers that Seerr will request it. Undoing such an add removes it from the watchlist and says Seerr may already have requested it; the app never calls Seerr. This settles PRD Q-13: requests by voice go through the watchlist. "On Plex" is the app's rule (a ledger item matched on a Plex server); HaynesOps mirrors HaynesTower's Movies and TV from the same storage (OPS-002), so it agrees with what Seerr sees as available. Known imprecision, accepted: for a show that is only partly on Plex, Seerr may also request the missing seasons, which the answer does not predict (completing a watchlisted show matches the intent). |
| C-04 | **Owner-only**, as ADR-091 C-04 already rules for Plex write-back: only the Server Owner's watchlist is read and written (the owner token authenticates as him). A connector answering for another tracked account says the watchlist isn't set up for their account yet, and never calls plex.tv. Household watchlists need each person's own plex.tv token (research note §5, item 5). |
| C-05 | **Identity.** A title's discover id comes from its stored `plex://` guid when there is one, else from plex.tv's external-id match (`tmdb`, then `tvdb`, then `imdb`, with the kind). A remove resolves only among titles on the watchlist. An ambiguous or unmatched title writes nothing, as for marks. |
| C-06 | **Freshness.** Reads stay on the 15-minute cache, with the account's watchlist Watch Marks (and their reverts) since the last sync overlaid at read time, so a change shows up in the very next answer and a sync that read plex.tv just before the change cannot hide it. |
| C-07 | Risk/accepted: a wrong resolution on an add of a title not on Plex downloads the wrong title within about 3 minutes, and undo cannot cancel it. Mitigated by the D-13 resolver (ambiguous asks; for an add, TMDB accepted only on an exact title, and **two or more exact TMDB hits are ambiguous and ask**, since `mark_watched`'s first-hit rule is harmless there and not here; a year the title names keeps only that year's hits, an add never takes a hit of another year than the one named (it asks), and hits that all read the same are refused without a question, DESIGN-051 D-15v, D-15w, D-15ac; the pool's title is taken without TMDB only when the query names it exactly, it is not another year than the one named, and the owner or the library knows it, not only a TMDB recommendation, and a pool title TMDB cannot settle is asked about, never taken, DESIGN-051 D-15x, D-15y), plex.tv's own title and year read back in the answer (and a guid that disagrees with the external-id match writes nothing), and "Seerr will request it" said aloud. |
| C-08 | Risk/accepted: the writes use the Plex server's own token, as the watchlist read already does. The app sends the same `X-Plex-Client-Identifier`/`X-Plex-Product` as today and no `X-Plex-Version`, the header that made plex.tv rewrite the server's device record when Tautulli reused the token. |
| C-09 | **Supersedes ADR-087 C-07's 3 KB cap in part: the `tools/list` cap becomes 4 KB (4,096 bytes).** Two tools and the longer descriptions come to about 3.6 KB. The cap exists for R-245 (at most 0.5 s added per voice turn); the 2,712-byte list added no measurable median latency, so the evidence is re-measured with the hass-sandbox voice bench after the deploy (PLAN-071), and R-245's latency bound, not the byte cap, stays the requirement. The 1,200-character result cap is unchanged. |
| C-10 | Cost: two Plex client methods on the confined write surface (`addToWatchlist`, `removeFromWatchlist`) and two reads (`matchDiscover`, `getDiscoverUserState`), a CHECK-constraint migration for the two new mark actions, two tools and their tests. No new table, CronJob or credential. |
| C-11 | Neutral: the `watch:read` and `watch:write` consent lines gain the watchlist for the Server Owner (the only account whose watchlist is read or changed; everyone else's lines are unchanged, DESIGN-051 D-09), so what a connector may read and change is said at consent. Tokens already granted keep working; the scope set is unchanged. |
| C-12 | Bad/accepted: **a wider blast radius.** ADR-087 C-05 already accepts that anything admitted to the hop acts as the owner; with this ADR, the hop's consumers (Home Assistant, the dev-env pod) and any owner connector can also cause an auto-approved Seerr download by adding a title. The app itself writes plex.tv only: it never calls Seerr or an *arr (hard rule 4 is unchanged), and the *arr add is Seerr's own configuration (the owner's watchlist sync and auto-approve). Undo, the read-back and the ambiguity rules (C-07) are the guard. |

## More information

- Research, live probes and the ranked follow-ups: `.agents/context/2026-09-25-plex-agent-interactions-research.md`.
- Upstream references: python-plexapi `myplex.py` (`addToWatchlist`, `removeFromWatchlist`,
  `userState`), Seerr `server/lib/watchlistsync.ts` (the 3-minute auto-request).
