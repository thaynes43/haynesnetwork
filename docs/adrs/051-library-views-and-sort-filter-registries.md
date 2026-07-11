# ADR-051: Library views, grouping, and per-view/per-engine sort & filter registries

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Tom Haynes (owner rulings 2026-07-11 — PLAN-029 R1–R8, all round-1 + round-2 questions answered) · ratified by Fable 5 (PLAN-029 design phase)
- **Relates:** EXTENDS the [ADR-018](018-library-metadata-modeling.md) / [DESIGN-008](../designs/008-library-metadata-enrichment.md)
  **D-09** shared `ledger.search` filter/sort engine (`packages/api/src/ledger-query.ts` — `SORT_SPECS`,
  `LIBRARY_FILTER_SHAPE`, the NULLS-LAST keyset cursor) and the [ADR-046](046-books-library-ledger-source.md) /
  [DESIGN-024](../designs/024-books-library.md) `books.search`/`books.filterFacets` contract; reads the
  [ADR-038](038-ytdlsub-library-direct-plex-read.md) live-Plex walls (Peloton/YouTube) and the TV Seasons/Episodes
  drill-in ([ADR-048](048-tv-season-episode-art-from-plex-match.md)). Inherits the [DESIGN-004](../designs/004-ui-shell-and-dashboard.md)
  **D-19** history-navigation contract (screen-level view switches PUSH, refinements REPLACE) and is bound by
  [ADR-015](015-no-layout-reorientation-on-interaction.md) (no reorientation) + CLAUDE.md hard rule 2 (no raw hex).
  Access is unchanged — every read path still passes the [ADR-047](047-library-play-here-access-aware-deep-links.md)
  library-access gate (THE INVARIANT). Companion ADRs: **ADR-052** (per-user library preferences),
  **ADR-053** (per-user watch/read-state). Realized by **DESIGN-026**. Implements PRD **R-165..R-168, R-171**;
  glossary **T-149..T-152**.

## Context and problem statement

The Library walls today are one shape: a flat poster grid with ONE global sort control and a fixed chip bar,
built on the D-09 engine (sort: `title, imdb_rating, tmdb_rating, rt_tomatometer, added_at, play_count,
last_viewed, runtime`; filter: genre, resolution, rating, collection, requester). The owner wants Plex-grade
browsing (PLAN-029 R2/R5/R6):

1. **Different views per tab** — Books/Audiobooks grouped by Author, Comics by Series, Peloton by Exercise,
   YouTube by Channel, Movies a flat wall, TV its existing Shows → Seasons → Episodes hierarchy (R2). A wall is
   not just a grid anymore; the presentation is selectable and has an opinionated default per kind.
2. **Different sort/filter per view** — the owner's explicit emphasis: *"Episodes ≠ Shows."* A season has no
   single resolution or duration; an episode has an air date a show cannot sort by; an artist has no year. A
   flat, one-size sort/filter list is wrong. The Plex recon (`.agents/context/2026-07-11-plex-sort-filter-recon.md`)
   confirms Plex's whole trick is that **sort/filter capability is advertised PER libtype**, and the leaf level
   carries dimensions the parent can't. That asymmetry is the thing worth stealing.
3. **Two must-have dimensions the walls don't surface** — **Date Added** and **Date Released**, which the owner
   uses constantly in Plex. Date Added already exists everywhere (see the verification below); Date Released is a
   real data gap for Movies/TV-Shows and Kavita books.

The problem: the data behind the walls does **not** live in one engine, so a single sort/filter contract cannot
serve them. The recon identified — and this session's live queries confirmed — **three data engines** with
different capabilities, and forcing them into one DSL (or forking three unrelated ones) both fail.

### Live verification (this session, read-only against `haynesnetwork` on `haynes-ops`)

The recon's population claims were code-verified but kubectl-unverified. Confirmed live 2026-07-11:

