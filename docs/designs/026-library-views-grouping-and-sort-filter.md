# DESIGN-026: Library views, grouping, and the per-view Sorting & Filtering overhaul

- **Status:** Accepted <!-- ratified with ADR-051/052/053 on 2026-07-11; the Draft label was a docs-only-PR oversight (noted by the PLAN-029 data/domain build, fixed in the UX build PR) -->
- **Last updated:** 2026-07-13 <!-- group-card ART pass: D-04 art amendment (author portraits / glyph tiles / `?by=` grouping dimension), live art-source grounding table, D-11 art-density closure -->
- **Satisfies:** PRD-001 **R-165..R-171**; governed by **ADR-051** (views + registries), **ADR-052** (per-user
  preferences), **ADR-053** (per-user watch/read-state). EXTENDS **DESIGN-008 D-09** (the shared `ledger.search`
  filter/sort engine + keyset cursor) and **DESIGN-024** (the `books.search`/`filterFacets` contract); reads the
  live-Plex walls of **DESIGN-017** (ytdl-sub) and the TV drill-in of **DESIGN-005 D-22**. Inherits **DESIGN-004
  D-19** (history-navigation) and is bound by **ADR-015** (no reorientation) + **ADR-047** (the library-access
  invariant, unchanged) + CLAUDE.md hard rule 2 (tokens only). Bounded context **DDD-002 BC-03 Media Ledger**
  (extends DESIGN-008). Glossary **T-149..T-155**.

> **Scope discipline (owner budget directive — economical, one pass done well).** This design decides the
> **architecture** — the view model, the registry seam, the per-wall registry CONTENTS, the two new per-user
> tables, and the `released_at` data add. **Pixel-level UX judgment is DEFERRED to the build phase's UX pass**
> (D-11 lists exactly what is deferred). "Architecture decided, pixels deferred."

## Overview

The Library today is one flat poster grid per tab with a single global sort and a fixed chip bar (DESIGN-008
D-10/D-11). PLAN-029 makes a wall's presentation a real, per-user choice (**views** + **grouping**) and gives
each view the sort/filter dimensions *that view* can answer (**per-view registries**), grounded in the
three-engine seam the Plex recon identified and this session's live queries confirmed. Two dimensions the owner
uses constantly in Plex — **Date Added** (already present everywhere) and **Date Released** (a real gap for
Movies/TV-Shows/Kavita) — become peer sorts/facets wherever feasible. Per-user watched/in-progress (video) and
read (ABS) facets arrive via a reusable identity-mapping seam. Everything rides the existing rails: the D-09
engine + keyset cursor (extended, not forked), the ADR-047 access gate (unchanged), and the D-19 history
contract (view switches PUSH, refinements REPLACE).

### Live-verified grounding (read-only SELECTs, `haynesnetwork` on `haynes-ops`, 2026-07-11)

| Fact | Live result |
|---|---|
| Date Added everywhere | `arr_added_at` 100% on all live \*arr rows; `books_items.source_added_at` 100% |
| Year precision | radarr/sonarr 100%; **lidarr 0** (artists have no year) |
| Household watch is thin | `play_count` non-null: radarr 360/9569, sonarr 193/1026, **lidarr 0** |
| Book facets | ABS: author 100%, genres 91%, duration 100%, language 100%, **narrator 16%**, **series 3/823**; Kavita book: author 96%, pages 100%, format 100%, **year/genres/series 0**; Kavita comic: pages/format 100%, **author/year/genres 0** |
| No per-user store | none — ADR-052 + ADR-053 tables are new |

### Live-verified art-source grounding (group-card ART pass, port-forward probes, 2026-07-13)

| Fact | Live result |
|---|---|
| ABS author photos | `GET /api/libraries/{id}/authors` carries `imagePath`/`updatedAt`; photos are **Audnexus-backed via ABS's own author match**. Live library: **0/130 matched at probe time**; one probe match (John Grisham) filled the photo and `GET /api/authors/{id}/image?width=300&format=webp` returned a **2.7 KB WebP** (400×267 original) — pipeline proven, population is one owner "Match all authors" run in ABS |
| Kavita person images | Kavita 0.9.0.2 `POST /api/Person/all`: **0 of 1156 people carry a coverImage** (person art is effectively a Kavita+ feature); `person-cover`/`person-image` 404. **Not wired** — the cover fan stands for Kavita author cards (honest gap) |
| Peloton / YouTube | discipline/channel cards are Plex shows with posters (Peloton = the PLAN-024 durable poster-guard art) already streaming through `/api/ytdlsub/poster` — no new wiring |
| Comics | a Kavita row IS a series; the wall already wears real series covers via `/api/books/cover` |

