# DESIGN-044: The collection builder page — a full-page, search-first builder with a live member preview

- **Status:** Accepted (Shipped) <!-- leg 2: the builder page + collections.search/preview + arr collection field, PR feat/collection-builder-page -->
- **Last updated:** 2026-07-18
- **As-built (leg 2):** The page ships at `/collections/new?tab=<mediaType>` (create) and
  `/collections/<id>/edit?tab=<mediaType>` (edit; `&hand=<file>` for a hand-authored Kometa collection),
  in `apps/web/app/(app)/collections/builder-client.tsx`. The DESIGN-043 D-03 Modal composer is REMOVED from
  `collections-client.tsx`; "New collection" and every Edit PUSH the page, and the wall-drill `?edit=`/`?new=1`
  deep links resolve to a push (D-01). Search + preview are the new `collections.search` / `collections.preview`
  tRPC procedures over the confined `@hnet/domain` `searchCollectionRefs` / `previewCollectionMembers` (books ⇒
  the `@hnet/libretto` client; movies/TV ⇒ the `@hnet/arr` lookup, with `radarrLookupSchema` extended to
  surface the franchise `collection { name, tmdbId }` per Q-04). The held/missing split is computed app-side
  against `books_items` (ISBN + the DESIGN-037 title fallback) and `media_items` (tmdb/tvdb id) per D-10. The
  builder-card copy (D-03) lives verbatim in `apps/web/lib/collections.ts` (one source of truth for the page +
  the gallery), lint-tested for the no-em-dash tone rule.
- **Satisfies:** the amended PRD R-225..R-228 (collection add/edit UX); realizes the 2026-07-18 owner
  ruling that the `/collections` composer must become a FULL BUILDER PAGE — plain-language builder
  explanations, provider SEARCH (find the series/list/franchise by typing, no slug pasting), and a LIVE
  PREVIEW of resolved members split in-library vs missing with counts + a cap meter.
- **Supersedes (in part):** **DESIGN-043 D-03** — the `Modal` composer is REMOVED and replaced by this
  page. DESIGN-043 stays the design of record for the manager surface, the cap (D-10), the over-cap
  ticket (D-11), find-missing (D-14), delete (admin), the sub-nav (D-09), and the mirror read (D-02). This
  design changes ONLY how a collection is ADDED/EDITED (the composer → a page); every save FLOW, gate, and
  audit rule DESIGN-043/042 fix is unchanged.
- **Governed by:** ADR-072 (direct-add + capped self-serve + over-cap ticket + find-missing grant + Kometa
  auto-merge), ADR-064 (mirror-only — the app writes a recipe, the provider owns the collection), ADR-015
  (page contents must not re-orient on interaction — hard rule 9), ADR-014 / hard rule 8 (ConfirmButton /
  Modal for destructive + explanatory confirms), hard rule 2 (tokens-only color), hard rule 6 (audit in the
  same tx as the mutation).
- **Companions:** DESIGN-043 (the collection manager — the page this composer lives under), DESIGN-042
  (the Kometa provider — Movies/TV write path + the `KOMETA_BUILDER_TYPES` allowlist), DESIGN-037 / Libretto
  (the books provider — the live search + preview API this page consumes), DESIGN-035 / DESIGN-038 (the
  Movies/TV and Books/Audiobooks mirrors the held-match reads back through), DESIGN-008 (the `@hnet/arr`
  `movie/lookup` + `series/lookup` metadata paths the Movies/TV ref search rides), ADR-058 (the shared card
  system), DESIGN-029 (the wall/registry idioms), DESIGN-004 (the nav / page chrome idioms).

## Overview

The owner ruled the DESIGN-043 add/edit `Modal` a design flaw: "a tiny popup nobody can add collections
with." A collection is a rich thing — a builder type, a source ref that is hard to know by heart (a
Hardcover series slug, a TMDb collection id, an IMDb list URL), a set of options, and a resolved
membership that a user cannot see before they commit. Squeezing all of that into a modal makes the one
job the manager exists for — adding a good collection — the hardest thing on the page.

This design replaces the modal with a **full builder page**. It has three jobs, and it does each one in
the open, at any screen width down to 390px:

1. **Explain the choices in plain words.** The builder types are picked from **cards** with a one-line,
   jargon-free explanation each (the actual copy is in D-03 — the page agent uses it verbatim). No one
   should need to know what "tmdb_collection_details" means to build a franchise collection.
