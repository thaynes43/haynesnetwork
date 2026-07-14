# ADR-057: Integrations hub + all-shelves acquisition + the composed Library-Wanted (books) model

- **Status:** Accepted
- **Date:** 2026-07-14
- **Deciders:** Tom Haynes (owner spec + rulings 2026-07-14 ~00:55/~01:15 — PLAN-045)
- **Builds on:** ADR-055 (integration linking + app-side shelf sync + confined LL requests) and ADR-056
  (Kapowarr comic routing) — both Accepted and immutable; this ADR is a follow-on, not an edit. ADR-046
  (books_items pure mirror), ADR-047 (server-side access posture), ADR-051 (library view registry seam),
  ADR-021 (section permissions), ADR-015 (reflow-free) all STAND.

## Context and problem statement

The v0.49.0 Integrations tab shipped as ONE flat page (link card + coverage stat + a text-tile
Requests & Missing wall). At the live acceptance the owner ruled it "sloppy — doesn't follow our common
theme across Library, Trash, Bulletin Tickets" and spec'd the redesign: Integrations becomes a HUB of
provider cards with **Goodreads as a sub-section** (a stats page + an items page that looks like the
Library), shelf filters behave like the **Helpdesk ticket state chips**, and shelf books we don't hold
appear as **Wanted in the Library like Movies and TV**. Two structural questions follow: (a) which
shelves sync AND acquire, and (b) how Wanted books surface on the Books/Audiobooks/Comics walls without
polluting the pure `books_items` mirror.

## Decision drivers

- **Owner ruling — A1 OVERRULED: ALL synced shelves acquire.** read / currently-reading /
  did-not-finish items we don't hold also mint requests and push LL wants (both formats) — the same
  no-gate Missing flow (SAB rips; the MAM governor gates). Comics from any shelf route via Kapowarr
  (ADR-056). Expect a real first wave (~21 read-shelf books); the existing LL/GB pacing + backoff paths
  are reused VERBATIM.
- **Owner ruling Q-01 — books-section gating** for Library-Wanted tiles (household visibility wherever
  the Books walls are granted; clearly badged).
- **Owner ruling Q-02 — the want-shelf headline** stays the coverage headline; per-shelf breakdown
  under it.
- **Owner ruling Q-03 — full Wanted parity**: the books/audiobooks/comics Wanted experience gets ALL
  the functionality TV/Movies Wanted have, including the force-search button (the dispatching
  `integrations.search` — ADR-056 C-04).
- **Mirror purity (ADR-046)** — `books_items` never carries request state.
- **The estate's idioms, not new ones** — hub cards (Trash-Overview), `?tab=` sub-navigation with D-19
  push semantics (Metrics/Trash), Helpdesk chip semantics (DESIGN-012 D-12), corner-puck poster badges
  (twall/bwall), the ADR-051 registry seam for the new wall filter.

## Considered options

1. **Widen the sync but keep acquisition want-shelf-only** (the original PLAN-045 A1). REJECTED by the
   owner — every synced shelf acquires.
2. **Store Wanted rows in `books_items`** (a "virtual" mirror row per unmet request). Rejected —
   violates ADR-046; tombstone/sync semantics would fork.
3. **Compose Wanted as a UNION/overlay of the `book_requests` read-model (CHOSEN, A2)** — the walls
   render a clearly-badged Wanted overlay from a books-section-gated read over the request ledger,
   exactly how the *arr ledger surfaces monitored-but-missing without faking on-disk rows.

## Decision (C-01 … C-07)

- **C-01 — all four shelves sync AND acquire.** `GOODREADS_SHELVES = to-read · currently-reading ·
  read · did-not-finish` becomes the `user_integrations.shelves` default; migration **0047** backfills
  v1 want-shelf-only rows. Request minting was already shelf-agnostic (one `book_requests` row per live
  shelf item), so widening the shelves list IS the acquisition change; the push/reconcile/pacing paths
  are untouched. A request's **source shelf** rides the existing `integration_shelf_items.shelf` via
  the `shelf_item_id` join — **no new column**.
- **C-02 — absent-shelf tolerance (A3).** The first three shelves are Goodreads BUILT-INS (exist on
  every account); `did-not-finish` is a conventional CUSTOM slug. A 404 on a custom shelf reads as an
  EMPTY shelf (zero items, still synced — tombstoning stays scoped); a 404/failure on a built-in shelf
  is an integration ERROR (private/unreachable) and never tombstones. (`isAbsentCustomShelfError` in
  `@hnet/goodreads`; applied by the sync mode and the fresh-link fast path.)
