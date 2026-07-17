# DESIGN-035: Mirrored Plex collections — the Movies/TV Collections group view

- **Status:** Accepted
- **Last updated:** 2026-07-17 (amended: **D-10'/D-11'** SUPERSEDE D-10/D-11 — the collection
  category is now LABEL-DRIVEN and OPEN, not a title-guessed closed enum; see the dated amendment
  below. No new ADR — still an annotation + facet on ADR-064's read-model)
- **Prior update:** 2026-07-16 (PLAN-053: **D-10/D-11** — the title-based Collection Type annotation
  + Type facet chip row on the grouped walls)
- **Satisfies:** PRD-001 **R-208..R-210, R-214**; governed by **ADR-064** (mirror-only doctrine,
  owner R1–R4) on top of **ADR-047** (THE INVARIANT + `media_plex_matches`), **ADR-051/052** (view
  engine + per-user preferences), **DESIGN-026** (D-01 view model, D-02 registry seam, D-04 group
  cards, D-10 URL contract, D-19 PUSH/REPLACE via DESIGN-004). Glossary **T-179..T-182, T-186**.

## Overview

The owner curates collections on the HOps Plex server (Kometa charts + franchise sets). PLAN-037
mirrors them into two rebuildable tables (`plex_collections` + `plex_collection_members`, migration
0053), synced by a new standalone `collections-sync` mode, and surfaces them as an **opt-in
"Collections" grouped view** on the Movies and TV walls through the shipped PLAN-029 view engine —
registry-row edits, one new tRPC group read, one new `ledger.search` predicate, zero new components
(ADR-051 C-01, GroupCard reused). Everything reads under the ADR-047 access gate: counts, covers,
and the drill-in all resolve through `media_plex_matches` into libraries the caller can access.

## Detailed design

### D-01 — The two mirror tables (migration 0053)

- **`plex_collections`** — one row per collection per library:
  `id uuid pk`, `plex_library_id` FK → `plex_libraries` ON DELETE CASCADE, `rating_key text`
  (the Plex collection's metadata id), `title text`, `child_count int` (the RAW Plex member count —
  diagnostics only, never shown as the wall count, ADR-064 C-03), `first_seen_at` / `last_seen_at` /
  `created_at` / `updated_at`. Identity: **UNIQUE `(plex_library_id, rating_key)`** (the
  plex-libraries "identity is keys, never names" rule — collection titles are not unique).
- **`plex_collection_members`** — one row per member per collection:
  `id uuid pk`, `collection_id` FK → `plex_collections` ON DELETE CASCADE, `rating_key text` (the
  MEMBER title's ratingKey — the join key into `media_plex_matches (plex_library_id, rating_key)`),
  `sort_order int` (position in the source read, D-07), same four timestamps. Identity: **UNIQUE
  `(collection_id, rating_key)`**.
- Membership is stored **RAW** regardless of ledger match (owner R3 mirror-everything): a chart
  entry the *arrs don't manage still gets a member row; the ledger join is a read-time concern.
  Both tables are the rebuildable-derived-cache class (ADR-064 C-02): single-writer, guard-listed,
  no audit rows. The migration also grows `SYNC_RUN_KINDS` + rebuilds the `sync_runs.run_kind`
  CHECK (`collections-sync` — parity only; the mode writes no `sync_runs` row).

### D-02 — The `collections-sync` standalone mode

The plex-match shape, verbatim in spirit:

- **Fetcher** (`@hnet/sync` `fetchPlexCollectionsSnapshot`) — reads ONLY slug **`haynesops`** (owner
  R4) and ONLY sections of type `movie|show` that exist in the `plex_libraries` registry
  (`available = true`; an unregistered section is skipped and logged — run a registry refresh first).
  Collections come from a NEW paged `@hnet/plex` read, `listCollections(sectionKey)` —
  `GET /library/sections/{key}/collections` with the `X-Plex-Container-Start/-Size` loop until
  `start >= totalSize` under a MAX_PAGES cap (the container-bounded lesson from plex-match). Members
  come from the EXISTING `listMetadataChildren(collection.ratingKey, { limit: 1000 })` (D-08 bound).
- **Domain single-writer** (`@hnet/domain` `syncPlexCollections`) — one transaction:
  upsert collections `onConflictDoUpdate` on `(plex_library_id, rating_key)` (title/child_count/
  last_seen_at advance; first_seen_at/created_at keep), upsert members on
  `(collection_id, rating_key)`, then reconcile-DELETE:
  - **members** where `last_seen_at < runStart`, scoped ONLY to collections whose member read was
    COMPLETE this run (D-08 `fullyRead`);
  - **collections** where `last_seen_at < runStart`, scoped ONLY to `plex_library_id`s whose section
    was fully read this run (`scopedLibraryIds` — the plex-match rule: a server outage or a
    mid-section error never tombstones what the run couldn't see; the CASCADE removes their members).
- **Standalone**: no `--source`, writes NO `sync_runs` row — its trail IS the mirror tables (the
  plex-match/books-sync class). Orchestrator branch mirrors plex-match (report + totalFailure when
  no section could be read); CLI `--mode=collections-sync`; the CronJob lands in haynes-ops later.

### D-03 — The Collections group read model (`ledger.collectionGroups`)

The `books.groups` idiom on the ledger engine: one bounded query, in-process aggregation, wire shape
`{ key, label, count, coverUrls }` per collection (the GroupCard contract; `imageUrl` stays null —
a collection has no portrait source, the cover fan is the art, DESIGN-026 D-04 ladder).

- **Query** — for the wall's `arrKind` (`radarr`|`sonarr`): members join
  `plex_collection_members → plex_collections → media_plex_matches ON (plex_library_id, rating_key)
  → media_items` (+ LEFT JOIN `media_metadata` for the poster source), restricted to live
  (non-tombstoned) items of that kind **AND the ADR-047 gate** (`libraryAccessConditionRaw` for the
  raw join / `libraryAccessWhere`), ordered by `(collection, sort_order)`.
- **Aggregation** — count = DISTINCT accessible ledger members (never the raw Plex `child_count` —
  counts are leak vectors, the filterFacets precedent); covers = the first **4** accessible members'
  poster URLs via the existing `posterUrlFor` path (the group-card cover fan; a member with no
  poster contributes none). Cards come back label-A–Z; the client re-sorts by the grouped level's
  registry keys (label | count).
- **PLAN-053 amendment (D-10/D-11)** — each card also carries the collection's `type` (the D-10
  annotation), the input takes an optional `ctype` (the D-11 facet — the SERVER filters the cards),
  and the wire adds `typeCounts` (accessible-collection counts per type, computed BEFORE the
  `ctype` narrowing so the chip row's numbers are stable while filtering).
- **THE INVARIANT** — a collection whose accessible ledger-member count is ZERO (all members
  withheld, unmatched, or non-ledger) is DROPPED from the listing entirely: no card, no label leak.
  Admin (unrestricted) sees every collection with ≥ 1 ledger-matched member of the kind.
- **Collection-existence visibility note (intended, pending owner confirmation):** access is
  ITEM-level (the ADR-047 gate), not collection-home-level — a member accessible through ANOTHER
  library (e.g. mirrored into a granted HNet library) still counts toward, and therefore surfaces,
  the HOps collection's title even for a caller not granted the HOps library itself; the card
  exposes only that collection's name plus items the caller could already see.

### D-04 — Drill-in: `?group=<ratingKey>` is a `ledger.search` predicate

The drilled wall is the SAME flat grid the tab already renders. `LIBRARY_FILTER_SHAPE` (the shared
search/browse/export DSL) gains an optional **`collection`** field (the collection's `rating_key`),
and `buildLibraryWhere` adds ONE predicate:

```sql
EXISTS (SELECT 1
          FROM plex_collection_members pcm
          JOIN plex_collections pc ON pc.id = pcm.collection_id
          JOIN media_plex_matches cmx
            ON cmx.plex_library_id = pc.plex_library_id
           AND cmx.rating_key      = pcm.rating_key
         WHERE pc.rating_key = ${collection}
           AND cmx.media_item_id = media_items.id)
```

Because it is just an AND predicate inside `ledger.search`, the drilled wall inherits **everything**
unchanged: every registry facet, every sort + the keyset cursor, the A–Z jump, and the ADR-047
access gate (a withheld member never appears in the drilled grid — R-210). The group key is the
collection `rating_key` (stable, key-not-name — the D-01 identity rule); the drill header's label
resolves from the group listing.

### D-05 — Registry seam edits (ADR-051 C-01: rows, not components)

- `WALL_VIEWS.movies` → `offers: ['flat', 'grouped']`, `flatLabel: 'All movies'`, `groupings:
  [{ dimension: 'collection', selectorLabel: 'Collections', allLabel: 'All collections',
  art: 'covers', level: 'movies:grouped-collection' }]`.
- `WALL_VIEWS.tv` → `offers: ['hierarchy', 'grouped']`, `flatLabel: 'All shows'`, same grouping with
  `level: 'tv:grouped-collection'`. The hierarchy shape (Shows → Seasons → Episodes drill) is the
  wall's non-grouped shape and is UNTOUCHED (owner R2).
- Two new `ViewLevelKey`s — `movies:grouped-collection` / `tv:grouped-collection` — as `groupLevel`
  entries sorting the CARDS by `label` (Collection A–Z, asc-first) | `count` (Most items,
  desc-first), default label-asc, no facets, no A–Z rail (the `audiobooks:grouped-genre` shape).
- **`WALL_VIEW_DEFAULTS` / `LIBRARY_WALL_DEFAULTS` are UNCHANGED** — Movies stays flat, TV stays
  hierarchy; Collections is opt-in via the view selector (which now renders on these walls) or a
  shared `?view=grouped&by=collection` link. The domain/client mirrors stay in parity (the
  parity test binds them).

### D-06 — URL contract (rides DESIGN-026 D-10 / D-19 verbatim)

- `?view=grouped&by=collection` — the Collections view (a screen-level **PUSH**; `by=` may be
  omitted since `collection` is the walls' only/default grouping dimension). A bare URL that
  RESOLVES to grouped (a stored Collections preference) canonicalizes to `?view=grouped` with a
  replace; a bare URL resolving to the wall's DEFAULT shape stays bare — the D-10 rule ("`?view`
  omitted when it equals the wall's R2 default") is shipped contract on these walls, and existing
  deep links / the history e2e assert the bare `?tab=` form.
- `?group=<ratingKey>` — the drilled collection (a **PUSH**; implies the flat/item grid). The drill
  header shows the collection title + a back link to the grouped wall. Sorts/filters inside the
  drill stay **replace** refinements; the drilled sort is transient (not persisted — the books
  drill rule).
- A view switch persists via `library.preferences.set` from the selection handler (ADR-052; URL
  renders are never written back). Tab-switch reset (only `?tab` survives) is inherited unchanged.

### D-07 — Member ordering: stored honestly, unconsumed in v1

`sort_order` records the position members came back from `GET /library/metadata/{key}/children`.
Plex documents collection ordering (`collectionSort` release-date/alpha/custom), but whether the
active order survives the `/children` read is **UNVERIFIED** here (no live Plex reachable from this
build environment, and the item schema carries no order field — only response position). So:

- v1 stores the response order (cheap, honest, rebuilt every sync) but **no read consumes it** —
  the group cards sort by label/count and the drilled wall sorts by its own registry keys.
- If a future surface wants "Plex order" as a drill sort, verify live first (Q-02) — the column is
  already there.

### D-08 — Membership read bound (honest truncation handling)

`listMetadataChildren` is container-bounded at 1000 and unpaged. HOps collections are Kometa charts
and franchise sets (tens to a few hundred members), so 1000 covers reality; but a collection whose
`totalSize` exceeds the items returned is marked **not fully read**: its collection row still
upserts (title/child_count advance) and the members it DID return upsert, but its member
reconcile-delete is SKIPPED that run — a truncated read never tombstones members it didn't see
(the plex-match partial-read rule applied at collection grain). The fetcher logs the truncation.

### D-09 — UI: the MediaBrowser gains the grouped shape (no new components)

The Movies/TV `MediaBrowser` (library-client.tsx) adopts the books-browser idioms for its new
multi-shape reality: the `.seg` view selector (Collections | All movies/All shows), the grouped
card grid (`GroupCard`, cover-fan art, PUSH drill), the drill header (back link + collection
title), client-side card search (label contains) + card sort (label/count), and the D-06
canonicalization. In grouped mode the item-only controls (on-disk segment, Wanted-only, facet
chips) do not render — a grouped level declares no facets *(amended by D-11: the grouped-collection
levels now declare exactly ONE facet, the Type chip row — still registry-enforced; item facets
remain absent)*; the drilled grid is the ordinary wall and keeps them all. All copy is plain and
friendly, no em-dashes, no personal names ("Collections", "All movies", "All collections", "No
collections yet."). ADR-015 holds: the selector/toolbar heights are fixed, cards reserve the 2:3
box, refetches dim in place.

### D-10 — The Collection Type annotation (`collection_type`, migration 0055 — PLAN-053)

Owner rulings (2026-07-16, final): **six buckets** — Trilogies, Franchise/Universe, Director,
Actor, List, Other (producer/writer FOLD INTO Director); the wall shows ALL types by default and
the chip filters — never hides.

- **Column** — `plex_collections.collection_type text NOT NULL DEFAULT 'other'`, CHECK
  `('trilogy','franchise_universe','director','actor','list','other')` (migration 0055; the
  `COLLECTION_TYPES` enum in `@hnet/db` mirrors it). It is an ANNOTATION on the mirror row, not
  new state: `syncPlexCollections` recomputes it from the title at every upsert (insert AND
  conflict-update), so the whole column rebuilds on the next sync — the same rebuildable
  derived-cache class as the row it sits on. No audit, no widening of the single-writer surface.
- **Classifier** — ONE versioned pure module, `@hnet/domain` `collection-type.ts`
  (`classifyCollectionType(title) → CollectionType`, `COLLECTION_CLASSIFIER_VERSION`). Bumping the
  rules bumps the version; the next `collections-sync` re-annotates the estate (nothing migrates).
  Rule order (first match wins), explicit patterns + estate-seeded name lists — a bare person-name
  heuristic is TOO LOOSE, so anything ambiguous stays honestly `other`:
  1. **trilogy** — "… Trilogy" and the explicit n-ology variants (duology/dilogy, tetralogy,
     quadrilogy, pentalogy, hexalogy, heptalogy, septology, octology, ennealogy, decalogy).
     ("Anthology" does NOT match — the prefix list is closed.)
  2. **franchise_universe** — the TMDb "… Collection" franchise idiom (title ENDS with
     "Collection" — the franchise Default's canonical names) + "… Saga", the "…verse" /
     "… Universe" idiom (Marvel Cinematic Universe, Arrowverse, Shondaverse, Monsterverse), and
     the universe-Default names our estate runs (Kometa research §4: Star Wars, Wizarding World,
     Middle Earth, X-Men, Alien / Predator, Fast & Furious, Rocky / Creed, Star Trek, In
     Association with Marvel/DC — exact-title matches).
  3. **director / actor** — the people-file idiom: exact (case-insensitive) title match against
     the known-name lists seeded from our Kometa config's outputs (`movies-people.yml` —
     Producers/Directors section → `director`, Actors section → `actor`). A person name NOT in
     the lists (e.g. the "Roald Dahl" author list) is honestly `other`.
  4. **list** — charts (IMDb …/Top 250/Top Rated/Top Grossing/Popular/Trending/Now Playing/In
     Theaters/Best of …/"… Chart(s)"; decade charts "…1980s…"; seasonal charts — Christmas,
     Halloween, Thanksgiving, Valentine's, Easter, New Year, …) and awards (Oscars/Academy
     Award, Golden Globe, BAFTA, Cannes/Palme, Emmy, Razzie, Sundance, Venice, Berlinale,
     Critics Choice, Independent Spirit).
  5. **other** — everything else ("Curated for Jackson", "A24", "Disney Animation", "Dolby
     Atmos", bare franchise names like "Sharknado"/"Breaking Bad" that carry no idiom).

### D-11 — The Type facet chip row (`?ctype=` — PLAN-053)

- **Registry seam (ADR-051 C-01)** — the two grouped-collection levels
  (`movies:grouped-collection` / `tv:grouped-collection`) declare exactly ONE facet:
  `{ key: 'collectionType', label: 'Type', kind: 'select', param: 'ctype' }`. It is never gated
  and never data-hidden (owner ruling: the chip filters, never hides — a 0-count chip still
  renders). Item facets stay absent from the grouped levels (D-09 asymmetry).
- **Chips** — one always-visible single-select row over the grouped CARDS: **All** (default) ·
  Trilogies · Franchise · Director · Actor · Lists · Other. *(Owner amendment 2026-07-17 — see
  below: labels are display-only, counts removed, Trilogies is movies-only.)*
- **Server-side filtering** — the chip narrows the group cards in `ledger.collectionGroups`
  (`ctype` input), never in the client; the gated `typeCounts` still come back on the wire
  (accessible-collection counts — a collection with zero accessible members is neither carded nor
  counted; THE INVARIANT applies to counts exactly as to cards — R-210/R-214) and back the
  backlogged global total, though they are no longer painted per chip.
- **URL contract** — `?ctype=<type>` is a D-19 REFINEMENT (replace-in-place, no history entry;
  All = param absent). A view switch PUSHes a clean URL, so `ctype` drops with the other
  refinements; the `?group=` drill (a PUSH) does not carry it — the drilled wall is the ordinary
  item grid and the facet is a card-grid concern.
- **ADR-015** — chips recolor (`is-active`), never reflow: static labels, fixed-height chip bar
  (the existing `.library-chipbar`/`.seg` skins — tokens only). The bar pans horizontally when
  crowded (`.library-chipbar > .seg { flex: none }` + `white-space: nowrap`, the Tickets
  `.twall-bar .seg` idiom) so a narrow phone scrolls the row instead of wrapping it.

#### D-11 amendment — owner mobile review (2026-07-17, PLAN-053 amendment)

The owner reviewed the live chips on his phone and directed four DISPLAY-only changes (stored keys
/ classifier / DB untouched — stable IDs):

- **Per-chip counts removed.** The `(N)` suffix bloated the row on mobile. A **global** total (one
  number, not per-category) is backlogged (`.agents/plans/TODO.md`); the gated `typeCounts` stay on
  the wire as its seed.
- **"Franchise & Universe" → "Franchise"** (label map only; the `franchise_universe` key is stable).
- **Trilogies hidden on TV** (`collectionTypeOptionsForWall` — movies keep all six). Trilogies are a
  movies concept; the mirror classifies ~0 of them either way (see the diagnosis below).
- **Mobile fit** — the row now fits a 320px phone on one line; horizontal pan is the overflow
  fallback (never a wrap/reflow — ADR-015).

**Trilogies diagnosis (data-backed).** A live query (461 collections) found the `trilogy` bucket
holds exactly ONE collection — "The Barrytown Trilogy" (child_count 2) — the only estate title
containing a `…logy` word. This estate names collections BARE (no "Trilogy"/"Collection" suffix —
"Back to the Future", "Men in Black", "Ocean's"…), so the title-only classifier can't find the
real trilogies. There is no safe fix: member-count = 3 is not a trilogy signal (that set includes
"Iron Man", "Guardians of the Galaxy", "Avatar"), and the mirror carries titles only (Q-01). The
classifier is left UNCHANGED — trilogies are honestly near-empty for movies, hidden on TV.

### D-10' / D-11' amendment — LABEL-DRIVEN, OPEN categories (2026-07-17, SUPERSEDES D-10/D-11)

The Trilogies diagnosis above is the tell: a TITLE-only classifier cannot recover categories the
owner knows but the titles don't spell out. Owner directive (2026-07-17): stop guessing from titles
and MIRROR labels we own. The owner deliberately labels every collection in the Kometa config
(haynes-ops), and those labels ARE the category chips. This retires the six-bucket title classifier
and the closed `collection_type` enum.

- **Category is OPEN, free-form, and label-derived.** `plex_collections.collection_type` (text +
  CHECK enum, migration 0055) becomes **`category` (text, nullable, NO CHECK — migration 0062)**.
  There is NO fixed vocabulary and NO "Other" bucket: a new label the owner coins becomes a new
  stored category and a new chip on the next sync, zero migration. `null` = no owner/section label
  (the collection shows only under "All", contributes no chip). *Follow-up (live-verified,
  2026-07-17): 0062 preserved the renamed column's values expecting the next sync to overwrite
  them all, but a NULL-deriving collection is COALESCE-preserved, so its stale title-classifier
  bucket survived (8 live rows, all `'other'`) and would have surfaced as an unwanted "other"
  chip. Migration 0063 clears every legacy six-bucket value to NULL (the legacy vocabulary is
  all-lowercase and disjoint from the owner labels, so derived categories are untouched).*
- **`deriveCollectionCategory(labels)`** (`@hnet/domain`, replacing `classifyCollectionType(title)`;
  `COLLECTION_CLASSIFIER_VERSION` → 2) picks the category with a ratified precedence:
  1. **Owner inline label wins** — the first label that is neither the reserved `Kometa` provenance
     label nor a Kometa SECTION label is returned verbatim (Universe / Sequels / Director / Actor /
     List / Studio / Audio / a coined one).
  2. **Section-label fallback** — for Default-produced collections with no inline owner label, map
     the section label Kometa already applies: `TMDb Collections` → Sequels, `Universe Collections`
     → Universe, `Oscars Winners Awards` / `Golden Globes Awards` → List, legacy TV
     `Show Franchise Collections` → Universe. (This is why the app needs NO Kometa change for the
     ~300 in-run franchise/universe Default collections — they are born labeled.)
  3. Otherwise `null`. A `null` labels array (read failed) → `null`, so the writer COALESCE-preserves
     the prior category (symmetric with `created_by` / D-12).
  The precedence matters where a collection carries BOTH kinds — e.g. Game of Thrones has the legacy
  `Show Franchise Collections` section label (→ Universe) AND an inline `Sequels`; the owner label
  wins (Sequels).
- **Zero new Plex I/O.** The sync fetcher already reads each collection's labels once (for D-12
  provenance); `category` is derived from that same read and threaded through
  `PlexCollectionSyncInput` beside `createdBy`.
- **D-11' — DYNAMIC chips.** The Type chip row is no longer a static registry vocabulary. The
  registry facet stays (`{ key: 'category', label: 'Type', param: 'ctype' }`) but declares no
  options; `ledger.collectionGroups` returns **`categoryCounts`** = the DISTINCT categories actually
  present (non-null only), and the client renders one chip per present category ordered by a HINT
  list `['Universe','Sequels','Director','Actor','List','Studio','Audio']` then alphabetical for any
  novel category. Both walls render identically (the movies-only Trilogies special-case is gone). The
  chip still FILTERS server-side (`category` input), never hides; ADR-015 holds (fixed-height row,
  horizontal pan when crowded). THE INVARIANT (R-214) is unchanged — a zero-accessible collection is
  neither carded nor counted.
- **Kometa side (haynes-ops).** Hand-authored defs carry an inline `label:`; the four award "Best
  Winners" static Defaults are re-authored as customs with `label: List`; two movie/TV orphans get a
  `blank_collection` + `label:` companion; a new `A Song of Ice and Fire` Universe umbrella is added.
  A same-name `blank_collection` companion CANNOT relabel an in-run Default collection (Kometa
  duplicate-skips it — proven by the 2026-07-17 dry-run), which is exactly why the section-label
  fallback map (rule 2) carries those.

### D-12 — Collection provenance (`created_by`, migration 0058 — owner directive 2026-07-16)

Owner directive (2026-07-16, near-verbatim): "We should also be tagging collections for what
created them, like 'IMDB Builder' would be from Kometa." Every mirrored collection carries a
PROVENANCE — the software that created it — stored on the mirror at sync time and shown as a small
muted badge on the group-card face. The mirror stays a MIRROR (owner R1 / hard rule 4): provenance
is READ from what the source exposes, never invented.

- **Source signal (verified live 2026-07-16, HOps server via a frontend-ns probe Job)** — Kometa
  LABELS every collection it manages with a `Kometa` Plex label: 123 of 124 sampled collections
  carried it; the one that did not is a hand-made collection. The labels ride the per-collection
  metadata read only (`GET /library/metadata/{ratingKey}?includeLabels=1`) — the `/collections`
  LISTING never carries them (probed: `includeLabels` / `includeAdvanced` on the listing return no
  `Label`), so the fetcher does one extra metadata read per collection (`readCollectionLabels`).
  Secondary labels the estate also carries ("Universe Collections", "TMDb Collections", awards
  groupings) are CATEGORY labels, not builder identity, so `kometa` is the honest software tag — we
  do NOT invent a per-builder tag ("IMDb Builder") the label does not encode (honest coarse beats
  invented fine).
- **Derivation** — `@hnet/domain` `collection-provenance.ts` `derivePlexCollectionProvenance(labels)`
  → `'kometa'` when the `Kometa` label is present (case-insensitive), `'plex'` (hand-made) when it
  is absent, and `null` when the label read did not run this sync.
- **Column** — `plex_collections.created_by text` (migration 0058), NULLABLE and OPEN (no CHECK):
  the vocabulary belongs to external software the app does not own, so an unknown token is honest,
  not rejected. It is a rebuildable derived-cache ANNOTATION like `collection_type` — recomputed at
  every upsert — with ONE difference: a null (the label read failed this run) PRESERVES the prior
  value via `COALESCE(excluded.created_by, plex_collections.created_by)`, so a transient label-read
  failure never re-tags a Kometa collection as hand-made.
- **Badge** — `ledger.collectionGroups` returns `provenance` (the display name resolved server-side
  via `provenanceDisplayName`: `kometa → "Kometa"`, `plex → "Plex"`, unknown → title-cased); the
  `GroupCard` renders it as one muted badge in the caption's reserved badge row. ADR-015: every
  card on the Collections wall carries a provenance badge, so the row is consistent and a badge
  recolors, never reflows. Tokens only (`.badge--muted`).

## Alternatives considered

- **App-native collections / authoring UI** — rejected permanently by the owner doctrine (ADR-064
  option 2, R1).
- **Surfacing collections via `media_metadata.source_collections`** — rejected: a per-item Kometa
  label facet, not an entity (no identity/membership/count; ADR-064 option 3). Left untouched.
- **Live Plex reads at render** — rejected: gated counts need the ledger join in SQL; the drill-in
  must compose with `ledger.search` (ADR-064 option 4).
- **A `?group=<title>` drill key** — rejected: titles are neither unique nor stable; `rating_key`
  is the Plex identity (D-01) and survives renames sanely (the sync re-titles the same row).
- **Storing only ledger-matched members** — rejected by R3 (mirror everything): raw membership
  keeps the mirror faithful and makes later non-ledger surfaces possible without a resync schema
  change.

## Test strategy

- **Sync (packages/sync, embedded PG + fake Plex read)** — mirror the plex-match test: fetch +
  upsert produces the expected collections/members; a re-run with a vanished collection/member
  reconciles it away; a section that errors mid-read is NOT scoped (its collections survive); a
  TRUNCATED collection read (totalSize > items) upserts what it saw but never member-tombstones;
  non-`haynesops` servers and non-movie/show sections are ignored.
- **API (packages/api, real routers)** — THE INVARIANT end-to-end: seed two movies in an accessible
  library + one in a withheld library, all members of one collection → the withheld member is
  excluded from BOTH the drill-in wall AND the group count; a collection whose only members are
  inaccessible is ABSENT from the listing; admin sees full accessible counts; covers cap at 4;
  the raw Plex child_count never leaks as the wire count.
- **Registry/client (apps/web unit)** — the domain⇄client view-model parity test stays green
  (defaults unchanged); the new grouped levels expose exactly label/count sorts and no facets.
- **Migration (packages/db)** — 0053 block: tables exist, the `(plex_library_id, rating_key)` /
  `(collection_id, rating_key)` uniques bite, FK cascades clean members with their collection and
  collections with their library, and `sync_runs.run_kind` admits `collections-sync`.
- **Classifier (packages/domain, pure — PLAN-053)** — one unit per bucket using REAL estate names
  (the Kometa config's outputs), plus ambiguous cases asserting honest `other` (a person name not
  in the seeded lists; a bare franchise name; "Anthology" not matching the n-ology rule).
- **Type facet (packages/api + packages/db + registry — PLAN-053)** — `ctype` filters the cards
  server-side; `typeCounts` respect the ADR-047 gate (an all-withheld collection counts for
  NOBODY restricted); migration 0055 block (default `'other'`, CHECK bites); the registry
  asymmetry test pins the grouped-collection levels to exactly the `collectionType` facet; the
  sync test proves the annotation persists and RECOMPUTES on retitle.
- **e2e** — see Q-03 (deferred honestly, not half-built).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Filter/hide specific mirrored collections (charts vs franchises), or per-collection display toggles? | DEFERRED by owner ruling R3 — mirror everything in v1; the knob is designed after the owner sees it live. |
| Q-02 | Does Plex's `collectionSort` order survive the `/children` member read? | UNVERIFIED (no live Plex from the build env; schema carries no order field). v1 stores response order but no read consumes it (D-07); verify live before any "Plex order" sort ships. |
| Q-03 | e2e smoke spec for the Collections view? | DEFERRED: the shared e2e seed keeps its ledger movies UNMATCHED (kind-home gating), and a collections journey needs `media_plex_matches` rows — which would grow "Watch on Plex" buttons on detail pages other specs assert against. The stub Plex serves a `/collections` fixture (the read path is stubbable); the seeded journey needs its own isolated seed pass — tracked in the plan file, not half-built here. |