| Claim | Live result | Verdict |
|---|---|---|
| Date Added present everywhere | `media_metadata.arr_added_at` = **100%** on all live rows (radarr 9569/9569, sonarr 1026/1026, lidarr 7211/7211); `books_items.source_added_at` = **100%** (ABS 823, Kavita book 1283, Kavita comic 50) | ✅ Date Added is a surfacing task, not a sync task |
| Year (today's Date-Released proxy) | radarr 9569/9569, sonarr 1026/1026, **lidarr 0** (artists have no year) | ✅ confirms year-only precision + Music has none |
| Watch stats are household + sparse | `play_count`/`last_viewed_at` non-null on radarr **360/9569 (3.8%)**, sonarr **193/1026 (18.8%)**, lidarr **0** | ✅ the household Tautulli signal is real but thin (grounds ADR-053) |
| Book facet richness | ABS: author 100%, genres 91%, duration 100%, language 100%, **narrator 16%**, **series 3/823**; Kavita book: author 96%, page_count 100%, format 100%, **year/genres/narrator/series 0**; Kavita comic: page_count/format 100%, **author/year/genres 0** | ✅ ABS rich, Kavita sparse — R8 "all book facets" is fully feasible for ABS now, Kavita only for author/pages/format/date-added |
| No per-user prefs/state/map table | none found | ✅ ADR-052 + ADR-053 tables are genuinely new |

Two honest corrections to the recon strawman from the live data: ABS **series** is nearly empty (3/823) and ABS
**narrator** is partial (16%), so those two book facets must be **populated-value-gated** (offered only when the
kind actually carries values — the existing `filterFacets` DISTINCT pattern already does this).

## Decision drivers

- **Owner rulings are normative** (R2/R5/R6): selectable views with opinionated defaults; different sort/filter
  per view; Date Added + Date Released as must-haves; sensible default sort per kind.
- **Respect the three-engine seam** — do not fork the D-09 engine, and do not bend live-Plex or books data into
  the \*arr-shaped DSL (the ADR-046 lesson: books already have their OWN wire contract for exactly this reason).
- **Steal Plex's asymmetry, not a longer flat list** — declare capability per view, and never offer a sort a
  level can't answer (no Duration/Resolution at the Season level).
- **Economical, no gold-plating** (owner budget directive) — extend the shipped engines and the shipped filter
  UI; add the smallest data plumbing the must-have dimensions need; defer pixel-level UX judgment to the build.
- **No regressions** — the existing flat Movies/Music grid is just the default view of the new model; the
  D-09 wire shape, the keyset cursor, the access gate (ADR-047), and ADR-015 all stay intact.

## Considered options

### How sort/filter capability is modeled

1. **One flat, global sort/filter list across all walls** (today). Rejected by R5: it offers Resolution on a
   Season (unanswerable), Runtime on an Artist (none), and no per-level air-date/index sorts. It is exactly the
   "longer flat list" the recon warns against.
2. **A per-view REGISTRY that DECLARES the sort keys + filter facets each view offers, resolved against the
   view's backing engine** (chosen). A small, static, per-(wall, view-level) capability table — the app-side
   analogue of Plex advertising fields per libtype. Each registry entry names a sort key or facet and binds it to
   its engine's expression (a `SORT_SPECS` column for ledger walls, a Plex field for live walls, a `books_items`
   column for book walls). The UI renders exactly what the active view's registry lists; nothing more.
3. **Fork three independent sort/filter systems (one per engine).** Rejected: it duplicates the chip/sort UI
   three times and lets the contracts drift. The registry is the ONE seam that lets three engines share ONE UI.

### The three engines the registries span (the seam, respected not erased)

- **Ledger engine** — Movies, TV **Shows**, Music **Artists** read Postgres `media_items ⟕ media_metadata`
  through the D-09 `buildLibraryWhere` + `SORT_SPECS` + keyset cursor. Extended, not replaced (new sort keys +
  facets append to the existing arrays).
- **Plex-live engine** — TV **Seasons/Episodes** drill-in, **Peloton**, **YouTube** read Plex section/children
  live; `sectionItemSchema` already parses `addedAt`, `originallyAvailableAt`, `index`, `duration`, `year`, so
  both must-have dates + title/index/duration are available at these levels **for free**.
- **Books engine** — Books, Comics, Audiobooks read `books_items` through the ADR-046 `books.search` contract.
  Extended with per-medium facets + sorts (author/series, narrator, format, duration/length buckets).

### The view + grouping model

4. **Selectable views per tab with an opinionated default** (chosen, R2). A wall renders as one of: a **flat
   grid** (default for Movies), a **grouped view** (aggregate cards keyed by a dimension — Author/Series/Channel/
   Exercise → item count + stacked covers → drill into the filtered grid), or the existing **hierarchy** (TV:
   Shows → Seasons → Episodes, unchanged). The default view per kind is the R2 ruling; the user can switch views
   and their choice persists (ADR-052). Grouping is **queries + view shells over the existing engines** — the
   data already exists (`author`/`series_name` on `books_items`, channel/discipline as Plex tags, `arr_kind`), so
   a group view is a GROUP BY / distinct-key aggregate, not a new store.

### The Date Released gap

5. **Add a canonical `released_at` timestamp to the ledger walls via sync + surface `originallyAvailableAt`
   already present on the live walls** (chosen — folded here as the data layer the registry's "Release Date"
   dimension needs, C-05). Date Released is the real gap: Movies/TV-Shows/Kavita-books store only `year`. Radarr
   (`digitalRelease`/`inCinemas`/`physicalRelease`) and Sonarr (`firstAired`) expose a precise date upstream but
   it is not in our zod subset; ABS has `publishedDate`. Alternatives — deriving from `year` (rejected: `year`
   is a January-1 lie that mis-sorts within a year) or a whole TMDB re-harvest (rejected: overkill; the \*arr
   list already carries the field). This is the ONE new sync/schema surface of this ADR.

## Decision outcome

Chosen options **2 + 4 + 5**: **per-view, per-engine sort/filter REGISTRIES** feeding ONE filter/sort UI over
**three respected engines**, a **selectable view model with R2 defaults** (grouped/flat/hierarchy), and a
**canonical `released_at`** added to the ledger walls so Date Added + Date Released are peer dimensions
everywhere feasible.

