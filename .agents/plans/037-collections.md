# PLAN-037: Collections — mirrored (Plex/Kometa) + app-native logical collections

- **Status:** Backlogged (owner 2026-07-11: split OUT of PLAN-029 — "large chunk, no benefit
  to increasing its scope"). Scope session later; not before PLAN-029 ships.
- **Owner vision (from 029 intake):** collections as a view of a library — (a) mirrored
  Plex/Kometa collections (read-only, from existing metadata facets), (b) app-native LOGICAL
  collections, e.g. a book series in the order you'd read them (the flagship case).
- **Relates:** PLAN-029 (the views/grouping + S&F foundation this builds on; its
  group-view/aggregate-card idiom is the natural collections UI), ADR-046 books_items
  (series_name), Kometa `source_collections` facets (PLAN-004 metadata), PLAN-032 (a list
  that becomes a collection is the natural join).

## Parked open questions (from 029's original intake — unanswered, re-ask at scoping)

- Curation rights: admin-only v1 vs per-role action grant vs personal+household collections.
- Cross-media-type membership allowed?
- New domain: `collections` + ordered `collection_items` — own ADR; reading-order semantics.
- Mirrored vs native precedence when both exist for the same series.
