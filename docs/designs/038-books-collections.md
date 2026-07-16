# DESIGN-038: Books collections mirror — the Books/Audiobooks/Comics Collections group view

- **Status:** Accepted
- **Last updated:** 2026-07-16
- **Satisfies:** PRD-001 **R-215..R-217**; governed by **ADR-066** (books collections mirror — the
  ADR-064 mirror-only doctrine applied to Kavita/ABS) on top of **ADR-046** (`books_items` mirror +
  the `books` section gate), **ADR-051/052** (view engine + per-user preferences), **DESIGN-035**
  (the PLAN-037 donor vertical), **DESIGN-026** (D-01 view model, D-04 group cards, D-10 URL
  contract, D-19 PUSH/REPLACE). Glossary **T-187..T-190**.

## Overview

Collections curated in the book sources of truth — Kavita collections, Kavita reading lists
(rendered as ORDERED collections — PLAN-051 Q-01), and Audiobookshelf collections (ordered) — mirror
into two rebuildable tables (`books_collections` + `books_collection_members`, migration 0056),
synced by a new standalone `books-collections-sync` mode, and surface as an opt-in **"Collections"
grouped view** on the Books, Audiobooks, and Comics walls through the shipped view engine:
registry-row edits, one new tRPC group read, one new `books.search` predicate + sort, zero new
components (GroupCard reused). Every read rides the walls' own server-authoritative `books` section
gate. The series payoff: an ordered collection's drill-in wall sorts by member position by default —
reading order on the wall.

## Detailed design

### D-01 — The two mirror tables (migration 0056)

