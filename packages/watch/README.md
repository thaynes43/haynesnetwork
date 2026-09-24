# @hnet/watch

The Watch Companion's pure math (DESIGN-049; ADR-088, ADR-089; PLAN-068 S4): title identity,
per-episode progress and states, the spoken-title resolver, the Taste Profile, the recommendation
exclusions and score, and the spoken answers of the seven watch tools — plus (S5–S7) the Title State
helpers the sync, the live revalidation and the Watch Mark write-through share, and the read queries.

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
| `formatWatchStatus(view, { now })` | "The Expanse (2015 show): all 62 episodes watched, finished in March 2025. On Plex." |
| `formatRecentHistory(entries, { now, days, limit })` | "In the last two weeks: Silo, 5 episodes, latest season 2 episode 10 on September 20. WarGames, a movie, on September 5." |
| `formatMarkResult(view)` | "Marked Severance (2022) as watched in Plex, all 19 episodes." / "Noted Dark Matter (2024) as watched. It isn't on Plex, so only your history changed." |
| `formatDismissResult(view)` | "Got it. I won't suggest Grey's Anatomy (2005) again." |
| `formatUndoResult(view)` | "Undone. Severance (2022) is back to unwatched in Plex, 19 episodes." / "Nothing to undo from the past day." |
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
| `selectResolverPool(db, account, { kind? })` | D-13's pool: Title States (`inHistory`), the live ledger, the signals — each a `PoolEntry` that remembers its row / ledger item. |
| `selectTitleRows`, `selectTitleRowsByIdentity`, `selectLedgerHolders`, `selectLedgerFacts`, `selectLedgerIndex` | Title States by id / kind / identity; where a ledger item is on Plex; ledger genres and Sonarr's ended status. |
| `selectAccountEvents`, `selectTitleEvents`, `selectKnownShowGuids`, `selectUnresolvedShowPairs` | Events for the sync and for one title; the Q-06 show-guid lookups. |
| `selectLiveMarks`, `selectSignals`, `selectSignalsFetchedAt` | Unreverted marks; the signal cache and its freshness (the 20-hour seed cadence). |
| `selectUnfinishedRows`, `selectRecentEvents` | The T-245 candidates (shows with a next episode, movies resumed 5–90%) as narrow `UnfinishedRow`s — no episode map or Plex counters (`selectTitleRows` loads whole rows for the few titles revalidated); the events of a window. |
| `selectRecommendInputs(db, account, { kind, genre, kids })` | D-17: the library candidates (live Sonarr/Radarr items on Plex; SQL pre-filter on kind, genre (every source spelling, substring) and children's genres; anti-joined on Ever Watched / started Title States and every live mark; best rated first, ≤ 600), the watchlist and TMDB-seed candidates matched to the ledger, the Title States and the live marks. |
| `ledgerExclusions(titles, marks)`, `selectLibraryCandidates(db, { kind, genre, kids, limit, exclusions })` | The anti-join as excluded-id arrays per kind (ledger link, TVDB — shows only —, TMDB, IMDb; one array parameter each, which Postgres hashes) and the library query itself. |

## Views (D-10, D-15, D-18..D-21) — `src/views.ts`

Pure: stored rows, events and live marks → the formatters' inputs, so the MCP layer only reads and formats.

| Export | Contract |
|---|---|
| `indexMarks(marks)`, `marksFor(index, ids)` | Live marks by kind-scoped identity key → `{ watched, dismissed }`. |
| `unfinishedItems(rows, marks, { kind, kids, now })` | T-245: `in_progress` / `stalled` (never a Taster), not dismissed, children's only with `kids`; `compareUnfinished` order. |
| `recentEntries(events, marks)` | Per title: distinct episodes, the latest, when; a `not_mine` title is left out (a show whose episodes have no guid, Q-06, by its normalized name). |
| `recommendations(inputs, marks, opts)` | Exclusions + Taste Profile + exemplars → `pickRecommendations`. |
| `watchStatusView({ title, row, marks, onPlexElsewhere, now })` | The `formatWatchStatus` view (Ever Watched per T-247). |

## Tests

`pnpm --filter @hnet/watch test` — offline, no database. `__tests__/exclusions.property.test.ts` is
the AC-21 property test: 600 seeded worlds (an inlined mulberry32) of histories, marks and candidates
whose sources know random subsets of each title's ids.
