# 2026-09-25 — Research: letting the agents do more with Plex (watchlist first)

**Ask (owner, 2026-09-25):** research how ChatGPT, the Movie Room voice agent and the dev-env agents can
interact more with the owner's Plex experience; specifically, add and remove titles on his Plex
watchlist. A ChatGPT test had found that `recommend` knows the watchlist but nothing can list it, change
it, or say from `watch_status` whether a title is on it. ChatGPT proposed `list_watchlist`,
`set_watchlist` and an `onWatchlist` field on `watch_status`.

**Outcome:** the watchlist leg is feasible, cheap and verified live; it is being built as
**ADR-092 / DESIGN-051 / PLAN-071**. Owner ruling (asked on his phone, 2026-09-25): a watchlist add
of a title that is not on Plex **goes ahead and says it downloads** (it does, see §2). The other
opportunities are ranked in §5 with what each needs.

**2026-09-26 update (PLAN-071 close-out).** The watchlist leg (§5 item 1) is **live in haynesnetwork v0.100.0**
(haynes-ops #3205; PLAN-071 S5 and S6 verified it through the hop and on the Movie Room agent). All three §4 bullets
are superseded:

- **Movie Room voice does not get new tools by itself.** The trailing `tools/list` after each call is the MCP
  client's own; the tool list HA hands the LLM is loaded once at entry setup (the `mcp` coordinator has no
  listeners, so its refresh never runs). A tool change needs `homeassistant.reload_config_entry` on the "Watch
  history" entry: DESIGN-051 D-12, OPS-015 §8.
- **ChatGPT keeps a connector's old tools** (names, descriptions, the server instructions) until the owner
  refreshes the connector in its settings and starts a new chat: DESIGN-051 D-15ad, OPS-016 §7. The
  `watch:write` consent line did change (DESIGN-051 D-09).
- **dev-env did need a change:** its GitOps `CLAUDE.md` lists the `haynesnetwork` tools by name, so it gains
  `watchlist`, `set_watchlist` and a warning never to test an add with a title not on Plex (haynes-ops #3192, a
  held draft the owner merges; DESIGN-051 D-15, D-12).

§5 items 2–6 are now tracked as issues (§6).

Method: three read-only research passes (the codebase, Plex's APIs from primary sources, the live Home
Assistant and Seerr configuration), then live probes from a `haynesnetwork-main` pod with its own owner
token (no token printed): the read endpoints, and one add/remove round trip on The Matrix (1999,
already on Plex, not on the watchlist), timed right after a Seerr poll and away from the `sync-watch`
minutes. The watchlist was back to 150 titles with Slow Horses on top within 2 seconds.

## 1. What exists today

- `sync-watch` (CronJob `3,18,33,48 * * * *`) reads the owner's plex.tv watchlist with an owner server
  token (HaynesOps first, then HaynesTower): `GET https://discover.provider.plex.tv/library/sections/watchlist/all?includeGuids=1&sort=watchlistedAt:desc`,
  100 per page (101 is a 400). It replaces `watch_reco_signals` rows with `source = 'watchlist'`
  (title, year, kind, tmdb/tvdb/imdb ids, `plex_guid`, `rank` = position). 150 titles live today.
- `recommend` boosts watchlist titles (+0.35) and gives "on your watchlist" as the first reason; a
  watchlist title is "on Plex" when a Sonarr/Radarr ledger item with the same external id has a
  `media_plex_matches` row, else it is listed as "Not on Plex yet".
- `watch_status` never reads the signals, so it cannot say "on your watchlist". Nothing lists or
  writes the watchlist. ADR-088 C-03 says Plex is written only by an owner-issued `watched` mark.
- The only Plex tokens the app holds are the three owner server tokens. No per-user Plex token exists
  anywhere (Better Auth holds Authentik OIDC tokens; Authentik's Plex source stores each user's
  `plex_token` but its API marks the field write-only).
- Voice Budget: `tools/list` is 2,712 bytes against a 3,072-byte test cap (ADR-087 C-07, R-245).

## 2. Seerr turns a watchlist add into a download (verified live)