- **C-03 — the Integrations HUB + provider sub-sections.** `/integrations` renders provider CARDS (the
  Trash-Overview whole-card-button idiom); a card PUSHES into `/integrations/goodreads` (D-19 —
  sub-navigation pushes; Back returns to the hub). The sub-section is `?tab=` navigation over one route
  (the Metrics/Trash precedent): **Overview** (the stats page — link card, want-shelf headline coverage,
  per-shelf breakdown, request-phase summary tiles) and **Items** (a REAL library wall). The v0.49.0
  flat page's Requests & Missing wall FOLDS INTO the sub-section, restyled to the poster idiom.
- **C-04 — shelf chips = the Helpdesk state-chip semantics** (DESIGN-012 D-12 ported verbatim):
  multi-select additive OR; "All" is a SUPERSET select that lights when every chip is on; counts on
  every chip; repeated `?shelf=` params via `router.replace`; canonical default (all populated shelves)
  writes NO param; the deliberate-empty selection writes the `shelf=none` sentinel; chips are
  populated-value-gated (ADR-051 C-06 — an absent DNF shelf grows no chip).
- **C-05 — the composed Library-Wanted model.** A new **books-section-gated** read (`books.wanted`,
  household visibility per Q-01) composes Wanted tiles per wall from the `book_requests` ledger:
  format decides the wall (`ebook` ⇒ Books, `audiobook` ⇒ Audiobooks, `comic` ⇒ Comics); a request is
  Wanted on a wall while that format hasn't landed and the want isn't matched into the library; deduped
  per distinct book across users/shelves (requesters aggregated). The walls render the overlay as a
  clearly-badged **Wanted strip** above the library grid plus a registry-declared **Wanted filter**
  (`?wanted=1`, the Movies/TV narrowing as an ADR-051 registry row, value-gated). `books_items` is
  UNTOUCHED. Per-viewer affordances are computed server-side: `canSearch`/`canOpenRequest` require
  OWNERSHIP of the request's integration AND the `integrations` section — exactly what
  `integrations.search` enforces (ADR-056 C-04 unchanged).
- **C-06 — force-search parity.** Wanted tiles (Library) and items-wall tiles (sub-section) render the
  shared force-search control calling the dispatching `integrations.search` (comic → Kapowarr
  `auto_search`; book/audiobook → LL `searchBook`; audited `request_book_search`), with PLAN-015-style
  live feedback in a RESERVED slot (button ⇄ fired-chip swap — ADR-015, no reflow). Non-destructive ⇒
  a plain button, never ConfirmButton.
- **C-07 — per-item state = the corner-puck idiom.** Every shelf/Wanted tile wears an absolute corner
  puck over the reserved 2:3 poster box (the twall/bwall grammar) carrying the request PHASE
  (`have · searching · missing · parked` — the `requestPhase` collapse of the per-format statuses);
  state changes recolor, never reflow.

## Consequences

- **Positive:** one design language across Library/Trash/Helpdesk/Integrations; every shelf want is an
  acquisition (the owner's actual intent); Wanted books/audiobooks/comics reach the household exactly
  like Wanted Movies/TV incl. force-search; the mirror stays pure; the hub scales to the saga's next
  providers as sibling cards.
- **Negative / residual:** Wanted tiles are synthetic (no `books_items` row) — they render designed
  fallback tiles (never fake covers) and cannot honestly answer the walls' format/length/read facets,
  so the strip hides under those refinements (the "never offer what it can't answer" rule); a book on
  several shelves acquires once per shelf item at the LL layer (addBook/queueBook are idempotent — the
  reads dedupe per distinct book); coverage headline stays want-shelf-only (Q-02) while phases count
  every request. The first live all-shelves sync mints a real wave — the machinery paces, MAM stays
  governed.

## More information

- PRD-001 R-188..R-191; DDD glossary T-167..T-169; DESIGN-029 (realization), DESIGN-028 (amended
  pointer).
- PLAN-045 (`.agents/plans/045-integrations-hub-library-idiom.md`), PLAN-043 saga master.
- Precedents: DESIGN-012 D-12 (Helpdesk chips), DESIGN-004 D-19 (push/replace), Trash-Overview cards,
  ADR-051 C-01/C-06 (registry rows + value gates), PLAN-015/ADR-028 (action feedback).
