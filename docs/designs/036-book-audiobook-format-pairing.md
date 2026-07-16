# DESIGN-036: Book ⇄ audiobook format pairing — pair cache, paced system wants, dual consume buttons

- **Status:** Draft
- **Last updated:** 2026-07-16
- **Satisfies:** PRD-001 R-211..R-213; governed by ADR-065 (pairing model + system wants), ADR-046
  (mirror stays pure), ADR-055/057 (request ledger + wanted composition), ADR-054 (governor
  untouched), ADR-015 (reserved slots, recolor-not-reflow), hard rules 4/6.
- **Companions:** DESIGN-028 (request ledger + LL push), DESIGN-029 (wanted walls), DESIGN-025
  (the plex-match derived-cache sibling), DESIGN-033 (LL-id resolve fallback precedent).

## Overview

A new `books_format_pairs` derived cache persists which Kavita book row and ABS audiobook row are
the SAME title (conservative normalized title + author agreement — never a wrong pair). A new
`format-pairing` standalone sync mode rebuilds the cache from `books_items`, then mints PACED
system wants (`book_requests` rows with `origin='pairing'`, no user, no shelf) for unpaired items'
missing formats and pushes ONLY the missing format through the confined LazyLibrarian chain. The
detail page renders BOTH consume buttons when paired, and the missing format's honest affordance
when not; walls gain a format-coverage badge; the composed Wanted surfaces include the system wants
with a "Format pairing" attribution and a books-gated, audited force-search.

## Detailed design

### D-01 — Schema: `books_format_pairs` (migration 0054)

`id`; `book_item_id` FK → `books_items` (CASCADE) **UNIQUE**; `audio_item_id` FK → `books_items`
(CASCADE) **UNIQUE**; `matched_via` text CHECK (v1 value `title_author`); `first_seen_at` /
`last_seen_at`; `created_at` / `updated_at`. One row per declared pair, each side in at most one
pair. A rebuildable derived cache (the media_plex_matches class): written ONLY by the
`syncFormatPairs` single-writer, no per-row audit (documented exemption), joined to BOTH regex
families of the no-direct-state-writes guard.

### D-02 — Schema: `book_requests` system-want widening (migration 0054)

`integration_id` and `shelf_item_id` become NULLABLE (the shelf unique stands — Postgres uniques
admit multiple NULLs). New `origin` text NOT NULL DEFAULT `'goodreads'`, CHECK ∈
`('goodreads','pairing')`. New `pairing_books_item_id` FK → `books_items` (CASCADE) — the anchor
library item whose missing format the want fills. Coherence CHECK: `origin='goodreads'` ⇒
shelf+integration keys NOT NULL; `origin='pairing'` ⇒ `pairing_books_item_id` NOT NULL. PARTIAL
UNIQUE index on `pairing_books_item_id` WHERE NOT NULL — one open pairing want per (books_item,
format); the missing format is implied by the anchor's `media_kind` (ADR-065 C-03). On a pairing
want the held format is `landed`; only the missing format runs the lifecycle;
`comic_status`/`matched_books_item_id` stay NULL. `SYNC_RUN_KINDS` grows `format-pairing`
(run_kind CHECK rebuilt — the 0050 relax pattern).

### D-03 — The conservative matcher (kind-partitioned)

`matchFormatPairs(items)` — a PURE function over live, non-comic `books_items` projections:
partition by `media_kind` (`book` vs `audiobook`), index audiobooks by `normTitle`, then for each
book (deterministic order: `sortTitle`, then id) take the first unclaimed audiobook with the same
`normTitle` AND author agreement — both `normAuthor` values non-empty and one a substring of the
other. Null/empty author on either side ⇒ no pair. Greedy one-to-one (both sides UNIQUE in D-01).
`normTitle`/`normAuthor` are the EXISTING goodreads-match idioms, exported from
`book-requests.ts` — one normalizer, never a fork.

### D-04 — `syncFormatPairs` single-writer

Reads the live mirror, computes the fresh pair set (D-03), then in ONE transaction: deletes rows no
longer in the set (either side tombstoned, or the match no longer holds — the reconcile), inserts
new pairs, and advances `last_seen_at`/`updated_at` on survivors. Report:
`{ paired, added, dropped }`. Unaudited (derived cache, D-01).

### D-05 — `mintPairingWants` (paced, capped, honest)

Candidates = live non-comic `books_items` with no `books_format_pairs` row on their side. Work
order: fresh candidates (no pairing want yet) oldest-first (`first_seen_at`, id), then retryable
existing wants (unmintable `ll_book_id IS NULL`, or never-pushed `requested`) least-recently-tried
first (`updated_at` asc — the backoff-by-recency). At most **`PAIRING_MINT_CAP_PER_RUN`** (constant
25; env `PAIRING_MINT_CAP_PER_RUN`) attempts per run — each attempt spends budget (it may cost a GB
resolve + an LL push), so a failing run cannot burn the quota hunting. Per attempt:

1. Resolve `ll_book_id`: reuse a goodreads request's `llBookId` with the same
   `normTitle`+`normAuthor` when present, else `gb.resolveVolume({ title, author })`; null ⇒ the
   want row is upserted honestly UNMINTABLE (`ll_book_id` NULL) and retried on later runs.
2. Upsert the want (single-writer, tx): `origin='pairing'`, `pairing_books_item_id`, title/author
   snapshot, held format `landed`, missing format `requested`. Unaudited (the syncShelfRequests
   sync-mint class).
