# DESIGN-029: Integrations hub, the Goodreads sub-section, shelf chips, and the composed Library-Wanted

- **Status:** Accepted
- **Last updated:** 2026-07-14
- **Satisfies:** PRD-001 R-188..R-191; governed by ADR-057 (hub + all-shelves acquisition + composed
  Wanted), ADR-055/056 (linking, requests, Kapowarr routing — unchanged), ADR-046 (mirror purity),
  ADR-051 (registry seam), ADR-015 (reflow-free), ADR-021 (section permissions). Supersedes the UI
  shape of DESIGN-028 D-06 (the flat tab) — the data model and sync flow of DESIGN-028 D-01..D-05
  stand, extended per D-01 below.

## Overview

The Integrations tab becomes a **hub** of provider cards; **Goodreads is a sub-section** with a stats
page and an items page that looks and feels like the Library. All four shelves (`to-read ·
currently-reading · read · did-not-finish`) sync AND acquire (owner ruling — A1 overruled). Shelf books
we don't hold surface as **Wanted in the Library** (Books/Audiobooks/Comics walls), composed from the
`book_requests` ledger — with the full TV/Movies Wanted parity including the force-search button.

## Detailed design

### D-01 — Data: all-shelves acquisition, no new column

`GOODREADS_SHELVES` (db enums) is the new `user_integrations.shelves` default; **migration 0047** sets
the column default and backfills exact-`["to-read"]` goodreads rows (a customized list is untouched).
Request minting was already shelf-agnostic (one `book_requests` row per live shelf item, ADR-055) —
widening the shelves list IS the acquisition change; push/reconcile/pacing are byte-identical. The
request's source shelf rides `integration_shelf_items.shelf` via the `shelf_item_id` join.
**A3 tolerance:** `isAbsentCustomShelfError` (`@hnet/goodreads`) — a 404 on a NON-built-in shelf reads
as an empty (still-synced) shelf; built-in failures stay integration errors and never tombstone. Applied
by `fetchShelfTolerant` (`@hnet/sync goodreads.ts`) and the fresh-link fast path (`integrations.link`).

### D-02 — Read-models (domain `book-requests.ts`)

- `requestPhase(request) → 'have' | 'searching' | 'missing' | 'parked'` — the shared collapse of the
  per-format statuses (match/landed ⇒ have; parked comic ⇒ parked; any format actively looking ⇒
  searching; every live format dead-ended ⇒ missing). Drives the corner puck + the stats tiles.
- `isRequestSearchable(request)` — the ONE force-searchability rule (moved from the router): a comic
  needs a Kapowarr volume id and not-landed; a book needs an LL id and not-both-landed.
