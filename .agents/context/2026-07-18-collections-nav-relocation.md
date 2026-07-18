# Collections nav relocation — top row back to four, "Collection settings" in the user menu

- **Date:** 2026-07-18 (evening)
- **Author:** agent (Opus build agent; owner-ruled IA change, coordinator-endorsed)
- **Branch / PR:** `fix/collections-nav-relocation`
- **TL;DR:** The Collections top-nav tab (shipped in v0.81.x / ADR-072 PR4a as a fifth entry) was too
  large on mobile — it broke the DESIGN-004 D-22 goal of FOUR labels fitting 320px with no rail scroll
  (an edge-fade papered over it). It moves into the user menu as **"Collection settings"** (universal),
  and the Library walls gain a contextual **"Edit collection"** nav-out from a collection drill.

## What changed (surfaces)

1. **`apps/web/components/top-bar.tsx`** — removed the Collections `<Link>` from `.topbar__nav` (row
   returns to the ratified four: Portal · Library · Tickets · Trash). Added a universal user-menu item
   **"Collection settings"** → `/collections` (D-19 Link push, closes the menu), in the tooling group
   directly above "Trash settings". The tooling separator now always renders (Collection settings is
   the one universal tooling item). Removed the now-unused `COLLECTIONS_NAME` import. Nav history
   comments updated with the owner ruling.

2. **`apps/web/app/(app)/collections/collections-client.tsx`** — deep-link support:
   `?tab=<mediaType>&edit=<recipeId>` opens the matching MediaSection composer pre-loaded with that
   recipe (existing `openEdit` path), then CLEARS the param (router.replace, not push). Unknown
   recipeId → just the tab, no error. `&new=1` opens the create composer. The composer-open uses the
   adjust-state-during-render idiom (the codebase forbids setState in an effect — `react-hooks/
   set-state-in-effect`); a follow-up effect does only the router.replace.

3. **Wall nav-out "Edit collection"** on the drill header, tokens-only `.btn.sm.library-drill__edit`
   (`app.css`), static per screen (no reflow, ADR-015):
   - `apps/web/app/(app)/library/books-browser.tsx` — Books/Audiobooks drills. Renders only when the
     mirror row's `librettoRecipeId` is non-null (hand-made collections have none → no link). Comics
     wall has no Collections media tab → never shows the link. Links with `&edit=<recipeId>`.
   - `apps/web/app/(app)/library/library-client.tsx` — Movies/TV drills. Links to
     `/collections?tab=movies|tv` WITHOUT an edit param (the Kometa join is by title, no clean recipe
     id client-side — never fabricate an id). Music has no tab → no link.
   - `packages/api/src/routers/books.ts` — `BooksCollectionGroup` gains `librettoRecipeId` (surfaced
     from `books_collections.libretto_recipe_id` via the collectionGroups query) so the Books/Audiobooks
     drill header can build the deep link.

## Tests / docs

- `apps/web/e2e/nav-restructure.spec.ts` + `nav-overlap.spec.ts` — restored the FOUR-entry assertions
  incl. the strict no-scroll-at-320 guard (the pre-PR4a D-22/D-24 spec text), plus a new case: every
  user (even a fresh member) sees "Collection settings" → /collections as a history push.
- `packages/api/__tests__/books-collections.test.ts` — seeded `librettoRecipeId` on one fixture and
  assert it surfaces (and is null for a hand-made collection).
- Docs: DESIGN-043 D-01 amendment + new D-09' (wall drill nav-out + deep-link edit); DESIGN-004 D-22
  amendment (row back to four). No ADR supersede — ADR-072 is about the `/collections` SURFACE (still
  first-class), not the nav chrome. No glossary change ("Collection settings" is a UI label).

## Do-not-touch (honored)

Suggest machinery graveyard, /admin, packages/goodreads, trash.
