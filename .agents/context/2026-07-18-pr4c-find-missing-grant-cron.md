# 2026-07-18 — PR4c: find-missing grant + per-collection knob + cron force-search (SHIPPED on branch)

Realizes **ADR-072** + **DESIGN-043 D-14** + **DESIGN-042 D-06/D-14** per **PLAN-052 PR4c**, the last PR4
leg, on top of PR4a (#393) + PR4b (#397). Branch `feat/find-missing-grants`. **NO migration** — the
`find_missing` grant + the reused `upsert_collection` / `request_book_search` audit actions already exist
from PR4a; the Kometa recipe source of truth is the app-owned managed file in git, not a table.

## What landed

- **/admin "Collections actions" FLIP grid.** `roles.setCollectionsActions` (+ `collectionsActions` on
  `roles.list`, admin implies) → the existing `setRoleCollectionActions` single-writer
  (`update_collection_actions` audit same-tx). The grid renders in the add + edit role forms
  (`lib/collections-actions.ts` mirror of `COLLECTION_ACTIONS`), Admin-only default. Forbidden path tested.
- **Per-collection knob.** `collections.setFindMissing({id, mediaType, on})` behind
  `collectionActionProcedure('find_missing')` (admin implies; a forged flag from a non-granted caller ⇒
  FORBIDDEN, tested). Libretto (`setCollectionFindMissing`) reads the recipe and re-PUTs it with
  `variables.acquisitionEnabled` flipped (a full PUT preserves builder/variables) — instant. Kometa
  (`setKometaFindMissing`) finds the recipe in the managed include, flips `findMissing`, recompiles, and
  opens a HUMAN-merged PR (`evaluateKometaAutoMerge` already withholds auto-merge when findMissing ON; the
  compiler emits `<arr>_add_missing: true` + `<arr>_search: true`). Both audit `upsert_collection` with a
  `find_missing` detail (the Kometa `upsertAuditDetail` now always carries the recipe's find-missing state).
- **UI.** The `/collections` find-missing puck became a TOGGLE for a granted caller (`data.canFindMissing`,
  which folds admin in server-side): Modal confirm on ENABLE (owner tone, no em-dashes; Kometa case notes
  the admin-merge-then-next-run pending state), direct click to disable. Recolor-never-reflow (ADR-015 —
  the `.acq-puck` reserves the widest label's width; the `<button>` variant only adds cursor/hover). A
  non-grant caller sees the honest read-only puck.
- **Cron force-search.** New `@hnet/domain/collection-force-search.ts` `forceSearchFindMissingCollections`:
  reads the Libretto recipe list for `acquisitionEnabled` ON, maps to mirror collections, and drives the
  confined LazyLibrarian chain (addBook → queueBook(format) → searchBook(format)) over each find-missing
  collection's origin='collection' wants (from #394 — resolved `llBookId`). Single-writer +
  `request_book_search` audit (via `find_missing_cron`); IDEMPOTENT via a 12h cooldown on `last_searched_at`
  + a 25/run cap (both env-tunable); DEGRADES on a Libretto outage (whole pass skipped) or per-want LL error
  (counted, left for next run). Wired into the `books-collections-sync` mode AFTER the wants pass, gated on
  `librettoRead` + `lazyLibrarian`; `sync.ts` now builds the LazyLibrarian bundle for that mode too.
- **Movies/TV need NOTHING extra (verified + documented).** Kometa's own `radarr_add_missing` /
  `sonarr_add_missing` + `_search` flags do the acquisition on its scheduled `collections` CronJob runs — the
  app only compiles the flag on. There is no Kometa app-side force-search; the human-merged PR + Flux + the
  next Kometa run is the whole path.

## Runtime prerequisites (unchanged from PR4b, re-flagged)
- Kometa writes still need `HAYNESOPS_WRITE_TOKEN` + the haynes-ops bootstrap (docs/ops/014). Absent it,
  Movies/TV find-missing surfaces the honest degrade; Books/Audiobooks are unaffected.
- The books cron force-search needs `LAZYLIBRARIAN_API_KEY` in the `books-collections-sync` CronJob env.
  Absent it, the flag is still set (Libretto's own apply/cron acquires) but the app pulls nothing — a
  degraded run, logged.

## No migration
Reused: `find_missing` (COLLECTION_ACTIONS, PR4a/0069), `upsert_collection` + `request_book_search` audit
actions (both already in `PERMISSION_AUDIT_ACTIONS`). The find-missing toggle audits as `upsert_collection`
(with a `find_missing` detail) — enabling acquisition IS an edit to the recipe; the cron audits as
`request_book_search` (the recordManualSearch precedent). No new column, enum, or CHECK.

## Tests (full typecheck/lint/lint:css/test/build green)
- Domain: `collections.test.ts` (setCollectionFindMissing re-PUT + audit + NotFound); `kometa-collections.test.ts`
  (setKometaFindMissing enable ⇒ human-merged + `radarr_add_missing: true`, disable ⇒ may auto-merge, NotFound);
  new `collection-force-search.test.ts` (acquisition-ON-only, cooldown idempotency, unresolved-want skip,
  Libretto-unreachable degrade).
- API: `roles.test.ts` (setCollectionsActions replace-set/admin-implies/empty-clears + admin-only forbidden);
  `collections.test.ts` (setFindMissing no-grant FORBIDDEN, granted Libretto re-PUT, admin Kometa human-merged PR).

## Left for later legs
- **Drift-guard leg:** the find-missing puck-toggle is a collection-local control (the acq-puck idiom), NOT a
  `<MediaAction>`. The unified media-action drift guard (memory: "Unified media-action UX doctrine") is a
  separate leg and should decide whether the puck registers there.
- Advisory e2e/gallery screenshot capture for the toggle state was not extended — a parallel agent owns the
  wanted-detail/activity surfaces (boundary respected); `apps/web/e2e/support/capture-collections.ts` already
  captures the Settings find-missing seam.
