# PLAN-029: Library views & grouping (Plex-style) + Sorting & Filtering overhaul

- **Status:** DESIGN COMPLETE (2026-07-11 — docs-only PR: ADR-051/052/053 + DESIGN-026 + PRD
  R-165..R-171 + glossary T-149..T-155; see "Design phase complete" below). NOT dispatched for
  build; **agent types must be discussed with the owner before dispatch** (standing rule
  2026-07-11). Sequencing: PLAN-036 (history contract) + PLAN-034 (Helpdesk) have LANDED; owner
  ordering puts PLAN-031 (MAM) ahead of 029's build. Recon folded in
  (`.agents/context/2026-07-11-plex-sort-filter-recon.md`, its unverified claims corrected by live
  SELECTs during the design phase).
- **Collections are OUT OF SCOPE** (owner ruling: "large chunk, no benefit to increasing its
  scope") → split to **PLAN-037**.
- **Relates:** D-09 search contract (extends with view + group-by dimensions), ADR-046
  books_items (author/narrator/series/format already stored), PLAN-022 (Peloton/YouTube
  structure), PLAN-028 (detail pages), PLAN-036 (history contract — view switches are history
  entries), the Feed-attribution backlog item (CONSUMES this plan's per-user watch mapping).

## Owner rulings (2026-07-11 — normative)

- **R1 persistence: SERVER-SIDE per user** (small user-prefs store). URL overrides for shared
  links. Last-used SORT persists per user the same way (R6).
- **R2 defaults: as proposed** — Books/Audiobooks → Author · Comics → Series · Peloton →
  Exercise · YouTube → Channel · Movies → flat wall. **TV clarification (owner):** TV is not
  "flat" — it already embodies the hierarchy (Shows → Seasons → Episodes); keep that shape.
- **R3 collections: OUT** → PLAN-037.
- **R4 URL: view/grouping IS URL-synced** (D-09 extension; shareable, back/forward restores
  per PLAN-036).
- **R5 affordances: ALL FOUR** — per-view sort menus (+direction), A–Z letter jump bar on big
  walls, richer facets (year/decade, rating thresholds, genre chips everywhere — the shipped
  `books.filterFacets` endpoint finally gets its UI), watch/read-state facets.
  **Owner emphasis:** different views have different data ⇒ DIFFERENT sort/filter per view
  (Episodes ≠ Shows). Plex does this well — Opus recon gathers its per-view model for ideas.
  Ground everything in genuine exploration value; e.g. **"Date Released" and "Date Added" do
  not exist in our walls today and the owner uses them all the time in Plex** — treat those
  two as must-haves (verify schema carries them per kind; add to sync if missing).
- **R6 sort defaults: sensible per type + remember last-used per user** — Movies/TV/Peloton/
  YouTube recently-added; Books/Comics A–Z within their grouping.
- **R7 watch/read-state: PER-USER, IN SCOPE NOW** (owner chose the big option). This pulls the
  **app-user ↔ Plex-account attribution mapping** into this plan: map household Plex accounts
  (Tautulli/Plex history) to app users, then per-user watched/in-progress facets. Build the
  mapping as its own domain seam — the Feed-attribution backlog item reuses it verbatim.
  Books/audiobooks read-state comes from Kavita/ABS progress (per-user there already; needs
  identity mapping too).
- **R8 book facets: ALL** — genre chips, author/series, narrator (audiobooks), format/length
  (epub vs cbz/cbr, duration buckets, page counts where present).

## Design phase complete (2026-07-11) — docs-only PR

The docs-first artifacts are authored + Accepted (docs-only, no code). Doc numbers (taken AFTER
PLAN-034's PR #210 claims: it holds ADR-050, R-160..R-164, T-145..T-148, migration 0040):

- **ADR-051** — Library views, grouping, and per-view/per-engine sort & filter registries (the
  core: the three-engine seam [ledger / live-Plex / books], Plex-style per-view asymmetry, the
  view/grouping model, and the `released_at` data add folded in as C-05). Accepted.
- **ADR-052** — Server-side per-user library preferences (R1/R6; URL-override precedence). Accepted.
- **ADR-053** — Per-user watch/read-state attribution (R7; the app-user↔account mapping seam
  [approach C], Tautulli per-user re-key, ABS admin-read, Kavita DEFERRED). Accepted.
- **DESIGN-026** — Library views, grouping, and the S&F overhaul (D-01 view model + R2 defaults,
  D-02 registry seam, D-03 per-wall registry CONTENTS [verified], D-04 group cards, D-05
  `released_at`, D-06 prefs, D-07 watch/read seam, D-08 facet UI, D-09 A–Z jump bar, D-10 URL
  contract riding D-19, **D-11 the explicit DEFERRED-to-build UX list**).
- **PRD** R-165..R-171; **glossary** T-149..T-155 (+ changelog row).

**Live-verified this session** (read-only SELECTs on `haynes-ops`, cited in ADR-051 / DESIGN-026):
Date Added 100% on all \*arr + books rows (a surfacing task, not sync); year 100% radarr/sonarr, 0
lidarr; household watch SPARSE (radarr 3.8% / sonarr 18.8% / music 0%); ABS facets rich (author
100%, genres 91%, duration 100%, narrator 16%, series 3/823) vs Kavita sparse (author 96%, pages/
format 100%, year/genres/series 0); no prior per-user store. These corrected the recon's
kubectl-unverified claims (ABS narrator/series near-empty → populated-value-gated facets).

**Sequencing reminder:** still gated behind PLAN-036 (DONE) + PLAN-034 (DONE, merged #210); owner
ordering puts **PLAN-031 (MAM) highest priority BEFORE 029's build** — so the `released_at` + the
two per-user tables take **next-free migration numbers AT BUILD** (PLAN-031 may consume some first).
Agent-type discussion with the owner still required before any build dispatch (standing rule).

## Build-phase steps (reference the docs above)

1. **`released_at` data layer** (DESIGN-026 D-05 / ADR-051 C-05) — new nullable `media_metadata.released_at`
   (migration, next-free); Radarr/Sonarr adapter fields + ABS published-date fetch (`@hnet/arr`/`@hnet/sync`);
   `SORT_SPECS.released_at` + Release-Date range facet.
2. **The registry seam** (DESIGN-026 D-02/D-03) — the per-(wall, view-level) `LibraryViewRegistry`; extend
   `LIBRARY_SORT_FIELDS`/`LIBRARY_FILTER_SHAPE` (ledger) + `BOOKS_SORTS`/`books.filterFacets` (books) + the
   live-Plex read; each level offers ONLY answerable dimensions.
3. **View + grouping shells** (DESIGN-026 D-01/D-04) — the view selector, flat/grouped/hierarchy shapes, the
   group-by aggregate cards + drill-in, R2 defaults.
4. **Per-user preferences** (DESIGN-026 D-06 / ADR-052) — `library_preferences` table (guard-listed,
   single-writer, migration) + `library.preferences.get`/`set` + the URL-precedence resolver.
5. **Per-user watch/read seam** (DESIGN-026 D-07 / ADR-053) — the mapping table (guard-listed, single-writer) +
   Tautulli `user_id` subset add + per-user watch read-model (ADDITIVE) + ABS `mediaProgress` read; the
   registry's per-user facets; **Kavita read-state NOT in this plan**.
6. **Facet UI + A–Z jump bar + URL contract** (DESIGN-026 D-08/D-09/D-10) — book genre chips, author/series,
   narrator, format/length; the jump bar; `?view`/`?group` URL sync riding D-19 (view switches PUSH,
   refinements REPLACE).
7. **The build UX pass owns D-11's deferred pixels** — view-selector affordance, group-card art density,
   jump-bar placement, facet bucket boundaries, per-view sort presentation. Screenshot review per the standing
   owner rule.
8. **Tests** (DESIGN-026 Test strategy) — registry-asymmetry unit tests, `released_at` adapter + keyset-null
   tests, the pref URL-precedence resolver, per-user attribution; integration under the ADR-047 gate; e2e
   view-switch history + grouped drill-in + shared-link override + 390px.

## Shape (for the design phase)

Selectable per-tab views with opinionated defaults (R2); group-view = aggregate cards (author →
item count + stacked covers → drill in). Data for every view already exists (ADR-046 fields,
Peloton discipline/duration, YouTube channel) — grouping is queries + view shells on the filter
engine. The S&F work extends the shared filter engine: per-view sort/filter registries (what the
Opus recon informs), the two new date dimensions, the jump bar, facet UI, and the per-user
watch/read-state seam (R7 — the only new sync/domain surface in the plan).

## Open items

- ~~Await the Opus Plex-recon doc → fold into the design.~~ DONE — folded into ADR-051 / DESIGN-026;
  its kubectl-unverified population claims corrected by live SELECTs.
- Owner + coordinator: agent-type discussion for the build split before dispatch (standing rule).
- Build-time: assign next-free migration numbers for `released_at` + the two per-user tables
  (PLAN-031 may consume some first — re-grep before authoring build migrations).
  **RESOLVED (data/domain build, steps 1/4/5):** consumed **0042** (`media_metadata.released_at` +
  `books_items.released_at`), **0043** (`library_preferences`), **0044** (`user_account_map` +
  `user_media_watch` + `user_book_progress`). Steps 2/3/6/7 (the registry seam, view/group shells,
  facet UI + jump bar + URL contract, the UX pass) remain for the UX agent's follow-up PR.
- DEFERRED to the build UX pass (DESIGN-026 D-11), not lost: view-selector affordance, group-card
  art density, jump-bar placement, facet bucket boundaries, alt view shapes per wall, optional
  Kavita per-series metadata fetch (year/genre facets), optional wider live-Plex read (Season/
  Episode rating/genre/resolution).