- Seerr (`media/seerr`, v3.4.1) runs `plex-watchlist-sync` every 3 minutes. The owner (Seerr user 1,
  ADMIN) is the only one of 16 users with `watchlistSyncMovies` and `watchlistSyncTv` on, and ADMIN
  passes the auto-approve check. The job reads the **20 newest** watchlist items, skips anything
  available, already requested or blocklisted, and requests the rest (all seasons for a show). Radarr
  and Sonarr have `preventSearch: false`, so an approved request searches immediately.
- So "add X to my watchlist" = "download X" within about 3 minutes whenever X is not already on
  HaynesTower or requested. It has never fired yet (0 of 96 requests are auto-requests) only because
  the 20 newest items were all available or requested. The About page already tells the household
  "Anything you add to your Plex Watchlist gets picked up by Seerr".
- Removing a title from the watchlist does not cancel a request Seerr already made.
- Since Seerr v3.3.0 a title that was deleted but is still among a user's 20 newest watchlist items is
  **requested again** (intended upstream, seerr-team/seerr#3343). A Trash or Maintainerr delete of a
  recently watchlisted title would re-download it. Low exposure today (the 20 newest are recent adds,
  Trash candidates are old unwatched items), recorded in issue #576 (see §6).
- Owner ruling 2026-09-25 (asked): **"Add it, say it downloads."** The answer to an add of a title not
  on Plex says Seerr will request it. This also settles PRD Q-13 (requests by voice): they go through
  the watchlist.

## 3. Plex API facts (verified live 2026-09-25 unless marked)

| Need | Call | Live result |
|---|---|---|
| Add | `PUT https://discover.provider.plex.tv/actions/addToWatchlist?ratingKey=<discover id>` | 200 `{"MediaContainer":{"size":0}}`, 53–88 ms; a repeat add is also 200 (idempotent) |
| Remove | `PUT …/actions/removeFromWatchlist?ratingKey=<discover id>` | 200, 47–86 ms; removing an absent title is also 200 |
| Bad id | add with `000000000000000000000000` | 404 `MetadataItem for … not found!` |
| Discover id of a known title | the 24-hex suffix of its `plex://movie|show/<id>` guid | suffix equals `ratingKey` on every watchlist item checked |
| Discover id from an external id | `GET …/library/metadata/matches?type=1|2&guid=tmdb://…` (also `tvdb://`, `imdb://`) | 70–254 ms, returns `ratingKey`, `guid`, title, year and all external ids; `type` is mandatory upstream since 2026-09 |
| On the watchlist? | `GET …/library/metadata/<id>/userState` | 70–150 ms; `watchlistedAt` (epoch seconds) present only when on the watchlist; also `userRating`, `viewCount`/`viewedLeafCount` |
| Search a title not in any library | `GET …/library/search?query=&searchTypes=movies,tv&searchProviders=discover&includeMetadata=1&limit=` | 244 ms; "dune part three" → Dune: Part Three (2026) first at score 0.86; results carry no external ids |

Notes from primary sources (python-plexapi 4.18.2, Seerr, plezy): the watchlist host moved from
`metadata.provider` to `discover.provider` in 2025; Plex's official PMS API docs (2025) do not cover the
discover host, `/clients` or `/player/*`; Plex is introducing 7-day JWT tokens but legacy tokens still
work, and registering a JWT key with an existing token expires that token (never do it with the owner
server token). No rate limit is documented; Seerr caps its own discover fan-out at 5 concurrent.

Token provenance: the app's `PLEX_*_TOKEN`s come from the 1Password `homepage` item, which holds the
Plex **server's** own token. Tautulli once reused it on plex.tv with its own `X-Plex-Version`, and
plex.tv rewrote the server's device record (haynes-ops tautulli externalsecret note, 2026-09-11). The
app sends `X-Plex-Client-Identifier: haynesnetwork` and `X-Plex-Product: haynesnetwork` and **no
`X-Plex-Version`**, has read plex.tv with these tokens for months (sharing, then the watchlist every 15
minutes) with no incident. Watchlist writes use the same headers; DESIGN-051 keeps them identical.

## 4. Where each agent stands

_(As written on 2026-09-25; all three bullets are corrected by the 2026-09-26 update at the top.)_

- **Movie Room voice** (HA `conversation.chatgpt_5`, attached through the hop): gets new tools
  automatically, because HA re-reads `tools/list` on every call. Its WATCH HISTORY prompt block lives in
  hass-sandbox (`agent-docs/voice-agent-prompts.md`, `scripts/voice-bench/attach_watch_history.py`).
- **ChatGPT** (public `/mcp`, OAuth): same tools; the `watch:write` consent line needs to mention the
  watchlist.
- **dev-env Claude Code / Codex**: through the hop, same token as HA, so they cannot be given a
  different tool list without a second hop consumer. Not needed: all three get the same tools.

## 5. Opportunities, ranked

1. **Watchlist: list, add, remove, and "on your watchlist" in `watch_status`** (live in v0.100.0, 2026-09-26:
   ADR-092, DESIGN-051, PLAN-071).
   Low risk: plex.tv state only, idempotent, reversible by undo (except a Seerr request already made).
2. **"Play the next episode of X in the Movie Room."** Home Assistant has **no Plex integration**
   today; the Movie Room plays through `media_player.movie_room_shield` (Android TV Remote) and the LG
   TV (webOS), neither of which can pick a Plex title. Path: add HA's Plex integration (one Plex OAuth),
   check the Shield's Plex app advertises as a player, then an HA script "play on the Movie Room TV"
   exposed to Assist, fed by `unfinished`/`watch_status` (which already know the next episode). The
   remote-control API behind it (`/player/playback/playMedia`, `createPlayQueue`) is undocumented
   legacy; Plex's newest TV apps have dropped "advertise as player" on at least Apple TV (forum,
   2026-08). Work lives in hass-sandbox; needs an owner go-ahead and a live device test.
