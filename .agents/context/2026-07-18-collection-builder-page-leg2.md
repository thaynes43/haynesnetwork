# 2026-07-18 — Collection builder page (DESIGN-044 leg 2)

Branch `feat/collection-builder-page`. Leg 2 of the collection-builder rework: the full builder PAGE that
replaces the DESIGN-043 D-03 "tiny popup" Modal composer (owner ruling). Leg 1 (Libretto search/preview API +
`@hnet/libretto` client) shipped in PR #417.

## What shipped

- **Routes (D-01):** `/collections/new?tab=<mediaType>` (create) and `/collections/<id>/edit?tab=<mediaType>`
  (edit; `&hand=<file>` for a hand-authored Kometa collection). Route pages under
  `apps/web/app/(app)/collections/new/` and `.../[id]/edit/`. The page component is
  `apps/web/app/(app)/collections/builder-client.tsx`.
- **Modal removal:** `collections-client.tsx` no longer renders the composer/over-cap Modal. `openCreate`/
  `openEdit`/`openEditHand` and the wall-drill `?edit=`/`?new=1` deep links now PUSH the builder route. The
  find-missing / force-search / delete Modals stay (they were never the add/edit modal).
- **Builder page (D-02..D-08):** single progressive page (form left, sticky preview right; stacks at 390).
  Builder-type cards with the D-03 copy verbatim (from `apps/web/lib/collections.ts`); search-first ref field
  in three shapes (typeahead / validated URL / multi-add id list); live preview split "In your library" vs
  "Missing" with counts + a cap meter; options (ordered / syncMode); save via the unchanged `upsert` /
  `editHandCollection` / over-cap `requestOverride` flows.
- **tRPC (D-04/D-05):** new `collections.search` + `collections.preview` (authed, read-only) over the confined
  `@hnet/domain` `searchCollectionRefs` / `previewCollectionMembers` (new `packages/domain/src/collection-builder.ts`).
- **arr schema (Q-04):** `radarrLookupSchema` extended with the franchise `collection { name | title, tmdbId }`
  (tolerant of Radarr's version-drifted name key). `packages/arr/src/schemas/radarr.ts`.
- **Held-match (D-10):** app-side against the mirrors — books via `books_items` ISBN + the DESIGN-037
  title+author fallback (honest "matched by title" flag, Q-03); movies/TV via `media_items` tmdb/tvdb id.
- **Preview coverage:** books/audiobooks (Libretto preview); movies/TV hand-picked id lists (arr lookup);
  movie franchise via the Radarr collection read; URL-ref builders (imdb_list / tvdb_list_details) render the
  honest "preview unavailable" note (Q-01, no new egress).
- **Docs:** DESIGN-044 → Accepted (Shipped) with as-built notes, Q-05 + Q-06 resolved; DESIGN-043 D-03 marked
  superseded by DESIGN-044.
- **Gallery:** `capture-collections.ts` extended with the builder states (empty type-cards, searched,
  previewed-with-missing, over-cap meter + ticket, locked-builder edit); stub Libretto gained `/api/search` +
  `/api/preview`.

## Tests

- `packages/arr/__tests__/metadata-clients.test.ts` — the collection field parse (name + title serializations).
- `packages/domain/__tests__/collection-builder.test.ts` — search (books/franchise/degrade) + preview
  (books ISBN + title fallback, source isolation, 0-member, outage; movies franchise + id list; URL unavailable).
- `packages/api/__tests__/collections.test.ts` — the search/preview procedures (proxy, franchise, degrade,
  unavailable, authed-only).
- `apps/web/lib/__tests__/collection-builder.test.ts` — the D-03 copy (no em-dash), cap meter, URL validation.

Full `pnpm typecheck && pnpm lint && pnpm lint:css && pnpm test && pnpm build` green (only pre-existing
unrelated lint warnings). e2e is advisory.

## Not done / residual

- The unsaved-navigation guard is a plain Cancel/Back (the design's ConfirmButton/Modal guarded-nav is a
  nice-to-have; not blocking). Consider adding on hardening.
- The screenshot capture code is written but running it (full stack via Playwright) was not exercised in this
  pass; run `pnpm --filter web exec tsx e2e/support/capture-collections.ts <out-dir>` for the gallery.
