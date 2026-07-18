# 2026-07-18 — Collections row action: "Run now" → registry Force Search (owner ruling)

Owner ruling (live phone screenshot of /collections Books "Managed here" rows): "We have standard
nomenclature and this doesn't match any of it. What is 'Run now'? Where is 'Force Search' for
missing items?" The rows carried a hand-labeled "Run now" ConfirmButton wired to raw Libretto
applyScope — off the ADR-071 media-action vocabulary.

## What shipped (branch fix/collection-force-search-action)

- **Domain** `packages/domain/src/collection-force-search.ts` — `forceSearchCollectionNow`: the
  on-demand composition (a) applyScope (fresh membership) → (b) refresh the collection's
  origin='collection' wants (shared `resolveMissingMembers`, extracted into
  collection-wants-sync.ts, + `syncCollectionWants`) → (c) LL force-search the resolved missing
  members NOW. Cooldown BYPASSED (cutoff=null), per-call cap kept (default
  COLLECTION_FORCE_SEARCH_CAP_PER_RUN = 25). The cron leg (`forceSearchFindMissingCollections`)
  now shares `gatherCollectionWants` + `runForceSearchWorklist` with it — same LL chain
  (addBook→queueBook→searchBook), same one-tx stamp+audit (`request_book_search`; on-demand via
  `collection_force_search` with actor/subject = caller + collection_id tag; cron keeps
  `find_missing_cron`, actor null).
- **API** `packages/api/src/routers/collections.ts` — `collections.forceSearchCollection`
  mutation, gated by the books `force_search_book` grant (admin implies; FORBIDDEN otherwise — the
  same gate as books detail, which the owner has granted to all roles). Overview now carries
  `canForceSearch` + per-recipe `missingCount` (open origin='collection' wants). The dead
  `applyRecipe` procedure was REMOVED (`applyCollectionScope` domain fn stays; the mutation
  composes it via the bundle's write.applyScope). `collections.run` polling stays (the row still
  polls the returned runId for counts).
- **Client** `apps/web/app/(app)/collections/collections-client.tsx` — `ApplyButton` replaced by
  `CollectionForceSearchButton`: `<MediaAction action="forceSearch" size="sm">` in a
  `ReservedActionSlot`; firing opens the shared Modal ("Search for the N missing books in this
  collection now" + plain what-it-does copy); after firing the slot swaps to a PhaseChip in place
  (Searching… / Search started / Service unreachable / Search failed) — recolor, no reflow. Only
  mounted when `canForceSearch`; Kometa rows unchanged (no app-side on-demand path — Kometa's cron
  acquires).
- **Guard** `apps/web/lint/action-anatomy-guard.mjs` — "Run now" + "Run it?" joined
  RETIRED_ACTION_LABELS (R2); fixture test proves a raw btn wearing either label fails lint.
- **Docs** DESIGN-043: D-02 Force Search amend (owner quote + date) + D-07 sentence update.

## Tests

- domain: `packages/domain/__tests__/collection-force-search.test.ts` — on-demand describe
  (compose order, caller audit, cooldown bypass + idempotent mint, cap honored, unreachable
  degrade, NotFound).
- api: `packages/api/__tests__/collections.test.ts` — grant matrix (FORBIDDEN / granted / admin),
  event-ordered compose proof, audit actor, overview canForceSearch + missingCount.
- guard: `apps/web/lib/__tests__/action-system-guard.test.ts` — Run now/Run it? fixtures FAIL,
  `<MediaAction action="forceSearch">` passes; repo walk stays clean.

## Residuals

- `missingCount` counts open wants (visible tiles) — the searchable subset can be smaller
  (unresolved llBookId); the modal copy says "missing books", which stays honest.
- Kometa rows deliberately untouched (owner-ratified scope).
