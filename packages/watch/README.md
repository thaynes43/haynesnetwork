# @hnet/watch

The Watch Companion's pure math (DESIGN-049; ADR-088, ADR-089; PLAN-068 S4): title identity,
per-episode progress and states, the spoken-title resolver, the Taste Profile, the recommendation
exclusions and score, and the spoken answers of the nine watch tools — plus (S5–S7) the Title State
helpers the sync, the live revalidation and the Watch Mark write-through share, the read queries, and (ADR-092 /
DESIGN-051, PLAN-071) the watchlist's read-time overlay.

Exports raw TS — no build step (see root `CLAUDE.md`). The math is **pure**: no network, no clock, no
`@hnet/domain`, no MCP SDK; every function that depends on time takes `now`. The queries (`src/queries/`)
are SELECT only and take the `db` to run on; the package **never writes** (D-01). Dependencies:
`@hnet/db` (schema types, the queries), `drizzle-orm` (their query builder) and `zod`.

**Servers.** `PLEX_SERVERS` is the schema's `PLEX_SERVER_SLUGS` in preference order (HaynesOps,
HaynesTower, HaynesKube) — one source of truth (DESIGN-049 D-26); `PlexServer` is `PlexServerSlug`.

**Units.** Every time is a unix timestamp in **seconds** (Plex `lastViewedAt`, Tautulli
`started`/`stopped`, `now`). Resume offsets and durations are milliseconds, as Plex reports them.

## Identity (D-08) — `src/identity.ts`, `src/normalize.ts`

| Export | Contract |
|---|---|
| `titleKeyFor(ids: TitleIds): string` | The `title_key`: `plex:<plex://show\|movie/… guid>` (same kind; `local://` and legacy agent guids never), then `tvdb:<id>` (show) or `tmdb:movie:<id>` (movie), then `imdb:<id>`, then `tmdb:show:<id>`, last `name:<kind>:<normalized title>\|<year>`. |
| `identityKeys(ids: TitleIds): string[]` | Every key the title can be matched by, strongest first; always one `name:` key. Two records are the same title when their key sets intersect. |
| `keysOf(ids & { titleKey? })` | `identityKeys` plus a stored `titleKey`. |
| `titleKeyRank(key): number` | 0 plex, 1 tvdb / tmdb:movie, 2 imdb, 3 tmdb:show, 4 name — for re-keying a row to a stronger key. |
| `nameKey(kind, title, year?)` | The `name:<kind>:…` key alone — it carries the kind (PLAN-068 S5 ruling), so a show and a movie of the same title and year never share it. |
| `normalizeTitle(s): { norm, year }` | D-13: NFKD, no diacritics, lower-case, `&`→`and`, apostrophes and periods join, other punctuation → space, one leading the/a/an dropped. A `(2019)` tag leaves the title and becomes the year hint; a bare trailing year (`dune 2021`, `Blade Runner 2049`) becomes the hint but stays in `norm`. |
| `stripTrailingTag(norm)` | Drops one trailing country tag (`us`, `uk`, `au`, …) or bare year. |

`TitleIds = { kind: 'show' \| 'movie'; title; year?; plexGuid?; tvdbId?; tmdbId?; imdbId? }`. A TVDB id
counts for shows only (TVDB movie ids are another id space).

## Progress and states (D-10) — `src/progress.ts`