2. **Find the source by typing, not by pasting.** A **search-first ref field** (D-04): type "stormlight"
   and pick The Stormlight Archive; type "goosebumps" and pick the movie franchise; type "hardcover
   fiction" and pick the NYT list. Slug/id/URL pasting stays as an honest fallback, never the front door.
3. **Show what you are about to build.** A **live preview panel** (D-05): the resolved members as a tile
   grid, split into "In your library" and "Missing", with counts and a **cap meter** — so a user sees,
   before saving, exactly which titles land, which the estate lacks, and whether the set fits the size cap.

**Binding direction.** This is the design of record for the composer. The page is at
`/collections/new?tab=<mediaType>` (create) and `/collections/<id>/edit` — reached from the manager and
from the wall drill deep links, which now PUSH the page instead of opening a modal (D-01). The
`collection_size_cap`, the over-cap `collection_override` ticket, the Libretto-direct / Kometa-auto-merge
write split, find-missing, delete, and every audit rule stay exactly as DESIGN-043/042 specify — this
design does not touch a single save-side gate. It changes the surface a user builds on, and it adds the
Libretto API (search + member preview, D-09) that makes the search + preview possible.

## Detailed design

### D-01 — Routing: a page, not a modal

The add/edit composer becomes its own route under the DESIGN-043 first-class `/collections` page:

- **Create:** `/collections/new?tab=<mediaType>` where `<mediaType> ∈ {movies, tv, books, audiobooks}`.
  The tab seeds the provider binding (Movies/TV → Kometa; Books/Audiobooks → Libretto) and the builder-card
  set (D-03). A missing/invalid tab falls back to the first media type the caller can see.
- **Edit:** `/collections/<id>/edit` opens the page pre-loaded with the recipe (the DESIGN-043 `openEdit`
  data). The builder type + name are LOCKED in edit (the DESIGN-042 D-05 identity rule — only the ref and
  options change); the page states this plainly.
- **Deep links now push the page, not the modal.** The DESIGN-043 D-09' wall drill "Edit collection" link
  and the `/collections?tab=..&edit=<recipeId>` / `?new=1` deep links RESOLVE to a push of this page. On
  arrival the page clears the transient `edit`/`new` query params with a `router.replace` (refresh + Back
  land on the plain sub-section — the DESIGN-043 D-09' behavior, preserved). An unknown `id`/`recipeId`
  lands on the media tab with a quiet "that collection could not be loaded" note, never an error modal.
- **The `Modal` composer (DESIGN-043 D-03) is removed** along with its mount points. `Modal` stays in use
  for the OTHER DESIGN-043 confirms (delete's explanatory Modal, the over-cap "request it" Modal, the
  find-missing enable Modal) — this design removes only the ADD/EDIT modal.

Leaving the page with unsaved edits uses the estate's standard guarded-navigation prompt (a `ConfirmButton`
/ Modal, never `window.confirm` — hard rule 8); a pristine page navigates freely.

### D-02 — A single progressive page, not a wizard

The page is ONE scroll, not a multi-step wizard (a wizard hides the preview behind "next" and re-orients
the view on every step — both are exactly what the owner rejected). Top to bottom, at desktop width the
FORM is the left column and the PREVIEW is a sticky right column; at phone width the preview stacks BELOW
the form (D-08). The form sections, in order:

1. **What kind of collection?** — the builder-type cards (D-03). Picking one reveals the ref field below
   it; the cards recolor to show the choice but do not reflow the sections under them (ADR-015).
2. **Which one?** — the search-first ref field (D-04), shaped by the chosen builder.
3. **Name it** — the collection name (prefilled from the resolved ref's name when search supplies one; the
   user can override). Locked in edit.
4. **Options** — the human-worded toggles (D-06), only the ones that MEAN something for this builder +
   media type.
5. **Target library** — a select, shown ONLY when it is meaningful (D-06): Books vs Audiobooks already
   fixes the Libretto target; a Movies/TV tab may map to more than one Plex library.
6. **Save** — the primary action; its label + behavior are the DESIGN-043 save flows (D-07).

Every reveal is an in-place expansion (the sanctioned ADR-015 exception, like the catalog inline editor):
choosing a builder or resolving a ref changes CONTENT in place; it never repositions a neighbor a user was
already looking at. The preview panel updates its own contents (a deliberate content change, allowed) but
holds its position.

