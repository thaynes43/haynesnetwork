# ADR-065: Book ⇄ audiobook format pairing — a persisted pair cache + estate-wide system wants for the missing format

- **Status:** Accepted (owner green-lit PLAN-050 2026-07-16 morning; rulings R1 AUTO-MINT
  ESTATE-WIDE + R1a paced backfill are normative; Accept authority per plan-loop)
- **Date:** 2026-07-16
- **Deciders:** Tom Haynes (saga spec + rulings R1/R1a, 2026-07-16)
- **Builds on / refines:** ADR-046 (books_items pure mirror — STANDS, untouched), ADR-055
  (`book_requests` ledger + confined `@hnet/lazylibrarian/write`), ADR-057 (composed Library-Wanted
  + force-search dispatch), ADR-054 (MAM governor — structurally untouched, see C-08), ADR-062
  (LL-id resolve fallback precedent). Nothing is superseded.

## Context and problem statement

The library holds ~a thousand titles that exist in exactly ONE format: a Kavita ebook with no
audiobook, or an ABS audiobook with no ebook. The owner's spec (saga pt 5, near-verbatim): "attempt
a copy of EACH format per title; the one we lack is a Missing entry. Library items with both show
'Listen on Audiobookshelf' AND 'Read in Kavita'; otherwise one active button plus 'Search for …' on
the missing format."

Three gaps block this today (exploration fact sheet, 2026-07-16):

1. **No persisted cross-format link.** `books_items` has no natural cross-source key (no ISBN/ASIN
   anywhere — Kavita and ABS wire schemas carry none); the goodreads-sync `loadLibraryMatcher` is
   ephemeral and collapses kinds. The UI and any mint pass need ONE shared truth of which book row
   pairs with which audiobook row.
2. **A system want is not representable.** `book_requests` is keyed NOT NULL on
   `shelf_item_id`/`integration_id`, every Wanted read INNER-joins linked integrations, and the
   force-search gate is integration OWNERSHIP — a want minted by the estate itself (no user, no
   shelf) has no schema seat, no read visibility, and no searcher.
3. **An unpaced backfill would flood.** ~1000 missing-format wants pushed at once would bury
   LazyLibrarian/SABnzbd and hammer the Google Books quota.

## Decision drivers

1. NEVER a wrong pair — a false "we have both" or a mis-minted want is worse than an honest
   UNPAIRED state (Q-01 mitigation lean, now ruled).
2. Owner ruling **R1: AUTO-MINT ESTATE-WIDE** — every library title holding one format auto-mints a
   Missing want for the absent format (chosen over on-demand-only and over
   Goodreads-shelved-only).
3. Owner commitment **R1a: the backfill is PACED** — a per-run mint cap so LL/SAB digest the
   backlog over days; MAM stays entirely behind the PLAN-039 governor; comics are OUT of scope.
4. Reuse over invention: the normTitle/normAuthor idiom, the confined LL chain
   (addBook → queueBook → searchBook), the 250ms pacer, `mapLlStatus`/`advanceStatus`, the
   media_plex_matches derived-cache class, the standalone sync-mode pattern.
5. Honest failure states: an unresolvable Google Books identity fabricates nothing — the want
   stays visibly unmintable and is retried on later runs.

## Considered options

**Pairing representation:** columns on `books_items` (rejected — the mirror stays pure, ADR-046);
match at read time only (rejected — the mint pass and three UI surfaces would each re-derive the
truth and could disagree); **CHOSEN: a dedicated `books_format_pairs` derived-cache table** (the
media_plex_matches class — rebuildable, single-writer, no audit row).

**System-want representation:** a synthetic "system" user_integrations row (rejected — a fake user
identity pollutes ownership semantics and the integrations UI); a separate system_wants table
(rejected — duplicates the whole per-format status machine, reads, and force-search plumbing);
**CHOSEN: widen `book_requests`** with nullable keys + an `origin` discriminator — one ledger, one
status machine, one reconcile path.

**Mint trigger:** on-demand from the detail page only (rejected by owner ruling R1); unpaced full
backfill (rejected — R1a); **CHOSEN: estate-wide auto-mint, paced by a per-run cap**.

## Decision outcome

- **C-01 — Conservative matcher.** A pair is declared ONLY when a live Kavita `book` row and a live
  ABS `audiobook` row agree on normalized title (the existing `normTitle` idiom: lowercase, strip
  leading articles, cut at the first `:`/`(`, collapse non-alphanumerics) AND on author — a
  non-empty `normAuthor` substring match in either direction. A null/empty author on EITHER side ⇒
  no auto-pair. Comics never participate. NEVER a wrong pair: an ambiguous or author-less title
  stays honestly UNPAIRED. Kind-partitioned matching (books map vs audiobooks map) — the
  `loadLibraryMatcher` idiom, not a reuse of its kind-collapsing instance.
- **C-02 — `books_format_pairs` (migration 0054).** One row per declared pair:
  `book_item_id`/`audio_item_id` FK → `books_items` (CASCADE), each UNIQUE (a row is at most one
  pair per side), `matched_via` (v1: `title_author`), `first_seen_at`/`last_seen_at` + timestamps.
  A rebuildable derived cache written ONLY by the `@hnet/domain` `syncFormatPairs` single-writer
  (guard-listed); no per-row audit (the media_plex_matches exemption class). Reconcile: a pair
  whose either side tombstoned (or whose match no longer holds) is dropped.