3. When resolvable: OUTSIDE the tx, push the confined chain for ONLY the missing format —
   `addBook → queueBook(missing) → searchBook(missing)` — behind the existing 250ms pacer, then
   `markPairingWantPushed` (missing format `requested → wanted`, never regressing). A push failure
   is logged; the want stays `requested` for the next run (the goodreads-sync retry discipline).

### D-06 — The `format-pairing` sync mode

A standalone mode (books-sync/plex-match class): no `--source`, writes NO `sync_runs` row; its
trail is `books_format_pairs` + the pairing `book_requests` rows. It fetches no external snapshot —
it derives from `books_items`, so it runs AFTER `books-sync` on its own CronJob tick. Sequence:
`syncFormatPairs` (D-04) → `mintPairingWants` (D-05) → reconcile every OPEN pushed pairing want
against ONE `getAllBookStatuses()` read via the EXISTING machinery (`mapLlStatus` →
`applyRequestReconcile`, positives never regress). LL and GB clients are OPTIONAL — absent LL ⇒
pair + mint only (no push); absent GB ⇒ reuse-only resolution. Orchestrator branch + report
(`formatPairing` / `formatPairingError`) + CLI `--mode=format-pairing`.

### D-07 — Reads widening (the system want made visible)

`getWantedBookRequests` + `getBookRequestDetail` LEFT-join `integration_shelf_items` /
`user_integrations` / `users` and admit rows where EITHER the goodreads linked-integration
condition holds OR `origin='pairing'`. Pairing rows surface `requestedBy: ['Format pairing']`,
shelf slug `pairing` (labelled "Format pairing"), `shelvedAt = created_at`, and
`integrationUserId: null` (no owner — ownership affordances are simply false). The wanted walls and
`wantedDetail` render them through the existing cards/rows unchanged. `getShelfWallItems` is
deliberately NOT widened: it is the per-integration personal shelf wall and a system want has no
shelf item — the composed Wanted walls + wanted-detail are the pairing want's surfaces
(ADR-065 C-04).

### D-08 — Search gating (`books.searchPairingWant`)

A new mutation on the books router, gated `booksProcedure` (`books ≥ read_only`,
server-authoritative): input `{ requestId }`; the request must exist (NOT_FOUND) and be
`origin='pairing'` (FORBIDDEN otherwise — goodreads wants keep `integrations.search` and its
ownership check untouched). It runs `runManualBookSearch` — the audited `recordManualSearch`
(`request_book_search`, actor = the caller) commits first, then the confined `searchBook` fires for
the not-yet-landed format (the held `landed` format narrows itself out). `wantedDetail` gains an
`origin` field so the client dispatches the right mutation; for pairing wants `canSearch` = the
caller's books section ≥ read_only.

### D-09 — Detail + wall UI

`BooksDetailResult` gains `pairing`:

- **Paired** ⇒ `pairing.pairedPlay` — the counterpart item's own deep link. The detail head renders
  BOTH consume buttons ("Read in Kavita" + "Listen on Audiobookshelf", each its own
  `deepLinkUrl`), primary style on the item's own app, secondary on the pair.
- **Unpaired** (book/audiobook only; comics carry no pairing block) ⇒ `pairing.missingFormat` +
  `pairing.want` (`requestId`, the missing format's status, `searchable`). The head keeps the
  active button and adds the missing format's affordance in a reserved slot: a link to the pairing
  want's wanted-detail when minted, plus a plain audited search button (the FormatSearchSlot
  reserved-slot idiom — button ⇄ PhaseChip in place, ADR-015 recolor-not-reflow) when actionable
  (`searchable`); an unminted/unmintable state shows the honest muted note ("No audiobook yet" /
  "No ebook yet").

`BookCard` wears a format-coverage `CardBadge` on the Books/Audiobooks walls: "Ebook + Audio"
(paired) / "Ebook only" / "Audio only" — computed per page by `books.search` from a bounded pair
lookup over the page's ids (`formatCoverage` on the wire); comics carry none. Copy tone across the
surfaces: no em-dashes, no personal names, semi-professional but friendly.

## Alternatives considered

Pair columns on `books_items` (rejected — ADR-046 mirror purity); read-time-only matching (rejected
— three surfaces re-deriving one truth); a synthetic system integration row (rejected — fake
ownership identity); widening `getShelfWallItems` (rejected — a personal shelf wall is the wrong
surface for an estate want); an uncapped backfill (rejected — owner ruling R1a).

## Test strategy

Domain: matcher unit tests (author agreement REQUIRED, null-author no-pair, subtitle/edition
variants pairing via normTitle, comic exclusion, substring-either-direction); `syncFormatPairs`
upsert + tombstone-reconcile; mint-cap (backlog N > cap mints exactly cap, deterministic order,
resumes next run), llBookId reuse-before-resolve, unresolvable ⇒ unmintable row retried later; the
LL push chain against the existing stub (missing-format-ONLY queue/search, one addBook); reconcile
rides mapLlStatus/advanceStatus; governor-untouched pinned by asserting the pairing path invokes
nothing on the confined surface beyond addBook/queueBook/searchBook. DB: migration 0054 CHECK block
(origin enum, coherence CHECK, partial unique, pair uniques, run-kind admit). API: wanted wall +
detail include `origin='pairing'` ("Format pairing" attribution); `books.searchPairingWant` gate
matrix (books read_only OK + audited; books disabled FORBIDDEN; goodreads-origin FORBIDDEN);
`books.detail` pairing states; `books.search` formatCoverage.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Should a long-unmintable want ever alert (an outbox digest of unresolvable titles)? | (open — observe the backfill first) |
| Q-02 | Identifier-backed matching (ISBN/ASIN columns on the mirror) to pair edition variants the conservative matcher skips. | (open — the known upgrade path, ADR-065 C-c) |