## Detailed design

### D-01 — The view-selector model + R2 defaults

Each Library kind tab renders a **wall** in one of three **view shapes**:

- **flat** — the current poster grid (DESIGN-008 D-11), one card per item.
- **grouped** — aggregate cards keyed by a grouping dimension (D-04); tapping a card drills into the same
  engine's filtered grid for that group.
- **hierarchy** — the existing TV Shows → Seasons → Episodes drill-in (DESIGN-005 D-22), unchanged.

A **view selector** on the wall lets the user switch shapes (where a wall offers more than one) and, for grouped
walls, choose the group-by dimension. Each tab has an **opinionated default** (R2), and the user's last choice
persists per user (D-06). Defaults, per the owner ruling:

| Wall | Default view | Group-by (grouped) | Engine |
|---|---|---|---|
| Movies | flat | — | ledger |
| TV | hierarchy (Shows → Seasons → Episodes) | — | ledger (Shows) + Plex-live (Seasons/Episodes) |
| Music | flat (Artists) | — | ledger |
| Peloton | grouped | **Exercise** (discipline) | Plex-live |
| YouTube | grouped | **Channel** | Plex-live |
| Books | grouped | **Author** | books |
| Comics | grouped | **Series** | books |
| Audiobooks | grouped | **Author** | books |

TV is NOT flattened — it already embodies the hierarchy the owner wants (owner clarification R2). A wall may
offer a flat alternative to a grouped default (e.g. Books as a flat A–Z grid) — which shapes each wall offers is
a **DEFERRED build-phase UX call** (D-11); the DEFAULTS above are fixed here.

### D-02 — The three-engine registry seam + the registry contract

The load-bearing seam (ADR-051). Sort/filter capability is **declared per (wall, view-level)** in a static
**registry**, and each declared key binds to its backing engine's expression. The registry is the ONE place that
lets three engines share ONE filter/sort UI (the DESIGN-008 D-10 `@hnet/ui` filter engine).

A registry entry, conceptually:

```
LibraryViewRegistry = {
  wall: WallId,                 // movies | tv-shows | tv-seasons | tv-episodes | music | peloton | youtube | books | comics | audiobooks
  engine: 'ledger' | 'plex-live' | 'books',
  sorts: Array<{ key: SortKey; label: string; default?: dir }>,   // ONLY the keys this level can answer
  facets: Array<{ key: FacetKey; kind: 'enum' | 'range' | 'toggle' }>,
  defaultSort: { key: SortKey; dir: 'asc' | 'desc' },              // R6 per-kind default
}
```

- **Ledger engine** (Movies, TV Shows, Music Artists) — sort keys resolve to `SORT_SPECS` columns
  (`packages/api/src/ledger-query.ts`); facets resolve to `buildLibraryWhere` predicates. This design EXTENDS
  `LIBRARY_SORT_FIELDS` with **`released_at`** (D-05) + **`year`** and `LIBRARY_FILTER_SHAPE` with a Release-Date
  range, a Year/Decade facet (derived from `year`, no new data), and the per-user watch facets (D-07). The
  keyset cursor already sorts any nullable column NULLS-LAST — `released_at`/`year` need no cursor change.
- **Plex-live engine** (TV Seasons/Episodes, Peloton, YouTube) — sort/filter over the live Plex read.
  `sectionItemSchema` already carries `addedAt`, `originallyAvailableAt`, `index`, `duration`, `year`, so Date
  Added + Date Released (air/upload) + index + duration are available now; the registry declares which level
  offers which. Adding rating/genre/resolution here means WIDENING the Plex read (a DEFERRED, per-need call —
  D-11) — the must-have dates need no widening.