- **`books_collections`** — one row per collection per source per kind:
  `id uuid pk`, `source text` CHECK `kavita|audiobookshelf` (`BOOKS_SOURCES`), `external_id text`
  (Kavita collection id / reading-list id as text; ABS collection uuid), `kind text` CHECK
  `collection|reading_list` (`BOOKS_COLLECTION_KINDS` — a Kavita reading list is a distinct id space
  from Kavita collections, so `kind` is part of the identity), `library_id text NULL` (the library
  scope exactly as the source exposes it: ABS collections carry `libraryId`; Kavita collections and
  reading lists are server-wide → null), `title text`, `item_count int` (the RAW source member count
  — diagnostics only, never the shown count; the wall count is the resolved live-member count of the
  wall's kind), `ordered boolean` (whether the SOURCE carries an explicit member order — D-09),
  `first_seen_at` / `last_seen_at` / `created_at` / `updated_at`.
  Identity: **UNIQUE `(source, external_id, kind)`**.
- **`books_collection_members`** — one row per member per collection:
  `id uuid pk`, `collection_id` FK → `books_collections` ON DELETE CASCADE, `external_ref text`
  (the RAW source member id — Kavita seriesId as text / ABS library-item uuid; the join key into
  `books_items (source, external_id)`), `books_item_id uuid NULL` FK → `books_items` ON DELETE SET
  NULL (the OPPORTUNISTIC resolution — refreshed every sync; null = the ref has no mirror row, e.g.
  a Manga-library series the app doesn't surface), `position int` (D-09 semantics), the same four
  timestamps. Identity: **UNIQUE `(collection_id, external_ref)`**; index on `books_item_id` (the
  drill-in predicate + group counts join through it).
- Membership is stored **RAW** (the PLAN-037 idiom): an unresolvable ref still gets a member row —
  the mirror stays faithful; resolution is a sync-time refresh, invisibility on the walls is a
  read-time consequence (ADR-066 C-06). Both tables are the rebuildable-derived-cache class
  (ADR-066 C-02): single-writer, guard-listed in all six regex families, no audit rows. The
  migration also grows `SYNC_RUN_KINDS` + rebuilds the `sync_runs.run_kind` CHECK
  (`books-collections-sync` — parity only; the mode writes no `sync_runs` row; the rebuilt CHECK is
  the union of all NINETEEN current kinds).

### D-02 — The `@hnet/books` READ extensions (verified wire shapes)

All shapes verified 2026-07-16 against the DEPLOYED versions' tagged sources (Kavita **v0.9.0.2**,
ABS **v2.35.1**) plus live route probes against the in-cluster ingresses (401-vs-404 existence
checks). Zod strip-mode subsets at the boundary, the existing client idioms untouched (lazy login,
token cache, one 401 re-auth). Read-only — there is still NO `./write` export (ADR-066 C-01).

- **Kavita `listCollections()`** — `GET /api/Collection` → `AppUserCollectionDto[]`; we consume
  `{ id, title, itemCount, promoted }` (subset).
- **Kavita collection membership** — `POST /api/Series/all-v2` with FilterV2 statement
  `{ comparison: 0 (Equal), field: 7 (CollectionTags), value: String(collectionId) }` — the exact
  idiom the shipped library filter uses (field 19 = Libraries in the same verified
  `SeriesFilterField` enum; `HasCollectionTags` treats Equal and Contains identically). Paged with
  the existing `PageNumber/PageSize` + `Pagination` response-header loop
  (`listCollectionSeriesPage`).
- **Kavita `listReadingListsPage()`** — `POST /api/ReadingList/lists?PageNumber=&PageSize=&includePromoted=true`
  (verified: the route is POST-with-query-params; GET 404s) → `ReadingListDto[]`; we consume
  `{ id, title, itemCount, promoted }`. Total from the same `Pagination` header idiom.
- **Kavita `listReadingListItems(readingListId)`** — `GET /api/ReadingList/items?readingListId=` →
  `ReadingListItemDto[]`; we consume `{ id, order, seriesId }` (subset). CHAPTER-grain — see D-09.
- **ABS `listCollections()`** — `GET /api/collections` → `{ collections: [...] }`, each
  `{ id, libraryId, name, books: [...] }` where `books` is the expanded library-item array returned
  **`collectionBook.order ASC`** (verified in the 2.35.1 `Collection.getOldCollectionsJsonExpanded`
  source — the array order IS the curated order). We consume each book's `id` only.

### D-03 — The `books-collections-sync` fetcher (`@hnet/sync` `fetchBooksCollectionsSnapshot`)

Reads both servers through the SAME `BooksSyncBundle` the `books-sync` mode uses (no new env). Per
source, per kind — a **family** `(source, kind)`, the reconcile scope grain:

- **Kavita collections** (`kavita`/`collection`): `listCollections()`, then each collection's
  members via the paged all-v2 CollectionTags filter. Members carry
  `{ externalRef: String(series.id), position: <response index> }`; `fullyRead` = every page
  returned without error and the page walk completed under the MAX_PAGES cap. `ordered: false`
  (D-09).
- **Kavita reading lists** (`kavita`/`reading_list`): paged `listReadingListsPage()`, then each
  list's items via `listReadingListItems`. Items DEDUPE to series grain (D-09): keep each
  `seriesId`'s EARLIEST `order`, sort by it, and re-densify positions 0..n. `ordered: true`.
- **ABS collections** (`audiobookshelf`/`collection`): one `listCollections()` read — members are
  the `books` array in order (`position` = index), `fullyRead: true`, `ordered: true`,
  `libraryId` recorded.
- **Scoping discipline (the PLAN-037 rule at family grain):** a family whose LISTING failed or was
  truncated is NOT scoped — the writer can never reconcile-delete collections the run couldn't see.
  A collection whose MEMBER read failed/truncated keeps its row (title/count advance) but is not
  `fullyRead` — its members are never reconciled from this run. Stats mirror the plex-collections
  fetcher (`collectionsFetched`, `membersFetched`, `truncatedCollections`, per-family read flags).

### D-04 — The domain single-writer (`@hnet/domain` `syncBooksCollections`)

One transaction, the `syncPlexCollections` shape:

- **Resolve** every member's `external_ref` → `books_items.id` via one chunked
  `(source, external_id)` lookup over LIVE rows (tombstoned rows resolve to null — a vanished item
  drops off the card count immediately, its raw ref remains). Runs every sync — the resolution is
  as rebuildable as the rows it sits on. This is why the mode runs AFTER `books-sync`.
- **Upsert** collections `onConflictDoUpdate` on `(source, external_id, kind)`
  (title/item_count/ordered/library_id/last_seen_at advance; first_seen_at/created_at keep), then
  members on `(collection_id, external_ref)` (position/books_item_id/last_seen_at advance).
- **Reconcile-DELETE:**
  - **members** where `last_seen_at < runStart`, scoped ONLY to collections whose member read was
    COMPLETE this run (`fullyRead`);
  - **collections** where `last_seen_at < runStart`, scoped ONLY to the fully-read
    `(source, kind)` families (`scopedFamilies`) — a server outage or a mid-listing error never
    tombstones what the run couldn't see; the CASCADE removes their members.
- No audit rows (derived cache — ADR-066 C-02). Report: collections/members upserted + removed +
  `membersResolved` (refs that found a live `books_items` row).

### D-05 — The Collections group read model (`books.collectionGroups`) + the wall-mapping rule

The `books.groups` idiom: one bounded query, in-process aggregation, `booksProcedure`-gated (the
SAME server-authoritative `books` section gate as the wall — ADR-066 C-07). Input
`{ mediaKind }`; wire shape per card: `{ key, label, count, coverUrls, imageUrl: null, ordered }`
(the GroupCard contract + the `ordered` flag the drill consumes, D-06).

- **Query** — `books_collections` JOIN `books_collection_members` (resolved: `books_item_id NOT
  NULL`) JOIN `books_items` (live: `deleted_at IS NULL`), ordered by `(title, id, position)`.
- **The wall-mapping rule (R-217):** a collection surfaces on exactly ONE wall — the media kind
  holding the **majority of its resolved live members**; ties break in `BOOKS_MEDIA_KINDS` order
  (`book` → `comic` → `audiobook`). In practice: ABS collections are all-audiobook (Audiobooks
  wall); a pure comic Kavita list lands on Comics; a MIXED Kavita reading list (books + comics)
  lands where most of it lives. The card's `count` and cover fan are the WALL's kind only —
  exactly what the drilled wall will show (never a count the drill can't honor).
- **Aggregation** — count = resolved live members of the wall's kind; covers = the first **4** such
  members' cover URLs in position order via the existing `booksCoverUrlFor` proxy path (a member
  with no cover contributes none; `imageUrl` stays null — the cover fan is the art). A collection
  with ZERO resolved live members of any kind is absent everywhere (nothing to show); cards come
  back label-A–Z and the client re-sorts by the grouped level's registry keys (label | count).
- No `ctype` analog: the PLAN-053 Collection Type classifier is movie-estate-specific; the books
  grouped levels declare NO facets (honest — revisit if the owner wants buckets here).

### D-06 — Drill-in: `?group=<id>` is a `books.search` predicate + the ordered sort contract

The drilled wall is the SAME item grid the tab already renders. `booksSearchInputSchema` gains an
optional **`collection`** field (the `books_collections.id` uuid — stable key-not-name identity),
adding ONE predicate:

```sql
EXISTS (SELECT 1 FROM books_collection_members bcm
         WHERE bcm.collection_id = ${collection}
           AND bcm.books_item_id = books_items.id)
```

Because it is just an AND predicate inside `books.search`, the drilled wall inherits the wall's
facets, search, pager, and the section gate unchanged.

**The sort contract (the series payoff — R-216):**

- `BOOKS_SORTS` gains **`position`** (the member's `position` via a correlated subquery against the
  drilled collection; asc-first, NULLS LAST, the usual sort_title/id tiebreakers). The schema
  REFUSES `sort: 'position'` without a `collection` (a zod refinement) — position is meaningless
  outside a drill.
- An **ordered** collection's drill (`ordered: true` from the group listing) offers "List order"
  as its FIRST sort and DEFAULTS to it (position asc) — a reading list drills into reading order.
- An **unordered** collection's drill (Kavita collections — D-09) does NOT offer the position sort
  (the client drops it from the level's declared sorts — the `ordered` flag is the data-honesty
  gate, the same class of rule as `dataGated` facets) and defaults to the wall level's default
  sort. Never "Plex-order roulette" (the DESIGN-035 D-07 lesson, applied rather than deferred —
  here the sources DO tell us which orders are real).
- The drilled sort is **transient**: never persisted (the books drill rule), and the wall's STORED
  sort preference does not override the drill default (a fresh ordered drill always lands on
  reading order; an explicit `?sort=` in the URL still wins — shared links stay exact).

### D-07 — Registry seam edits (ADR-051 C-01: rows, not components)

- **`WALL_VIEWS`** — `books`, `audiobooks`, and `comics` each gain a `collection` grouping as a
  SIBLING dimension (existing author/genre/series groupings untouched; `WALL_VIEW_DEFAULTS` /
  `LIBRARY_WALL_DEFAULTS` unchanged): `{ dimension: 'collection', selectorLabel: 'Collections',
  allLabel: 'All collections', art: 'covers', level: '<wall>:grouped-collection' }`.
- **Six new `ViewLevelKey`s:**
  - `books:grouped-collection` / `audiobooks:grouped-collection` / `comics:grouped-collection` —
    grouped CARD levels sorting by `label` ("Collection A–Z", asc-first) | `count` ("Most items",
    desc-first), default label-asc, **no facets**, no A–Z rail (the PLAN-037/053 idiom minus the
    movie-specific Type facet — D-05).
  - `books:collection-items` / `audiobooks:collection-items` / `comics:collection-items` — the
    DRILLED item-grid levels: `position` ("List order", asc-first) + the wall level's own sorts;
    default position-asc (the ordered case — D-06 governs the unordered narrowing); the wall
    level's facets MINUS `wanted` (a want is not a collection member — the composed-Wanted overlay
    stays a top-level-wall concern); the wall's `azSorts`.