- **C-03 — `book_requests` grows the system-want seat.** `shelf_item_id` and `integration_id`
  become NULLABLE; a new `origin` text discriminator (`'goodreads'` default | `'pairing'`) is
  CHECK-constrained; a new `pairing_books_item_id` FK → `books_items` (CASCADE) names the library
  item whose missing format the want fills. A coherence CHECK enforces origin↔keys (goodreads ⇒
  shelf+integration keys present; pairing ⇒ the pairing anchor present). A PARTIAL UNIQUE index on
  `pairing_books_item_id` (WHERE NOT NULL) enforces ONE open pairing want per (books_item, format)
  — the missing format is fully implied by the anchor's `media_kind` (a `book` anchor wants the
  audiobook; an `audiobook` anchor wants the ebook), so the item-scoped unique realizes the
  (item, format) rule exactly. On a pairing want the HELD format's status is `landed` (honest — it
  is in the library) and only the missing format runs the lifecycle.
- **C-04 — Wanted reads widen from inner-join to origin-aware.** `getWantedBookRequests` and
  `getBookRequestDetail` LEFT-join the integration tables and include `origin='pairing'` rows;
  attribution renders the label "Format pairing" in place of a requester name. The per-integration
  Goodreads items wall (`getShelfWallItems`) stays shelf-scoped by construction — a pairing want
  has no shelf item and does not (and should not) render on a user's personal shelf wall; the
  composed Library-Wanted walls + the wanted-detail page are the system want's surfaces.
- **C-05 — Books-gated, audited force-search for pairing wants.** A pairing want has no owner, so
  the ADR-057 ownership gate cannot apply. A new books-section-gated path (≥ `read_only`,
  server-authoritative) fires the manual search for `origin='pairing'` requests, audited via the
  existing `recordManualSearch` (`request_book_search`) — FORBIDDEN when the caller's `books`
  section is disabled, and FORBIDDEN for a goodreads-origin request (which keeps the existing
  `integrations.search` ownership semantics untouched).
- **C-06 — Estate-wide auto-mint, PACED (owner ruling R1/R1a verbatim: auto-mint estate-wide was
  chosen over on-demand).** Every run, unpaired live items lacking the other format mint wants
  oldest-first (deterministic order), capped at `PAIRING_MINT_CAP_PER_RUN` attempts per run
  (constant 25, env-tunable — `PAIRING_MINT_CAP_PER_RUN`). Each minted want pushes the confined LL
  chain for ONLY the missing format (addBook → queueBook(missing) → searchBook(missing)) behind the
  existing 250ms pacer. The backlog drains over days by design.
- **C-07 — GB volume resolution, honest when it fails.** The LL identity (`ll_book_id`) resolves by
  (1) reusing an existing goodreads request's `llBookId` for the same normalized title/author when
  present, else (2) `gb.resolveVolume({ title, author })`. Unresolvable ⇒ the want persists in an
  honest `unmintable` state (row present, `ll_book_id` NULL, nothing fabricated, not searchable)
  and is retried on later runs with backoff-by-recency (least-recently-attempted first, behind
  fresh mints). Status reconcile of pushed pairing wants rides the existing machinery
  (`getAllBookStatuses` → `mapLlStatus` → `applyRequestReconcile`, never regressing a positive).
- **C-08 — Comics OUT; the MAM governor structurally untouched.** No Kavita-comic ⇄ audio pairing
  (R1a). The pairing path pushes ONLY `addBook`/`queueBook`/`searchBook` on the confined
  `@hnet/lazylibrarian/write` surface, which "NEVER touches LL provider config" by its own contract
  (fact sheet §3/§5: the governor sits at the Prowlarr seam; usenet-first via LL dlpriority; no
  provider-config call exists on the pairing path) — proven structurally, and pinned by a test that
  asserts the pairing path calls nothing beyond those three writes.

### Consequences

| ID | Consequence |
|----|-------------|
| C-a | Good: paired titles finally render both consume buttons from ONE persisted truth; the mint pass and the UI cannot disagree. |
| C-b | Good: no new external write surface, no new gate machinery — the system want rides the existing ledger, statuses, reconcile, and audit verbatim. |
| C-c | Bad/accepted: normalized title+author matching misses edition/subtitle variants and translated authors — those titles stay UNPAIRED and may mint a want for a format the estate arguably holds. Conservative by ruling; an identifier-backed match (ISBN/ASIN columns on the mirror) is the known upgrade path. |
| C-d | Bad/accepted: the paced backfill takes days for ~1000 titles (25/run) — deliberate (R1a); the cap is env-tunable when the owner wants it faster. |
| C-e | Neutral: a pairing want whose format lands becomes a pair on the next runs (books-sync ingests the new item → syncFormatPairs pairs it); the want's statuses reconcile to landed via LL — no bespoke completion step. |
| C-f | Neutral: GB quota exposure is bounded by the mint cap (≤ cap resolve calls per run) and reuse-before-resolve. |

## More information

PRD R-211..R-213 (authored with this ADR). Glossary T-183..T-185 (Format Pair, Pairing Want,
Format Coverage). Realized by DESIGN-036; PLAN-050. Owner rulings recorded in
`.agents/plans/050-book-audiobook-pairing.md` (R1, R1a). Fact sheet: PLAN-050 exploration
(2026-07-16) — locations/signatures verified against v0.62.1.