- **The registry** (DESIGN-026 D-02/D-03). A static per-(wall, view-level) declaration: `{ sorts: SortKey[]
  (with a per-view default + direction), facets: FacetKey[] }`, each key bound to its engine's expression. The UI
  reads the active view's registry and renders exactly those sort options + facet chips — capability is declared,
  not hard-coded per component. The ledger registry extends `LIBRARY_SORT_FIELDS`/`LIBRARY_FILTER_SHAPE` with
  `released_at` (+ a Release-Date range facet) and Year/Decade (derived from `year`, no new data); the books
  registry extends `BOOKS_SORTS` + `books.filterFacets` with author/series, narrator, format, and length buckets;
  the live-Plex registry surfaces `originallyAvailableAt`/`index`/`duration` at the levels that have them.
- **Plex-style asymmetry is honored** — the registry for a level lists ONLY the dimensions that level can
  answer: Release Date is first-class at Movies + Shows (not Seasons/Episodes, which sort on per-episode air
  date); Resolution/Duration appear at Episode, not Season; Runtime is absent from Music; TV gains a **"Last
  Episode Added"** rollup sort. Date Added sorts at every level.
- **Views + grouping** — the per-tab default is R2 (Movies flat · TV hierarchy · Music Artists · Peloton Exercise
  · YouTube Channel · Books Author · Comics Series · Audiobooks Author); a group view is an aggregate-card shell
  that drills into the same engine's filtered grid. TV's Shows → Seasons → Episodes shape is untouched.
- **`released_at`** — a new nullable `released_at timestamptz` on the ledger metadata, populated by the sync
  (Radarr: `digitalRelease ?? inCinemas ?? physicalRelease`; Sonarr: `firstAired`; ABS: `publishedDate` when the
  item detail is fetched), a new `SORT_SPECS.released_at`, and a Release-Date range facet. Live-Plex walls need
  no add (`originallyAvailableAt` is already parsed). Kavita books have no date in the list read → Release Date is
  simply absent from their registry (honest gap, not a fake column).
- **Everything rides the existing rails** — the ADR-047 access gate wraps every read unchanged; the D-19 history
  contract governs the new view/group-by URL segments (a view switch PUSHes, a sort/filter/group refinement
  REPLACEs); ADR-015 (reserve widest, no reflow) and hard rule 2 (tokens only) bind the UI.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: ONE filter/sort UI serves three engines because capability is DECLARED per view (the registry), not coded per wall. Adding a dimension to a wall is a registry-row edit + (if new data) an engine expression, never a new component. |
| C-02 | Good: Plex's asymmetry is captured cheaply — a level offers only the sorts/facets it can answer, so no dead "Resolution on a Season" control ships. The registry is the enforcement point. |
| C-03 | Good: grouped views are queries + shells over the existing engines (no new store) — the grouping data (`author`, `series_name`, Plex channel/discipline tags, `arr_kind`) already exists and is live-verified populated where R2 groups on it (author 96–100% on the walls that group by author). |
| C-04 | Neutral: the D-09 wire contract GROWS (new sort keys + facets) but does not FORK — `ledger.search`, the keyset cursor, and the access gate are extended in place; `books.search` grows its own contract (ADR-046 precedent); live walls widen their Plex read. Three engines, one UI, no fourth store. |
| C-05 | Cost: **`released_at` is the one new data surface** — a nullable metadata column + Radarr/Sonarr adapter fields + an ABS published-date fetch + a `SORT_SPECS.released_at` + a range facet (migration next-free at build; adapters in `@hnet/arr`/`@hnet/sync`). Bounded and additive; a null `released_at` sorts NULLS-LAST like every other nullable sort (the keyset already handles it). Kavita book/comic Release Date stays honestly absent. |
| C-06 | Cost/accepted: some registry dimensions depend on data that is SPARSE or ADMIN-gated (watch/read-state — ADR-053; ABS narrator 16% / series 3/823) — those facets are **populated-value-gated** (rendered only when the kind carries values, the existing `filterFacets` DISTINCT behavior) so an empty facet never shows a dead chip. |
| C-07 | Good: no visual regression — the flat Movies/Music grid is simply the DEFAULT view of the new model; existing deep links keep working (the view/group params default to R2 when absent); ADR-015 + hard rule 2 unchanged. |

## More information

- Realized by **DESIGN-026** (the view-selector model D-01, the registry seam + contract D-02, the per-wall
  registry contents D-03, group-view cards D-04, `released_at` data layer D-05, facet UI D-08, A–Z jump bar D-09,
  URL contract D-10, and the DEFERRED-to-build UX list D-11).
- Numbering: takes **ADR-051** (ADR-050 claimed by the concurrent PLAN-034 Helpdesk PR #210); the `released_at`
  migration + the two per-user tables (ADR-052/053) take next-free migration numbers **at build time** (PLAN-034
  claimed 0040; the higher-priority PLAN-031 may consume more before PLAN-029 builds — the plan tracks the actual
  numbers, per the `.agents/plans/README.md` reconciliation rule).
- The build-phase UX pass owns pixel-level judgment (view-switcher affordance, group-card art density, jump-bar
  placement) — this ADR decides the model, DESIGN-026 D-11 lists what is deliberately deferred.
