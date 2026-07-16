# ADR-064: Mirrored Plex collections read-model (external software is always the collections source of truth)

- **Status:** Accepted <!-- owner scoped + green-lit 2026-07-16; docs-first in the PLAN-037 build branch (owner-granted authority) -->
- **Date:** 2026-07-16
- **Deciders:** Tom Haynes (owner rulings R1–R4, PLAN-037 scoping 2026-07-16) · ratified by Fable 5 (PLAN-037 docs+build)
- **Relates:** EXTENDS CLAUDE.md **hard rule 4** ("the *arrs are the source of truth") to collections;
  builds on [ADR-047](047-library-play-here-access-aware-deep-links.md) (`media_plex_matches` + THE
  INVARIANT access gate), [ADR-051](051-library-views-and-sort-filter-registries.md) (the view/registry
  seam this surface plugs into — C-01 "a registry-row edit, never a new component"),
  [ADR-052](052-per-user-library-preferences.md) (view persistence), and
  [ADR-017](017-plex-library-sharing.md)/[ADR-024](024-role-scoped-all-libraries.md)
  (the `plex_libraries` registry + effective-library resolver). Realized by **DESIGN-035**. Implements
  PRD **R-208..R-210**; glossary **T-179..T-182**.

## Context and problem statement

The owner curates **Plex collections** on the HOps server — Kometa-maintained chart collections
(IMDb Top 250, Trakt Trending, seasonal overlays) plus franchise collections — and wants to browse
them inside the app's Movies/TV walls. PLAN-029 shipped the view engine (selectable views, grouped
aggregate cards, per-view sort/filter registries), and its intake deliberately parked collections
(PLAN-037) with an open question: are collections **mirrored** from Plex/Kometa, **app-native**
(orderable `collection_items` with reading-order semantics, the book-series flagship), or both, with
some precedence rule when the two disagree?

The app has no collections store today. The nearest neighbors are:

- `media_metadata.source_collections` — a **Kometa metadata facet** harvested per item (migration
  0012; the ledger walls' "Collection" filter chip). It is a flat per-item label list, not a browsable
  entity: no identity, no membership order, no card, no count.
- `media_plex_matches` (ADR-047) — the rebuildable *arr→Plex match cache keyed
  `(media_item, plex_library, rating_key)`. It is exactly the join that turns a Plex collection's
  member ratingKeys back into gated ledger items.

## Decision drivers

- **The owner doctrine (R1 — normative, permanent):** *"We should always use external software as the
  source of truth for collections and just sync with that here — even when we do books, we build a
  tool first, then sync."* (owner, 2026-07-16). The app **mirrors** collections; it never authors
  them. App-native collections are out of this plan AND out of the roadmap; the future book-list
  case gets an external tool first, then the same mirror treatment. This extends hard rule 4's
  posture (external systems of record; the app is a synced copy) to collections.
- **R2:** the surface is a **"Collections" group-by VIEW inside the Movies/TV kind tabs** via the
  PLAN-029 view engine — no new top-level nav, no new component class (ADR-051 C-01).
- **R3:** mirror **everything** visible on the source server — Kometa charts included. Filtering or
  hiding specific collections is a later knob, added once the owner sees the mirror live.
- **R4:** **HOps Plex only** for v1 (slug `haynesops`) — it is where collections and poster overlays
  are maintained today.
- THE INVARIANT (ADR-047) is non-negotiable: a collection read must never leak an item — or even a
  member **count** — from a Plex library the caller's role cannot access.
- Sync conventions are settled: standalone modes (no `sync_runs` row), fetcher/domain split,
  upsert + scoped reconcile, guard-listed single-writer tables.

## Considered options

1. **Mirror-only: new `plex_collections` + `plex_collection_members` tables synced from Plex, read
   through the existing view engine** (chosen). A `collections-sync` mode reads each HOps movie/show
   section's `/collections` and each collection's members, and a domain single-writer upserts the
   snapshot. Reads join members → `media_plex_matches` → `media_items` under the ADR-047 gate.
2. **App-native collections (`collections` + ordered `collection_items`) with authoring UI.**
   Rejected by R1 — permanently, not deferred: the owner rules that collection curation always lives
   in external software (Plex/Kometa today; an external book-list tool later), and the app only syncs.
3. **Reuse the `media_metadata.source_collections` facet as the collections surface.** Rejected: it
   is a different concept — a per-item Kometa metadata label with no entity identity, no membership
   list, no counts, no non-ledger members, and no way to honor "mirror everything". It stays exactly
   as it is (the ledger Collection filter chip); this ADR touches it not at all.
4. **Live Plex reads at render time (no mirror tables).** Rejected: the group listing needs an
   accessible-member COUNT per collection under the access gate — a per-render fan-out of
   N-collections × members against Plex, re-joined to the ledger, on every wall load. The mirror is
   the established shape for exactly this (books_items / media_plex_matches class), and the drill-in
   must compose with `ledger.search`'s SQL predicates, which a live read cannot.

## Decision outcome

Chosen option: **1 — mirror-only**, because it is the owner's ruling (R1) and it rides every settled
rail: the plex-match sync idiom, the ADR-047 gate, and the ADR-051 registry seam.

- **Two new tables** (DESIGN-035 D-01): `plex_collections` (one row per `(plex_library, rating_key)`
  collection) and `plex_collection_members` (one row per `(collection, member rating_key)`, with the
  source order). Membership is stored **raw** — a member with no ledger match (a chart entry the
  *arrs don't carry) is still mirrored (R3); the ledger join happens at read time.
- **A `collections-sync` standalone mode** (DESIGN-035 D-02): fetcher restricted to slug `haynesops`
  and section types `movie|show` (R4), paging `/library/sections/{key}/collections`; members via the
  existing children read. The domain single-writer `syncPlexCollections` upserts and reconcile-deletes
  with the plex-match scoping discipline (a partially-read section/collection never tombstones).
- **Read model + drill-in** (DESIGN-035 D-03/D-04): a collections group listing for the Movies/TV
  walls (accessible-member counts + a bounded member-poster fan), and a `?group=<ratingKey>` drill-in
  that adds one EXISTS predicate to `ledger.search` — so the drilled wall inherits every existing
  filter, sort, and the access gate unchanged.
- **Registry-row surface** (DESIGN-035 D-05): `WALL_VIEWS.movies`/`WALL_VIEWS.tv` gain a `grouped`
  offer with a `collection` grouping dimension. Wall DEFAULTS are unchanged (flat/hierarchy);
  Collections is opt-in per view selector / URL. TV's Shows → Seasons → Episodes drill is untouched.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the owner doctrine is structural — there is NO app-side collection write surface (no create/rename/reorder), so the mirror can never drift from Plex/Kometa by app action. Future book lists follow the same shape: external tool first, then a sync (R1 extends hard rule 4). |
| C-02 | Good: the two tables are a **rebuildable derived cache** (the `media_plex_matches` exemption class): Plex is the source of truth, a re-run rebuilds them from scratch, so the single-writer appends **no audit/ledger rows** (the documented no-audit exemption). Both tables are guard-listed in both regex families of the no-direct-state-writes guard. |
| C-03 | Good: THE INVARIANT holds by construction — the group listing counts only members that join through `media_plex_matches` into libraries the caller can access, a collection with zero accessible ledger-matched members is absent from the listing, and the drill-in is a predicate INSIDE the already-gated `ledger.search`. Raw Plex `child_count` is stored for diagnostics but never shown as the member count. |
| C-04 | Neutral/accepted (R3): charts and seasonal Kometa collections mirror too — the wall may show many collections. Filtering/hiding specific collections is a deliberately deferred knob (owner wants to see it live first); v1 ships mirror-everything. |
| C-05 | Neutral (R4): v1 scope is the `haynesops` server only. The schema is server-agnostic (keyed by `plex_library_id`), so widening later is a fetcher-restriction change, not a migration. |
| C-06 | Cost/accepted: mirrored membership includes ratingKeys with no ledger item (charts referencing titles the *arrs don't manage). They are stored (R3) but invisible in v1 reads — the walls are ledger walls. Surfacing non-ledger members would be a live-Plex wall, a separate decision. |
| C-07 | Neutral: `media_metadata.source_collections` (the Kometa per-item facet + its Collection filter chip) is a DIFFERENT concept and is left untouched. The two may name overlapping sets; the facet filters items by label, the mirror browses collection entities. |

## More information

- Realized by **DESIGN-035** (schema D-01, sync D-02, read model D-03, drill-in D-04, registry seam
  D-05, URL contract D-06, ordering honesty D-07, membership bound D-08).
- Owner rulings recorded in `.agents/plans/037-collections.md` (R1–R4, 2026-07-16).
- Numbering: migration **0053**; glossary **T-179..T-182**; PRD **R-208..R-210**.
