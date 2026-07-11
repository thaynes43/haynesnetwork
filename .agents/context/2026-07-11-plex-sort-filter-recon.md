# Plex per-view sort/filter recon → PLAN-029 (Library views + S&F overhaul)

- **Date:** 2026-07-11
- **Author:** Opus recon agent (read-only; one context doc, no code/cluster changes)
- **Feeds:** PLAN-029 owner rulings R1–R8 (`.agents/plans/029-library-views-grouping-collections.md`).
- **Scope:** (1) what Plex exposes per view level; (2) map each dimension to OUR schema per kind
  (Date Added + Date Released called out explicitly — the owner's two must-haves); (3) per-user
  watch/read-state feasibility (R7); (4) a per-view sort/filter registry strawman for the walls.
- **Not designed here** — this is raw material + honest gaps for the design phase.

## TL;DR for the design

1. **Plex's whole trick is that sort/filter fields are advertised PER LIBTYPE and the leaf level
   carries dimensions the parent can't** (episode air date, episode resolution/duration), *plus*
   it lets a parent filter on a child's attribute ("shows with a new episode this month"). That
   asymmetry — not a longer flat list — is the thing worth stealing.
2. **Our data already splits into two engines**, and the design must respect the seam:
   - **Ledger-backed walls** (Movies, TV *Shows* level, Music *Artists* level) read Postgres
     `media_items` ⟕ `media_metadata` through the **existing D-09 `ledger.search` filter engine**
     (`packages/api/src/ledger-query.ts`). That engine ALREADY sorts by `added_at` and filters by
     genre/resolution/rating/collection — the walls just don't surface it.
   - **Plex-live walls** (TV *Seasons*/*Episodes* drill-in, Peloton, YouTube) read Plex section /
     children endpoints live (`packages/plex` → `ledger.plexSeasons`, `ytdlsub` router). Plex's
     `sectionItemSchema` ALREADY parses `addedAt`, `originallyAvailableAt`, `index`, `duration`,
     `year` — so both must-have dates are available for these levels for free.
   - **Books walls** (Books, Comics, Audiobooks) read `books_items`. `source_added_at` (Date Added)
     is present for all three; release/pub date is only a `year`, ABS-only.
3. **"Date Added" is essentially a UI/surfacing gap, not a data gap** — it exists everywhere today
   (`arr_added_at`, Plex `addedAt`, `books_items.source_added_at`) and is already a sort field in
   the engine. **"Date Released" is the real data gap for Movies / TV-Shows / Comics** — those store
   only `year`; the precise date needs a small sync add (Radarr release dates, Sonarr `firstAired`,
   Kavita/ABS published date). It's already present, live, for the Plex-backed levels.
4. **R7 per-user watch state:** we already own the hard part — an app-user↔plex.tv-account map
   (numeric `plex_user_id` claim + `users.plex_email/plex_username` overrides + the friend-list
   matchers in `packages/plex`). What's missing is that the metadata harvest **collapses Tautulli
   history to a household SUM/MAX and throws away the per-`user` dimension**. Re-keeping it (plus
   pulling Tautulli's `user_id`) is the whole video feature. Books read-state is harder: Kavita/ABS
   have their own account systems disjoint from plex.tv (ABS admin-readable; Kavita needs per-user
   tokens). **No per-user state/prefs table exists today** — both R1 (prefs) and R7 (mapping) are new tables.

---

## PART 1 — Plex's per-view sort/filter model (web research)

Plex does **not** hard-code fields client-side: the server advertises sort/filter capability **per
libtype** at `/library/sections/<id>?includeDetails=1` (+ `/filters`, `/sorts`), keyed by the type
map `movie=1, show=2, season=3, episode=4, artist=8, album=9, track=10`, with field scoping like
`show.title` / `episode.year` and modifiers `:desc` / `:nullsLast`
([developer.plex.tv/pms](https://developer.plex.tv/pms/)). Field names below are from the
python-plexapi `search()` docstring/source
([readthedocs](https://python-plexapi.readthedocs.io/en/latest/modules/library.html)); the
per-level matrix is from Kometa, which builds its smart filters directly off Plex's advertised
capabilities ([kometa smart-filter](https://kometa.wiki/en/latest/files/builders/plex/smart-filter/)).

### Sort key ↔ UI-label glossary

| Plex UI sort | plexapi key | Notes |
|---|---|---|
| By Title | `titleSort` | respects sort-title overrides |
| By Year | `year` | |
| By Release Date (Originally Available) | `originallyAvailableAt` | movie release / **show first-aired** / **per-episode air date** / album release |
| By Date Added | `addedAt` | per-item, every level |
| By Last Episode Date Added | `episode.addedAt` | TV shows/seasons rollup |
| By Last Played / Date Viewed | `lastViewedAt` | **per-user** |
| By Plays | `viewCount` | **per-user** |
| By Unplayed | `unviewedLeafCount` | **per-user** |
| By Date Rated | `lastRatedAt` | **per-user** |
| By Rating (mine) | `userRating` | **per-user** star |
| By Critic Rating | `rating` | |
| By Audience Rating | `audienceRating` | |
| By Content Rating | `contentRating` | |
| By Duration | `duration` | |
| By Resolution | `mediaHeight` | |
| By Bitrate | `mediaBitrate` | |
| Random | `random` | |

Filter fields confirmed by plexapi (unprefixed = library's primary level; `show.`/`episode.`/
`album.`/`track.` scope down): `actor, addedAt, audioLanguage, collection, contentRating, country,
decade, director, duplicate, genre, hdr, inProgress, label, lastViewedAt, mood, producer,
resolution, studio, style, subtitleLanguage, unmatched, unwatched, userRating, writer, year`.

### Per-level SORT matrix (✓ = offered at that level)

| Sort → key | Movie | Show | Season | Episode | Artist | Album | Track |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| Title `titleSort` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Index `index` (season/track #) | | | ✓ | ✓ | | | ✓ |
| Year `year` | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ |
| **Release/Air `originallyAvailableAt`** | ✓ (release) | ✓ (**series first-aired**) | via `episode.*` | ✓ (**per-episode air**) | — | ✓ (album) | inherits album |
| **Date Added `addedAt`** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Last Episode Date Added `episode.addedAt` | | ✓ | ✓ | | | | |
| Critic `rating` / Audience `audienceRating` | ✓ | ✓ | ✓ | ✓ | | ✓(critic) | |
| My Rating `userRating` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Content Rating `contentRating` | ✓ | ✓ | ✓ | ✓ | | | |
| Duration `duration` | ✓ | ✓ | | ✓ | ✓ | ✓ | ✓ |
| Resolution `mediaHeight` | ✓ | ✓ | | ✓ | | | |
| Last Played `lastViewedAt` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Plays `viewCount` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Unplayed `unviewedLeafCount` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Album Artist / Artist / Album | | | | | ✓ | ✓ | ✓ |
| Random | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Three asymmetries worth stealing:
- **Release Date is a first-class sort only at Movies + Shows**; Seasons/Episodes sort on
  `episode.originallyAvailableAt` (per-episode air date), and Music exposes release only at **Album**
  (with a **Decade** companion). A "release timeline" belongs at the item level, not the leaf.
- **`addedAt` sorts at EVERY level**, and TV adds a distinct **"Last Episode Date Added"**
  (`episode.addedAt`) — "which of my shows got a new episode most recently."
- **Resolution & Duration disappear at the Season level** (a season has no single value); they
  reappear at Episode (one file per episode). Don't offer a sort the level can't answer.

### Per-view filter facets (condensed)

- **Movies:** Genre, Year, **Decade**, Content Rating, Studio, Director, Writer, Actor, Country,
  Collection, Label, Edition, Resolution, HDR, Dolby Vision, Audio/Subtitle language, Duration,
  Plays, Critic/Audience/My rating, **Date Added range**, **Release Date range**, Last Played,
  Unplayed, In Progress, Duplicate, Unmatched.
- **TV — Shows:** Genre, Year, Decade, Network/Studio, Content Rating, Country, Collection, Label,
  Actor, ratings, Unplayed, **Has Unplayed Episodes**, In Progress, Date Added, First Aired, Last
  Played — **plus cross-level filters** `episode_air_date`, `episode_added`, `episode_last_played`,
  `episode_year`, `episode_actor`, `episode_collection`… ("filter the show by its episodes").
- **TV — Seasons:** thin — Collection (`season_collection`), Label, Unplayed, Date Added; mostly
  inherits show tags.
- **TV — Episodes:** Episode Title, **Air Date range**, Date Added, Last Played, Year, Resolution,
  HDR, Duration, Plays, Unplayed, In Progress, Audio/Subtitle language, Content Rating, Director,
  Writer, Actor, Collection, Label, ratings.
- **Music — Artists:** Genre, Style, Mood, Country, Collection, Label, My Rating, Date Added, Last
  Played, Unplayed. **Albums:** Genre, Style, Mood, Format, Type, Source, Collection, Label,
  **Record Label**, Year, **Decade**, Critic/My rating, Plays, Date Added, **Release Date**, Last
  Played, Unplayed. **Tracks:** Mood, Source, Label, My Rating, Plays, **Skips**, Date Added, Last
  Played, **Last Skipped**, Duration, Unplayed.

**Per-user note:** `viewCount`, `lastViewedAt`, `unviewedLeafCount`/On-Deck, `userRating`/
`lastRatedAt` are tracked **independently per Plex Home / managed user** — any Unplayed / Last
Played / My Rating sort/filter is inherently viewer-scoped, not a library-global fact
([Plex support: Sync Watch State & Ratings](https://support.plex.tv/articles/sync-watch-state-and-ratings/)).
`addedAt`, `originallyAvailableAt`, `rating`/`audienceRating`, and tag facets are library-global.

---

## PART 2 — Map to OUR data (per kind)

**Legend:** ✅ available now · 🟡 syncable with a small named change · 🔴 not feasible without a
bigger change / new source. Population figures could **not** be verified live this session —
kubectl to `haynes-ops` was unreachable (queries to `postgres16-7` hung; even `get pods` timed
out — the known kubectl-outage fallback). Presence/population below is asserted from the sync +
harvest **code**, flagged `code-verified, live-unverified`.

### 2a. The seam: three data engines

| Wall(s) | Backing store | Read path | Both must-have dates? |
|---|---|---|---|
| Movies; TV **Shows**; Music **Artists** | Postgres `media_items` ⟕ `media_metadata` | D-09 `ledger.search` engine (`ledger-query.ts`) | Date Added ✅ (`arr_added_at`); Date Released 🟡 (`year` only) |
| TV **Seasons/Episodes** drill-in; **Peloton**; **YouTube** | live Plex | `plexReadClient.listSectionContents / listMetadataChildren` → `ledger.plexSeasons`, `ytdlsub` | Date Added ✅ (`addedAt`); Date Released ✅ (`originallyAvailableAt`) — both already parsed in `sectionItemSchema` |
| Books; Comics; Audiobooks | Postgres `books_items` | `books` router (+ shipped `books.filterFacets`) | Date Added ✅ (`source_added_at`); Date Released 🟡/🔴 (`year` ABS-only) |

### 2b. Dimension → our-data matrix (ledger-backed kinds)

| Plex dimension | Movies (radarr) | TV Shows (sonarr) | Music Artists (lidarr) | Source column / gap |
|---|---|---|---|---|
| Title / sort | ✅ | ✅ | ✅ | `media_items.title` / `sort_title` |
| Year | ✅ | ✅ (first-aired yr) | — (artists have none) | `media_items.year` |
| **Date Added** | ✅ | ✅ | ✅ | `media_metadata.arr_added_at` ← *arr `added`; **already a `SORT_SPECS.added_at` sort** |
| **Date Released** | 🟡 | 🟡 | — | store only `year`. Radarr `inCinemas`/`digitalRelease`/`physicalRelease` + Sonarr `firstAired` exist upstream but are **not in our zod subset** → add field + column + adapter |
| Critic/Audience rating | ✅ | ✅ (single→tmdb slot) | 🔴 | `imdb_rating`/`tmdb_rating`/`rt_tomatometer` |
| My rating (`userRating`) | 🔴 | 🔴 | 🔴 | per-user; not harvested (see Part 3) |
| Content rating | 🔴 | 🔴 | — | not parsed (Radarr/Sonarr expose `certification` upstream) |
| Duration / runtime | ✅ | ✅ | 🔴 | `media_metadata.runtime_minutes` (already `SORT_SPECS.runtime`) |
| Resolution | ✅ | ✅ (dominant tier) | — | `media_metadata.resolution` (already a filter facet) |
| Genre | ✅ | ✅ | ✅ | `media_metadata.genres` (already a filter facet) |
| Studio / Network | 🔴 | 🔴 | — | not parsed (upstream `studio`/`network` available) |
| Director/Writer/Actor/Country | 🔴 | 🔴 | 🔴 | not parsed; heavier harvest |
| Collection / requester | ✅ | ✅ | ✅ | `source_collections` / `requesters` (tag-derived; already facets) |
| Last Played / Plays / Unplayed | 🟡 household · 🔴 per-user | same | same | `last_viewed_at`/`play_count` = Tautulli **household** SUM/MAX; per-user in Part 3 |
| Size on disk | ✅ | ✅ | ✅ | `media_items.size_on_disk` |
| Decade | 🟡 | 🟡 | — | derive from `year` (trivial, no new data) |

Music **Albums/Tracks** are **not synced** — only the artist is a ledger row (`ARR_KINDS` top-level
only). Lidarr `album.releaseDate` exists upstream but isn't persisted. An Albums/Tracks view would
be **live Plex reads** (like TV episodes) or a new ledger surface (bigger — treat as out of R2 defaults).

### 2c. Plex-live kinds (TV Seasons/Episodes, Peloton, YouTube)

`sectionItemSchema` (`packages/plex/src/schemas.ts`) already carries, per item:
`titleSort`, `year`, **`addedAt`** (epoch secs — Date Added ✅), **`originallyAvailableAt`**
('YYYY-MM-DD' — Date Released / episode Air / YouTube upload ✅), `index` (season/episode #),
`duration` (episode runtime ms), `childCount`/`leafCount`, `guid`/`Guid`. So for these walls both
must-have dates + title + year + index + duration are **available now, live**. What is **NOT** on
that shape: rating, genre, resolution/HDR, content rating, per-user watch state — adding any of
those means requesting more Plex fields (and, for watch, the per-user problem of Part 3). Today the
drill-in (`ledger.plexSeasons`) only pulls season/episode NUMBER + art, so a sort/filter registry
here means widening the existing Plex read, not new sync.

### 2d. Books kinds (`books_items`)

| Dimension | Books (Kavita) | Comics (Kavita) | Audiobooks (ABS) | Column / gap |
|---|---|---|---|---|
| Title / sort | ✅ | ✅ | ✅ | `title` / `sort_title` |
| Author | ✅ (folder-derived) | 🔴 (comics folder = series, no author) | ✅ | `author` |
| Narrator | — | — | ✅ | `narrator` (ABS only) |
| Series | 🔴 (Kavita series **is** the title) | 🔴 | ✅ | `series_name` (ABS only) |
| **Date Added** | ✅ | ✅ | ✅ | `source_added_at` ← Kavita `created` / ABS `addedAt` |
| **Date Released / pub** | 🔴 (`year` null — Kavita all-v2 carries none) | 🔴 | 🟡 `year` only | `year` ABS `publishedYear`; full ABS `publishedDate` + Kavita `releaseYear` need a per-item metadata fetch |
| Genre | 🔴 (empty in series list) | 🔴 | ✅ | `genres` (ABS only) |
| Format (epub vs cbz/cbr) | ✅ | ✅ | — | `attrs.format` (Kavita format int) |
| Page count / word count | ✅ | ✅ | — | `page_count` / `word_count` |
| Duration | — | — | ✅ | `duration_seconds` (ABS) |
| Size on disk | 🔴 | 🔴 | ✅ | `size_bytes` (ABS only) |
| Language | 🔴 | 🔴 | ✅ | `attrs.language` (ABS) |
| Read-state | 🟡/🔴 | 🟡/🔴 | 🟡 | per-user; Part 3 |

Honest note: **Kavita rows are sparse** (no year, no genres, no author for comics) because the
`Series/all-v2` list omits them; enriching would need a per-series detail call. **ABS rows are
rich.** So the R8 "all book facets" ruling is fully feasible for Audiobooks now, and for Kavita
Books/Comics only for format/pages/date-added/title unless we add a Kavita metadata fetch.

### 2e. The two must-have dates — explicit verdict

- **Date Added** — ✅ everywhere today (code-verified): `media_metadata.arr_added_at` (movies/
  shows/artists), Plex `addedAt` (seasons/episodes/Peloton/YouTube), `books_items.source_added_at`
  (books/comics/audiobooks). It's **already `SORT_SPECS.added_at`** in the engine. **This is a
  surfacing task, not a sync task.** Optional upgrade: TV **"Last Episode Date Added"** (a genuinely
  useful "what got a new episode" sort) is a rollup we don't compute — derivable from a live Plex
  children read or a Sonarr episode scan.
- **Date Released** — the real gap. 🟡 for Movies (add Radarr `digitalRelease`/`inCinemas`/
  `physicalRelease`), 🟡 for TV Shows (add Sonarr `firstAired`), ✅ live for Episodes/Peloton/
  YouTube (`originallyAvailableAt`), 🟡 Audiobooks (`year` now; full date needs ABS `publishedDate`),
  🔴 Kavita Books/Comics (no date in the list read — needs a metadata fetch). Recommend one canonical
  `released_at timestamptz` per ledger kind (radarr: prefer `digitalRelease` ?? `inCinemas`; sonarr:
  `firstAired`) added to the sync + a `SORT_SPECS.released_at` + a Release-Date range facet.

---

## PART 3 — Per-user watch/read-state feasibility (R7)

### 3a. Identity signals we already have

1. **App user identity** (`packages/auth`): Better Auth `users` row + app/OIDC email. `resolvePlexIdentity`
   (`hooks/plex-identity.ts`) yields `{ userId, email, username }` where **`userId` = the plex.tv
   NUMERIC id** from the `plex_user_id` OIDC claim (immutable, the strongest key, reliably present
   for the owner), and email/username come from the claim OR the admin-set `users.plex_email` /
   `users.plex_username` **override columns**.
2. **plex.tv sharing ACL** (`packages/plex`): friend list `<User id,email,username,title>` and
   `SharedServer <userID,email,username>`. The matchers already exist and are used for library
   sharing: `findFriendById(plexUserId)` (numeric), `findFriendByEmail`, `findFriendByIdentity`
   (email OR username, with app-email fallback). **The app-user↔plex.tv-account map is already
   solved and in production** — R7 reuses it, doesn't invent it.
3. **Household watch signals = Tautulli** (`packages/arr/tautulli.ts`). `get_history` rows carry
   **`user`** (a display name string), `rating_key`, `grandparent_rating_key` (series rollup),
   `watched_status` (1 / partial), `date`. **Today the metadata harvest collapses this to a
   household aggregate** — `media_metadata.play_count`/`last_viewed_at`/`last_watched_at` are SUM/MAX
   across all three Tautulli instances (per the table doc), and the **per-`user` dimension is
   discarded**. The trash walls' "watch" facets read that same household aggregate via the
   metadata join — **Maintainerr is NOT a watch source** (it supplies rule-collection membership only).
4. **Books per-user progress** (`packages/books`): both servers track per-user progress
   (Kavita `pagesRead`/`percentComplete` + per-user apiKey; ABS `mediaProgress` `isFinished`/
   `progress`) — but our clients log in as a **single service account** and read only the catalog,
   never progress. **Kavita/ABS accounts are separate identity systems** with no shared id with plex.tv.

### 3b. Three concrete mapping approaches (with gaps)

- **A — Numeric-id join (strongest; video).** app user → `resolvePlexIdentity.userId` (plex.tv
  numeric id) → **Tautulli history `user_id`** → per-user video watch state.
  *Gap:* our Tautulli zod subset pulls `user` (name) but **not** `user_id` — a one-field schema
  add. Requires plays to have happened under a Plex account that maps to a plex.tv id (owner + real
  Home users: fine; local/guest plays: no id). Covers video only.
- **B — Username/email fuzzy join (fallback; video).** Tautulli `user`/`friendly_name` or plex.tv
  friend email/username ↔ `resolvePlexIdentity` ↔ app user (same surface `findFriendByIdentity`
  already handles for shares). *Gap:* Tautulli friendly names are free-text/admin-editable and drift
  from the plex.tv username — lower confidence than A; good as a secondary matcher.
- **C — Explicit admin mapping table (deterministic; ALL sources).** New table keyed by app
  `user_id` carrying per-source handles: plex.tv `userId` (auto-filled from the OIDC claim when
  present), Kavita username, ABS user id. Mirrors the **existing** `users.plex_email`/`plex_username`
  override pattern (the codebase already chose manual overrides as the reliable fallback).
  *Gap:* manual upkeep; new users invisible until mapped. **But it's the only approach that also
  joins Kavita + ABS.** Recommend this as the R7 "domain seam" the Feed-attribution backlog reuses
  verbatim: A/B **auto-populate** it for video, admin fills the book handles.

### 3c. How books read-state joins

- **ABS (feasible):** admin `GET /api/users/{id}` returns `mediaProgress[]` (`isFinished`,
  `progress`, `currentTime`) — **an admin/service token can read ANY user's progress**, so with an
  app-user↔ABS-user-id map (approach C) audiobook read-state needs no per-user auth. Join key: our
  `books_items.external_id` = ABS libraryItemId, present in the progress rows.
- **Kavita (harder):** progress is per-account and there's **no admin "progress for user X"** in the
  read surface we use — realistically needs **per-user API keys** or an OIDC-linked Kavita (newer
  Kavita supports OIDC, which could unify identity with Authentik/Plex — a bigger, cleaner play).
  Join key: `books_items.external_id` = Kavita series id.

### 3d. Honest gaps

- Video per-user: cheap-ish — reuse the existing map, add Tautulli `user_id`, and **stop collapsing
  history** (or add a per-user rollup table alongside the household aggregate; don't regress the
  trash walls that depend on the household numbers).
- Books per-user: ABS yes via admin token + map; Kavita blocked on identity/tokens.
- **No per-user store exists at all** (confirmed: no prefs/state table in `schema/index.ts`). R1's
  server-side view/sort prefs and R7's account map are both **new tables** — design them together.

---

## PART 4 — Recommended per-view sort/filter registry (strawman)

Grounded in what's available now vs. a named small add. **Bold = new vs. the shipped D-09 engine**
(which today offers sort: `title, imdb_rating, tmdb_rating, rt_tomatometer, added_at, play_count,
last_viewed, runtime` + dir; filter: genre, resolution, rating min/max, collection/requester,
onDisk/wanted). Default sort per R6 in *italics*.

| Wall | Sorts (default *italic*) | Filter facets | New data needed |
|---|---|---|---|
| **Movies** | *Date Added*, **Release Date**, Title, **Year**, Rating (imdb/tmdb/RT), Runtime, Plays, Last Watched, Random | Genre, **Year/Decade**, Resolution, Rating threshold, Collection/Requester, **Unwatched/In-progress (household→per-user)**, on-disk | 🟡 Radarr release date; per-user watch (Part 3) |
| **TV — Shows** | *Date Added*, **Last Episode Added**, **First Aired**, Title, **Year**, Rating, Plays, Last Watched | Genre, **Year/Decade**, Rating, Collection, **Has-unwatched-episodes**, **Network** | 🟡 Sonarr `firstAired`; Last-Ep-Added rollup; per-user watch |
| **TV — Seasons** (Plex-live) | *Season #* (`index`), **Date Added**, Title | (thin) Unwatched, Collection | none (widen Plex read) |
| **TV — Episodes** (Plex-live) | **Air Date** (`originallyAvailableAt`), Season/Ep #, *Date Added*, Title, **Duration**, **Resolution** | **Air-date range**, **Resolution**, Unwatched/In-progress | none for dates; ratings/res need wider Plex read + per-user watch |
| **Music — Artists** | *Date Added*, Title (A–Z), Plays, Last Played, Random | Genre, Collection, Unplayed | per-user plays |
| **Peloton** (Plex-live) | *Date Added*, Title, **Release Date**, Duration | **Discipline/Class-type** (group-by per R2), **Duration bucket**, Instructor | none for dates; discipline via Plex tags |
| **YouTube** (Plex-live) | *Date Added*, **Upload Date** (`originallyAvailableAt`), Title, Duration | **Channel** (group-by per R2), **Upload-date range** | none |
| **Books** (Kavita) | *Author A–Z* (grouping), Title, **Date Added**, **Page count** | **Genre**(if enriched), **Author/Series**, **Format**, on-disk | 🟡 Kavita metadata fetch for year/genre; per-user read-state |
| **Comics** (Kavita) | *Series A–Z*, Title, **Date Added**, **Page count** | **Format** (cbz/cbr), **Series** | same as Books |
| **Audiobooks** (ABS) | *Author A–Z*, Title, **Release Year**, **Duration**, **Date Added** | **Genre**, **Author/Narrator/Series**, **Duration bucket**, **Language** | per-user read-state (ABS admin-readable) |

**Cross-cutting (all walls):** direction toggle (exists), A–Z jump bar on big walls (R5) keys off
`sort_title`, URL-synced view+grouping+sort (R4), per-user last-used persistence (R1 — new prefs
table). **Steal from Plex:** (a) only offer a level the sorts it can answer (no Duration/Resolution
at Season level); (b) the parent-filters-on-child move (shows by `episode_added`/`episode_air_date`)
as the "what's fresh" story; (c) Date Added and Release Date as **peer** toggles wherever both exist.

---

## Sources

- python-plexapi — Library module (sort/filter fields, `search()` grammar):
  https://python-plexapi.readthedocs.io/en/latest/modules/library.html
- Plex PMS media-queries / type map / sort modifiers (official): https://developer.plex.tv/pms/
- Kometa — Plex Smart Filters (per-level sort & filter tables):
  https://kometa.wiki/en/latest/files/builders/plex/smart-filter/
- Kometa — Plex Builders overview (sort labels): https://kometa.wiki/en/latest/files/builders/plex/overview/
- Plex support — Using the Library View (UI sort/filter/advanced filters):
  https://support.plex.tv/articles/200392126-using-the-library-view/
- Plex support — Sync Watch State and Ratings (per-user state):
  https://support.plex.tv/articles/sync-watch-state-and-ratings/
- Plex forum (gap-fill, marked in Part 1) — show "Release Date" / "Last Episode Date Added" behavior.
- Repo (read this session): `packages/db/src/schema/{media-items,media-metadata,books-items,plex-match}.ts`,
  `packages/db/src/schema/enums.ts`; `packages/sync/src/{adapt,books}.ts`;
  `packages/arr/src/schemas/{radarr,sonarr,lidarr,tautulli}.ts`, `packages/arr/src/{tautulli,maintainerr}.ts`;
  `packages/books/src/{schemas,read}.ts`; `packages/plex/src/{schemas,read}.ts`;
  `packages/auth/src/hooks/plex-identity.ts`; `packages/api/src/ledger-query.ts`,
  `packages/api/src/routers/ledger.ts`.
- **Prod population unverified** — kubectl `haynes-ops` unreachable this session (queries hung); all
  presence claims are code-verified only.