### D-03 — Builder-type cards + the plain-language copy (THE deliverable)

Each media tab shows the builder types its provider allows, as **cards** (the ADR-058 card family, tokens
only). Each card is a short human title + a one-line explanation + a tiny "what you'll enter" hint. The
copy below is authored in the owner's tone (no em-dashes, no jargon, no names, semi-professional and
friendly) and is used VERBATIM by the build. Cards are ordered easiest-first.

**Books and Audiobooks (Libretto provider — live builder types `hardcover_series`, `nyt_list`,
`static_ids`):**

| Builder | Card title | One-line explanation (verbatim) | "What you'll enter" hint |
|---|---|---|---|
| `hardcover_series` | A book series | "Every book in a series, in reading order. Type the series name and pick it, and the whole series comes along, even the ones the library does not have yet." | Search a series by name |
| `nyt_list` | A New York Times list | "A New York Times bestseller list, kept in list order. Great for a shelf that follows what is popular right now." | Pick a list by name |
| `static_ids` | A hand-picked set | "A set you choose book by book. Search for each title and add it, and they stay in the order you add them." | Search and add each book |

**Movies (Kometa provider — the member-suggestible allowlist `imdb_list`, `tmdb_collection_details`,
`tmdb_movie`; DESIGN-042 D-04):**

| Builder | Card title | One-line explanation (verbatim) | "What you'll enter" hint |
|---|---|---|---|
| `tmdb_collection_details` | A movie franchise | "A movie franchise or series, all of its films together. Type a movie from it and pick the franchise, and every film in that franchise comes along." | Search a movie, pick its franchise |
| `imdb_list` | An IMDb list | "Any public IMDb list, kept in the list's order. Paste the list's web address and the app pulls in everything on it." | Paste an IMDb list link |
| `tmdb_movie` | A hand-picked set of movies | "A set you choose film by film. Search for each movie and add it, and they stay in the order you add them." | Search and add each movie |

**TV (Kometa provider — the member-suggestible allowlist `tvdb_list_details`, `tmdb_show`, `tvdb_show`;
DESIGN-042 D-04):**

| Builder | Card title | One-line explanation (verbatim) | "What you'll enter" hint |
|---|---|---|---|
| `tvdb_list_details` | A TVDb list | "Any public TheTVDB list, kept in the list's order. Paste the list's web address and the app pulls in every show on it." | Paste a TVDb list link |
| `tmdb_show` | A hand-picked set of shows | "A set you choose show by show. Search for each show and add it, and they stay in the order you add them." | Search and add each show |
| `tvdb_show` | A hand-picked set of shows (TVDb) | "A set you choose show by show, matched on TheTVDB. Search for each show and add it, and they stay in the order you add them." | Search and add each show |

Owner-only builder types (`tmdb_discover`, `imdb_chart`, `imdb_search`, `plex_all`) are NOT cards on this
page (DESIGN-042 D-04 — they are query/search/regex objects, not a ref a member picks). If the estate later
opens one, it gets a card + copy in the same tone. An empty allowlist for a tab shows an honest "no
collection types are available here yet" state, never a fabricated card.

### D-04 — The search-first ref field

The ref field is shaped by the chosen builder. Three shapes cover every live type; all three keep
slug/id/URL entry as a visible fallback (an "enter it directly" affordance), so an advanced user is never
blocked and a search outage degrades to manual entry.

**Shape A — typeahead search (one ref).** `hardcover_series`, `nyt_list`, and the Movies/TV
franchise/collection types. The user types a name; a debounced (~250ms) query fills a result list; picking
one sets `builder.ref` and prefills the name. Per builder the search backend is:

- **`hardcover_series`** → Libretto `GET /api/search?type=hardcover_series&q=<text>` (D-09). Results are
  `{ ref, name, workCount, author }` — the card shows the series name, the author, and the book count.
- **`nyt_list`** → Libretto `GET /api/search?type=nyt_list&q=<text>` (D-09). Results are the well-known
  list names filtered by substring (`{ ref, name }`); zero external calls, so it is instant.
- **`tmdb_collection_details`** (movie franchise) → `@hnet/arr` Radarr `movie/lookup?term=<text>` (DESIGN-008
  D-05): the user searches a MOVIE by name, and the app reads the looked-up movie's TMDb **collection**
  field (its franchise) as the ref. The result card reads "part of the <Franchise> collection". A movie
  with no franchise is shown disabled with an honest "this movie is not part of a franchise" note.
  **Dependency (Q-04):** the `@hnet/arr` `radarrLookupSchema` does not currently surface the `collection`
  field; the page agent extends the ACL schema to expose `collection { name, tmdbId }` (Radarr returns it
  on `movie/lookup`).
