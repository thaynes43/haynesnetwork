# DESIGN-035: Mirrored Plex collections — the Movies/TV Collections group view

- **Status:** Accepted
- **Last updated:** 2026-07-16
- **Satisfies:** PRD-001 **R-208..R-210**; governed by **ADR-064** (mirror-only doctrine, owner R1–R4)
  on top of **ADR-047** (THE INVARIANT + `media_plex_matches`), **ADR-051/052** (view engine +
  per-user preferences), **DESIGN-026** (D-01 view model, D-02 registry seam, D-04 group cards,
  D-10 URL contract, D-19 PUSH/REPLACE via DESIGN-004). Glossary **T-179..T-182**.

## Overview

The owner curates collections on the HOps Plex server (Kometa charts + franchise sets). PLAN-037
mirrors them into two rebuildable tables (`plex_collections` + `plex_collection_members`, migration
0053), synced by a new standalone `collections-sync` mode, and surfaces them as an **opt-in
"Collections" grouped view** on the Movies and TV walls through the shipped PLAN-029 view engine —
registry-row edits, one new tRPC group read, one new `ledger.search` predicate, zero new components
(ADR-051 C-01, GroupCard reused). Everything reads under the ADR-047 access gate: counts, covers,
and the drill-in all resolve through `media_plex_matches` into libraries the caller can access.

## Detailed design

### D-01 — The two mirror tables (migration 0053)

- **`plex_collections`** — one row per collection per library:
  `id uuid pk`, `plex_library_id` FK → `plex_libraries` ON DELETE CASCADE, `rating_key text`
  (the Plex collection's metadata id), `title text`, `child_count int` (the RAW Plex member count —
  diagnostics only, never shown as the wall count, ADR-064 C-03), `first_seen_at` / `last_seen_at` /
  `created_at` / `updated_at`. Identity: **UNIQUE `(plex_library_id, rating_key)`** (the
  plex-libraries "identity is keys, never names" rule — collection titles are not unique).
