# DESIGN-038: Books collections mirror — the Books/Audiobooks/Comics Collections group view

- **Status:** Accepted
- **Last updated:** 2026-07-18 (D-13 added — the books/audiobooks collection **Wanted tiles**: a
  collection that is not full renders its MISSING members as Wanted tiles beside the held ones,
  minted as `book_requests` origin `'collection'` from Libretto's member-level missing endpoint;
  SUPERSEDES the D-07 held-only stance + the DESIGN-035 D-16 books-leg deferral. Migration 0068. See
  the dated amendment below. Prior: D-12 — the books collection CATEGORY chip, completing the
  dynamic-category story across all three walls)
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
- No `ctype` analog **(SUPERSEDED 2026-07-17 by D-12)**: the original view shipped with no facet on
  the books grouped levels because the PLAN-053 Collection _Type_ classifier was movie-title-specific.
  The label-driven CATEGORY program (DESIGN-035 D-10'/D-11') retired that classifier for an OPEN,
  free-form category, and the owner extended it to books — so the grouped levels now carry the SAME
  dynamic category chip the movies/TV Collections walls do. See D-12.

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

### D-11 — Collection provenance (`created_by`, migration 0058 — owner directive 2026-07-16)

Owner directive (2026-07-16, near-verbatim): "'NY Times Builder' would be something we'd see over
in the Books." Every mirrored book collection carries a PROVENANCE — the software that created it —
stored on the mirror at sync time and shown as a small muted badge on the group-card face. The
mirror stays a MIRROR (owner R1): provenance is READ from what the source exposes, never invented.