- **`tmdb_movie`** (hand-picked movies) → Radarr `movie/lookup?term=<text>`: each pick appends the movie's
  `tmdbId` to the id list (Shape C multi-add).
- **`tmdb_show` / `tvdb_show`** (hand-picked shows) → Sonarr `series/lookup?term=<text>`: each pick appends
  the show's `tmdbId` / `tvdbId` to the id list (Shape C multi-add).

**Shape B — validated URL (one ref).** `imdb_list`, `tvdb_list_details`. There is no name search for a list
URL (and the estate adds NO new external egress for a resolve, DESIGN-042 Q-06). The field is a URL input
with inline validation against the DESIGN-042 D-04 pattern (`imdb.com/list/ls\d+/`, a TVDb list URL). The
preview for these is honestly "preview unavailable for this ref type" (D-05) — the app cannot resolve a
list URL's members without a network call it does not make.

**Shape C — multi-add id list.** `static_ids` (books), `tmdb_movie`, `tmdb_show`, `tvdb_show`. The field is
a search box (Shape A backend per builder) that ADDS each pick to an ordered, reorderable, removable list
(drag-reorder is an ADR-015-sanctioned exception). The ref is the accumulated id array. Each row shows the
resolved title so the list is legible, never a bare id.

The `@hnet/arr` lookups are reached ONLY through a tRPC procedure server-side (the ADR-055 confinement —
never a browser call to a *arr); the Libretto search likewise goes through the confined `@hnet/libretto`
read client (D-09). Debounce is the client's job; result counts are capped by both providers server-side.

### D-05 — The live preview panel: in-library vs missing, counts, cap meter

Whenever the ref resolves to a concrete membership, the preview panel fills. It is the page's centerpiece.