3. **Ratings as a taste signal.** `userState` already returns the owner's `userRating` (Slow Horses 8,
   The Terminator 8, FROM 7), and PMS `PUT /:/rate` can set one. A `rate` tool ("I loved it, five
   stars") plus rating-weighted Taste Profile would sharpen `recommend`. Unverified: whether those
   ratings came from the owner or from Plex's "sync ratings" of another app.
4. **Continue Watching hygiene.** `PUT /actions/removeFromContinueWatching?ratingKey=` on PMS would let
   `dismiss` also clear a show from Plex's Continue Watching. Conflicts with the ADR-088 rule that
   `dismiss` never writes Plex (the children share the account): an owner call.
5. **Household watchlists.** Needs each person's own plex.tv token: an in-app Plex PIN link, or an
   Authentik mapping that exposes `plex_token`. Plex Home managed users could use the owner's
   `switch` token instead. Follows PLAN-070; a design decision on holding household tokens.
6. **Smaller:** PMS `GET /hubs/search/voice` (fuzzy, built for garbled speech) as a resolver fallback;
   playlists (`POST /playlists`) for "queue these up"; On Deck / Continue Watching reads to answer
   "what's up next" exactly as Plex shows it.

None of 2–6 is started. 2, 4 and 5 each need an owner decision and are parked as decision issues (#591, #592,
#593); 3 and 6 are ordinary follow-ups (#589, #590). See §6.

## 6. Follow-ups filed

- The Seerr re-request of deleted-but-watchlisted titles (§2): https://github.com/thaynes43/haynesnetwork/issues/576 (options: exclude watchlisted titles from Trash, drop them from the watchlist on Trash, or accept).
- §5 item 2, playing a title in the Movie Room (owner decision): https://github.com/thaynes43/haynesnetwork/issues/591
- §5 item 3, ratings as a taste signal (DESIGN-051 Q-02): https://github.com/thaynes43/haynesnetwork/issues/589
- §5 item 4, `dismiss` clearing Continue Watching (owner decision): https://github.com/thaynes43/haynesnetwork/issues/592
- §5 item 5, household watchlists (owner decision, after PLAN-070; DESIGN-051 Q-01): https://github.com/thaynes43/haynesnetwork/issues/593
- §5 item 6, voice search fallback, playlists, On Deck reads: https://github.com/thaynes43/haynesnetwork/issues/590