| Export | Contract |
|---|---|
| `computeShowProgress(servers: ServerEpisodes[], events: EventObs[]): ShowProgress` | The union over servers of `(season ≥ 1, episode)`; watched if any server says so; `furthest` = greatest watched pair; `next` = the pair right after it, or — nothing watched — the started (resume point) episode viewed most recently; next served from HaynesOps, else HaynesTower, else HaynesKube; `rewatch` when events hold more than `episodesWatched + 2` distinct watched episodes; `lastWatchedAt` = newest of Plex `lastViewedAt` and event `stoppedAt` (a missing stop counts at its start). Season-0 events are ignored like specials. Returns `episodesTotal`, `episodesWatched`, `furthest`, `next {season, episode, title, server, ratingKey, resume}`, `plexWatched`, `plexLastViewedAt`, `firstWatchedAt`, `lastWatchedAt`, `rewatch`, `eventWatchedEpisodes`, `eventPlays` and `episodeMap`. |
| `EpisodeMap` / `episodeMapSchema` / `parseEpisodeMap(json)` | The D-07 `episode_map`: `{"<season>": [[episode, watched 0/1, lastViewedAt s or 0, {server: ratingKey}]]}`. |
| `applyFlips(episodeMap, flips: PlexItemKey[], watched, { at? }): ServerEpisodes[]` | Write-through after a mark (D-14 step 6) or its undo (D-15): the progress inputs rebuilt from the stored map with the flipped keys set; feed them to `computeShowProgress`. A flip sets the whole pair; a mark stamps `lastViewedAt = at`, an undo clears it; resume points and episode titles are not in the map (carry `next_title` over when the next pair is unchanged). |
| `computeMovieProgress(servers: ServerMovieObs[], events): MovieProgress` | `plexWatched` (any server), `resumePercent` from the server with the newest `lastViewedAt` (ties: the one with a resume point, then HaynesOps), `resumeServer`, dates, `eventPlays`, `eventWatched`. |
| `isKidsTitle({ kind, contentRating?, genres? })` | TV-Y / TV-Y7 / TV-Y7-FV, or a Kids/Children genre; a movie also when Animation and Family. |
| `showState(p, { showStatus?, now }): ShowState` | `in_progress` (next, ≤ 90 days incl.), `stalled`, `taster` (≤ 2 watched, < 10%, untouched for more than 30 days; overrides both), `caught_up`, `finished` (`showStatus = 'ended'`), `unstarted`. An unknown last-watched time counts as old. |
| `movieState(p, { now }): MovieState` | `in_progress` for 5 ≤ resume ≤ 90 within 90 days, `stalled` older, else `finished` when watched in Plex, else `unstarted`. |
| `compareUnfinished` | The T-245 order: in progress first, newest first, then title. |

## Resolver (D-13) — `src/resolver.ts`

| Export | Contract |
|---|---|
| `resolveTitle(query, pool: ResolverCandidate[], { kind? }): ResolveResult` | Pool entries sharing an identity key (same kind) are ONE title. Title score = best entry's match + 0.05 year-hint match + 0.05 when any entry is in history (bonuses never lift a zero match). `resolved` (with `candidate`, `score`, `sameTitle`) when the best is ≥ 0.9 and the runner-up title is at least 0.05 below — a margin of exactly 0.05 resolves; `ambiguous` (`options`: ≤ 3 titles, best first, newer first on a tie) when ≥ 0.6; else `not_found` (the caller may then try TMDB `search/multi`). |
| `titleMatchScore(query, title)` | Before bonuses: 1.0 exact; 0.95 exact once ONE side's trailing country or year tag is dropped (two different tags never match); 0.85 prefix when the shorter is ≥ 60% of the longer; else the better of Jaro-Winkler × 0.9 (when Jaro-Winkler ≥ 0.9) and `WORD_PREFIX_SCORE` 0.7 when the query's words are the leading whole words of the title ("dune" → "Dune: Prophecy"; also with a trailing year hint dropped — Q-05 ruling: listed in an ambiguous answer, never resolved alone); else 0. Use `=== 1` for the TMDB exact-match acceptance. |
| `jaroWinkler(a, b)` | Standard Jaro-Winkler (prefix scale 0.1, up to 4 characters, boost above 0.7). |

`ResolverCandidate = { titleKey; kind; title; year: number \| null; inHistory: boolean; ids?: ExternalIds }`.

## Recommendations (D-16..D-20) — `src/recommend.ts`, `src/genres.ts`