- **Resolve the members.** The panel calls the provider's member-preview:
  - **Books/Audiobooks (Libretto):** `POST /api/preview { builder: { type, ref } }` → the resolved member
    identities `{ label, title, author, isbn, position, identifiers }[]` with `total` + a `truncated` flag
    (Libretto caps at 100; D-09). This is the FULL membership a run would produce, not just the missing
    ones.
  - **Movies/TV (Kometa):** the DESIGN-042 D-04/Q-06 `previewKometaRef` — an id-list builder
    (`tmdb_movie`/`tmdb_show`/`tvdb_show`) previews its EXACT members (the app knows the ids and resolves
    each title via `@hnet/arr` lookup); a URL / collection-id builder (`imdb_list`, `tvdb_list_details`,
    `tmdb_collection_details`) that the app cannot resolve without new egress renders the honest
    "preview unavailable for this ref type" state. `tmdb_collection_details` CAN preview when it was reached
    through Shape-A movie search (the app then holds the collection's films from the Radarr payload); a
    pasted collection id cannot.
- **Split held vs missing, app-side.** The held-match is computed by the app against its own MIRRORS
  (D-10), never asked of the provider — so the preview is honest about THIS estate:
  - **Books/Audiobooks:** each member is held if its ISBN or any of its `identifiers` matches a
    `books_items` row for the tab's source (kavita ⇒ books, abs ⇒ audiobooks), with the DESIGN-037 D-04
    conservative title+author fallback for the many Kavita rows whose ISBN is null. Members that match
    nothing are "Missing".
  - **Movies/TV:** each member is held if its `tmdbId` (movies) / `tvdbId` (TV) matches a `media_items`
    row; unmatched members are "Missing".
- **Render two tile groups.** "In your library (N)" and "Missing (M)" as tile grids (the ADR-058 card
  family; poster where the mirror has one, a titled placeholder otherwise), each with its count. A member
  resolved by the title fallback carries a quiet "matched by title" sub-note (the DESIGN-037 honesty flag),
  never a defect badge.
- **The cap meter.** A meter reads `resolved members / collection_size_cap` (DESIGN-043 D-10; the cap is a
  COUNT of resolved members). Under the cap it is calm; at/over the cap it deepens color and the save
  action switches to the over-cap "request it" path (D-07) — a recolor, not a reflow (ADR-015; the meter
  reserves its width). For an admin (cap-exempt) the meter is informational only.
- **Honest edges.** A 0-member resolve (a container-series slug, an empty list) shows "this resolved to no
  titles" — the silent-failure guard, never a fabricated tile. A truncated preview (>100 members) shows
  "showing the first 100 of N" so the count is never a lie. A provider/search outage degrades the panel to
  "preview unavailable right now" and still lets the user save (the save re-resolves server-side under the
  real cap) — the preview is an aid, not a gate.

The preview is READ-ONLY and mutates nothing (Libretto `/api/preview` and the *arr lookups are pure); it is
safe to call on every debounced ref change.

### D-06 — Options in human words

Only the options that MEAN something for the chosen builder + media type are shown, each in plain language
(the DESIGN-043/037/042 variables, worded for a person):

- **Reading / list order** (`variables.ordered` / Kometa `collection_order`) — shown for ordered sources
  (a series, a ranked list): "Keep them in order" with a sub-note "the series' reading order" or "the
  list's order". Off for a hand-picked set unless the user opts in.
- **How it stays in sync** (`variables.syncMode`) — "Replace the collection to match the list every time it
  runs" (`sync`) vs "Only add new matches, never remove" (`append`). Worded as a two-choice, default
  `append` (the safe, non-destructive default).
- **Find missing** (`variables.acquisitionEnabled` / Kometa `radarr_add_missing`/`sonarr_add_missing`) —
  shown ONLY to a caller whose role holds the DESIGN-043 D-14 `find_missing` grant, and disabled with an
  honest "needs the find-missing grant" otherwise. Enabling it is confirmed through the DESIGN-043 D-14
  explanatory `Modal` ("this makes the estate acquire the collection's missing titles on the next run") —
  that Modal survives; it is not the add/edit modal this design removed. Default OFF.
- **Target library** (D-02 §5) — shown only when the media type maps to more than one target library. Books
  vs Audiobooks is already the target; a single-library Movies/TV tab hides it.

### D-07 — Save flows are unchanged

Save runs the EXACT DESIGN-043 D-03/D-06 + DESIGN-042 flows — this design changes the surface, never the
save semantics:

- **Validate before save.** `collections.upsert` re-validates the draft server-side (Libretto
  `POST /api/validate` for a books recipe; the Kometa compiler `--validate-file` for a Movies/TV recipe);
  blocking issues render inline per path. The client preview is never trusted as the gate.
- **Within the cap →** the provider write: Books/Audiobooks a `PUT /api/recipes/:id` through the confined
  `@hnet/libretto` writer (instant); Movies/TV the regenerated managed include + the auto-merged haynes-ops
  PR (DESIGN-042 D-10) — the row shows "Applying" until the next run + mirror. Every write is audited in the
  same tx (hard rule 6).
- **Over the cap →** the DESIGN-043 D-11 `collection_override` ticket (the "request it" Modal, carrying the
  full definition), NOT a save error and NOT a silent truncation. A Movies/TV over-cap add is human-merged
  (DESIGN-042 D-10).
- **`id` uniqueness** is enforced (the Libretto "recipe id is global" rule). Delete stays admin-only, its
  own explanatory Modal (DESIGN-043 D-03), and is NOT part of this page's create flow.

### D-08 — Mobile-first, works at 390

The page is designed phone-first and MUST be usable at 390px (the standing DESIGN-006 / screenshot-review
width):

- **Single column at phone width; the preview stacks BELOW the form.** The desktop two-column (form left,
  sticky preview right) collapses to one column under the layout breakpoint. On a phone a user fills the
  form, then scrolls to the preview; a small "N in library / M missing" summary chip sits inline near the
  save action so the counts are visible without scrolling back.
- **Builder cards** wrap to one-per-row at 390; the tile grids use the viewport-fit grid primitive
  (`minmax` columns) so posters never overflow. Wide content (a long id list, a member grid) scrolls
  inside its own container, never the page body (no horizontal page scroll — the DESIGN-006 rule).
- **Touch targets** meet the estate minimum; the search field, the add/remove/reorder controls, and the
  save action are all thumb-reachable. No hover-only affordance is load-bearing.
- **Tokens only** (hard rule 2): every color is a `--color-*` token themed by `data-theme`; the cap meter,
  the held/missing group headers, and the card selected-state all read correctly in dark and light.

Gallery entries capture the page at desktop + 390, dark + light: the builder-card step, a resolved
search + preview (both groups populated), the cap meter under and at the cap, the URL-ref
"preview unavailable" state, and the edit (locked builder) state.

### D-09 — The Libretto contract (search + preview), as shipped

This is the Libretto API this page's Books/Audiobooks path consumes, shipped in
[thaynes43/libretto#10](https://github.com/thaynes43/libretto/pull/10) and bound by the `@hnet/libretto`
read client (`search` + `preview`). Kept in sync with Libretto's own API doc (its README API table).

**`GET /api/search?type=<builderType>&q=<text>&limit=<n>`** — typeahead for a builder's ref.

- `type=hardcover_series` → proxies Hardcover's series search (rate-limit paced + short-TTL cached),
  returning `{ ref, name, workCount?, author? }[]` where `ref` is the Hardcover series id and `workCount`
  is the canonical (`primary_books_count`) size.
- `type=nyt_list` → the well-known `list_name_encoded` names filtered by substring, `{ ref, name }[]` (no
  key, no external call).
- `type=static_ids` → `[]` (free-form; nothing to search).
- Response: `{ type, query, results, truncated }`. Result counts are capped server-side (default 8, max
  25). Unknown `type` → 400; an unconfigured source (e.g. `HARDCOVER_TOKEN` unset) → 503, which the shared
  client maps to `LibrettoUnreachableError` (the field degrades to manual entry either way).

**`POST /api/preview`** — the member-level identities a DRAFT builder would resolve to.

- Body: `{ builder: { type, ref }, limit? }` (an UNSAVED builder — no recipe id or target needed; `ref` is a
  string for `hardcover_series`/`nyt_list`, a string array for `static_ids`).
- Response: `{ builder, total, truncated, members }` where each member is
  `{ label, title, author, isbn, position, identifiers }`. Bounded at 100 members with an honest
  `truncated` flag; the app applies the per-user `collection_size_cap` on top. Mutates nothing. A builder
  whose source is unavailable → 502; a 0-member resolve → `total: 0` honestly.

Supporting Libretto changes shipped alongside: `WorkItem` gained an optional `position` (series position /
list rank) surfaced by `hardcover_series` + `nyt_list` (their disk-cache keys bumped so a live pod
refreshes), and `resolveBuilder` now takes the builder directly so preview can resolve an unsaved draft.

### D-10 — Held-match idioms (against the mirrors, app-side)

The held/missing split (D-05) is computed against the app's OWN mirror tables by the existing match idioms —
the app never asks a provider "does this estate hold it" (Libretto answers only for ITS library targets, and
the manager reads live). Per media type:

- **Books/Audiobooks** — `books_items` (source `kavita` ⇒ books tab, `abs` ⇒ audiobooks tab). A member is
  held when its `isbn` or any of its normalized `identifiers` matches a `books_items` row's `isbn`; because
  Kavita rows frequently carry a null ISBN (DESIGN-024 / books-items.ts), the DESIGN-037 D-04 conservative
  noise-stripped title + author fallback recovers the rest. This is the same matcher family Libretto's own
  reconcile uses, run here against the app's mirror.
- **Movies** — `media_items` where `arr_kind = 'radarr'`, matched on `tmdb_id`.
- **TV** — `media_items` where `arr_kind = 'sonarr'`, matched on `tvdb_id` (a member's `tvdbId`).

The match is exact on the external id (no fuzz for Movies/TV; the *arrs carry clean ids). A member that
matches nothing is Missing. All of this is server-side in the `@hnet/domain` collections orchestrator (the
preview tRPC procedure joins the provider members to the mirror), never in the browser.

## Alternatives considered

- **A multi-step wizard.** REJECTED — a wizard hides the preview behind steps and re-orients the view on
  every "next", the two things the owner called out. A single progressive page keeps the preview always in
  view.
- **Keep the modal, just make it bigger.** REJECTED by the owner ruling — the problem is not modal size, it
  is that add/edit is a first-class task and deserves a page (search + live preview do not fit a confirm).
- **Resolve list-URL members (IMDb / TVDb list) for a full preview.** DEFERRED — it needs a new external
  egress allowlist entry (DESIGN-042 Q-06 resolved: no new egress in this pass). The URL-ref builders show
  an honest "preview unavailable for this ref type" until a resolve source is chosen (an open Q-NN).
- **Ask the provider for held/missing.** REJECTED — Libretto knows only its own library targets and the
  manager reads it live; the honest "does THIS estate hold it" answer is the app's mirror (D-10). Computing
  held-match app-side also keeps Movies/TV (no Kometa per-member API) on the same idiom.
- **A browser-side call to Hardcover / the *arrs for search.** REJECTED — the ADR-055 confinement: all
  provider calls go through tRPC + the confined clients, never the browser.

## Test strategy

- **Client (`@hnet/libretto`):** `search` + `preview` bind the endpoints, parse the tolerant shapes, and map
  errors honestly (unknown type → `LibrettoHttpError` 400; unconfigured/down → `LibrettoUnreachableError`).
  Shipped green in the client PR.
- **Domain / API:** the preview orchestrator joins provider members to the mirror and splits held/missing
  correctly (books by ISBN + title fallback; movies/TV by tmdb/tvdb id); the ref-search tRPC procedure is
  server-only + confined (a forbidden browser path has no route); save still routes within-cap → provider,
  over-cap → ticket (the DESIGN-043 matrix, unchanged) — a preview outage NEVER changes the save gate.
- **UI:** a hermetic capture driving stub providers at 390 + desktop, dark + light — the builder-card step,
  a populated search + split preview, the cap meter under/at cap, the URL-ref "preview unavailable" state,
  the locked-builder edit state, and an ADR-015 no-reflow assertion across every builder pick / ref resolve
  / option toggle. The removed add/edit `Modal` has no mount (a guard that the modal composer is gone).
- **Copy:** the D-03 builder-explanation strings live as constants (one source of truth) so the gallery and
  the page render the same verbatim copy; a lint check that they carry no em-dash (the owner tone rule).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | **URL-ref preview.** `imdb_list` / `tvdb_list_details` cannot preview members without a new external egress (DESIGN-042 Q-06). Do we ship the honest "preview unavailable" note (chosen), or add a resolve source + egress allowlist entry via a haynes-ops PR so those builders also get a live preview + a provable cap? | OPEN — owner ruling. Design ships the honest note; a TMDb/IMDb/TVDb resolve behind a new egress entry is a follow-up, not a proxy workaround. |
| Q-02 | **`tmdb_collection_details` reach.** The franchise ref is best found by searching a MOVIE (Radarr `movie/lookup`) and reading its `collection` field. A pasted collection id has no name/preview without a TMDb call. Is movie-search-to-franchise the only v1 entry, with a raw-id fallback that shows "preview unavailable"? | OPEN. Design leans yes (movie-search primary, raw-id fallback honest). Owner/coordinator confirm. |
| Q-03 | **Books held-match honesty.** Kavita `books_items` rows frequently carry a null ISBN, so the held/missing split leans on the D-04 title+author fallback for a large fraction of the books library. Is the title-fallback confidence enough to label a tile "In your library", or should such matches read as a distinct "probably in your library" state? | OPEN. Design leans: hold + the quiet "matched by title" sub-note (the DESIGN-037 honesty idiom). Owner confirm. |
| Q-04 | **`@hnet/arr` `collection` field.** `radarrLookupSchema` does not currently surface the `movie/lookup` `collection { name, tmdbId }` field the franchise search needs. The page agent extends the ACL — is `collection { name, tmdbId }` the exact subset, or does the franchise card want the poster too? | OPEN — build detail. Design specifies name + tmdbId (enough to set the ref + label); poster is a nice-to-have. |
| Q-05 | **Create route shape.** `/collections/new?tab=<mediaType>` + `/collections/<id>/edit` (chosen) vs a single `/collections/compose?...` param route. The dedicated `new`/`edit` paths read cleaner and deep-link better; a single route is one less file. | RESOLVED (leg 2) — the dedicated paths shipped: `/collections/new?tab=<mediaType>` (create) and `/collections/<id>/edit?tab=<mediaType>` (edit; edit carries the tab so the page loads the recipe from the right media overview, and `&hand=<file>` routes a hand-authored Kometa collection to `editHandCollection`). |
| Q-06 | **Search debounce + result cap on the client.** 250ms debounce and show the provider's server-capped results (8 default). Is that the right feel for a phone, or does the owner want a shorter debounce / a "show more" affordance? | RESOLVED (leg 2) — shipped at 250ms debounce with the provider's server-capped default (Libretto 8; the *arr lookups are clamped to the same request `limit`, max 25). A "show more" affordance is deferred; re-tune after the first gallery pass if the owner wants a different feel. |