- **Books engine** (Books, Comics, Audiobooks) — sort keys resolve to `books_items` columns / `BOOKS_SORTS`;
  facets resolve to `books.filterFacets` (the shipped endpoint finally gets UI). Extended with author/series,
  narrator, format, and length buckets (D-08).

**Plex-style asymmetry (the thing worth stealing) — encoded in the registry:** a level lists ONLY dimensions it
can answer. Release Date is first-class at Movies + Shows (not Seasons/Episodes, which sort on per-episode air
date); Resolution/Duration appear at Episode, never Season (a season has no single value); Runtime is absent
from Music (artists have none); TV Shows gain a **"Last Episode Added"** rollup sort ("which show got a new
episode"). Date Added sorts at every level.

### D-03 — Per-wall registry CONTENTS (the verified strawman)

Grounded in the recon strawman + this session's live verification. **Default sort in *italics* (R6). Bold =
new vs. the shipped D-09/books engines.** Watch/read facets (D-07) are populated-value-gated (C-06).

| Wall (engine) | Sorts (default *italic*) | Filter facets | New data |
|---|---|---|---|
| **Movies** (ledger) | *Date Added*, **Release Date**, Title, **Year**, Rating (imdb/tmdb/RT), Runtime, Plays, Last Watched | Genre, **Year/Decade**, Resolution, Rating threshold, Collection/Requester, on-disk, **Watched/In-progress (per-user)** | 🟡 `released_at` (Radarr); per-user watch (D-07) |
| **TV — Shows** (ledger) | *Date Added*, **Last Episode Added**, **First Aired**, Title, **Year**, Rating, Plays, Last Watched | Genre, **Year/Decade**, Rating, Collection, on-disk, **Has-unwatched-episodes / Watched (per-user)** | 🟡 `released_at`=Sonarr `firstAired`; Last-Ep-Added rollup; per-user watch |
| **TV — Seasons** (Plex-live) | *Season # (`index`)*, **Date Added**, Title | (thin) Collection, Unwatched | none (widen Plex read only if facets grow) |
| **TV — Episodes** (Plex-live) | **Air Date (`originallyAvailableAt`)**, Season/Ep #, *Date Added*, Title, **Duration** | **Air-date range**, Unwatched/In-progress | dates free; resolution/rating need a wider Plex read (deferred) |
| **Music — Artists** (ledger) | *Date Added*, Title (A–Z), Plays, Last Played | Genre, Collection, on-disk | per-user plays (D-07) |
| **Peloton** (Plex-live) | *Date Added*, Title, **Release Date**, **Duration** | **Exercise/Discipline (group-by)**, **Duration bucket**, Instructor | none for dates; discipline via Plex tags |
| **YouTube** (Plex-live) | *Date Added*, **Upload Date (`originallyAvailableAt`)**, Title, **Duration** | **Channel (group-by)**, **Upload-date range** | none |
| **Books** (Kavita) | *Author A–Z (grouping)*, Title, **Date Added**, **Page count** | **Author (group-by)**, **Format** (epub/cbz), on-disk | Kavita metadata sparse — no year/genre facet (honest gap) |
| **Comics** (Kavita) | *Series A–Z*, Title, **Date Added**, **Page count** | **Series (group-by)**, **Format (cbz/cbr)** | same Kavita sparsity |
| **Audiobooks** (ABS) | *Author A–Z*, Title, **Release Year**, **Duration**, **Date Added** | **Genre**, **Author (group-by)**, **Narrator***, **Series***, **Duration bucket**, **Language**, **Read/In-progress (per-user)** | per-user read via ABS admin token (D-07) |

`*` ABS narrator (16%) + series (3/823) are populated-value-gated — offered only where the kind carries values.
Kavita Books/Comics get Author/Series/Format/Date-Added/Page-count only (year/genre absent in the list read —
adding them needs a Kavita per-series metadata fetch, a DEFERRED enhancement, D-11).

### D-04 — Group-view aggregate cards

A grouped wall (D-01) renders **one aggregate card per group key** instead of one per item:

- **Card content** — the group label (author / series / channel / discipline), an item **count**, and a small
  **stacked-cover** motif (a few member covers fanned/stacked; the exact art density is a DEFERRED UX call,
  D-11). Reserved dimensions so load/failure never reflows (ADR-015); KindIcon fallback per member.
- **Data** — a GROUP BY / distinct-key aggregate over the wall's engine: `books_items.author`/`series_name`
  (books), the Plex channel/discipline tag (Peloton/YouTube). No new store — the grouping keys are live-verified
  populated where R2 groups on them (author 96–100% on the author-grouped walls). A group's covers come from the
  same engine's rows (a bounded per-group sample).
- **Drill-in** — tapping a card opens the same wall in **flat** view pre-filtered to that group (an added
  `group=<key>` URL segment, D-10), with the wall's normal sort/filter registry active. Back returns to the
  grouped view (D-19: the drill-in is a screen-level PUSH).
- **Access** — the aggregate + its covers pass the ADR-047 gate like any other read; a group whose members are
  all withheld does not appear.

**D-04 art amendment (group-card ART pass, 2026-07-13 — owner directive: real imagery for every slice
dimension wherever a source exists, at the PLAN-030 Seasons/Episodes bar).** The art SLOT of an aggregate
card is now a ruled ladder per dimension (one component — `GroupCardArt`; everything renders inside the same
reserved 2:3 box, ADR-015; portraits fade in via the shared `.poster-img` reveal):

| Slice dimension | Card art (populated-value-gated at every rung) |
|---|---|
| **Author (Audiobooks/ABS)** | the author's REAL portrait — ABS's Audnexus-backed author photo, served by the new sibling proxy `/api/books/author-image` (ADR-041 idiom: fixed 300w WebP variant + original fallback tier + strong `(id, updatedAt, variant)` ETag + the shared books LRU; session + `books`-section gated like `/api/books/cover`). `books.groups` attaches the URL through an in-process TTL author DIRECTORY (`@hnet/books` `listAuthors` read — read-only, no ./write) ONLY where `imagePath` is non-null → a card never renders a broken slot. No photo / ABS down → the cover fan. |
| **Author (Books/Kavita)** | the cover fan stands — live-verified: Kavita person images are 0/1156 (a Kavita+ feature); NOT wired (honest gap, revisit if Kavita+ arrives). |
| **Channel (YouTube) / Exercise (Peloton)** | already REAL Plex show posters via `/api/ytdlsub/poster` (ADR-041; Peloton = the PLAN-024 poster guard) — these walls ARE their grouped views, unchanged. |
| **Series (Comics)** | already REAL Kavita series covers via `/api/books/cover` — the wall IS the series grid, unchanged. |
| **Abstract dimensions (genre; decade/format/length when they ship)** | NO fake art — a designed, token-themed GLYPH tile (`genre-glyphs.tsx`, the TicketCategoryIcon "icon large where a poster would be" precedent): the family glyph inside a thin ring on the tinted box. Genre ships as Audiobooks' second grouping dimension (`?by=genre`, `books.groups groupBy:'genre'` — label+count only), populated-value-gated like its facet chip. |
| **Universal fallback** | the 3-cover fan, then the KindIcon tile — unchanged. |

The grouped URL contract gains **`?by=<dimension>`** (omitted = the wall's default/first dimension; a
grouping switch is a screen-level PUSH like a view switch; the drill's `?group=` binds the drilled
dimension's own filter — author OR genre). `WALL_VIEWS` declares `groupings[]` per wall (default first)
with each dimension's art source; the genre grouped level (`audiobooks:grouped-genre`) sorts its cards
label/count like every grouped level.

### D-05 — The `released_at` data layer (the one new sync/schema surface)

Date Released is the real gap (ADR-051 C-05). Canonical approach:

- **Column** — a new nullable `released_at timestamptz` on the ledger metadata (`media_metadata`; migration
  next-free at build). One canonical instant per ledger item.
- **Population (sync adapters, `@hnet/arr` + `@hnet/sync`)** — Radarr: `digitalRelease ?? inCinemas ??
  physicalRelease`; Sonarr: `firstAired`; Lidarr: none (artists have no release date → null). These fields exist
  upstream but are not in our current zod subset → add the fields + the adapter mapping in the same change.
- **Books** — ABS `publishedDate` (a per-item detail read; today only `year` is synced, 71% populated) fills
  Audiobooks Release Year/Date; Kavita has no date in the list read → Release Date stays absent from the Kavita
  registry (honest gap, not a fabricated column).
- **Plex-live** — no add; `originallyAvailableAt` is already parsed (air date / upload date).
- **Surface** — a new `SORT_SPECS.released_at` (`kind: 'date'`, NULLS-LAST — the keyset already handles it) + a
  Release-Date **range facet** in `LIBRARY_FILTER_SHAPE`. A null `released_at` sorts last, like every nullable
  sort.

Date Added needs **no** sync work (`arr_added_at`/`addedAt`/`source_added_at` are 100% populated and already a
sort field) — it is purely a registry-surfacing task (ADR-051 C-01).

### D-06 — Per-user library preferences store (ADR-052)

- **Table** (migration next-free at build; guard-listed, single-writer) — `library_preferences`, one row per
  `(user_id, wall)`: `view` (flat/grouped/hierarchy), `group_by` (nullable), `sort_field`, `sort_dir`. Cascade
  on user delete. Bounded (≤ one row per user per wall).
- **tRPC** — a session-gated `library.preferences.get`/`set` pair; a user reads/writes only their own row. No
  audit rows (descriptive UI state, ADR-052 C-04); no admin/cross-user surface.
- **URL precedence (R1 "URL overrides for shared links")** — on wall load: an explicit URL `view`/`group`/`sort`
  param WINS and is NOT written back (shared-link fidelity); a bare URL is filled from the stored preference,
  falling back to the D-01/R6 default when no row exists. A user CHANGING view/sort writes the row AND updates
  the URL (D-10). This is the resolution seam between the personal default (the store) and the shareable state
  (the URL).

### D-07 — Per-user watch/read-state seam (ADR-053)

- **The mapping table** (migration next-free at build; guard-listed, single-writer in `@hnet/domain`; the seam
  the Feed-attribution backlog reuses) — one row per app `user_id` with per-source handles: plex.tv numeric id
  (auto-filled from `resolvePlexIdentity`/the friend matchers when resolvable), ABS user id, Kavita username
  (admin-set). Mirrors the existing `users.plex_email`/`plex_username` override pattern.
- **Video (feasible now)** — add `user_id` to the Tautulli history zod subset (DESIGN-008 D-03); the harvest
  attributes per-user watched/in-progress through the map into a per-user watch read-model (keyed by
  `(media_item, app_user)`), **ADDITIVE** to the untouched household `play_count`/`last_viewed_at`/
  `last_watched_*` (never a replacement — the trash walls depend on those, ADR-053 C-03). The registry's
  Watched / In-progress facets (Movies/TV/Episodes/Music) read this; sparse coverage (live-verified) →
  populated-value-gated.
- **Books — ABS now, Kavita deferred** — ABS admin token reads any user's `mediaProgress[]`
  (`isFinished`/`progress`; join `books_items.external_id` = ABS libraryItemId) via the map → the Audiobooks
  Read / In-progress facet, in a bounded sync mode (the `ai-usage-sync` shape). **Kavita read-state is DEFERRED**
  (ADR-053 C-05) — no admin per-user progress read exists; Books/Comics ship without read facets.
- **Security** — per-user state is a FACET on content the ADR-047 gate already filtered; the map never widens
  access. Handle entry is admin-only.

### D-08 — Facet UI

The DESIGN-008 D-10 `@hnet/ui` filter engine (chip bar + enum checklist + range chips) is REUSED as-is; this
design supplies new field definitions per the registry (D-02), not new mechanism:

- **Books genre chips finally get UI** — the shipped `books.filterFacets` endpoint (ADR-046 out-of-scope note)
  gets its chip bar on the walls where genres exist (ABS 91%); Kavita genre is absent (honest — no chip).
- **Author/Series** — enum facets from `books_items.author`/`series_name` (also the group-by dimensions, D-04).
- **Narrator** (audiobooks) — enum facet, populated-value-gated (ABS 16%).
- **Format / length** — Format (epub vs cbz/cbr from `attrs.format`); **length buckets** — duration buckets
  (audiobooks, from `duration_seconds`), page-count buckets (Kavita, from `page_count`). Bucket boundaries are a
  DEFERRED UX call (D-11).
- **Year/Decade** (ledger) — derived from `year` (no new data); a decade enum + a year range.
- **Watch/read-state** (D-07) — per-user Watched / Unwatched / In-progress (video), Read / In-progress
  (audiobooks) — toggle facets, populated-value-gated.

All facets follow the existing pattern: same-field OR, cross-field AND (chip semantics), values from a
`filterFacets`-style DISTINCT so an empty facet renders no dead chip (ADR-051 C-06). Reflow-free (ADR-015); the
chip bar stays a fixed-height horizontally-panning rail (DESIGN-008 D-11); tokens only (hard rule 2).

### D-09 — A–Z jump bar (R5)

On big walls sorted by Title/Author/Series (the A–Z sorts), an **A–Z letter jump bar** keys off `sort_title`
(ledger) / `sort_title`/`author` (books) — tapping a letter scrolls/pages to the first item at that letter. It
appears ONLY when the active sort is an A–Z sort on a wall above a size threshold (both DEFERRED-tunable, D-11);
it is a navigation affordance over the existing keyset/offset pager, not a new query dimension. Reflow-free,
reserved gutter (ADR-015).

### D-10 — URL contract extension (R4, riding D-19)

The DESIGN-008 D-11 Library URL contract (`?tab`, `?q`, `?disk`, `?genre/res/req/col`, `?rmin/rmax`, `?sort`)
gains **view + grouping dimensions**, URL-synced so a view is shareable and Back/Forward restores it:

- **New params** — `?view=flat|grouped|hierarchy` (omitted when it equals the wall's R2 default), `?group=<key>`
  (the drilled-into group, D-04), and the existing `?sort=field:dir` grows the new registry sort keys
  (`released_at`, `year`, `last_ep_added`, air-date, upload-date, per-medium book sorts). Repeated-param facets
  (D-11's book/watch facets) follow the D-11 comma-safe repeated-param convention.
- **History semantics (D-19, inherited — the load-bearing rule):**
  - **View switches PUSH** (a history entry) — selecting a different view shape, or drilling from a grouped card
    into a group (`?group=`), is a `router.push`; Back restores the prior view WITH its URL-synced state.
  - **Refinements REPLACE** (no history entry) — sort changes, filter chips, the A–Z jump, debounced search,
    pagination cursors stay `router.replace`. So Back/Forward cross VIEWS, not individual filter edits.
  - **Canonicalizing redirects REPLACE** — normalizing a bare/unknown `?view` to the wall default is a
    `router.replace` (no spurious history entry).
- **Tab-switch reset** (DESIGN-008 D-11, unchanged) — switching KIND tabs keeps only `?tab`; view/group/sort do
  not leak across kinds. The per-user preference (D-06) refills the cleaned URL for the new tab.

This extends — does not fork — D-09/D-11/D-19; the only new dimension over D-19 is the `view`/`group` segment,
which D-19 already anticipates ("PLAN-029 inherits this contract for any new screen-level switch it adds").

### D-11 — DEFERRED to the build-phase UX pass (architecture decided, pixels deferred)

Per the owner directive (polish-level UX judgment applied AT BUILD, not locked here). The following are
**explicitly deferred** — the architecture above constrains them; the exact treatment is the build's call:

- The **view-selector affordance** (segmented control vs menu vs icon toggle) and where it sits on the toolbar.
- **Which alternative view shapes each wall offers** beyond its R2 default (e.g. a flat A–Z Books grid; a
  grouped Movies-by-Collection view — note: Collections proper are PLAN-037, out of scope here).
  <!-- PARTIALLY RESOLVED: Books/Audiobooks ship the flat alternative (PLAN-029 build); the group-card ART
       pass (2026-07-13) adds Audiobooks' second grouping DIMENSION (Genres, ?by=genre). Movies-by-Collection
       stays with PLAN-037. -->
- **Group-card art density** — how many stacked covers, fan vs stack vs grid-of-4, count-badge placement.
  <!-- RESOLVED by the group-card ART pass (2026-07-13, D-04 amendment): 3-cover fan as the universal
       fallback; a dimension PORTRAIT where a real source exists (ABS author photos); designed GLYPH tiles
       for abstract dimensions; count in the card body. -->
- **A–Z jump-bar** placement (edge rail vs floating), the wall-size threshold that shows it, and touch sizing.
- **Facet bucket boundaries** — duration buckets (e.g. <15m / 15–45m / >45m), page-count buckets, decade
  grouping granularity.
- **Sort-menu vs sort-pills** presentation and per-view labels/ordering.
- **Whether to widen the live-Plex read** for Season/Episode rating/genre/resolution facets (a per-need call;
  the must-have DATES need no widening).
- **Whether to add a Kavita per-series metadata fetch** for Books/Comics year+genre facets (a bounded
  enhancement; deferred, not promised).
- **Per-user facet copy/labels** ("Watched by me" vs "Unwatched", etc.) and empty-state messaging.

DEFERRED does NOT mean unbounded: each lands inside the decided model (registry-declared dimensions, the three
engines, the D-19 URL semantics, ADR-015 reflow-free, tokens only).

## Alternatives considered

- **One flat global sort/filter list** (today) — rejected (ADR-051): offers dimensions a level can't answer;
  the "longer flat list" the recon warns against.
- **Forking three sort/filter systems per engine** — rejected (ADR-051 C-04/option 3): triplicates the UI and
  lets contracts drift; the registry is the single seam that shares ONE UI across three engines.
- **Deriving Date Released from `year`** — rejected (ADR-051 option 5): `year` is a January-1 lie that mis-sorts
  within a year; the \*arr list already carries the precise field.
- **localStorage / URL-only preferences** — rejected (ADR-052): not cross-device / cannot remember a default
  (owner ruled SERVER-SIDE).
- **Replacing the household watch aggregate with per-user** — rejected (ADR-053 C-03): regresses the trash
  walls + guardian keep; per-user is additive.
- **Blocking all book read-state until Kavita is solved** — rejected (ADR-053): needlessly withholds the
  feasible ABS half; Kavita is deferred, ABS ships.

## Test strategy

- **Unit** — the registry resolution (a view level exposes ONLY its declared sorts/facets; no
  Duration/Resolution at Season; no Runtime on Music); `released_at` adapter mapping (Radarr
  `digitalRelease ?? inCinemas ?? physicalRelease`; Sonarr `firstAired`; Lidarr null; ABS `publishedDate`); the
  keyset over `released_at` NULLS-LAST in both directions (extends the DESIGN-008 D-09 null-frontier tests); the
  per-user preference URL-precedence resolver (URL wins, no write-back; bare URL fills from store; missing row →
  default); the Tautulli per-user attribution + ABS progress join.
- **Integration** — `ledger.search`/`books.search` with the new sorts + facets; the group-by aggregate
  (counts + member covers) under the ADR-047 access gate (a withheld group does not appear); per-user watch/read
  facets against seeded Tautulli/ABS stubs; the household aggregate is unchanged (regression guard).
- **e2e** — view switch → `page.goBack()` restores the prior view WITH its state (extends
  `history-navigation.spec.ts`); grouped-card drill-in + back; the A–Z jump; a shared deep link with an explicit
  `?view`/`?sort` overriding a saved preference; the 390×844 pass (view selector + group cards + jump bar fit,
  single-row chip bar, no reflow). Seed a per-user watch/read fixture so a facet visibly changes the set.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Exact per-user watch read-model shape — a dedicated `(media_item, app_user)` rollup table vs a per-user column set? | DEFERRED to build (D-07): either satisfies the additive constraint (ADR-053 C-03); the build's UX pass + the Feed-attribution reuse pick the shape that serves both. |
| Q-02 | Do Kavita Books/Comics get a per-series metadata fetch for year+genre facets? | DEFERRED (D-11): a bounded enhancement, not promised in v1; the walls ship with author/series/format/date-added/pages. |
| Q-03 | Which alternative view shapes each wall offers beyond its R2 default? | DEFERRED to the build UX pass (D-11); the DEFAULTS (D-01) are fixed. |
| Q-04 | Widen the live-Plex read for Season/Episode rating/genre/resolution facets? | DEFERRED per-need (D-11); the must-have dates need no widening — ship those, add facets only if the owner asks. |