| Export | Contract |
|---|---|
| `canonicalGenre(s): string \| null` | The `genre` parameter and every source spelling onto one name: sci-fi/scifi/science fiction, comedy/funny, horror/scary, documentary/docs, animation/animated, romance/romantic, thriller, crime, drama, action, fantasy, mystery, war, western, family, kids/children; fillers like "some … movies" drop; unknown genres pass through normalized. |
| `canonicalGenres(list): string[]` | Per title; compound source genres split on `&`, `/`, `,` ("Sci-Fi & Fantasy" → sci-fi, fantasy). |
| `buildTasteProfile(titles: ProfileTitle[], now): { adult, kids }` | D-16: each Ever Watched title weighs `0.5 ^ (years since last watched)` × completion (movies 1; shows watched/total, at least 0.25 once three episodes are watched — Plex or events), split evenly over its genres; `not_mine` left out; `not_interested` subtracts half its weight (floored at 0); children's titles build `kids`; each vector sums to 1. |
| `titleWeight(t, now)` | One title's weight (0 without a last-watched time). |
| `genreExemplars(titles)` | Per genre, the owner's most-watched title — the input for `<genre> like <title>`. |
| `isEverWatched(facts, { watched?, notMine? })`, `isStarted(facts)` | T-247 and the D-18 "started" rule (a show with a watched episode or a started next episode; a movie with a resume point). |
| `buildExclusions(titles: HistoryFacts[], marks: LiveMark[]): Exclusions` | The four identity-key sets. Title States and marks that share a key (same kind, transitively) are one title, and ALL its keys join the set its facts call for. |
| `excludeCandidates(cands, exclusions, { kids })` | D-18, applied last (AC-21): a candidate goes when any key of it — or of any candidate sharing a key with it — is in any set; `kids: false` drops children's titles, `kids: true` keeps only them (children's when any source says so, or their genres together do). |
| `mergeCandidates(cands)` | One candidate per title across library, watchlist and TMDB seeds; order-independent. |
| `scoreCandidates(cands, profile, { kind?, genre?, now, genreTitles? }): ScoredPick[]` | D-19 `0.45 × affinity + 0.30 × quality + boosts` (watchlist +0.35, seeds +0.3 × min(1, n/3), new on Plex within 21 days +0.1); ties on quality, then title. Reason, first that applies: "on your watchlist"; `because you watched <most recent seed>`; `<genre> like <title>` (the requested genre, else the owner's strongest shared genre, drama last); `rated <x> on IMDb`; "new on Plex"; "new to you". |
| `pickRecommendations(input): { onPlex, notOnPlex }` | The whole pure pipeline: exclude → merge → score with the adult or kids profile → split. |

`name:` keys carry the kind (since PLAN-068 S5), so a watched movie no longer excludes a show with the
same normalized title and year. Where identity is uncertain the rules still err toward leaving a pick
out, never toward repeating a watched title.

## Spoken answers (D-14, D-15, D-20, D-21) — `src/format.ts`, `src/spoken.ts`

Plain sentences, no markdown, bullets, emoji or URLs (titles pass through `spokenTitle`); the count
leads; episodes are "season 3 episode 1"; at most `limit` items, then "And N more."; never more than
`SPOKEN_MAX_CHARS` (1,200), cut at a sentence boundary.

| Export | Example |
|---|---|
| `formatUnfinished(items, { now, limit, kind?, timeZone? })` | "Three unfinished shows. Silo: 30 of 40 watched, next is season 3 episode 1, last watched on September 20. For All Mankind: next is season 5 episode 3, on September 12. Stalled: The Righteous Gemstones, 36 of 45, untouched since March 2025." |
| `formatRecommendations({ onPlex, notOnPlex }, { limit, offset?, genre?, kids?, kind? })` | "Five picks on Plex. Foundation, a 2021 show, because you watched The Expanse. … Not on Plex yet: Dark Matter, a 2024 show, on your watchlist." Not-on-Plex picks page two at a time with `offset`. Empty: "Nothing new matches that. Try another genre or kind." |
| `formatWatchStatus(view, { now })` | "The Expanse (2015 show): all 62 episodes watched, finished in March 2025. On Plex, not on your watchlist." — DESIGN-051 D-02's four availability sentences (`On Plex and on your watchlist.` · `On Plex, not on your watchlist.` · `Not on Plex, but on your watchlist.` · `Not on Plex or your watchlist.`); with `onWatchlist` null (a non-owner), DESIGN-049's `On Plex.` / `Not on Plex.` |
| `formatWatchlist(items, { total, offset, kind? })` | DESIGN-051 D-02: "Your watchlist has 150 titles. Newest first: Slow Horses, a 2022 show, on Plex, started. The Toxic Avenger, a 2023 movie, not on Plex yet. And 148 more." The items are fitted to the 1,200-character cap FIRST, then the range and "And N more." name exactly the items kept (D-15f): a later page, or a first page the cap cut short, says its range ("Numbers 6 to 10: …", "Newest first, numbers 1 to 4: …"); empty: "Your watchlist is empty." (with a kind: "Your watchlist has no movies."); past the end: "That's the end of your watchlist." |
| `formatWatchlistChange(view)` | "Added The Matrix (1999 movie) to your watchlist. It's on Plex." / "… It isn't on Plex yet, so Seerr will request it." / "Removed …" / "… is already on your watchlist." (+ " It isn't on Plex yet, so Seerr will request it if it hasn't already." for an add of a title not on Plex, D-15j) / "… isn't on your watchlist." / "I found … but not in Plex's catalog, so your watchlist didn't change." / "I couldn't confirm … in Plex's catalog, …" / "I couldn't reach Plex, so your watchlist didn't change." / an unconfirmed write: "Plex didn't answer in time, so I can't tell whether … changed." (+ " It isn't on Plex yet, so if it was added, Seerr will request it." for an add of a title not on Plex) (DESIGN-051 D-15). |
| `formatWatchlistDuplicates(options)` | DESIGN-051 D-15l: several watchlist titles under one spoken title, which no `set_watchlist` argument can pick between, so never a question: "Your watchlist has more than one Dark Matter (2024 show), and I can't tell them apart, so I left it as it is. You can change it in the Plex app." (titles that read differently are named). |
| `formatWatchlistIndistinct(options)` | DESIGN-051 D-15w: an add whose TMDB titles read the same (one name, year and kind), which no `set_watchlist` argument can pick between, so never a question: "I found more than one Alone (2020 movie) and can't tell them apart, so I left your watchlist as it is. You can add it in the Plex app." |
| `formatNotOnWatchlist(query, { kind? })`, `formatWatchlistNotSetUp()` | "I couldn't find Arrival on your watchlist." (a remove resolves only there) / "Your Plex watchlist isn't set up for your account yet." |
| `formatRecentHistory(entries, { now, days, limit })` | "In the last two weeks: Silo, 5 episodes, latest season 2 episode 10 on September 20. WarGames, a movie, on September 5." |
| `formatMarkResult(view)` | "Marked Severance (2022) as watched in Plex, all 19 episodes." / "Noted Dark Matter (2024) as watched. It isn't on Plex, so only your history changed." |
| `formatDismissResult(view)` | "Got it. I won't suggest Grey's Anatomy (2005) again." |
| `formatUndoResult(view)` | "Undone. Severance (2022) is back to unwatched in Plex, 19 episodes." / "Nothing to undo from the past day." A Watchlist Change (DESIGN-051 D-04): "Removed The Matrix (1999 movie) from your watchlist again." (+ " Seerr may already have requested it." when not on Plex) / "Put … back on your watchlist." (+ " Seerr will request it.") / a failed inverse: "I couldn't reach Plex, so … is still on your watchlist. Say undo again to retry." / a change that never reached Plex: "Your last change, adding … to your watchlist, never reached Plex, so there was nothing to undo." / a failed add removed anyway: "Your last change, adding … to your watchlist, may not have reached Plex, so I made sure it's off your watchlist." / a failed remove: "Your last change, removing … from your watchlist, never confirmed with Plex, so I left your watchlist as it is." / an unconfirmed call: "Plex didn't answer in time, so I can't tell whether … changed." (+ " It isn't on Plex yet, so if it was put back, Seerr will request it." when it undid a remove of a title not on Plex, D-15j) / a failed add whose removal failed: "I couldn't reach Plex, so I couldn't make sure … is off your watchlist. Say undo again to retry." (D-15m) / a remove sent over an unsettled add: "Your last change, removing … from your watchlist, came after an add Plex never confirmed, so I left it off your watchlist. To put it back, ask me to add it." (D-15k) / a change still pending: "Plex is still working on your last change, adding … to your watchlist. Say undo again in a moment." (D-15o) (`watchlistOutcome`, DESIGN-051 D-15). A `watched` mark still pending (`inProgress`, D-15t): "Plex is still working on your last change, marking Severance (2022) as watched. Say undo again in a moment." |
| `formatAmbiguous(query, options)` | "More than one match for Dune: Dune (2021, movie), Dune (1984, movie), Dune: Prophecy (2024, show). Which one?" |
| `formatNotFound(query, { kind? })`, `formatNotReady()`, `formatWatchError()` | "I couldn't find anything called Severence." / "Watch history isn't ready yet." / "Watch history hit an error. Try again in a minute." |
| `spokenDate(ts, now, { timeZone? })` | "today", "yesterday", "on September 12" (this year), "in March 2025"; the owner's calendar (`America/New_York` by default). `spokenSince` phrases the same after "since". |
| `capSpoken(text, max?)`, `capSpokenList({ lead, items, more?, tail? }, max?)` | The cap: a sentence-boundary cut (not after "Mr." or an initial); lists drop the tail first, then items from the end, raising "And N more.". |

## Title State helpers (D-09 step 4, D-11, D-14 step 6) — `src/state.ts`

Shared by the `watch` sync, `revalidateTitles` and the Watch Mark write-through, so all three write the
same shape. Plex items are read structurally (`PlexItemLike`; a `@hnet/plex` `PlexSectionItem` is
assignable — this package does not import `@hnet/plex`).

| Export | Contract |
|---|---|
| `parsePlexItemIds(item)`, `plexGenres(item)` | The `plex://` guid, `tmdb://` / `tvdb://` / `imdb://` agent ids, `local` (an unmatched `local://` item); the `Genre[]` tags. |
| `episodeObsFromLeaves(leaves)`, `movieObsFromItem(server, item)` | `allLeaves` / a movie item → the D-10 observations (specials kept; the math drops them). |
| `showCounts(item)`, `movieCounts(obs)`, `countsEqual(a, b)` | The per-server change-detection counters (`plex_counts`). |
| `serverEpisodesFromMap(map)`, `withServerEpisodes(base, fresh)`, `storedMovieObs(row)` | Rebuild the inputs of servers not read this time from the stored snapshot. |
| `applyEpisodeFlips(servers, flips, watched, at)`, `applyMovieFlips(…)` | A mark or its undo applied without a second read (a flip sets the whole pair on every server). |
| `showProgressFields(p, carry?)`, `movieProgressFields(p, servers)` | D-10 outputs → the progress columns (a movie's `next_server` is its resume server). |
| `orderOnPlex(entries)`, `preferredHolder(onPlex)` | `on_plex` in preference order; the preferred holder. |
| `eventObs(row)`, `secondsToDate`, `dateToSeconds` | Unit conversions at the edge. |

## Read queries (SELECT only) — `src/queries/`

| Export | Returns |
|---|---|
| `selectWatchOwner(db)` | THE `owner` row (D-03) or null ("not ready yet"). |
| `selectWatchAccountForUser(db, userId)` | ADR-091 C-04 — the tracked account an app user acts as through a connector: `users.id` → the ADR-053 Plex Account Map → `watch_accounts` (`tracked = true`); null ⇒ "isn't set up for your account yet". Never via `app_user_id`. |
| `selectResolverPool(db, account, { kind?, now, only? })` | D-13's pool: Title States (`inHistory`), the live ledger, the TMDB seeds, and the OVERLAID watchlist (`selectWatchlist`, source `watchlist`) — each a `PoolEntry` that remembers its row / ledger item. `only: 'watchlist'` (a `set_watchlist` remove) is the overlaid watchlist plus the titles a Watchlist Change may have left on plex.tv's list that are not on it now (source `watchlist_recent`; plex.tv's live state then decides): a written remove of the last 10 minutes, a written remove whose undo plex.tv never confirmed (within the undo window, DESIGN-051 D-15r), and an add that failed or never finalized, made since the cache's fetch less the overlay margin or in the last 10 minutes, whichever reaches further back (DESIGN-051 D-15, D-15q). |
| `selectWatchlist(db, account, { now })` | DESIGN-051 D-05 — THE watchlist every reader sees: the `watchlist` signal rows (rank order) with the account's written Watchlist Changes and written reverts since `fetched_at − 5 min` overlaid (`overlayWatchlist`); with no cached rows the look-back is `now − 24 h`. |
| `selectTitleFacts(db, account, titles)`, `selectLedgerByIds(db, titles)`, `ledgerMatchesTitle(t, item)` | The D-02 "on Plex" facts for a few titles (the owner's Title States with `on_plex` and progress; ledger items sharing an external id, with their Plex match). |
| `selectTitleRows`, `selectTitleRowsByIdentity`, `selectLedgerHolders`, `selectLedgerFacts`, `selectLedgerIndex` | Title States by id / kind / identity; where a ledger item is on Plex; ledger genres and Sonarr's ended status. |
| `selectAccountEvents`, `selectTitleEvents`, `selectKnownShowGuids`, `selectUnresolvedShowPairs` | Events for the sync and for one title; the Q-06 show-guid lookups. |
| `selectLiveMarks`, `selectSignals`, `selectSignalsFetchedAt` | The unreverted watch STATEMENTS (`watched`, `not_interested`, `not_mine` — never a Watchlist Change, DESIGN-051 D-07; typed `LiveWatchMark`); the signal cache and its freshness (the 20-hour seed cadence). |
| `selectUnfinishedRows`, `selectRecentEvents` | The T-245 candidates (shows with a next episode, movies resumed 5–90%) as narrow `UnfinishedRow`s — no episode map or Plex counters (`selectTitleRows` loads whole rows for the few titles revalidated); the events of a window. |
| `selectRecommendInputs(db, account, { now, kind, genre, kids })` | D-17: the library candidates (live Sonarr/Radarr items on Plex; SQL pre-filter on kind, genre (every source spelling, substring) and children's genres; anti-joined on Ever Watched / started Title States and every live mark; best rated first, ≤ 600), the watchlist and TMDB-seed candidates matched to the ledger, the Title States and the live marks. |
| `ledgerExclusions(titles, marks)`, `selectLibraryCandidates(db, { kind, genre, kids, limit, exclusions })` | The anti-join as excluded-id arrays per kind (ledger link, TVDB — shows only —, TMDB, IMDb; one array parameter each, which Postgres hashes) and the library query itself. |

## Views (D-10, D-15, D-18..D-21) — `src/views.ts`

Pure: stored rows, events and live marks → the formatters' inputs, so the MCP layer only reads and formats.

| Export | Contract |
|---|---|
| `indexMarks(marks)`, `marksFor(index, ids)` | Live marks by kind-scoped identity key → `{ watched, dismissed }`. |
| `unfinishedItems(rows, marks, { kind, kids, now })` | T-245: `in_progress` / `stalled` (never a Taster), not dismissed, children's only with `kids`; `compareUnfinished` order. |
| `recentEntries(events, marks)` | Per title: distinct episodes, the latest, when; a `not_mine` title is left out (a show whose episodes have no guid, Q-06, by its normalized name). |
| `recommendations(inputs, marks, opts)` | Exclusions + Taste Profile + exemplars → `pickRecommendations`. |
| `watchStatusView({ title, row, marks, onPlexElsewhere, now, onWatchlist? })` | The `formatWatchStatus` view (Ever Watched per T-247; `onWatchlist` for DESIGN-051's availability sentence). |
| `onPlexFor(ids, facts)`, `watchlistItems(entries, facts, marks, now)` | DESIGN-051 D-02: on Plex = a ledger item with a Plex match or a Title State with `on_plex`; `started` (in progress / stalled, or a Taster: a show tried and left is not `watched`, DESIGN-051 D-14g), `watched` (Ever Watched, not unfinished and not a Taster; never for a `not_mine` title). |

## The watchlist overlay and the statement filter (DESIGN-051 D-05 / D-07) — `src/watchlist.ts`

| Export | Contract |
|---|---|
| `overlayWatchlist(base, marks, fetchedAt)`, `watchlistEvents(marks, fetchedAt)` | The cached rows with every WRITTEN change (at `created_at`) and WRITTEN revert (the inverse, at `reverted_at`, never before its change's `created_at`, DESIGN-051 D-15u) since `fetchedAt − WATCHLIST_OVERLAY_MARGIN_SECONDS` applied oldest first (then by mark id): an add of a title not present goes on top, a remove drops every row of the title. Set operations, so an event the cache already reflects changes nothing. |
| `sameWatchlistTitle(a, b)`, `isOnWatchlist(entries, ids)` | The same kind and a shared plex guid or TMDB / TVDB / IMDb id; the name and year only when a side knows no external id. |
| `isStatementAction`, `isWatchlistAction`, `statementMarks(marks)` | `watched` / `not_interested` / `not_mine` are watch statements; `watchlist_add` / `watchlist_remove` are not, and every statement reader (`indexMarks`, `recommendations`, `ledgerExclusions`) drops them. |

## Tests

`pnpm --filter @hnet/watch test` — offline, no database. `__tests__/exclusions.property.test.ts` is
the AC-21 property test: 600 seeded worlds (an inlined mulberry32) of histories, marks and candidates
whose sources know random subsets of each title's ids.