- `computeShelfStats({integrationId}) → { shelves: [{shelf,total,covered,pct}], phases }` — per-shelf
  coverage (the computeCoverage predicate per shelf; a multi-shelf book counts in each shelf's row) +
  the one-bucket-per-request phase rollup.
- `getShelfWallItems({integrationId})` — the items wall: live shelf items LEFT-joined to requests and
  the matched `books_items` row, GROUPED per distinct book (`external_book_id`); shelf memberships
  aggregated in canonical order; the canonical request follows shelf priority; newest-shelved first.
- `getWantedBookRequests({format})` — the HOUSEHOLD Wanted overlay: unmet requests for one wall format
  (`ebook`/`audiobook`: `comic_status IS NULL AND <format>_status <> 'landed'`; `comic`:
  `comic_status IS NOT NULL AND <> 'landed'`), matched wants excluded, linked integrations only, deduped
  per distinct book across users/shelves with `requestedBy` aggregated.

### D-03 — API

- `integrations.overview` — hub card + stats page: link wire, the WANT-SHELF headline (Q-02), the
  per-shelf breakdown, the phase rollup.
- `integrations.items` — the items wall wire: one tile per distinct book (`key`, title/author, shelves,
  `posterUrl` via `booksCoverUrlFor` when matched → the cover proxy; null ⇒ the designed fallback tile),
  per-format statuses, `phase`, `searchable`, `requestId`.
- `books.wanted({mediaKind})` — **`booksProcedure`-gated** (the wall's own section — Q-01, household):
  the composed Wanted tiles with per-viewer `canSearch`/`canOpenRequest` computed SERVER-side (ownership
  - the `integrations` section — mirroring what `integrations.search` enforces). `integrations.search`
    itself is UNCHANGED (ADR-056 C-04): ownership re-checked, dispatch by format, audited.
- `status`/`link`/`unlink`/`shelf`/`requests` stand as shipped (the fresh-link fast path gains the A3
  tolerance).

### D-04 — The hub (`/integrations`)

Provider CARDS in the Trash-Overview whole-card-button idiom (`.hub-card`): the Goodreads card carries
the provider glyph, the Linked/Not-linked badge, and a reserved stat block (want-shelf coverage % +
shelved-books count; a "first sync in progress" hint while pending; the not-linked hint otherwise), and
PUSHES `/integrations/goodreads` (D-19). A dashed non-interactive ghost card names the saga's future
providers — an honest placeholder, not a dead control.

### D-05 — The Goodreads sub-section (`/integrations/goodreads`)

Server-gated like `/integrations` (the `integrations` section). A header row (back-to-hub affordance +
provider title), the **link card** (DESIGN-028 D-06's card, moved verbatim — ConfirmButton unlink,
first-sync pending polling), then `?tab=` navigation over one route (the Metrics/Trash precedent;
roving-tabindex tablist; a tab switch PUSHES keeping only `?tab`; a bare/unknown tab canonicalizes to
Overview with a replace):

- **Overview (stats)** — the headline coverage stat (want shelf — Q-02; the DESIGN-028 pending-state
  contract kept), the per-shelf breakdown cards (`.gr-ovcard`, one per POPULATED shelf; a card click
  pushes the items tab pre-filtered to that shelf), and the request-phase summary tiles (`.gr-phase`:
  Have · Searching · Missing · Parked, parked hidden at 0).
- **Items** — a REAL library wall: the shared `.library-toolbar` chrome (debounced `?q=` search, a
  status seg, the `.library-sortbar` with Shelved/Title/Author two-state sorts), the **shelf chips**
  (D-06), and the `.gwall` poster grid: `MediaPoster` tiles (cover-proxy art where the want matched the
  library; the designed KindIcon fallback tile elsewhere — never fake covers), the corner puck (D-07),
  fixed-height caption/author/shelf-badge/chips rows, and the reserved force-search slot (D-08).
  `?focus=<requestId>` (the Library deep-link) outlines + scrolls the request's tile — the folded
  Requests & Missing wall's per-item context. Client-side filter/sort over the bounded list
  (`goodreads-shelf-wall.ts` — RSS caps shelves at 100 items).

### D-06 — Shelf chips (the Helpdesk semantics, ported verbatim)

DESIGN-012 D-12's contract over the `.seg` skin: multi-select toggles (additive OR — the visible set is
the union), **"All" is a superset select** lighting when every chip is on, counts always visible
(`All · N`, `To read · N`, …), `aria-pressed`, recolor-only toggles (ADR-015), repeated `?shelf=` params
via `router.replace`; the canonical default (ALL populated shelves — a library wall shows everything)
writes NO param; the deliberate-empty selection writes `shelf=none` and renders the "pick a shelf chip"
empty state. Chips are populated-value-gated (an absent/empty shelf grows no chip — A3). Pure helpers +
unit tests mirror the Helpdesk spec (`shelfSelectionFromParams`/`shelfParamsForSelection`/`toggleShelf`).

### D-07 — The corner puck (per-item state on the poster)

`.gwall-overlay` — the twall/bwall grammar: absolute 30px puck over the reserved 2:3 `poster-box`,
`RequestPhaseGlyph` per phase (have = check · searching = magnifier · missing = alert · parked = pause),
per-phase token recolor (`--color-accent/warning/danger/text-muted`). Data states, never interaction
reflow.

### D-08 — Force-search (full TV/Movies parity)

**Amendment 2026-07-18 (admin force-search override):** `canSearch` (the force-search affordance) was
OWNER-scoped for a goodreads want — only the household member who shelved it saw the button, so an
ADMIN (e.g. the owner) viewing another member's want got the read-only "available to the person who
shelved this want" message and no button. Per owner directive, **an admin may force-search ANY user's
want.** `canSearch` for a non-pairing want is now `(owns || viewer.isAdmin) && hasIntegrations &&
isRequestSearchable` on both `books.wanted` (`toWantedWireItem`) and `books.wantedDetail`; the
`integrations.search` MUTATION admits an admin past its ownership gate and records the audit as
actor=the acting admin / subject=the request OWNER (`recordManualSearch` — a UI-gating change over an
already-admin-capable domain path, not a new capability). `canOpenRequest` stays owner-scoped (the
Goodreads deep link targets the owner's own sub-section). The pairing-want path is unchanged (it is
books-gated, never owner-scoped).

`RequestSearchButton` (shared by the items wall + the Library Wanted tiles): a plain `.btn.sm`
"Search again" (non-destructive — NEVER ConfirmButton) → `integrations.search({requestId})` → the
PLAN-015-style feedback in the RESERVED `.request-action` slot: pending "Searching…" → a pulsing
"Search fired — LazyLibrarian/Kapowarr" `PhaseChip` (formats detail in the title), or the honest no-op
("not routed yet" / "already landed") / error chip. The swap recolors in place (ADR-015); the request's
durable status advances on the next sync reconcile (the books analog of the ledger's live poll — books
have no per-grab progress feed, a documented residual).

### D-09 — The composed Library-Wanted (Books/Audiobooks/Comics walls)

- **The strip:** `WantedStrip` — a clearly-badged, warning-tinted section ("Wanted · N") ABOVE the
  library grid on the wall's top level (grouped or flat; never inside a drilled group), each tile a
  `.gwall-tile`: designed fallback poster + corner puck, Wanted/Missing badge + source-shelf badge +
  "for <requesters>", and the force-search slot when `canSearch`. A tile with `canOpenRequest`
  deep-links its poster to `/integrations/goodreads?tab=items&focus=<requestId>` (a PUSH).
- **The registry filter:** `WANTED_FACET` (`kind:'select'`, `param:'wanted'`, `dataGated`) added to
  `books:wall` / `audiobooks:wall` / `comics:wall` (ADR-051 C-01 — a registry-row edit). `?wanted=1` ⇒
  the wanted tiles ARE the wall (the Movies/TV `?wanted=1` narrowing); the chip is value-gated on the
  overlay itself and shows its count.
- **Honesty rules:** the text query narrows wanted tiles client-side (title/author); other facet
  refinements hide the strip — synthetic tiles can't answer format/length/read facets (the "never offer
  what it can't answer" rule). Gating: the wall's `books` section (household — Q-01); the tRPC layer is
  authoritative (a withheld books section withholds the tiles with it).

## Alternatives considered

- Wanted rows in `books_items` — rejected (ADR-046; ADR-057 option 2).
- A separate `/integrations/goodreads/items` route instead of `?tab=` — rejected: the Metrics/Trash
  `?tab=` precedent is the house hub idiom; one route keeps the gate + header in one place.
- Rendering Goodreads CDN covers on unmatched tiles — rejected again (DESIGN-028's call): CSP-safe
  designed tiles; a cover-proxy variant for external art stays a polish residual.

## Test strategy

- **Unit:** shelf-chip semantics (the Helpdesk spec mirrored), items filter/sort, `requestPhase`/
  `isRequestSearchable`, absent-shelf tolerance (`@hnet/goodreads` + `@hnet/sync`), the registry rows.
- **Domain (embedded PG):** the all-shelves vertical — EVERY shelf's unmet items mint + push BOTH
  formats (read/currently-reading acquisition assertions), comics route from any shelf, absent-DNF
  tombstone scoping, `computeShelfStats`, `getShelfWallItems` multi-shelf grouping,
  `getWantedBookRequests` per-format composition + household dedupe + unlink exclusion.
- **API (embedded PG):** `books.wanted` gate (unauth 401; withheld books section FORBIDDEN — the
  ADR-047 posture), household visibility with owner-scoped affordances, per-wall format legs.
- **e2e (hermetic):** the full journey — hub → sub-section → link → all-shelves sync (the stub serves
  per-shelf RSS; did-not-finish 404s) → stats assertions → items wall + chip combinations → book +
  comic force-search against the LL/Kapowarr stubs → Books/Comics wall Wanted tiles → wanted-tile
  force-search → deep-link focus. Screenshot harness `capture-plan045.ts` (desktop + 390, dark + light).

## Open questions

| ID   | Question                                                                               | Resolution                                                                                                 |
| ---- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Q-01 | Wanted-tile visibility while the integrations rollout is admin-only?                   | RULED: books-section gating (household), tiles clearly badged; flip is one gate if re-ruled.               |
| Q-02 | Live per-grab feedback for a fired book search (the ledger's `searchProgress` analog)? | Deferred — LL/Kapowarr expose no per-grab progress feed; the fired-chip + next-reconcile is the honest v1. |
| Q-03 | External-art proxy for unmatched wanted tiles (Goodreads CDN covers)?                  | Deferred polish (DESIGN-028's original call stands — designed tiles, never hotlinked art).                 |

## Amendment — 2026-07-14 (owner-corrected card anatomy)

Shipped in v0.50.0, D-07/D-08/D-09 gave the Goodreads items wall and the composed Library-Wanted a
BESPOKE grammar — a warning-tinted "Wanted · N" STRIP above the book walls, tiles built from
`.gwall-*` classes with a stack of chips (source shelf + `Ebook: Wanted` + `Audio: Wanted`), a
`for <requester>` line, a corner phase-glyph puck, and a full-width `Search again` text button. The
owner rejected it: the book/audiobook/comic walls no longer looked like the rest of the Library — a
Library item must be **one cohesive poster block**, exactly like a Movies/TV card. This amendment
CORRECTS the presentation (the data model, gating, sync, and force-search dispatch of ADR-055/056/057
are unchanged); it supersedes the _visual_ specifics of D-07, D-08, and D-09.

- **One shared caption, by construction.** The Movies caption markup is extracted into
  `components/poster-card-body.tsx` (`PosterCardBody`: title (year) · optional author subtitle · a
  compact badge row over the shared `.badge--*` tones). The Movies wall, the Books/Audiobooks/Comics
  on-disk AND Wanted cards, and the Goodreads items cards all render `MediaPoster` + `PosterCardBody`
  inside a `.media-card.poster-card` in a `.media-list.poster-grid`. The card structure is now
  identical across every wall — only the glyph and the badge text differ.
- **The Wanted strip is deleted.** Wanted items merge INLINE at the head of the flat book wall's item
  stream as the SAME poster card as an on-disk book (glyph tile, since a want is unmatched by
  definition; title + author; ONE badge — "Wanted" amber / "Missing" red — in the Movies badge slot).
  The grouped author/genre views show aggregate cards (a want can't participate as an item), so wants
  surface in the flat "All …" view and under the Wanted-only filter. `WantedStrip`/`.gwall`/`.gwanted`
  are removed; `wanted-card.tsx` replaces `wanted-strip.tsx`.
- **The Wanted-only filter** is rendered as the Movies wall's `Wanted only` toggle (a `btn sm`,
  `primary` when armed) rather than a select chip — same look, same `?wanted=1` facet.
- **No card-face action or attribution on Library Wanted cards.** There is no `Search again` button and
  no `for <requester>` line; the whole card is a click-through into the owner's Goodreads request
  context (`?tab=items&focus=<requestId>`), where force-search and requester attribution live.
- **Goodreads items wall.** Each item is one cohesive poster block with at most two caption badges (the
  primary shelf + the dominant status — `Have it` / `Wanted` / `Missing` / `Comic · Wanted`); per-format
  status and the "waiting on a ComicVine match" note move to the status badge's tooltip, never a stack of
  pills. Force-search is the ONLY card action and rides a compact corner **puck** (`.gr-search-puck`,
  `request-search-puck.tsx`) in the ADR-015 reserved slot — a single small icon button, top-right,
  recoloring in place to narrate `searching → fired → failed` (the big text button is gone).
- **Retired code:** `request-glyphs.tsx` (`RequestPhaseGlyph`), `request-search-button.tsx`
  (`RequestSearchButton`), `wanted-strip.tsx`, and the `.gwall*` / `.gwanted` / `.request-action` CSS.

## Amendment 2 — 2026-07-14 (the Wanted DETAIL page — completing the owner parity ruling)

Amendment-1 (v0.50.1, PR #261) unified the _card anatomy_ across the walls, but delivered the owner's
Wanted-parity ruling only **partially**: the poster looked like a Movies/TV card, yet clicking it did NOT
open a detail page, and force-search was a card-face **corner puck** rather than the Movies/TV
poster→detail→Force-Search flow. The owner called this out ("I can't click on them to open the details page
like you can on the Library tab… I also thought we were adding Force Search / Fix identical UX as the
TV/Movies have"). This amendment builds the missing half — the DETAIL PAGE — and supersedes the _corner-puck_
mechanism of amendment-1's D-07/D-08 (the data model, gating, sync, and dispatch of ADR-055/056/057 are
unchanged). PLAN-047.

- **One canonical route, both walls link to it.** `/library/books/wanted/[requestId]` — a sibling of the
  `/library/books/[id]` books detail (DESIGN-025 / PLAN-028 idiom; static `wanted` segment wins over the
  `[id]` dynamic sibling). The composed Library-Wanted cards (Books/Audiobooks/Comics) AND every
  non-have-it Goodreads items-wall card open it; a **have-it** Goodreads card opens the existing library
  detail (`/library/books/[id]`) of its matched `books_items` row instead (`matchedBooksItemId`, now on the
  items wire). The old `?tab=items&focus=<id>` deep-link is replaced as the primary click target; existing
  `?focus=` links still land + highlight on the wall (unchanged in `ItemsTab`).
- **The detail page (`wanted-detail.tsx`), the /library/[id] visual language by REUSE.** `BackLink` +
  `.card.detail-head` (2:3 `MediaPoster` — the cover-proxy art when the want is matched, else the designed
  KindIcon glyph) + title/author + a badges row (source shelf + the dominant phase) + the **requester
  attribution** (`Requested by` chips — the household roll-up, THIS is where it belongs; it was pulled off
  the card faces in amendment-1). Then a **Formats** section of `.child-row`s — the *arr per-grain idiom in
  book words: one row per format (Ebook + Audiobook for a book; the single Comic leg for a comic), each with
  its own downstream status badge (`requested`/`wanted`/`grabbed`/`landed`/`missing`) and, in the reserved
  `.action-slot`, a **per-format Force-Search** button that swaps to a live `PhaseChip`
  (`searching → fired / nothing / failed`) in place — ADR-015, no reflow.
- **Force-Search dispatch is the existing surface.** The button calls `integrations.search`, extended with
  an optional `format` (`ebook`/`audiobook`) so a book leg fires ONE `LazyLibrarian.searchBook(bookId,
format)`; omitted ⇒ the whole request (the retired puck's behaviour, kept backward-compatible). A comic
  leg omits `format` — Kapowarr's `auto_search` covers the whole volume. Audited as before
  (`request_book_search`). Books expose no per-grab progress feed (Q-02 residual restated): the fired chip
  is the immediate confirmation and the per-format status badge is the downstream signal on the next
  reconcile — the honest books analog of the ledger's live poll.
- **Gating (server-authoritative).** VIEW is `booksOrIntegrationsProcedure` (`books` OR `integrations`
  ≥ read_only) — "reachable by whoever can see the card that links to it": household books cards are
  books-gated (Q-01), the per-user Goodreads wall is integrations-gated. The page-level server wrapper
  redirects a caller with NEITHER section to `/library`. The per-format `searchable` affordance stays
  owner-scoped (OWN the integration AND hold `integrations` — exactly what `integrations.search` enforces);
  a books-only household viewer sees the status rows read-only, and the search ACTION FORBIDs them.
- **The corner puck is retired.** With the whole card now a click-through, an in-card button would be an
  invalid nested-interactive; force-search moves to the detail page (parity with Movies/TV, where the wall
  card carries no force-search either). `request-search-puck.tsx` and the `.gr-search-puck` CSS are deleted;
  the unused `.poster-card__poster` wrapper goes with them.
- **Test strategy (added).** Domain (embedded PG): `getBookRequestDetail` (shelf/owner/household
  attribution/cover-match/per-format status) + `runManualBookSearch` single-format narrowing. API: the
  `booksOrIntegrationsProcedure` VIEW gate (anon 401; neither-section FORBIDDEN; NOT_FOUND), household view
  with owner-scoped per-format `searchable`, and the books-only member's `integrations.search` FORBIDDEN.
  e2e: both walls click-through to the detail page + per-format LL/Kapowarr round trip with the fired chip +
  the parked-comic no-search state. Screenshot side-by-side (`capture-wanted-detail-parity.ts`): a Movies/TV
  WANTED detail beside the new book-wanted detail (dark, desktop + 390) + the force-search feedback states.

## Amendment 3 — 2026-07-16 (PLAN-056: honest sort participation + the three-state Wanted filter)

Owner live report (2026-07-16): "Wanted is always at the top for Books and Audiobooks in Library …
I'd also like to work in 'Hide Wanted' somehow to the selector." **Triage finding:** the pinning was
DELIBERATE composition order, not a null-sort-key artifact — amendment-1 ruled "Wanted items merge
INLINE at the head of the flat book wall's item stream", and the client implemented that literally
(concatenate `books.wanted` ahead of the `books.search` page); the overlay never participated in the
active sort at all. This amendment supersedes amendment-1's _head-of-the-stream placement_ and its
_two-state `?wanted=1` toggle_ (the card anatomy, gating, data model, and detail-page flow all
stand). PLAN-056.

- **Server-composed stream.** `books.search` gains a three-state `wanted` input
  (`all | only | hide`, default `all`) and, under `all`, composes the wanted overlay INTO the paged
  item stream server-side: one SQL UNION of the item query and the (bounded) wanted list bound as a
  `VALUES` row-set, each side carrying the same per-sort key columns, ordered and offset-paged by
  Postgres. A wanted card lands exactly where the active sort says — never pinned. The client's
  flat grid renders the discriminated entries (`kind: 'item' | 'wanted'`) as the same poster blocks
  as before; the always-on `books.wanted` read remains only as the selector's populated-value gate
  and the wall-stage poll's enable signal.
- **The wanted sort-key mapping** (`wantedPrimarySortValue` — a want answers what it honestly can):
  _Title_ → the request's title snapshot, normalized like an item's `sort_title` (trim+lowercase);
  _Author_ → the author snapshot (null ⇒ NULLS LAST, like any author-less item); _Added_ → the
  request's `created_at` (when the app minted the want — the honest peer of an item's
  `COALESCE(source_added_at, first_seen_at)`; newly exposed on `WantedBookRequestView`);
  _Year / Released / Length / Pages_ → null (no edition metadata — the want sorts with the
  null-valued items, NULLS LAST in either direction); _List order_ → never composed (a want is not
  a collection member). Tiebreaks mirror the item ORDER BY (`sort_title` asc, id asc); the `added`
  sort gains the `sort_title` tiebreak on BOTH paths (same-instant batches are real — one sync
  transaction stamps many rows).
- **The three-state selector.** The `btn sm` "Wanted only" toggle becomes an
  **All · Wanted only · Hide wanted** `.seg` segmented group in the chip bar (the wall's existing
  idiom — zero new components; fixed per-segment labels, recolor-not-reflow per ADR-015).
  URL: `?wanted=only|hide`, absent = All (the default — current behavior minus the pinning,
  Q-01 lean confirmed); a replace-in-place refinement (D-19); legacy `?wanted=1` links read as
  Wanted-only. Value-gated on the overlay itself (no dead control), absent inside a drill, and it
  applies to all three walls (`WANTED_FACET` is unchanged in the registry — `kind:'select'`,
  `param:'wanted'`, dataGated).
- **Server-authoritative states.** `hide` excludes the wanted rows in `books.search` itself (never
  a client/CSS hide); `only` returns the query-narrowed wants alone, sorted by the active sort
  (facet chips still cannot narrow synthetic rows — unchanged semantics, now server-held); the
  D-09 honesty rule rides the server too: any refinement beyond the text query (facets, A–Z letter,
  read-state, a collection drill) excludes wants from the `all` stream.
- **Test strategy (added).** API (embedded PG, `books-wanted-sort.test.ts`): a wanted 'Aardvark'
  sorts FIRST under Title A–Z and NOT first under Pages (NULLS LAST) — the pinning asserted GONE;
  author-snapshot + created_at participation; the composed offset cursor pages the union without
  duplicating a want; the three states (hide excludes / only exclusive / all both); the honesty
  rule (query narrows wants, facets and letter exclude them). e2e: the three-state selector
  round-trip (`?wanted=only|hide` → URL → wall) + the sorted-composition assertions on the books
  wall.

## Amendment 4 — 2026-07-18 (the three-state Wanted axis becomes the shared cross-wall idiom)

Amendment 3 shipped the `All · Wanted only · Hide wanted` `.seg` segment on the BOOKS walls. The
\*arr walls (Movies / TV / Music) still carried the OLD standalone boolean "Wanted only" toggle, so
the same concept wore two different anatomies. Per the owner-blessed unification ruling (2026-07-18),
the \*arr walls now adopt **this exact three-state segment** — see **DESIGN-026 § Amendment —
2026-07-18** for the full design (the shared `LIBRARY_FILTER_SHAPE.wanted` enum, the honest per-engine
implementation — books compose an overlay row, the \*arr walls negate a `media_items` predicate — the
"On disk: …" / "Wanted: …" axis labels, and the owner's `Missing` + `Hide wanted` composed-gap insight).

The only change on the books side: the wanted segment gains a leading **"Wanted"** axis label
(`.library-axis__label`) to match the \*arr walls' now-labeled rails — the segment values, `?wanted=`
contract, gating, and server composition of amendment 3 are otherwise unchanged.