- **Source signal** — Libretto (the "Kometa for books" collection manager, DESIGN-037) plants a
  provenance MARKER `[libretto:<recipeId>]` in the description it writes: Kavita collections and
  reading lists carry it in `summary` (AppUserCollectionDto / ReadingListDto), ABS collections in
  `description` — verified in the deployed Libretto's own target source (the MARKER SPIKE finding:
  descriptions are API-writable on both Kavita container kinds and the ABS collection). The
  books-collections sync ALREADY reads these containers; it now reads the marker field off the same
  read — **no new service dependency** (the directive's preference). The Kavita/ABS schemas gained
  `summary` / `description`; the marker parse is a pure regex.
- **Derivation** — `@hnet/domain` `collection-provenance.ts`
  `deriveBooksCollectionProvenance(source, description)` → `'libretto'` when the marker is present,
  else the SOURCE app that hand-made it (`'kavita'` / `'audiobookshelf'`). Always derivable (the
  description rides the mirror read), so never null.
- **Column** — `books_collections.created_by text` (migration 0058), NULLABLE and OPEN (no CHECK),
  the `plex_collections.created_by` class: a rebuildable derived-cache annotation recomputed from
  the source description at every upsert (`excluded.created_by`).
- **Badge** — `books.collectionGroups` returns `provenance` (resolved server-side via
  `provenanceDisplayName`: `libretto → "Libretto"`, `kavita → "Kavita"`, `audiobookshelf →
"Audiobookshelf"`); the `GroupCard` renders it as one muted badge in the reserved badge row
  (ADR-015, tokens-only) — only on the Collections dimension (author/genre group cards carry none).
- **Software-level, not builder-level (v1)** — the marker carries the recipeId but NOT the
  `builder.type`, so `'libretto'` is the honest software tag. The finer builder identity the owner
  named ("NY Times", "Hardcover Series") needs the Libretto `/api/recipes` recipeId→builder.type
  join — a NEW sync dependency, deferred (Q-04). The display mapping for it (`BUILDER_DISPLAY`) is
  pre-wired data-driven so the join lands in one place; unknown builder tokens title-case honestly.

### D-12 — Books collection CATEGORY (migration 0064 — the dynamic chip, agent-set, mirror-preserved) — added 2026-07-17

The label-driven collection-category program (DESIGN-035 D-10'/D-11', PRD R-214, glossary T-186)
made the movies/TV Collections walls' Type chip an OPEN, free-form CATEGORY derived from the owner's
labels and rendered as a DYNAMIC chip row (one chip per distinct category present, ordered
hint-list-then-alphabetical, no "Other"). The owner ratified extending the same model to books so the
dynamic-chip story is identical across all three walls (Movies / TV / Books+Audiobooks+Comics). This
amendment adds that category to the books mirror.

The mechanism differs from movies because books carry no Plex labels. Two placements were weighed in
the ratified spike (`.agents/context/2026-07-17-label-driven-collections-spike.md` §4): **L1** (Libretto
writes a free-form `cat=` token into its `[libretto:<recipeId>]` description marker, the app parses it
at sync — mirror-pure but needs a Libretto change) vs **L2** (an app-owned `category` column set
directly). Because Libretto is not in the cluster GitOps tree today (feature branches only) and the
Kavita-native comic Event lists have NO Libretto recipe to carry a marker, the ratified call is **L2 —
`category` is agent-set directly on `books_collections`** — with the L1 path kept forward-compatible.

- **Column** — `books_collections.category text` (migration 0064), NULLABLE and OPEN (no CHECK), the
  `books_collections.created_by` / `plex_collections.category` class. null = the collection carries no
  category (no chip; it shows only under "All"). Categories are whatever an agent sets — a new value
  becomes a new chip on the next read with zero migration.
- **Set path (L2, ratified)** — the category is app/agent-owned state, set directly on the mirror row
  (the owner's "agent-set on ... books_collections"). The labeling agent assigns each collection a
  free-form category (Series / List / Event / a new one it coins), exactly the pass that labeled the
  Kometa collections for movies. The value is not derived from the source, so the sync must not wipe it
  (below).
- **Derive path (L1, forward-compatible, currently a no-op)** — `@hnet/domain`
  `deriveBooksCollectionCategory(description)` parses an optional `cat=<Category>` token the Libretto
  marker MAY carry (`[libretto:<recipeId>|cat=Series]`). Live descriptions carry no `cat=` yet, so it
  returns null for every row today; it is wired so that WHEN Libretto starts emitting `cat=`, the
  source value flows in automatically with no further app change.
- **Sync preservation (the reconciliation of L1 + L2)** — `syncBooksCollections` writes
  `category = COALESCE(excluded.category, books_collections.category)` on conflict, where
  `excluded.category` is the L1 derive (null today). So a source-carried `cat=` marker WINS when
  present (mirror doctrine — the source is authoritative), and otherwise the prior value is
  PRESERVED — an agent-set L2 category survives every re-sync. On INSERT a fresh collection takes the
  derived value (null today). A reconcile-DELETE of a vanished collection drops its category with the
  row, which is correct (the collection is gone). No audit rows (derived-cache class — ADR-066 C-02);
  the write stays confined to the `syncBooksCollections` single writer (guard-listed), so the guard is
  untouched and the L2 agent-set is an operational data pass, not a second code writer.
- **Read model** — `books.collectionGroups` returns `category` per card and a
  `categoryCounts: Record<string, number>` of the DISTINCT categories present among the wall's cards
  (only non-null categories appear). It also accepts an optional `category` input that filters the
  CARDS after aggregation (so `categoryCounts` holds steady while a chip is toggled — the
  `ledger.collectionGroups` idiom verbatim). The counts are computed only over the wall's own gated,
  resolved live members, so no count can leak a card the caller can't see (D-10 gate unchanged).
- **Chips** — the three `*:grouped-collection` registry levels gain the SHARED category facet
  (`key: 'category'`, `?ctype=` replace refinement). The books wall renders one chip per present
  category ordered by `orderCollectionCategories` (the movies hint-list-then-alphabetical helper) with
  an All default; the chip row is data-gated on the books walls' "no dead chip" ethos (ADR-051 C-06 —
  it renders only when at least one category is present), which is the books-idiom twist on the
  always-visible movies row. Both books and movies share the identical dynamic-chip renderer contract.

### D-13 — Collection WANTED tiles (migration 0068 — added 2026-07-18)

The owner flagged this "super important": a books OR audiobooks collection that is NOT full MUST render
its MISSING members as **Wanted tiles** beside the held ones — his Stormlight "3 held + 15 wanted" view
(held tiles + missing tiles side by side, so the household can SEE and FILL what's missing). Movies
shipped this in DESIGN-035 D-16 (v0.75.0); the books/audiobooks leg was deferred there ONLY until
Libretto exposed the missing member IDENTITIES — which is now LIVE
(`@hnet/libretto` `read.listMissingMembers(recipeId)`). This amendment **supersedes the D-07 held-only
stance** for the collection-items drill. The wanted-row model is medium-neutral, but books have no *arr
ledger for the not-held members, so the source is different: a collection's missing members are minted as
`book_requests` with a NEW origin **`'collection'`** (the DESIGN-035 D-16 named slot) — the DESIGN-029
composed-Wanted idiom, now collection-scoped.

- **Data (migration 0068)** — `books_collections` gains `libretto_recipe_id` (the recipeId parsed from
  the `[libretto:<id>]` marker the provenance derive already reads — D-11 — captured on the mirror for an
  EXACT id-join, the movies-leg "capture the id" hardening lever applied here). `book_requests` grows the
  COLLECTION-WANT seat, disjoint from goodreads/pairing: `collection_id` (FK → `books_collections` ON
  DELETE CASCADE — a vanished mirror collection cascade-drops its wants) + `collection_member_ref` (the
  stable per-member idempotency key: ISBN-13 → identifier → normalized title); the origin CHECK admits
  `'collection'`, the origin↔keys coherence CHECK gains the collection branch, and a PARTIAL unique
  `(collection_id, collection_member_ref) WHERE origin='collection'` keys them (goodreads/pairing rows,
  `collection_id` NULL, never collide).
- **Mint / reconcile (`@hnet/domain` `syncCollectionWants`, book_requests' own single-writer)** — one
  transaction, the `syncPlexCollections` wanted-row analog: upsert one origin='collection' want per CURRENT
  missing member and reconcile-DELETE the wants no longer missing (a member that became held drops out of
  Libretto's missing list ⇒ its want resolves — the "becomes held resolves its want" lifecycle). Idempotent
  (the partial unique). The ACTIVE format runs the lifecycle; the inactive sits `landed` (the ADR-065
  pairing "held format sits landed" idiom, so `searchableFormats` only searches the collection's own
  format). The format is source-derived: kavita ⇒ ebook, audiobookshelf ⇒ audiobook (comics stay held-only
  — Kapowarr's domain, out of this leg). Rebuildable derived cache — NO audit row (the ADR-066 C-02 class);
  `book_requests` joins the DELETE guard families for the reconcile, scoped to origin='collection'.
- **The Libretto pass (`@hnet/domain` `runCollectionWantsSync`, the `books-collections-sync` mode step)** —
  runs AFTER the mirror upsert (recipe ids fresh), ONLY when a Libretto READ client is supplied (the CLI
  builds it best-effort — absent `LIBRETTO_API_KEY` ⇒ held-only, the mirror still runs). For each
  Libretto-managed collection: `listMissingMembers(recipeId)`, opportunistically `resolve` each member's
  ISBN|title → a GB volume id (the LL bookid — makes the want FORCE-SEARCHABLE; a null keeps the tile
  visible, just not yet searchable — an honest gap), then `syncCollectionWants`. DEGRADING: Libretto
  unreachable ⇒ the whole pass is skipped (never reconcile wants it couldn't re-see); one collection's read
  error ⇒ that collection skipped (its wants untouched — the fully-resolved discipline). External I/O stays
  OUT of the write transaction (the goodreads-sync idiom).
- **Read + drill render** — `books.search` composes the COLLECTION's own wanted members
  (`getCollectionWantedBookRequests`, collection-scoped — NOT the household overlay) into the drill through
  the SAME union machinery as the top-level wall: held tiles + Wanted tiles interleaved by the active sort;
  under the `position` (List order) sort the held members sort by reading order and the wants (no position)
  sort LAST. The `books:collection-items` + `audiobooks:collection-items` registry levels gain the shared
  `wanted` facet (All · Wanted only · Hide wanted, dataGated — no dead chip on a FULL collection); the drill
  defaults to composing wants (the owner's "always show what's missing"). A collection want is an OWNERLESS
  system want (the pairing class): its force-search rides the books gate (`books.searchPairingWant` now
  admits `'collection'`), and the wanted TILE reuses the shipped `WantedCard` → the wanted-detail page (no
  hand-rolled action — the books wanted surfaces unify onto shared `@hnet/ui` components in a later pass,
  the unification lane; this leg does not fork the tile).
- **Comics — held-only (unchanged).** A comic want is Kapowarr's domain (never Libretto's), and comic
  collections rarely carry a Libretto recipe; the wanted-row model slots comics in later without schema
  change (`comics:collection-items` keeps no `wanted` facet).
- **Household overlay isolation** — `getWantedBookRequests` (the top-level wall's overlay) is unchanged:
  its WHERE admits only goodreads (linked shelf) + pairing origins, so collection wants NEVER leak onto the
  top-level Books/Audiobooks walls — they surface ONLY on their collection's drill.

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

| ID   | Question                                                                                                                                 | Resolution                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q-01 | e2e smoke spec for the books Collections view?                                                                                           | SUBSTRATE SHIPPED, SPEC DEFERRED — the stub collection fixtures + the harness `books-collections-sync` seed landed with the build (dev:local + every e2e run render the views), so the journey spec is now a cheap follow-up; the flows were hand-driven against dev:local during the build.                                                                                      |
| Q-02 | Merge cross-source collections (the same series in Kavita + ABS) into one card via PLAN-050 pairing data?                                | DEFERRED (owner lean: two honest source-scoped collections v1; merge later after the owner sees the mirror live).                                                                                                                                                                                                                                                                 |
| Q-03 | Kavita response shapes verified from the tagged 0.9.0.2 SOURCE + live route probes, not an authed live call (no creds in the build env). | Accepted risk, mitigated: strip-mode zod + the fixture battery; the deployed image is pinned to the exact verified tag. First staging `books-collections-sync` run validates live; any drift is a client-schema patch, not a schema migration.                                                                                                                                    |
| Q-04 | Builder-LEVEL books provenance (the owner's "NY Times" / "Hardcover Series", not just "Libretto")?                                       | DEFERRED (D-11). The marker carries only the recipeId; resolving `builder.type` needs a Libretto `/api/recipes` join — a NEW sync dependency (LIBRETTO_API_KEY, a client, Libretto-up coupling) the directive preferred to avoid. v1 ships the honest software tag "Libretto"; the `BUILDER_DISPLAY` map is pre-wired for the join. Owner ruling needed on adding the dependency. |