- **`plex_collection_members`** — one row per member per collection:
  `id uuid pk`, `collection_id` FK → `plex_collections` ON DELETE CASCADE, `rating_key text` (the
  MEMBER title's ratingKey — the join key into `media_plex_matches (plex_library_id, rating_key)`),
  `sort_order int` (position in the source read, D-07), same four timestamps. Identity: **UNIQUE
  `(collection_id, rating_key)`**.
- Membership is stored **RAW** regardless of ledger match (owner R3 mirror-everything): a chart
  entry the *arrs don't manage still gets a member row; the ledger join is a read-time concern.
  Both tables are the rebuildable-derived-cache class (ADR-064 C-02): single-writer, guard-listed,
  no audit rows. The migration also grows `SYNC_RUN_KINDS` + rebuilds the `sync_runs.run_kind`
  CHECK (`collections-sync` — parity only; the mode writes no `sync_runs` row).

### D-02 — The `collections-sync` standalone mode

The plex-match shape, verbatim in spirit:

- **Fetcher** (`@hnet/sync` `fetchPlexCollectionsSnapshot`) — reads ONLY slug **`haynesops`** (owner
  R4) and ONLY sections of type `movie|show` that exist in the `plex_libraries` registry
  (`available = true`; an unregistered section is skipped and logged — run a registry refresh first).
  Collections come from a NEW paged `@hnet/plex` read, `listCollections(sectionKey)` —
  `GET /library/sections/{key}/collections` with the `X-Plex-Container-Start/-Size` loop until
  `start >= totalSize` under a MAX_PAGES cap (the container-bounded lesson from plex-match). Members
  come from the EXISTING `listMetadataChildren(collection.ratingKey, { limit: 1000 })` (D-08 bound).
- **Domain single-writer** (`@hnet/domain` `syncPlexCollections`) — one transaction:
  upsert collections `onConflictDoUpdate` on `(plex_library_id, rating_key)` (title/child_count/
  last_seen_at advance; first_seen_at/created_at keep), upsert members on
  `(collection_id, rating_key)`, then reconcile-DELETE:
  - **members** where `last_seen_at < runStart`, scoped ONLY to collections whose member read was
    COMPLETE this run (D-08 `fullyRead`);
  - **collections** where `last_seen_at < runStart`, scoped ONLY to `plex_library_id`s whose section
    was fully read this run (`scopedLibraryIds` — the plex-match rule: a server outage or a
    mid-section error never tombstones what the run couldn't see; the CASCADE removes their members).
- **Standalone**: no `--source`, writes NO `sync_runs` row — its trail IS the mirror tables (the
  plex-match/books-sync class). Orchestrator branch mirrors plex-match (report + totalFailure when
  no section could be read); CLI `--mode=collections-sync`; the CronJob lands in haynes-ops later.

### D-03 — The Collections group read model (`ledger.collectionGroups`)

The `books.groups` idiom on the ledger engine: one bounded query, in-process aggregation, wire shape
`{ key, label, count, coverUrls }` per collection (the GroupCard contract; `imageUrl` stays null —
a collection has no portrait source, the cover fan is the art, DESIGN-026 D-04 ladder).

- **Query** — for the wall's `arrKind` (`radarr`|`sonarr`): members join
  `plex_collection_members → plex_collections → media_plex_matches ON (plex_library_id, rating_key)
  → media_items` (+ LEFT JOIN `media_metadata` for the poster source), restricted to live
  (non-tombstoned) items of that kind **AND the ADR-047 gate** (`libraryAccessConditionRaw` for the
  raw join / `libraryAccessWhere`), ordered by `(collection, sort_order)`.
- **Aggregation** — count = DISTINCT accessible ledger members (never the raw Plex `child_count` —
  counts are leak vectors, the filterFacets precedent); covers = the first **4** accessible members'
  poster URLs via the existing `posterUrlFor` path (the group-card cover fan; a member with no
  poster contributes none). Cards come back label-A–Z; the client re-sorts by the grouped level's
  registry keys (label | count).
- **THE INVARIANT** — a collection whose accessible ledger-member count is ZERO (all members
  withheld, unmatched, or non-ledger) is DROPPED from the listing entirely: no card, no label leak.
  Admin (unrestricted) sees every collection with ≥ 1 ledger-matched member of the kind.

### D-04 — Drill-in: `?group=<ratingKey>` is a `ledger.search` predicate

The drilled wall is the SAME flat grid the tab already renders. `LIBRARY_FILTER_SHAPE` (the shared
search/browse/export DSL) gains an optional **`collection`** field (the collection's `rating_key`),
and `buildLibraryWhere` adds ONE predicate:

```sql
EXISTS (SELECT 1
          FROM plex_collection_members pcm
          JOIN plex_collections pc ON pc.id = pcm.collection_id
          JOIN media_plex_matches cmx
            ON cmx.plex_library_id = pc.plex_library_id
           AND cmx.rating_key      = pcm.rating_key
         WHERE pc.rating_key = ${collection}
           AND cmx.media_item_id = media_items.id)
```

Because it is just an AND predicate inside `ledger.search`, the drilled wall inherits **everything**
unchanged: every registry facet, every sort + the keyset cursor, the A–Z jump, and the ADR-047
access gate (a withheld member never appears in the drilled grid — R-210). The group key is the
collection `rating_key` (stable, key-not-name — the D-01 identity rule); the drill header's label
resolves from the group listing.

### D-05 — Registry seam edits (ADR-051 C-01: rows, not components)

- `WALL_VIEWS.movies` → `offers: ['flat', 'grouped']`, `flatLabel: 'All movies'`, `groupings:
  [{ dimension: 'collection', selectorLabel: 'Collections', allLabel: 'All collections',
  art: 'covers', level: 'movies:grouped-collection' }]`.
- `WALL_VIEWS.tv` → `offers: ['hierarchy', 'grouped']`, `flatLabel: 'All shows'`, same grouping with
  `level: 'tv:grouped-collection'`. The hierarchy shape (Shows → Seasons → Episodes drill) is the
  wall's non-grouped shape and is UNTOUCHED (owner R2).
- Two new `ViewLevelKey`s — `movies:grouped-collection` / `tv:grouped-collection` — as `groupLevel`
  entries sorting the CARDS by `label` (Collection A–Z, asc-first) | `count` (Most items,
  desc-first), default label-asc, no facets, no A–Z rail (the `audiobooks:grouped-genre` shape).
- **`WALL_VIEW_DEFAULTS` / `LIBRARY_WALL_DEFAULTS` are UNCHANGED** — Movies stays flat, TV stays
  hierarchy; Collections is opt-in via the view selector (which now renders on these walls) or a
  shared `?view=grouped&by=collection` link. The domain/client mirrors stay in parity (the
  parity test binds them).

### D-06 — URL contract (rides DESIGN-026 D-10 / D-19 verbatim)

- `?view=grouped&by=collection` — the Collections view (a screen-level **PUSH**; `by=` may be
  omitted since `collection` is the walls' only/default grouping dimension — the books canonicalize
  rule applies on these now-multi-shape walls: a bare URL canonicalizes to the resolved `?view=`
  with a replace).
- `?group=<ratingKey>` — the drilled collection (a **PUSH**; implies the flat/item grid). The drill
  header shows the collection title + a back link to the grouped wall. Sorts/filters inside the
  drill stay **replace** refinements; the drilled sort is transient (not persisted — the books
  drill rule).
- A view switch persists via `library.preferences.set` from the selection handler (ADR-052; URL
  renders are never written back). Tab-switch reset (only `?tab` survives) is inherited unchanged.

### D-07 — Member ordering: stored honestly, unconsumed in v1

`sort_order` records the position members came back from `GET /library/metadata/{key}/children`.
Plex documents collection ordering (`collectionSort` release-date/alpha/custom), but whether the
active order survives the `/children` read is **UNVERIFIED** here (no live Plex reachable from this
build environment, and the item schema carries no order field — only response position). So:

- v1 stores the response order (cheap, honest, rebuilt every sync) but **no read consumes it** —
  the group cards sort by label/count and the drilled wall sorts by its own registry keys.
- If a future surface wants "Plex order" as a drill sort, verify live first (Q-02) — the column is
  already there.

### D-08 — Membership read bound (honest truncation handling)

`listMetadataChildren` is container-bounded at 1000 and unpaged. HOps collections are Kometa charts
and franchise sets (tens to a few hundred members), so 1000 covers reality; but a collection whose
`totalSize` exceeds the items returned is marked **not fully read**: its collection row still
upserts (title/child_count advance) and the members it DID return upsert, but its member
reconcile-delete is SKIPPED that run — a truncated read never tombstones members it didn't see
(the plex-match partial-read rule applied at collection grain). The fetcher logs the truncation.

### D-09 — UI: the MediaBrowser gains the grouped shape (no new components)

The Movies/TV `MediaBrowser` (library-client.tsx) adopts the books-browser idioms for its new
multi-shape reality: the `.seg` view selector (Collections | All movies/All shows), the grouped
card grid (`GroupCard`, cover-fan art, PUSH drill), the drill header (back link + collection
title), client-side card search (label contains) + card sort (label/count), and the D-06
canonicalization. In grouped mode the item-only controls (on-disk segment, Wanted-only, facet
chips) do not render — a grouped level declares no facets (registry-enforced); the drilled grid is
the ordinary wall and keeps them all. All copy is plain and friendly, no em-dashes, no personal
names ("Collections", "All movies", "All collections", "No collections yet."). ADR-015 holds: the
selector/toolbar heights are fixed, cards reserve the 2:3 box, refetches dim in place.

## Alternatives considered

- **App-native collections / authoring UI** — rejected permanently by the owner doctrine (ADR-064
  option 2, R1).
- **Surfacing collections via `media_metadata.source_collections`** — rejected: a per-item Kometa
  label facet, not an entity (no identity/membership/count; ADR-064 option 3). Left untouched.
- **Live Plex reads at render** — rejected: gated counts need the ledger join in SQL; the drill-in
  must compose with `ledger.search` (ADR-064 option 4).
- **A `?group=<title>` drill key** — rejected: titles are neither unique nor stable; `rating_key`
  is the Plex identity (D-01) and survives renames sanely (the sync re-titles the same row).
- **Storing only ledger-matched members** — rejected by R3 (mirror everything): raw membership
  keeps the mirror faithful and makes later non-ledger surfaces possible without a resync schema
  change.

## Test strategy

- **Sync (packages/sync, embedded PG + fake Plex read)** — mirror the plex-match test: fetch +
  upsert produces the expected collections/members; a re-run with a vanished collection/member
  reconciles it away; a section that errors mid-read is NOT scoped (its collections survive); a
  TRUNCATED collection read (totalSize > items) upserts what it saw but never member-tombstones;
  non-`haynesops` servers and non-movie/show sections are ignored.
- **API (packages/api, real routers)** — THE INVARIANT end-to-end: seed two movies in an accessible
  library + one in a withheld library, all members of one collection → the withheld member is
  excluded from BOTH the drill-in wall AND the group count; a collection whose only members are
  inaccessible is ABSENT from the listing; admin sees full accessible counts; covers cap at 4;
  the raw Plex child_count never leaks as the wire count.
- **Registry/client (apps/web unit)** — the domain⇄client view-model parity test stays green
  (defaults unchanged); the new grouped levels expose exactly label/count sorts and no facets.
- **Migration (packages/db)** — 0053 block: tables exist, the `(plex_library_id, rating_key)` /
  `(collection_id, rating_key)` uniques bite, FK cascades clean members with their collection and
  collections with their library, and `sync_runs.run_kind` admits `collections-sync`.
- **e2e** — see Q-03 (deferred honestly, not half-built).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Filter/hide specific mirrored collections (charts vs franchises), or per-collection display toggles? | DEFERRED by owner ruling R3 — mirror everything in v1; the knob is designed after the owner sees it live. |
| Q-02 | Does Plex's `collectionSort` order survive the `/children` member read? | UNVERIFIED (no live Plex from the build env; schema carries no order field). v1 stores response order but no read consumes it (D-07); verify live before any "Plex order" sort ships. |
| Q-03 | e2e smoke spec for the Collections view? | DEFERRED: the shared e2e seed keeps its ledger movies UNMATCHED (kind-home gating), and a collections journey needs `media_plex_matches` rows — which would grow "Watch on Plex" buttons on detail pages other specs assert against. The stub Plex serves a `/collections` fixture (the read path is stubbable); the seeded journey needs its own isolated seed pass — tracked in the plan file, not half-built here. |
