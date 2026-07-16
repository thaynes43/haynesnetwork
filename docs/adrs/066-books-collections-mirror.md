# ADR-066: Books collections mirror (Kavita + Audiobookshelf ride the ADR-064 model)

- **Status:** Accepted <!-- owner-ratified roadmap 2026-07-16 ("collections for books is a big one"); docs-first in the PLAN-051 build branch (owner-granted authority) -->
- **Date:** 2026-07-16
- **Deciders:** Tom Haynes (mirrored-only doctrine R1, PLAN-037 scoping; PLAN-051 roadmap ratification) · ratified by Fable 5 (PLAN-051 docs+build)
- **Relates:** APPLIES [ADR-064](064-mirrored-plex-collections-read-model.md)'s mirror-only doctrine
  (owner R1: *"external software is always the source of truth for collections — even when we do
  books, we build a tool first, then sync"*) to the BOOK sources of truth; builds on
  [ADR-046](046-books-library-ledger-source.md) (the `books_items` mirror + the `books` section gate),
  [ADR-051](051-library-views-and-sort-filter-registries.md) (C-01 — "a registry-row edit, never a
  new component"), [ADR-052](052-per-user-library-preferences.md) (view persistence). Realized by
  **DESIGN-038**. Implements PRD **R-215..R-217**; glossary **T-187..T-190**.

## Context and problem statement

PLAN-037 shipped the mirrored Plex collections vertical for Movies/TV (ADR-064): two rebuildable
derived tables, a standalone scoped-reconcile sync mode, a gated group read model, and an opt-in
"Collections" grouped view through the PLAN-029 registry seam. The book walls
(Books / Audiobooks / Comics) have no equivalent: a hand-curated "Harry Potter Collection" in
Kavita, a Kavita reading list carrying an explicit reading ORDER, or an ordered Audiobookshelf
collection is invisible in the app. The owner's ruling from PLAN-037 scoping already decided the
shape for books ("even when we do books, we build a tool first, then sync") — this ADR instantiates
it. The future PLAN-043 books app will WRITE collections into Kavita/ABS; this mirror displays them
with zero site changes.

The sources expose three concepts (wire shapes verified against the DEPLOYED versions — Kavita
0.9.0.2 + ABS 2.35.1 tagged sources, plus live route probes 2026-07-16; see DESIGN-038 D-02):

1. **Kavita Collections** (`GET /api/Collection`) — UNORDERED series groupings (no member-order API).
2. **Kavita Reading Lists** (`POST /api/ReadingList/lists` + `GET /api/ReadingList/items`) —
   explicitly ORDERED (each item carries `order`; there is an update-position API). Items are
   CHAPTER-grain; the series is the item's `seriesId`.
3. **ABS Collections** (`GET /api/collections`) — ORDERED (the `books` array is returned
   `collectionBook.order ASC`, verified in the 2.35.1 model source).

## Decision drivers

- **Owner doctrine R1 (ADR-064, permanent):** the app mirrors collections; it never authors them.
  Kavita/ABS are the sources of truth; the only curation surface is those apps (and later the
  PLAN-043 external tool writing INTO them).
- **PLAN-051 Q-01 (resolved by research input, 2026-07-16):** mirror BOTH Kavita concepts —
  collections AND reading lists — rendering reading lists as ORDERED collections. Reading order is
  the series payoff (the flagship book-collections case).
- **PLAN-051 Q-02 (lean, v1):** a cross-source series (ebook in Kavita + audio in ABS) shows as TWO
  honest source-scoped collections; merging via the PLAN-050 pairing data is a later knob.
- The PLAN-037 vertical is the settled donor end to end: rebuildable derived cache, raw membership,
  standalone mode with the fully-read scoping discipline, guard-listed single-writer, registry rows,
  group cards + `?group=` drill-in.
- Books gating is SECTION-level (ADR-046: the `books` section, server-authoritative), not per-library
  ACL — there is no ADR-047-style library gate to thread; the walls' own gate is THE gate.

## Considered options

1. **Mirror-only: new `books_collections` + `books_collection_members` tables synced from
   Kavita/ABS, read through the books walls' existing view engine** (chosen). A
   `books-collections-sync` standalone mode reads both servers' collections/reading lists and a
   domain single-writer upserts the snapshot; reads join resolved members → `books_items` under the
   `books` section gate.
2. **App-native book collections with authoring UI.** Rejected permanently by owner R1 (ADR-064
   option 2) — curation lives in external software; PLAN-043 writes into Kavita/ABS, not into app
   tables.
3. **Reuse `books_items.series_name` as the collections surface.** Rejected: a per-item metadata
   facet (ABS-only, no Kavita coverage), not an entity — no identity, no membership order, no counts,
   no hand-curated sets. It stays exactly as it is (the Audiobooks Series facet).
4. **Live Kavita/ABS reads at render time.** Rejected: the group listing needs per-collection counts
   over the wall's own `books_items` rows (the wall-mapping rule needs the resolved members' media
   kinds in SQL), and the drill-in must compose with `books.search`'s predicates — a live fan-out
   cannot. The mirror is the established shape (ADR-064 option 4's reasoning applies verbatim).

## Decision outcome

Chosen option: **1 — mirror-only**, the ADR-064 model books-flavored:

- **Two new tables** (DESIGN-038 D-01, migration 0056): `books_collections` (one row per
  `(source, external_id, kind)` — `source` `kavita|audiobookshelf`, `kind`
  `collection|reading_list`; `ordered` records whether the source carries an explicit member order)
  and `books_collection_members` (RAW member refs — the source item id — with `position` and an
  opportunistically resolved nullable `books_item_id`). Membership is stored raw (the PLAN-037
  idiom): a member whose series/item is not (yet) in the `books_items` mirror still mirrors; the
  resolution refreshes every sync.
- **A `books-collections-sync` standalone mode** (D-03/D-04): fetcher reads both servers read-only
  (no `./write` surface exists in `@hnet/books` — unchanged); the domain single-writer
  `syncBooksCollections` upserts and reconcile-deletes with the PLAN-037 scoping discipline — member
  reconcile only for fully-read collections, collection reconcile only for fully-read
  `(source, kind)` families; a partial read never tombstones. Runs after `books-sync` (it resolves
  members against the fresh mirror). No `sync_runs` row; its trail IS the mirror tables.
- **Read model + drill-in** (D-05/D-06): `books.collectionGroups` returns gated group cards (label,
  member count, up to 4 member cover URLs via the existing `/api/books/cover` proxy, the `ordered`
  flag); `?group=<id>` drills into the SAME wall grid via one `books.search` EXISTS predicate.
  **Ordered collections' drilled walls sort by member position by default** — the reading-order
  payoff (the D-06 sort contract).
- **Registry rows** (D-07): the Books/Audiobooks/Comics walls gain a `collection` grouping dimension
  as a SIBLING in the view selector (author/genre/series untouched; `WALL_VIEW_DEFAULTS` unchanged)
  plus grouped-collection and collection-drill `ViewLevelKey`s.
- **Wall mapping** (D-05): a collection surfaces on exactly ONE wall — the media kind holding the
  majority of its resolved live members (ties break in `BOOKS_MEDIA_KINDS` order: book → comic →
  audiobook); the card count and the drilled wall show only that kind's members.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the owner doctrine stays structural — NO app-side book-collection write surface exists (`@hnet/books` remains read-only, no `./write` export), so the mirror can never drift from Kavita/ABS by app action. The PLAN-043 books app later writes INTO Kavita/ABS and this mirror displays the result with zero site changes. |
| C-02 | Good: both tables are a **rebuildable derived cache** (the `plex_collections` / `media_plex_matches` exemption class): Kavita/ABS are the sources of truth, a re-run rebuilds them from scratch, so the single-writer appends **no audit/ledger rows** (the documented no-audit exemption). Both tables are guard-listed in all six regex families of the no-direct-state-writes guard. |
| C-03 | Good: reading lists mirror as ORDERED collections (`kind='reading_list'`, `ordered=true`) with explicit positions, and ABS collections carry their verified `collectionBook.order` — so the drilled wall's default position sort is honest reading order, not response luck. Kavita collections stay honestly `ordered=false` (the API exposes no member order): their drill defaults to the wall's normal sort and offers no position sort. |
| C-04 | Neutral/accepted (Q-02 lean): a series living in BOTH Kavita and ABS shows as two source-scoped collections (one per wall). Merging via PLAN-050 pairing data is deferred until the owner sees the mirror live. |
| C-05 | Accepted: Kavita reading-list items are CHAPTER-grain; the mirror stores SERIES-grain members (the `books_items` grain), deduping repeated series to their EARLIEST position. A list interleaving chapters of two series ("read A ch.1, B ch.1, A ch.2…") flattens to series order by first appearance — documented, honest, and the only shape the series-grain walls can render. |
| C-06 | Cost/accepted: mirrored membership includes refs with no `books_items` row (a series in a Kavita library type the app doesn't surface, e.g. Manga; an ABS podcast item). They are stored raw (the mirror stays faithful) but invisible in reads — the walls are `books_items` walls. |
| C-07 | Neutral: gating is the `books` SECTION level (ADR-046), server-authoritative on every new read — the same gate as the walls the cards ride. There is no per-library book ACL, so no ADR-047-style count-leak analysis applies; a caller who can see the wall can see every collection whose majority lives there. |
| C-08 | Neutral: the wall-mapping majority rule means a mixed Kavita reading list (books + comics) appears ONLY where its majority lives; its minority members are reachable through the source app, not the minority wall. Simple and honest over clever and duplicated (a both-walls surface would double-count the estate). |

## More information

- Realized by **DESIGN-038** (schema D-01, client reads D-02, sync D-03/D-04, read model + wall
  mapping D-05, drill-in + sort contract D-06, registry seam D-07, URL contract D-08, ordering
  honesty D-09, gating D-10).
- Wire shapes verified 2026-07-16 against the deployed versions' tagged sources (Kavita v0.9.0.2,
  ABS v2.35.1) + live route probes; recorded in DESIGN-038 D-02.
- Owner rulings inherited from `.agents/plans/037-collections.md` (R1) and
  `.agents/plans/051-books-collections-mirror.md` (Q-01/Q-02 leans).
- Numbering: migration **0056**; glossary **T-187..T-190**; PRD **R-215..R-217**.