- **Selector visibility rule (one shared-component amendment, not a new component):** the books
  walls' view selector renders when the wall offers multiple SHAPES **or multiple grouping
  dimensions** — Comics (single-shape `grouped`, now two dimensions) gains the selector
  (Series | Collections) without gaining a flat shape; the flat segment renders only for walls that
  offer `flat`. A grouping WITHOUT a bound `level` renders the wall's item grid (Comics' Series —
  the wall IS that grouping); a grouping WITH a `level` renders aggregate cards.

### D-08 — URL contract (rides DESIGN-026 D-10/D-19 verbatim)

- `?view=grouped&by=collection` — the Collections view (a screen-level **PUSH**; `by=` is carried
  because `collection` is never a wall's default dimension). Canonicalization, preference
  persistence (`library.preferences.set` from the selection handler only), and the tab-switch reset
  are inherited unchanged.
- `?group=<books_collections.id>` (+ `by=collection`) — the drilled collection (a **PUSH**; the
  item grid). The drill header shows the collection title (resolved from the group listing — the
  key is a uuid, never displayed) + the "All collections" back link. Sorts/filters inside the drill
  stay **replace** refinements; the drilled sort is transient (D-06).
- A mangled `?group=` (not a uuid / not on this wall) renders the empty drill state — never an
  error page.

### D-09 — Ordering semantics: three sources, three honest answers

`position` records:

- **Kavita reading list** (`ordered: true`) — the EXPLICIT `order` field, deduped to series grain:
  reading-list items are chapters, the walls are series, so repeated series keep their EARLIEST
  order and positions re-densify 0..n (ADR-066 C-05). This is the real curated reading order at the
  only grain the walls can render.
- **ABS collection** (`ordered: true`) — the `books` array index, which IS `collectionBook.order
  ASC` (verified in source — not response luck).
- **Kavita collection** (`ordered: false`) — the paged all-v2 response index: stored honestly
  (cheap, rebuilt every sync), consumed by NO read (D-06 drops the position sort for unordered
  collections). If Kavita ever exposes collection ordering, this flips to `ordered: true` with zero
  schema change.

### D-10 — Gating: the `books` section is THE gate

Every new read (`books.collectionGroups`, the `collection`-narrowed `books.search`) is
`booksProcedure`-gated — server-authoritative, the same gate as the walls (AC-13 discipline;
ships wherever the books walls are granted, Admin-only by the `books` section default). Books have
no per-library ACL (ADR-046), so there is no ADR-047-style member-count leak vector: a caller who
can see a wall can see every collection the wall-mapping rule places there, and counts are computed
only over `books_items` rows that wall would show (live rows of the wall's kind). The cover URLs
are the existing gated `/api/books/cover` proxy — no new art path.

## Alternatives considered

- **App-native book collections / authoring UI** — rejected permanently (ADR-066 option 2, owner R1).
- **Surfacing collections via `books_items.series_name`** — rejected: a per-item ABS metadata facet,
  not an entity (ADR-066 option 3). Left untouched.
- **Live Kavita/ABS reads at render** — rejected: the wall-mapping majority + counts need the
  resolved members' media kinds in SQL; the drill must compose with `books.search` (ADR-066
  option 4).
- **A both-walls surface for mixed collections** — rejected for v1: double-counts the estate and
  needs a per-wall count wire; the majority rule is simple and honest (ADR-066 C-08).
- **Chapter-grain reading-list members** — rejected: the walls are series-grain (`books_items` IS
  the Kavita series); a chapter surface is a different product (the PLAN-043 app's territory).
- **`?group=<title>`** — rejected: titles are neither unique nor stable across sources/kinds; the
  row uuid is the app-side identity (source ids collide across source+kind spaces).

## Test strategy

- **Client (`packages/books`, fetch-stubbed)** — zod coercion against fixtures shaped from the
  verified DTOs: Kavita GET /api/Collection, POST /api/ReadingList/lists (Pagination header),
  GET /api/ReadingList/items (order/seriesId), the all-v2 CollectionTags filter body
  (field 7 / comparison 0), ABS GET /api/collections (ordered books array); extra upstream fields
  dropped, auth/401-retry ridden through the existing idioms.
- **Sync (`packages/sync`, embedded PG + stubbed clients)** — the plex-collections battery
  books-flavored: fetch + upsert produces the expected collections/members with resolved
  `books_item_id`s; reading-list chapter dedupe keeps earliest positions; a re-run with a vanished
  collection/member reconciles it away; a family whose listing FAILS is not scoped (its collections
  survive); a truncated/failed member read never member-tombstones; per-source isolation (Kavita
  down ⇒ ABS families still scope).
- **Domain (`packages/domain`)** — the writer's resolution behavior: unresolvable refs stored raw
  with null `books_item_id`; a later run resolves them; a tombstoned item drops from resolution.
- **API (`packages/api`, real routers)** — the `books` gate REFUSES a disabled caller on
  `collectionGroups` and the drilled search; the wall-mapping majority (a mixed collection cards
  ONLY its majority wall, count = that kind's members); covers cap at 4 (position order); `ordered`
  flows; the `collection` predicate narrows the wall; `position` sort orders by member position and
  REFUSES without `collection`; raw `item_count` never leaks as the wire count.
- **Migration (`packages/db`)** — the 0056 block: identity uniques bite, the collection cascade
  cleans members, `books_item_id` nulls on item delete (SET NULL), the kind/source CHECKs bite, and
  `sync_runs.run_kind` admits `books-collections-sync`.
- **Registry (`apps/web` unit)** — the new levels pin label/count sorts + no facets
  (grouped-collection) and position-first sorts + no `wanted` facet (collection-items); the walls'
  grouping rows (sibling dimension, defaults unchanged) extend the existing parity/asymmetry tests.
- **Guard** — both new tables in all six regex families (the existing no-direct-state-writes test
  enforces it repo-wide once listed).
- **e2e substrate (shipped)** — the stub-books harness gained the collection endpoints
  (`/api/Collection`, the all-v2 CollectionTags branch, `POST /api/ReadingList/lists`,
  `/api/ReadingList/items`, ABS `/api/collections` — one fixture per concept incl. a chapter-dupe
  reading list) and the harness seeds the mirror by RUNNING the real `books-collections-sync` mode
  after the books-sync seed — so dev:local and every e2e run render the Collections views
  hermetically. The dedicated journey SPEC is deferred (Q-01); the flows were driven live against
  dev:local during the build (cards, ordered "List order" drill, unordered no-position drill,
  Comics selector gating).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | e2e smoke spec for the books Collections view? | SUBSTRATE SHIPPED, SPEC DEFERRED — the stub collection fixtures + the harness `books-collections-sync` seed landed with the build (dev:local + every e2e run render the views), so the journey spec is now a cheap follow-up; the flows were hand-driven against dev:local during the build. |
| Q-02 | Merge cross-source collections (the same series in Kavita + ABS) into one card via PLAN-050 pairing data? | DEFERRED (owner lean: two honest source-scoped collections v1; merge later after the owner sees the mirror live). |
| Q-03 | Kavita response shapes verified from the tagged 0.9.0.2 SOURCE + live route probes, not an authed live call (no creds in the build env). | Accepted risk, mitigated: strip-mode zod + the fixture battery; the deployed image is pinned to the exact verified tag. First staging `books-collections-sync` run validates live; any drift is a client-schema patch, not a schema migration. |
