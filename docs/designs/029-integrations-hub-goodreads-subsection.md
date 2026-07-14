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
  + the `integrations` section — mirroring what `integrations.search` enforces). `integrations.search`
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

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Wanted-tile visibility while the integrations rollout is admin-only? | RULED: books-section gating (household), tiles clearly badged; flip is one gate if re-ruled. |
| Q-02 | Live per-grab feedback for a fired book search (the ledger's `searchProgress` analog)? | Deferred — LL/Kapowarr expose no per-grab progress feed; the fired-chip + next-reconcile is the honest v1. |
| Q-03 | External-art proxy for unmatched wanted tiles (Goodreads CDN covers)? | Deferred polish (DESIGN-028's original call stands — designed tiles, never hotlinked art). |
