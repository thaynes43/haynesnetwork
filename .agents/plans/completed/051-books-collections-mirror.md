# PLAN-051: Books collections mirror (Kavita + Audiobookshelf)

- **Status:** Completed (v0.68.0, 2026-07-16 eve — feat #332, release #336, haynes-ops #2077; LIVE: first sync mirrored 7 collections / 12 members from real Kavita+ABS, all families scoped, CronJob :27). Was: BUILT (2026-07-16, `feat/plan-051-books-collections` — docs ADR-066 / DESIGN-038 /
  PRD R-215..R-217 / glossary T-187..T-190; migration 0056; the `books-collections-sync` mode;
  `books.collectionGroups` + the `collection` drill + `position` sort; the Collections sibling
  dimension + six registry levels on the three book walls. Five-green local gate on the branch.)
- **Depends on:** 037 (mirror pattern, group-by seam, gating discipline). Relates: 050 (format
  pairing feeds series/format coverage), 043 (the future books app WRITES the collections this
  plan displays).

## Scope

Mirror the collections that already exist in the book sources of truth, exactly the way
PLAN-037 mirrors Plex collections (the owner's mirrored-only doctrine — ADR-064):

1. **Kavita Collections** (and Reading Lists if the API shape cooperates — reading ORDER
   matters for series) → the Books + Comics walls.
2. **Audiobookshelf collections** → the Audiobooks wall.
3. Surface as the same "Collections" group-by view dimension the 037 registry rows added for
   Movies/TV — group cards with accessible counts, drill-in walls, no new nav.
4. Sync: a standalone mode in the 037 idiom (upsert + scoped reconcile; rebuildable derived
   cache; guard-listed; no audit rows).

**The quick win this unlocks:** a hand-curated collection in Kavita ("Harry Potter
Collection") appears on the site on the next sync — no waiting for the books app. When the
PLAN-043 books app later writes collections into Kavita/ABS programmatically, this mirror
displays them with ZERO site changes.

## Open questions

- Q-01: Kavita Reading Lists vs Collections — RESOLVED IN BUILD (2026-07-16): BOTH mirror.
  Kavita collections are UNORDERED (`ordered=false` — their drill offers no position sort);
  reading lists carry explicit positions and mirror as ORDERED collections (chapter-grain items
  deduped to series grain at the earliest order — ADR-066 C-05); ABS collections are ORDERED
  (verified `collectionBook.order ASC` in the 2.35.1 source). Ordered drills default to the
  "List order" position sort (DESIGN-038 D-06).
- Q-02: cross-source collection identity — RESOLVED lean-v1 (ADR-066 C-04): two honest
  source-scoped collections; a PLAN-050 pairing-data merge is a later knob (after the owner
  sees the mirror live).

## Built (2026-07-16) — the 037 vertical, books-flavored

- **Docs:** ADR-066 (Accepted), DESIGN-038 (D-01..D-10), PRD R-215..R-217, glossary T-187..T-190.
- **Wire shapes VERIFIED** against the deployed versions' tagged sources (Kavita v0.9.0.2, ABS
  v2.35.1) + live in-cluster route probes: Kavita `GET /api/Collection`, all-v2 CollectionTags
  filter (field 7 — the shipped library-filter idiom), `POST /api/ReadingList/lists`
  (POST-with-query-pagination; GET 404s), `GET /api/ReadingList/items`; ABS `GET /api/collections`
  (books[] = collectionBook.order ASC). No creds in the build env, so live AUTHED shape validation
  waits for the first staging run (DESIGN-038 Q-03 — strip-mode zod + fixtures mitigate).
- **DB:** migration 0056 (`books_collections` UNIQUE(source, external_id, kind) + ordered/
  item_count/library_id; `books_collection_members` UNIQUE(collection_id, external_ref) + nullable
  resolved `books_item_id` ON DELETE SET NULL + position; run-kind CHECK rebuilt — 19 kinds).
- **Sync:** `books-collections-sync` (standalone, no sync_runs row, rides the books-sync bundle,
  runs AFTER books-sync) — fetcher with `(source, kind)` family scoping + per-collection fullyRead;
  domain `syncBooksCollections` single-writer (guard-listed in all six regex families).
- **API:** `books.collectionGroups` (wall-mapping MAJORITY rule, wall-kind counts, ≤4 cover fan,
  ordered flag; books-gated) + `books.search` `collection` EXISTS predicate + `position` sort
  (schema-refused without a collection).
- **Web:** Collections as a SIBLING dimension on books/audiobooks/comics (defaults untouched;
  Comics gains the selector without a flat shape); six new ViewLevelKeys; ordered-gated position
  sort in the drill (transient — stored wall sort never overrides the drill default).
- **Adversarial-review fix (MEDIUM, landed on the branch):** a missing/malformed Kavita
  `Pagination` header used to fall back to the PAGE length as the total — a FULL first page would
  have "proved" completion and let the reconcile delete the unseen tail. The client now reports
  `hasAuthoritativeTotal`; the books-collections-sync paged loops treat a FULL page without an
  authoritative total as TRUNCATED (member read ⇒ un-fullyRead; reading-list LISTING ⇒ family not
  scoped) while a SHORT header-less page stays honest completion. Unit-covered both ways on both
  loops + at the client.
- **FOLLOW-UP (do not forget):** `packages/sync/src/books.ts` (the PLAN-023 books-sync fetcher)
  has the SAME latent exposure — its `listSeriesPage`/`listItemsPage` loops terminate on a
  fallback total, so a header-less full first page would mark the source fully synced and
  TOMBSTONE the tail. `listSeriesPage` now carries `hasAuthoritativeTotal` (unused there); wire it
  into the books-sync loop in its own change (deliberately NOT touched on this branch — reviewer
  scoping).
- **Deferred honestly:** the dedicated e2e journey SPEC (DESIGN-038 Q-01 — the stub collection
  fixtures + the harness `books-collections-sync` seed DID land, so the spec is a cheap follow-up);
  haynes-ops CronJob (books-collections-sync after books-sync) lands with the release PR, like
  every sync mode.
