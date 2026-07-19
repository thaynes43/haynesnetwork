# 2026-07-19 — Owner rulings: collection Search badges + drill-header primary pills

Owner UX review of the Movies collection drill (he is the reviewer; screenshots captured). Three
rulings, all shipped on `feat/collection-search-badges`.

## 1. Wanted-tile Force Search → corner BADGE
"Make it like a badge with a magnifying glass in one of the corners we have not decorated already — it
feeds into the gamification." The awkward bottom-edge pill is retired for an icon-only magnifier puck
in the poster's **top-right** (undecorated) corner. Shared variant: `<MediaAction
presentation="badge">` (ADR-071 companion note). Extended from radarr-only to **movies AND TV**
(radarr | sonarr). Books Wanted tiles unchanged (route to the wanted detail page).

## 2. Collection-centric "Search Missing"
Force-search ALL missing members of a collection:
- **Drill header:** a Force Search pill next to "Edit collection".
- **A page up (all-collections grid):** the same magnifier BADGE on each collection card.
- **Movies/TV:** NEW bulk mutation `ledger.forceSearchCollection({ ratingKey, arrKind })` — resolves
  missing members (held=false ∩ monitored ∩ not-on-disk ∩ live) under the access gate, fans out the
  shipped per-item `runForceSearch`, capped (`ARR_COLLECTION_FORCE_SEARCH_CAP`, default 25). Gated
  EXACTLY as the per-item path (#375): authed + shared hourly budget, admins bypass, NO new grant;
  per-member `search_requested` audit. Grid badge shows only when `wantedCount > 0`.
- **Books/Audiobooks:** reuse `collections.forceSearchCollection` (#418), gated by `force_search_book`
  (new `canForceSearch` flag on `books.collectionGroups`). Comics excluded (Kapowarr, no on-demand
  collection path). Generic confirm copy (no per-collection missing count on the books wall).

## 3. Drill-header primary treatment
"All collections" (back) + "Edit collection" were too small/hard to see → the `btn primary` green pill
idiom (the "New collection" look). Placement unchanged, no reflow (ADR-015).

## Shared seam
The badge/pill both render through ONE `MediaAction` (`presentation` = look only) → the action-anatomy
drift guard still holds (no new key/label). New component `apps/web/components/collection-search.tsx`
(`CollectionForceSearch`) wraps the confirm Modal + the two provider mutations.

## Docs
DESIGN-035 D-16 amend, DESIGN-043 D-01/D-02 amend, ADR-071 companion note (all dated 2026-07-19).
