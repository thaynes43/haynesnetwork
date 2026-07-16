# PLAN-037: Collections — mirrored (Plex/Kometa) + app-native logical collections

- **Status:** BUILT (2026-07-16 — docs + code on `feat/plan-037-collections`, awaiting
  coordinator review/PR). Docs: ADR-064 (Accepted) + DESIGN-035 + PRD R-208..R-210 +
  glossary T-179..T-182, authored docs-first in this branch. Runs PARALLEL to PLAN-050
  (separate branches; releases serialize).
- **Owner rulings (2026-07-16 scoping):**
  - **R1 — MIRRORED-ONLY, PERMANENTLY.** "We should always use external software as the source
    of truth for collections and just sync with that here, even when we do books we build a
    tool first then sync." App-native collections are OUT of this plan and out of the roadmap;
    the future book-list tool is external and gets mirrored the same way. (Extends hard rule 4.)
  - **R2 — surface = a "Collections" GROUP-BY VIEW inside the Movies/TV kind tabs** via the
    PLAN-029 view/group engine. No new top-level nav.
  - **R3 — mirror EVERYTHING** visible on the source server (Kometa charts included); filtering/
    hiding is a later knob once the owner sees it live.
  - **R4 (coordinator default, unobjected) — HOps Plex only** for v1: it is where collections +
    poster overlays are maintained now.
- **Owner vision (from 029 intake):** collections as a view of a library — (a) mirrored
  Plex/Kometa collections (read-only, from existing metadata facets), (b) app-native LOGICAL
  collections, e.g. a book series in the order you'd read them (the flagship case).
- **Relates:** PLAN-029 (the views/grouping + S&F foundation this builds on; its
  group-view/aggregate-card idiom is the natural collections UI), ADR-046 books_items
  (series_name), Kometa `source_collections` facets (PLAN-004 metadata), PLAN-032 (a list
  that becomes a collection is the natural join).

## Executed shape (2026-07-16 build — the docs are normative, this is the file map)

- **Docs (docs-first, same branch):** `docs/adrs/064-mirrored-plex-collections-read-model.md`
  (Accepted — records the R1 doctrine verbatim-in-intent), `docs/designs/035-mirrored-plex-collections.md`
  (D-01 schema · D-02 sync · D-03 group read model · D-04 drill-in predicate · D-05 registry seam ·
  D-06 URL contract · D-07 ordering honesty · D-08 membership bound · D-09 UI), PRD R-208..R-210
  (new `### Collections` section), glossary T-179..T-182.
- **DB:** migration `0053_plex_collections.sql` — `plex_collections` (UNIQUE (plex_library_id,
  rating_key), raw `child_count`) + `plex_collection_members` (UNIQUE (collection_id, rating_key),
  `sort_order`), CASCADE FKs, `sync_runs.run_kind` CHECK += `collections-sync`. Schema
  `packages/db/src/schema/plex-collections.ts`; enums `SYNC_RUN_KINDS += 'collections-sync'`;
  migration-test block in `packages/db/__tests__/migrations.test.ts`.
- **@hnet/plex:** `listCollections(sectionKey)` (paged /collections, MAX_COLLECTION_PAGES cap) +
  `plexCollectionSchema`/`collectionsContainerSchema`; fixture-driven read tests.
- **Sync/domain:** `packages/sync/src/plex-collections.ts` (`fetchPlexCollectionsSnapshot` —
  slug `haynesops`, movie|show registered sections; members via existing `listMetadataChildren`
  limit 1000, truncation → `fullyRead:false`) + `packages/domain/src/plex-collections.ts`
  (`syncPlexCollections` — upsert + member-reconcile scoped to fullyRead collections +
  collection-reconcile scoped to fully-read sections, one tx, no audit). Orchestrator branch,
  CLI `--mode=collections-sync`, both tables in ALL SIX guard regex families + comment block.
  Test `packages/sync/__tests__/plex-collections.test.ts` (upsert, raw membership, truncation
  scope, vanish reconcile, partial-read safety, member-read-failure honesty).
- **API:** `ledger.collectionGroups` (accessible-count group cards + 4-poster cover fan; zero-
  accessible collections absent) + `LIBRARY_FILTER_SHAPE.collection` → ONE EXISTS predicate in
  `buildLibraryWhere` (the drill inherits every filter/sort + the ADR-047 gate). Invariant test
  `packages/api/__tests__/ledger-collections.test.ts`.
- **Web:** registry rows only — `WALL_VIEWS.movies` offers `['flat','grouped']` /
  `WALL_VIEWS.tv` `['hierarchy','grouped']` with the `collection` dimension; new ViewLevelKeys
  `movies:grouped-collection` / `tv:grouped-collection` (label|count card sorts). Defaults
  UNCHANGED (opt-in `?view=grouped&by=collection`). `MediaBrowser` (library-client.tsx) gains the
  books-browser idioms: view selector, GroupCard grid, PUSH drill (`?group=<ratingKey>`) with
  header/back-link, bare-URL canonicalization, grouped-aware sort persistence.
- **e2e:** stub-plex serves a `/library/sections/{key}/collections` fixture (Stub Franchise +
  member children), so a sync-driven path is stubbable. **HONEST GAP — no seeded e2e journey:**
  the shared seed (seed-ledger.ts) deliberately keeps its ledger movies UNMATCHED (kind-home
  gating), and a Collections wall journey requires `media_plex_matches` rows, which would grow
  "Watch on Plex" buttons on detail pages other specs assert against. A collections smoke spec
  needs its own isolated seed pass — deferred, not half-built (DESIGN-035 Q-03).
- **Verify-live residuals:** (a) whether Plex `collectionSort` order survives `/children`
  (DESIGN-035 D-07/Q-02 — `sort_order` stored, unconsumed in v1); (b) per-collection `ratingKey`
  presence in the /collections listing is schema-enforced (a drift fails loudly as
  PlexParseError), not live-verified from this pod. (c) haynes-ops still needs the
  `sync-collections` CronJob (image bump + one CronJob block) after release.

## Parked open questions (from 029's original intake — resolved at scoping or moot under R1)

- Curation rights — MOOT (R1: no app-side curation, ever).
- Cross-media-type membership — MOOT for v1 (mirror carries whatever Plex holds; walls are per-kind).
- New domain `collections` + ordered `collection_items` — REJECTED permanently (R1; ADR-064 option 2).
- Mirrored vs native precedence — MOOT (there is no native).
