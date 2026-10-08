# DESIGN-036: Book ⇄ audiobook format pairing — pair cache, paced system wants, dual consume buttons

- **Status:** Draft
- **Last updated:** 2026-10-08 (issue #825: verified individual-work coverage, persistent uncertain counterparts and guarded identity transitions). Prior: 2026-10-07 (a Mint Backoff ends at the same-hour run however its start jitters; the mint waits out one per-minute quota window, owed check OC-014). Prior: 2026-10-06 (the pairing writers record a Request Event, issue #741, ADR-101). Prior: 2026-10-06 (the missing format's `grabbed` follows LazyLibrarian, and a given-up want releases its LazyLibrarian book, issues #734 and #735; see the last amendment). Prior: 2026-10-05 (a want on a non-English LazyLibrarian book asks for the English edition, issue #719). Prior: 2026-10-05 (a `foreign_language` park lifts when the anchor's language turns English, issue #712;
  see the last amendment). Prior: 2026-10-05 (a want is checked against its anchor's book, issue #693; see the
  amendment of that date). Prior: 2026-07-21 (**author-agreement tolerance** — the live pairing-gap diagnosis found the
  substring check refusing real pairs on initials spacing ("JRR Tolkien" ⇄ "J.R.R. Tolkien"),
  initials-to-full-name ("L.M." ⇄ "Lucy Maud"), middle-name insertion ("Dean Koontz" ⇄ "Dean Ray
  Koontz"), and leading co-author credits. `authorsAgree` now ALSO accepts an ordered token
  alignment (subsequence, equality-or-prefix per token, requiring one aligned REAL-word anchor ≥ 3
  chars on both sides). Full noise-stripped TITLE equality remains the primary gate — Homer's
  "Odyssey" still never pairs with Walter Mosley's — so ADR-065 C-01's conservatism bar is
  unchanged. Prior: 2026-07-20 (ADR-075 — the pair cache becomes the unified Books wall's COLLAPSE join +
  Format-facet source; standalone pairing-want tiles retire on the wall (the anchor card's coverage badge
  carries the missing-format want state); Q-02 now also improves card collapse. See the Amendment at the
  end. Prior: 2026-07-16)
- **Satisfies:** PRD-001 R-211..R-213 (+ **R-231** via ADR-075 — the pair cache powers the unified Books
  wall's collapse + Format facet, the 2026-07-20 amendment); governed by ADR-065 (pairing model + system
  wants), ADR-046 (mirror stays pure), ADR-055/057 (request ledger + wanted composition), ADR-054 (governor
  untouched), ADR-015 (reserved slots, recolor-not-reflow), **ADR-075** (unified Books wall), hard rules 4/6.
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
UNIQUE index on `pairing_books_item_id` WHERE NOT NULL — ONE pairing want per anchor item for its
LIFETIME (the missing format is implied by the anchor's `media_kind`), self-healing on re-vanish
via the D-04 reconcile (ADR-065 C-03). On a pairing
want the held format is `landed`; only the missing format runs the lifecycle;
`comic_status`/`matched_books_item_id` stay NULL. `SYNC_RUN_KINDS` grows `format-pairing`
(run_kind CHECK rebuilt — the 0050 relax pattern).

### D-03 — The conservative matcher (kind-partitioned; review-hardened 2026-07-16)

`matchFormatPairs(items)` — a PURE function over live, non-comic `books_items` projections:
partition by `media_kind` (`book` vs `audiobook`), index audiobooks by the PAIRING TITLE KEY
(`pairingTitleKey`), then for each book (deterministic order: `sortTitle`, then id) take the first
unclaimed audiobook with the IDENTICAL key AND author agreement — both `normAuthor` values
non-empty and one a substring of the other. Null/empty author on either side ⇒ no pair. Greedy
one-to-one (both sides UNIQUE in D-01).

The pairing key is deliberately NOT the goodreads `normTitle` (its cut at the first `:`/`(` would
collapse distinct franchise works — "Star Wars: Heir to the Empire" vs "Star Wars: Thrawn"): it
keeps the FULL title, lowercases, collapses non-alphanumerics to single spaces, drops ONLY the
edition-noise tokens {a, an, the, novel, unabridged, abridged, edition}, and the matcher requires
full equality of the remaining token sequence. "Project Hail Mary: A Novel" ⇄ "Project Hail Mary
(Unabridged)" pair; a bare "Dune" vs "Dune: Book One of the Dune Chronicles" honestly does not
(the conservative miss; Q-02 is the upgrade path). The goodreads want→library matcher keeps its
own `normTitle` untouched; `normAuthor` stays the shared author normalizer.

### D-04 — `syncFormatPairs` single-writer

Reads the live mirror, computes the fresh pair set (D-03), then in ONE transaction: deletes rows no
longer in the set (either side tombstoned, or the match no longer holds — the reconcile), inserts
new pairs, and advances `last_seen_at`/`updated_at` on survivors. The SAME transaction runs the
RE-VANISH self-heal: a pairing want whose anchor is live, non-comic, and UNPAIRED again while its
missing-format status reads `landed` (the both-landed inert state left behind when the pair stood)
has that missing format reset to `requested` — the want re-enters the D-05 retry queue and the
estate keeps wanting the vanished format. Report: `{ paired, added, dropped, revived }`. Unaudited
(derived cache, D-01).

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

Domain: matcher unit tests (author agreement REQUIRED, null-author no-pair, edition-noise variants
pairing via pairingTitleKey, franchise subtitles NOT collapsing, bare-stem vs subtitled edition NOT
pairing, comic exclusion, substring-either-direction); `syncFormatPairs` upsert +
tombstone-reconcile + the re-vanish reset (pair forms → want lands → side tombstones → requested
again → re-mints under the cap); mint-cap (backlog N > cap mints exactly cap, deterministic order,
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
| Q-02 | Identifier-backed matching (ISBN/ASIN columns on the mirror) to pair edition variants the conservative matcher skips. | (open — the known upgrade path, ADR-065 C-c; **2026-07-20 (ADR-075): now ALSO improves the unified Books wall's CARD COLLAPSE, not just the coverage badge — a true pair the conservative matcher misses renders as TWO cards until identifiers land**) |

## Amendment — 2026-07-20 (ADR-075 — the pair cache powers the unified Books wall)

ADR-075 unifies the Books and Audiobooks walls into ONE Books wall with format as a facet, and it makes the
`books_format_pairs` cache do DOUBLE DUTY. Nothing in D-01..D-06 changes (same schema, matcher, writer,
mint, mode); the CONSUMERS grow:

- **The pair cache is the wall's COLLAPSE join (C-02).** `books.search`, now work-grain over
  `media_kind ∈ {book, audiobook}` (DESIGN-024 D-04 amendment), LEFT-JOINs `books_format_pairs` and
  collapses a paired (book, audio) duo to ONE card anchored on the **ebook row** (unpaired audio-only
  anchors on itself — the anchor rule is TOTAL, PLAN-060 E-2). The same ONE truth the detail buttons (D-09)
  and the mint pass (D-05) read now also decides which rows merge into one card. Divergent pair metadata
  (E-3): facets match on the UNION, display uses the anchor's values.
- **The pair cache is the Format-facet source (C-03).** The three-state Format seg (All · Ebook ·
  Audiobook) reads coverage from the same cache: "Ebook" = works holding an ebook (paired + ebook-only),
  "Audiobook" = works holding audio. This generalizes the D-09 `formatCoverage` badge from a per-card badge
  to the wall's facet predicate.
- **Standalone pairing-want tiles RETIRE on the wall (C-05).** On the unified wall a pairing want's anchor
  work ALREADY renders as a library card, so the D-07 composition no longer emits a standalone tile for it
  — the anchor card's **coverage badge carries the missing-format want state** (wanted / in-flight). The
  detail page keeps the pairing-want deep link + per-format force-search (D-08, unchanged); Goodreads-origin
  wants (no library anchor) keep their Wanted tiles (D-07 unchanged for them). `getWantedBookRequests` is
  unchanged; the WALL's composition layer is where the standalone pairing tile drops.
- **Q-02 gains a second payoff.** Identifier-backed matching (ISBN/ASIN — the ADR-065 C-c upgrade path) now
  improves not only badge accuracy but the **card collapse itself**: a true pair the conservative matcher
  misses renders as TWO cards on the unified wall until identifiers land (ADR-075 C-08 — the same honesty
  the split walls had). Still open; still the upgrade path.

See DESIGN-024 D-04 (work-grain search) + DESIGN-026 (the merged registry) + PRD R-231/R-213/R-211.

## Amendment — 2026-09-22 (the LL push guard) — the pairing pushes are guarded, and the sweep is documented

**Normative rule: DESIGN-028's 2026-09-22 amendment.** Both LazyLibrarian writes on this path now
consult `llFormatAlreadyHeld` first and are suppressed when LL already holds the want's MISSING format:

1. **D-05's mint push.** A pairing candidate whose missing format LL already holds is already satisfied
   on LL's side; pushing would only `UPDATE books SET Status='Wanted'` over an imported book. The want
   is still minted/refreshed (a real attempt, the cap is consumed), the chain is withheld, and the
   run's own reconcile settles the want to `landed` from LL's status. Counted as
   `MintPairingWantsReport.skippedHeld`.
2. **The pairing `Skipped` sweep** — which until now existed only in code (`runFormatPairing`, mirroring
   DESIGN-028's 2026-07-15 amendment) and was **undocumented here**. Recorded now: the sweep re-queues +
   re-searches the missing format when LL reports it raw-`Skipped`, and since this amendment it does NOT
   fire when that `Skipped` row nevertheless carries a library date or an on-disk path (39 such rows
   existed on 2026-09-22 — `Skipped` is not proof LL lacks the file). Counted into the run report's
   `skippedHeld`, which on `FormatPairingReport` is widened to the RUN TOTAL (mint push + sweep).

**No extra LL reads.** The predicate is derived from the ONE `getAllBookStatuses` this run already takes
for DESIGN-039 D-18's `addBook` seat gate and the status reconcile — one read, three consumers. If that
read fails, `llHoldsFormat` is absent and the guard suppresses nothing, exactly as D-18's gate degrades.

**ADR-065 C-08 is intact.** The guard only ever withholds one of the three sanctioned acquisition
writes; it adds no new surface. The C-08 governor pin (every write-surface property the run touches is
one of `addBook`/`queueBook`/`searchBook`) still passes unchanged.

## Amendment — 2026-10-03: one `searchBook` per book (issue #644)

LazyLibrarian's `searchBook` ignores `type` and searches every `Wanted` format of the book (DESIGN-028's
2026-10-03 amendment). The pairing push is single-format, but its `llBookId` is routinely **reused from a
goodreads shelf request**, and `format-pairing` is its own cron job, so the same book could be
searched here minutes after goodreads-sync or the collection force-search searched it.

The mint push and the Skipped sweep now ask `shouldSearch(llBookId, format)` before `searchBook`: false when
the book was already searched this run (a shared per-format map across the mint and the sweep), or when any request row
for it has a `last_searched_at` within the hour **and** the pre-run `getAllBooks` snapshot already shows the
missing format as `Wanted` (the recent search covered it). A format the push is flipping from `Requested` is
always searched. `queueBook` is unchanged. Every search the pairing leg fires stamps `last_searched_at` on
its want, which is the signal the other jobs read. Normative detail: DESIGN-028's follow-up of the same date.

## Amendment — 2026-10-03: a parked pairing want stays parked

DESIGN-028's omnibus amendment repairs a want whose resolve landed on a bundle by parking it
(`unroutable_reason='wrong_volume'`, `ll_book_id` cleared) and setting the bundle's format `Skipped` in
LazyLibrarian. The collection force-search and `isRequestSearchable` already honored the park, but this leg did
not read `unroutable_reason` at all: the mint re-resolved the cleared id (it looked like an unmintable want),
and once an id was back the Skipped sweep re-queued and re-searched the format the repair had just skipped.

Both now skip a parked want. The mint never makes it a candidate (no Google Books call, no upsert, so its
`updated_at` stays put), and the reconcile + Skipped sweep leave it out. A park is lifted only by clearing
`unroutable_reason` by hand, after which the want is an ordinary unmintable or pushed want again.

## Amendment — 2026-10-04: the anchor is the book held (issue #661)

**The defect.** A Kavita `books_items` row is a series, and its `title` is the series name. The matcher (D-03)
and the mint (D-05) keyed a Kavita anchor on that title, so a one-book series asked Google Books for its series
name and got the box set: "A Song of Ice and Fire" (holding Fire & Blood) resolved to the GRRM audiobook bundle,
"Hogwarts Library Books" (The Tales of Beedle the Bard) to the Hogwarts Library box set, "Tom Clancy NF" (SSN)
to Jack Ryan Books 7-12. The same key paired a series with an audiobook named like the series: "Dune" holding
Heretics of Dune paired with the Dune audiobook, "Twilight" holding Breaking Dawn with Twilight. The 2026-10-03
bundle audit parked eight such wants (`.agents/context/2026-10-03-bundle-audit.md`).

**The held book.** DESIGN-024's D-03 amendment of the same date mirrors what each Kavita book series holds:
`attrs.heldBooks`, one entry per chapter (one book file) with its own title, first writer and ISBN.
`pairingIdentity(item)` turns that into the anchor's identity, the one truth the matcher and the mint read:

- **`one`**: an ABS audiobook (its own title), or a Kavita series holding exactly one book. That book's title
  is cleaned of series decoration (`stripSeriesDecoration`: a leading `<series> <number>` such as
  "Tom Clancy NF [08] - SSN", a trailing bracket naming the series such as "(The History of Middle-Earth,
  Vol. 3)") and of an author credit joined by a spaced dash (`stripAuthorDecoration`: "Dead in the Family -
  Charlaine Harris"). The author is the held book's writer, else the row's author. The ISBN is
  the book's. Duplicate files require the same full title and agreeing known authors, or the same normalized
  ISBN; conflicting known authors never collapse, even with the same ISBN. Same-title copies without that
  proof remain distinct books. A missing or empty held title is `unknown`, unless a proven duplicate supplies
  the actual title; the series name never supplies a guessed book title.
- **`multi_book`** (several books) and **`no_book`** (no book file): one want per anchor (D-02's partial
  unique) cannot describe them. Per-book wants would need a schema change and are not built.
- **`unknown`**: the row has not been read for its held books yet (the first books-sync after the deploy
  reads every series once). The series name is never used as a guess.

**D-03 (the matcher, amended 2026-10-07).** Only a `one` Kavita series can pair, keyed on its held book's title
and author. `multi_book`, `no_book` and `unknown` rows pair nothing; matching their series name would guess a
book identity. A series whose row title already names its held
book claims an audiobook before a series that matches only through its held book, so two series holding the
same file keep the pair they had. Measured against the live mirror before merge: 628 pairs become 659 (36
added, such as Bobiverse with Heaven's River and Heroes of Olympus with The House of Hades; 5 series-name
pairs drop, such as Dune with Dune; 2 move to the right audiobook, such as Destination: Void to The Jesus
Incident). A dropped pair revives its want (D-04), which then asks for the held book.

**D-05 (the mint).** The want's title/author snapshot, the reuse lookup and the Google Books resolve (title,
author and ISBN, so the `isbn:` leg fires first) all use the identity, never the series name. The DESIGN-039
D-22 ISBN-first order reads the identity's ISBN. A `multi_book` or `no_book` anchor is never a candidate: a
fresh one is not minted (`skippedNotOneBook`), and an existing want LazyLibrarian is not working yet
(`ll_book_id` NULL, or the missing format `requested`) is parked with `unroutable_reason` set to the kind
(`parkPairingWant`: single writer, one statement whose precondition is unparked and unpushed). A pushed want is
left alone: LazyLibrarian already has a book for it, and its current queued format remains protected. Its
reconcile and acquisition wait for a known one-book identity. An `unknown`
anchor is skipped with nothing written (`skippedUnknownHeld`). None of these is an attempt, so none spends the
cap.

**Lifting a park.** A want that had no `ll_book_id` and gets one on this attempt has never been pushed under
it, so a missing-format status other than `landed` or `requested` is left over from the id that was cleared
(the bundle a repair parked it from). The upsert resets it to `requested` and the attempt pushes the chain.
Lifting a park is therefore only clearing `unroutable_reason`; before this, the want took the new id and was
never pushed, because the push requires `requested`.

**D-04 (the re-vanish) fires only for a pair that dropped in this run**, as D-04 always said. It fired for
every unpaired anchor whose want read `landed`, and the reconcile lands a want from LazyLibrarian's own status
with no pair at all (the 2026-09-22 push guard made that common). On 2026-10-04 it reset 312 wants a run;
the mint then spent its whole cap of 100 on them (each one skipped as held) and pushed nothing. A dropped
pair whose anchor is `multi_book` or `no_book` revives nothing. The heal is one-shot by design: a pair that
drops while its want's missing format is still in flight is not healed in a later run when that format
lands. Accepted (PR #664 review): a pairing want's missing format lands because LazyLibrarian imported it,
so a revived want would only be withheld again by the push guard (DESIGN-028's 2026-09-22 amendment), and
a persisted "dropped" marker would buy nothing.

Unchanged: the omnibus guard in the Google Books resolve (DESIGN-028's 2026-10-03 amendment, #658) stays the
second line; a parked want stays parked (the 2026-10-03 amendment above); the confined LazyLibrarian surface
(C-08). Wants pushed before this change keep the identity they were resolved under; the parked ones this
defect caused are repaired by hand (`.agents/context/2026-10-04-pairing-held-book-repair.md`).

## Amendment — 2026-10-04: a pushed want whose LazyLibrarian book is gone (issue #665)

**Normative rule: DESIGN-028's 2026-10-04 amendment.** The reconcile used to skip a want whose `ll_book_id` the
run's `getAllBooks` snapshot lacked. LazyLibrarian deletes books the app added when it restarts (an author it
counts as bookless is removed, and its books cascade), so 747 pairing wants sat `wanted` or `grabbed` on ids that
no longer exist. The reconcile now re-keys such a want to the one row LazyLibrarian holds for the same title and
author (when that row already holds the format or is after it), or settles its missing format `missing` once the
book has been absent for 24 hours, with no LazyLibrarian call now or from the Skipped sweep later. A settled want
is never pushed again by the mint (it pushes only `requested`); a person's Search again re-adds the book. Report
fields `llGoneRekeyed` and `llGoneSettled`.

**The want's format comes from its anchor (follow-up, same day).** The reconcile guessed a want's format from which
status read `landed` (`ebookStatus === 'landed'` ⇒ audiobook, else eBook). Three July wants never had their held
format set `landed` (it read `grabbed`), so the guess picked the HELD format, and the Skipped sweep would have
re-queued and searched a format the library already holds whenever LazyLibrarian showed it `Skipped`. (The two of them
whose LazyLibrarian eBook reads `Wanted` are wanted by audiobook-anchored wants for the same books, so that status
stays.) The reconcile now reads every
open want's anchor media kind (one query) and uses `missingFormatFor`, and sets the anchor-held format `landed`
wherever it is not, as long as the anchor is still in the library (`deleted_at` NULL: a removed anchor no longer
holds its format, though its media kind still names the want's format) (`landPairingHeldFormat`, report field
`heldLanded`; ADR-065 C-03).

## Amendment — 2026-10-05: a want is checked against its anchor's book (issue #693)

**Normative rule: DESIGN-028's 2026-10-05 amendment.** Pairing wants read `landed` from books that were not their
anchor's book. Three of the causes were on this leg:

- the reuse lookup (D-05) keyed on `normTitle`, which cuts the subtitle;
- a want kept its id when its anchor turned out to be another book: the #661 held book, or an audiobook renamed by the
  2026-09-29 library repair (the amendment above said "wants pushed before this change keep the identity they were
  resolved under");
- the Google Books resolve took "Court of Thorns and Roses bk 2" for book 1.

**D-05, the identity check (`checkPairingWantBooks`, first in every mint).** Before any candidate is chosen, every
unparked want on a live anchor holding one book (`pairingIdentity` → `one`) is judged against that book
(`judgePairingWantBook`), with the title LazyLibrarian holds for the want's id:

- **`retitle`.** The anchor's book changed name, and the id already names the new book (LazyLibrarian holds it under
  exactly that title, `llBookNamesTitle`), or the want has no id. Only the title snapshot moves.
- **`clear`.** Either the anchor's book changed and the id does not name it, or LazyLibrarian no longer holds the id
  (`identity`), or the title is current but LazyLibrarian names the book as another volume or work (`volume` / `work`,
  `llBookMismatch`).

  `reidentifyPairingWant` writes the anchor's identity as the title, clears the id, sets the missing format
  `requested` (or `landed` when the anchor is paired, because the library holds it), sets the held format `landed`, and
  resets the one re-request (#668), which belonged to the old book. The want is then a candidate, and the mint resolves
  the anchor's own book (reuse, then Google Books).

Details:

- The check makes no external call and is not an attempt. It runs only with a usable `getAllBooks` snapshot
  (`llBookOf`); a degraded run checks nothing.
- The single writer is guarded on the row being unchanged since it was read, and is unaudited (the sync-mint class).
- LazyLibrarian is not written. The old book stays as it is there, and each change logs `pairing_want_reidentified`
  with `abandonedLlBookId`, or `pairing_want_retitled`.
- A want whose title is current and whose id LazyLibrarian lacks is left to the gone rule (#665).

**D-05, the reuse key (`reuseTitleKey`).** The reuse lookup keys on the full pairing title once its series decoration
is off (`gbQueryTitle`: a trailing "(The Stormlight Archive, #1)", a leading "Expanse 05 - "). It keeps the subtitle
and any volume number:

- "Mistborn: Wax & Wayne" never reuses *The Final Empire*'s id.
- "Court of Thorns and Roses bk 2" never reuses book 1's id.
- "Dune (Dune Chronicles, #1)" still reuses "Dune".
- "Dune: Special Edition" no longer does. That is the conservative miss: one Google Books call, not a wrong book.

Two more limits on reuse:

- A want on an anchor that left the library is no reuse source, because its id is never checked again.
- A reused or freshly resolved id is refused when LazyLibrarian already holds it as another volume or work
  (`pairing_resolve_rejected`, report field `rejectedResolves`). The want is then resolved by Google Books, or
  unmintable.

**The upsert (defense in depth).** When the title snapshot changes, `upsertPairingWant` no longer keeps the existing
id: it takes the attempt's. The mint takes a want's own id only while its title is the identity's, so a run without
LazyLibrarian's titles cannot carry a stale id either. A `landed` that belonged to the old book is reset with it.

**The reconcile.** It skips `applyRequestReconcile` and the Skipped sweep for a want whose book mismatches
(`ll_book_mismatch`). The identity check already cleared those on live anchors. This guard covers a removed anchor and
one not yet read for its held books.

**Report fields:** `reidentified`, `retitled`, `rejectedResolves`.

**Measured before merge** (live mirror, 2026-10-05 14:27Z), first run on the new code:

- 76 wants clear: 73 `identity` and 3 `volume` (9ab1d97c and two Beacon 23 parts on the whole novel, the bundle rule).
  27 of them are paired and settle `landed` with no id. The other 49 become `requested` and re-resolve over a few runs
  (cap 25, the Google Books budget).
- 22 wants re-title. One of them is c071f2dc ("Breaking Dawn" → "Twilight", whose series now holds Twilight, the book
  its id names).

## Amendment — 2026-10-05: pairing is English only (issue #700)

**Normative rule: the F10 English-only ruling** (`.agents/context/2026-07-13-f10-english-audit.md`). Pairing minted
a want for the missing format of every unpaired item, whatever its language. On 2026-10-05 the Audiobookshelf item
"Chroniken der Unterwelt (4-6)" (`attrs.language` `de`) became a candidate and pairing pushed LazyLibrarian's German
omnibus eBook for it. The volume check (#693) passed it, because the book really was that item's other format. The
missing piece is a language rule. Owner-side rulings (the coordinator's, 2026-10-05):

**The language of an item** (`books_items.attrs.language`, both sources; `classifyBookLanguage`):

| Class | Values | Pairing |
|---|---|---|
| English | `en`, `eng` (LazyLibrarian's own spelling), `en-*`, `English` (any case) | allowed |
| Unknown | blank, null, `XXX` (and LazyLibrarian's `Unknown`) | allowed (the 199 blank Audiobookshelf items are overwhelmingly English) |
| Foreign | anything else: `nl`, `de`, `es`, `German`, ... | never |

**D-05, the candidate filter.** A foreign anchor is never a candidate: with no want yet it is not minted
(`skippedForeign`, no Google Books call, no push); an existing want LazyLibrarian is not working yet (`ll_book_id`
NULL, or the missing format `requested`) is parked with `unroutable_reason='foreign_language'` through the same
`parkPairingWant` as `multi_book` / `no_book`. Unlike those, every OPEN want is parked, whatever stage it reached:
the missing format `requested`, `wanted`, `grabbed` or `missing` all park, because a want for the other format of
a non-English item is wrong at any stage. Only a want whose missing format already `landed` is left alone. The
park stops the app's own reconcile, Skipped sweep and re-request of the want; LazyLibrarian is not written, so a
book it already searches keeps being searched there, and a parked want's status stops following it. A parked want
stays parked (the 2026-10-03 amendment), so lifting the park is clearing the reason.

**The push-time guard (second line).** The library field is not fully reliable: the `525913ff` anchor reads
`English` yet held the German audio. So before `queueBook` and `searchBook`, the mint reads LazyLibrarian's own
`BookLang` (`getAllBooks`, `LlBookStatus.language`). An explicitly non-English book (same classes) is not queued or
searched: the want is parked `foreign_language` and `refusedForeignBook` counts it. A blank, `Unknown` or missing
language proceeds. The run's one snapshot answers for a book LazyLibrarian already holds; a book this push first
seats with `addBook` is re-read once, because the snapshot predates it (`addBook` alone leaves the book `Skipped`,
so it stays out of the search backlog). A degraded run without a usable snapshot checks nothing. The Skipped sweep
applies the same guard to a book LazyLibrarian holds as foreign: no re-queue, and the want is parked when its
state allows. The #668 re-request skips wants on foreign anchors.

**Report fields:** `skippedForeign`, `refusedForeignBook`; `parked` now includes the foreign parks.

Unchanged: the confined LazyLibrarian surface (C-08) and every other write. Foreign anchors still pair when both
formats are in the library; the rule only stops pairing from asking for the other format.

## Amendment — 2026-10-05: a `foreign_language` park lifts when the language is fixed (issue #712)

**Normative rule: the F10 English-only ruling, read in both directions.** The #700 park was one-way (the 2026-10-03
amendment: a park "is its own decision"), so a language corrected in the library afterwards never freed the want: on
2026-10-05 eighteen Kavita series had their `language` corrected to `en` and eleven of them still carried a want
parked `foreign_language`. Two halves fixed it: DESIGN-024's amendment of this date makes the correction reach
`books_items.attrs.language`, and this one lets the park go.

**The re-evaluation.** Every mint run, before the candidate list is built (D-05 step 2-pre), looks at every want
whose `unroutable_reason` is `foreign_language` and lifts it when ALL hold:

1. its anchor is still a live library item;
2. the anchor's `attrs.language` now classifies as English or unknown (the #700 table), not foreign;
3. LazyLibrarian's own `BookLang` for the want's `ll_book_id` is not foreign. A want with no `ll_book_id` has no
   LazyLibrarian book to contradict the library, and the push re-checks the language anyway. A want that has one
   needs the run's language read (`llBookLanguage`); a degraded run without it lifts nothing it cannot verify.

So the push-time park (an anchor that reads `English` whose LazyLibrarian book is `de`) stays parked: only the
anchor's language changed, not the book's. Only `foreign_language` lifts. `wrong_volume`, `multi_book` and `no_book`
are different decisions and are never touched here.

**The writer.** `unparkForeignLanguageWant` is the single writer, the inverse of `parkPairingWant` and the same
class (unaudited, one statement): it clears `unroutable_reason` only `WHERE unroutable_reason = 'foreign_language'`
on a pairing want. It leaves `updated_at` (the retry-recency key; a lift is not an attempt), the statuses and
`ll_book_id` as they were, so the want re-enters the mint exactly as it was parked: a want whose missing format is
`requested` or has no LazyLibrarian id is a normal candidate in the SAME run (resolved and pushed under the usual
cap and guards); a want LazyLibrarian was already working simply resumes reconciling on the next pass. The lift
costs no cap and no external call beyond the language read.

**Report field:** `unparked` (log line `foreign_language park lifted`).

Unchanged: parking itself, the push guard, the Skipped sweep guard and the confined LazyLibrarian surface.

## Amendment — 2026-10-05 (later): a `landed` missing format stays truthful (issue #715)

**Normative rule: DESIGN-028's amendment of this date, applied to the pairing want's missing format.** The missing
format reads `landed` when the library holds the other copy (the pair) or LazyLibrarian holds it. The open-want
reconcile only reads wants with a format still open, and `advanceStatus` never regresses a positive, so a want that went
both-landed was never looked at again: LazyLibrarian could lose the file or the book and the want kept reading `landed`.

**The check.** Each run, after the pair cache rebuilds and before the open-want reconcile
(`revalidateLandedPairingWants`), looks at every unparked want with a LazyLibrarian id whose anchor is a live item, is
UNPAIRED, and whose missing format reads `landed`:

- the book is absent from a usable snapshot, past the gone grace: re-keyed or settled `missing` (`includeLanded`);
- the book names another volume or work (T-280): the missing format settles `missing`. The mint's identity check
  normally clears such a pointer first, so this is the backstop;
- otherwise the format reads what LazyLibrarian shows if LazyLibrarian does not hold it (`wanted`, `grabbed`,
  `missing`), through `revertLandedFormats`.

A **paired** anchor is held by the library whatever LazyLibrarian says, so it is never touched. A want on a **removed**
anchor is history and a **parked** want is out of the reconcile; neither is touched. The held format (the anchor's own)
is not part of this: it is `landed` because the anchor is in the library (`landPairingHeldFormat`). A want the check
reopens is reconciled and, if LazyLibrarian has the format `Skipped`, swept in the same run (the #700 English-only
guard still applies to the sweep).

**Report field:** `requestsLandedReverted`; log line `request_landed_reverted` (site `format-pairing.landed-check`).
**Live data before the change (2026-10-05):** of 365 unpaired, unparked pairing wants on live anchors whose missing format
read `landed`, LazyLibrarian held 358, did not hold 4 (`Skipped`) and no longer had 3.

## Amendment — 2026-10-05 (latest): a want on a non-English LazyLibrarian book asks for the English edition (issue #719)

**Normative rule: DESIGN-028's 2026-10-05 (latest) amendment.** The push-time and Skipped-sweep parks of #700 (the anchor
reads English or unknown, LazyLibrarian's `BookLang` for the want's book is foreign) left the want parked
`foreign_language` with nothing asking for the English edition. The English-edition pass (goodreads-sync, DESIGN-028) now
takes exactly those parks: it requires the anchor's own language to be non-foreign (an anchor that is itself foreign is the
anchor's problem, not an edition's; the mint still never pairs it) and the book to be foreign in the run's snapshot.

- **Found:** the want's `ll_book_id` becomes the English volume, the missing format returns to `requested`, the park
  clears. The next mint run reuses that id (`ownLlBookId`; no Google Books call), `addBook`s it, re-checks the language
  (the #700 push guard still applies to the English book) and pushes the missing format through the usual chain.
- **None:** `unroutable_reason` becomes `no_english_edition` (the status is untouched, like every pairing park). The mint
  and the reconcile skip a parked want, so nothing is ever pushed. The pass retries once per Google Books quota-day, and
  lifts the park when LazyLibrarian's book is fixed. `liftForeignLanguageParks` (#712) never touches a
  `no_english_edition` park.
- The pairing mint itself makes no extra Google Books call and needs no change: the lookup is the goodreads-sync job's,
  charged to its `goodreads` budget slice, at most once per want per quota-day.

## Amendment — 2026-10-06: the missing format's `grabbed` follows LazyLibrarian, and a given-up want releases its book (issues #734, #735)

**Normative rule: DESIGN-028's amendment of this date.** On the pairing side:

- **#734, `grabbed`.** 51 of the 53 failed grabs the review found were pairing wants: the open-want reconcile read
  LazyLibrarian through `applyRequestReconcile`, which never moves `grabbed` back. Now, before that reconcile, an open want
  whose MISSING format reads `grabbed` takes `unheldFormatStatus` for it through the widened `revertLandedFormats`:
  `Wanted` reads `wanted`, `Skipped` reads `missing` (and the Skipped sweep below may queue it again in the same run),
  `Snatched` or held changes nothing. The held format is never touched. A want whose book names another volume or work is
  skipped as before (the mint's identity check clears its id). Report field `requestsGrabReverted`, log
  `request_grab_reverted` (site `format-pairing.reconcile`).
- **#735, the release.** Every pairing writer that ends the app's work on a book for a want records a LazyLibrarian Release
  (T-283) for the missing format when the want had LazyLibrarian working on it (`wanted` or `grabbed`), in its own
  transaction: `reidentifyPairingWant` in `clear` mode (the identity check, `reidentified`), `upsertPairingWant` when it
  re-points a want to another id (`reidentified`), and `parkPairingWant` for every reason (`parked:foreign_language`,
  `parked:multi_book`, `parked:no_book`; the last two only park unpushed wants, so they record nothing in practice). The
  park keeps the want's statuses, as before; only LazyLibrarian changes.
- **The drain runs in every format-pairing run,** after the mint, the reconcile and the one re-request (so a book a want
  took this run is owned), from one fresh `getAllBooks` read when a release is pending: a park or re-identify made in the run
  is unqueued in the same run. A pairing want owns only its anchor's missing format of its book: a live want for the other
  format, or a goodreads or collection want, on the same id keeps that format searching.
- **The censuses** ride the run report: `llOrphanWanted` (T-284, after the drain) and `grabbedNotSnatched`, each with a log
  line naming its rows (`ll_orphan_wanted`, `request_grabbed_not_snatched`). Both are null when LazyLibrarian could not be
  read.
- **A lifted park comes back on its own.** `liftForeignLanguageParks` (#712) and the English-edition pass's lift leave the
  want as it was parked; its book now reads `Skipped`, so the reconcile settles the format `missing` and the Skipped sweep
  queues and searches it again in that run.

**Live data before the change (2026-10-06 ~09:00Z, read-only):** 64 request formats read `grabbed`. 58 are on live,
unparked requests with a LazyLibrarian book: 52 on a `Wanted` book (51 pairing, 1 goodreads), 5 `Snatched`, 1 `Skipped`
with a file. The other 6 are on parked wants, a want with no book, or a goodreads want whose shelf item is gone.
LazyLibrarian had 24 `Wanted` formats no live request asks for: 22 on books no request names, 1 on a `foreign_language`
park (`yK8pzwEACAAJ`), 1 F10 hand re-want (`GGcbzgEACAAJ`).

## Amendment — 2026-10-06 (later): the Mint Backoff, the coverage Volume Check, and a held `Skipped` missing format lands (issues #740, #739, #752)

**Normative rules: this amendment for #740; DESIGN-028's amendment of this date for #739 and #752.**

### #740: the Mint Backoff

**What was seen.** The mint ordered candidates oldest first and, within one `first_seen_at`, least recently tried, so every
run walked the same oldest wants first. About 1,460 candidates; on 2026-10-05 and 2026-10-06 the runs logged `attempted 100,
unmintable 95` (and 97, 94, 89), tripped Google Books' per-minute quota at 10:33Z and 11:32Z (`skippedQuota` 187 to 226),
and spent the daily slice (700 calls) by 12:32Z (`skippedBudget 279` until the 07:00Z reset). The same key serves
LazyLibrarian's `addBook`, so the #668 re-request's adds waited (`llRerequestDeferred` about 470 each run), and the
English-edition pass (DESIGN-028, #719) had nothing to borrow from.

**The rule: a want whose lookup found nothing waits before the next one.** When a real Google Books lookup for a pairing
want answers with no usable book (no match, or a match the Volume Check refuses), the want's Mint Backoff (T-285) grows:
the next lookup waits 1 day after the first miss, 3 after the second, 7 after the third and 30 after every later one
(`PAIRING_MINT_BACKOFF_DAYS`). Three columns on `book_requests` (migration 0094), written only by `upsertPairingWant`:

| Column | Meaning |
| --- | --- |
| `mint_backoff_count` | misses in a row for the identity below (0 when none) |
| `mint_backoff_until` | no lookup before this time |
| `mint_backoff_key` | the identity the misses were counted for: title key, author, ISBN (`mintBackoffKey`) |

- **Only the lookup waits.** A want in backoff stays a candidate, so a book another request resolved since still mints it
  through the reuse index with no lookup. A waiting want needing a lookup is skipped with no cap consumed and no row
  touched, so the run's cap goes to the wants behind it.
- **A changed identity is looked up at once.** When the anchor's title, author or ISBN changes (a metadata re-read adds an
  ISBN, the identity check retitles it), the key no longer matches, the backoff is ignored, and a new miss counts from 1.
- **A resolve clears it.** Any id (resolved or reused) sets the count to 0 and the other two columns to null.
- **An error is not a miss.** A lookup that throws (network, a 5xx) is an attempt as before and changes nothing; a quota
  refusal is not an attempt at all (ADR-067 C-08).
- **Report field `inBackoff`:** candidates waiting out their backoff this run. `attempted` and `unmintable` keep their
  meaning, so the run line shows the ratio directly.

**Where the freed calls go.** The pairing slice stays 700 and the per-run cap 100; what the mint no longer spends stays on
the shared key's daily quota for LazyLibrarian's adds, and the goodreads job's English-edition pass may spend it once its
own `goodreads` slice is gone (DESIGN-039 D-23 amendment of this date). Shrinking the pairing slice once the backlog drains
is left for later evidence.

**Expected after deploy.** The first run attempts up to 100 as before (no want has a backoff yet) and backs off every miss;
from the next run `inBackoff` rises toward the unresolvable backlog (about 1,400) and `attempted` falls to the new and
changed wants plus the day's expiring backoffs. A miss on day 1 is retried on day 2, so the old cohort's second pass comes a
day later, its third three days after that.

**Order (follow-up the same day, after the first run on v0.107.10).** The first run (12:32Z) tried 50 wants before the
day's slice ran out (`skippedBudget 215`) and backed each off a day. 265 candidates needed a lookup that run: the 167 pairing
wants with no id (50 now counted, 117 not yet) and about 100 library items never minted at all. The drain's order (oldest
`first_seen_at` first) put every old want, including one whose backoff had just run out, ahead of those new items, so they
never got a lookup. The candidate order's first key is now the misses counted for the current identity (`missesOf`; 0 for a
fresh want or a changed identity), then the drain's order: new and changed wants are tried before any retry. With 167 wants
to back off, the slice's relief comes within about two days, as their waits lengthen (1, 3, 7, then 30 days).

### #739 on the pairing side

The identity check (`checkPairingWantBooks`), the reuse and resolve refusal (`bookRefused`), the landed check and the
open-want reconcile all call `llBookMismatch`, so they apply the coverage rule as is. Measured on the live wants: three
pairing wants change verdict (The Demigod Diaries, Tolkien's World, Ghosts of the Shadow Market 8); the next run
re-identifies them (`reidentified` 3). A refused resolve is a miss for the Mint Backoff, so a want Google Books keeps
answering with the same wrong book waits instead of costing a lookup every hour.

### #752 on the pairing side

The open-want reconcile reads each format through `llReconcileStatus`: a missing format LazyLibrarian holds under
`Skipped` (an import date) lands. Live before the change: 17 pairing wants reading `missing` and 1 reading `grabbed` (the
Confessions of an Ugly Stepsister audiobook); the next run lands them, except Ghosts of the Shadow Market 8, which the
identity check re-identifies first. The Skipped sweep already refused to re-queue these (`ll_push_skipped_have`).

**Tests:** `packages/domain/__tests__/format-pairing.test.ts` (the Mint Backoff: 1, 3, 7, 30, 30 days, no lookup and no cap
while waiting, a changed ISBN looked up at once, a reuse id minting through the backoff and clearing it, an error is not a
miss), `packages/domain/__tests__/landed-truth.test.ts` (#752), `packages/domain/__tests__/wrong-volume-guards.test.ts`
(#739), `packages/db/__tests__/migrations.test.ts` (0094); the follow-up adds a fresh want tried before a due retry.

## Amendment — 2026-10-06 (Request Events): the pairing writers record a Request Event (issue #741, ADR-101)

Every pairing-want writer this design calls "unaudited (the pairing sync class)" now records a Request Event
(glossary T-292) in its transaction, through `packages/domain/src/book-request-events.ts`, the only `book_requests`
write path: `upsertPairingWant` (`pairing_want_minted` / `pairing_want_refreshed`), `syncFormatPairs`
(`pairing_want_revived`), `landPairingHeldFormat`, `reidentifyPairingWant` (`pairing_want_reidentified` /
`pairing_want_retitled`, `detail.cause`), `markPairingWantPushed` (`ll_pushed`), `parkPairingWant` and
`unparkForeignLanguageWant` (`parked` / `unparked`), plus the shared reconcile, revert, gone and re-request writers.
The Mint Backoff columns are bookkeeping and are not recorded. The format-pairing mode runs as `actor: 'sync'`, site
`format-pairing` (a leg such as `format-pairing.rerequest` where the writer names it). Nothing the pass decides
changes. The full rules, reason table and queries: DESIGN-028, amendment 2026-10-06 (Request Events).

## Amendment — 2026-10-07: a Mint Backoff ends at the same-hour run, and a per-minute quota window is waited out once (owed check OC-014)

**Normative rules: this amendment for the grace; DESIGN-039's amendment of this date for the quota wait and the GB Call
Pacer (T-293).**

**The grace.** A Mint Backoff (T-285) is a whole number of days from the run that missed (`mint_backoff_until` = that run's
`now` plus 1, 3, 7 or 30 days), and the mint runs hourly, so the wait ends at the start of the same-hour run days later,
give or take the seconds a CronJob pod takes to start. Whether that run retried the want was decided by sub-second
jitter: the 61 wants missed at 2026-10-07 07:32:03.36Z come due at 10-08 07:32:03.36Z, and a run whose `now` is
07:32:03.0Z would have left them to 08:32Z. `mintBackingOff` now counts a want due once the run starts within
`PAIRING_MINT_BACKOFF_GRACE_MS` (10 minutes) of its `mint_backoff_until`; the stored column keeps its meaning, the grace is
far below the hour between runs, and `inBackoff` counts with the same rule.

**The quota wait (pointer).** A lookup refused by a per-minute quota window is waited out once a run and the same
candidate tried again, instead of ending the run's lookups (DESIGN-039 D-07 as amended 2026-10-07). New report field
`quotaWaits`; the wait is not an attempt and consumes no cap.

**Tests:** `packages/domain/__tests__/format-pairing.test.ts` (the run an hour early still waits; the same-hour run a day
later that starts 0.4 s sooner looks the want up; the quota-wait cases listed in DESIGN-039).

## Amendment: 2026-10-07, EPUB series split and retired anchors (issue #825, ADR-105)

Removing EPUB grouping metadata replaces a multi-book Kavita row with rows for its books. Kavita may retain a
series id when its old grouping name equals a surviving book title. The mirror tombstones absent rows and keeps
history; pairs are recomputed from live Held Book identities. Pair changes caused by replacement ids are expected
once, with their identities and Request Events checked in the staged and full runs.
Release-transition reads validate cached pairs against current live one-book identities; a stale
series-name or multi-book pair cannot prove a successor already holds the missing format.

A pairing want on a tombstoned anchor never enters mint, reconcile, identity repair, revival or the Skipped sweep.
The single writer settles such a historical want as removed, clears its LazyLibrarian id, and records a Request
Event in the same transaction. Removed anchors do not cover a collection want. A queued predecessor whose live replacement cannot yet
claim its format is temporarily reserved from release while cap, quota or backoff delays the successor; it never
initiates a resolve, queue or search. Other removed anchors do not own a LazyLibrarian format. Format release runs only through the existing audited release chain and after new live wants can claim the
format; the migration must account for mint cap, quota and in-flight work before settling or releasing a predecessor.
No release removes a downloaded file. Historical wants are retained rather than re-keyed to an inferred book.

An unread live replacement cannot prove that the old queued format has no successor. While a same-kind Held Book
read remains unknown, the reservation fails closed without a time expiry: an expiry during a prolonged detail-read
outage could cancel a valid in-flight format. Once per format-pairing run, a structured warning names the unknown
blocking item ids and deferred request ids, with total counts and at most 20 ids per list, so a persistent read
outage can be diagnosed without unbounded log output.

Every pairing acquisition path requires a live anchor whose identity is `one`, including re-request after a
LazyLibrarian book disappears and the Skipped sweep. Landed-state revalidation, open-want reconcile, English-edition
repair and manual Search again use the same identity guard. An unknown, multi-book or empty anchor cannot re-key,
reopen or queue a prior book using its stale request snapshot, nor pair through its row title. A pushed want on such
an anchor keeps its request state and LazyLibrarian id while the current identity is unavailable; the guard never
cancels an existing download or lifts a park. Successful reads resume the existing retry, backoff and language rules.

Every automatic mint or queue writer preserves a format LazyLibrarian already reports `Snatched`: it does not
add, queue or search that format, and its request reconciles to `grabbed`. Queueing another missing format never
changes the downloading format. A replacement pairing want adopts an existing `Wanted` format without queueing
or searching only when a removed predecessor owns the same LazyLibrarian id and missing format, and full title
plus known author agreement or a shared ISBN proves the same work. Resolution of the successor still uses its
fresh held identity. Adoption records the existing status through the Request Event writer before the predecessor
settles, so the release drain sees the successor owner. This scoped handoff does not change ordinary `Wanted`
retry policy. The current LazyLibrarian language guard runs before adoption: an explicitly foreign book parks
the new want without queueing or searching; an existing Snatched download is never cancelled by that park.
An unavailable snapshot cannot prove an active download or handoff and retains the existing
fail-closed reservation rules.

A surviving anchor whose Held Book changes cannot carry a prior book's landed state into the new identity. If its
want has no LazyLibrarian id, a changed identity is reidentified through the existing writer, resetting the missing
format to requested unless a current live format pair proves it held. A retitle that preserves state requires an
existing LazyLibrarian id verified to describe the new book. Every write uses the Request Event helpers.

Before the backfill, ship and deploy these safeguards, project the census against after-strip metadata, and review
the merged implementation adversarially. The staged Hunger Games/Mockingjay run proves surviving and new series
ids, chapter changes, exact file coverage and requests. Repeat across the full inventory; preserve one-time pair
deltas as evidence. The next 04:00Z scan must not cause tagged-series flips or unexplained dropped/revived wants.

A retained anchor can still carry a `multi_book` or `no_book` park after becoming one book. If the migration census
finds one, a scoped repair may lift only those two reasons after a successful fresh Held Book read; it must use the
new book identity, reset the missing format unless a live pair proves it held, and record the mutation under the
repair Request Event scope. It never lifts a `wrong_volume` or `foreign_language` park. This backfill repair does not
change the general rule that parks require an explicit repair to lift.

### Held formats before automatic acquisition (2026-10-07, issue #825)

One-to-one Format Pairs are the card and identity cache. They are not the only proof that a format is already
held. Before automatic acquisition, a current individual Held Book can prove ebook coverage for a live audio
anchor by its complete cleaned title and an agreeing actual Writer, even when its containing series holds
several books. A current Audiobookshelf book can similarly prove audio coverage. A series name alone, a title
without author proof, a removed item or an unread Held Book cannot establish this coverage. Pair matching still
requires a one-book series and keeps its existing one-to-one rule.

Actual author proof uses complete credits. Normalized equal names, including an exact declared mononym, agree.
Initials and middle-name tolerance require given-name and surname components on both sides with agreeing
first and last components. Unmarked uppercase given names are not inferred initial sequences; compact initials
agree only through explicit initial notation. A surname alone cannot validate a full author, nor can a given-and-middle fragment
validate a missing surname. Kavita's comma-split creator fragments cannot be joined into inferred people.
A chapter with multiple Writer credits including single-token fragments remains uncertain for automatic
acquisition; those ambiguous credits cannot establish strong library coverage. Multiple complete names
explicitly separated as credits may each provide proof. Existing broader resolver tolerances stay separate.

A complete LazyLibrarian snapshot can also prove the requested format is held by another edition: its complete
title and known author must agree with the current anchor, the format must satisfy the existing held-file/library
signals, and the edition's language must be English or unknown. A meaningful subtitle remains part of that
full-work identity; the primary title alone cannot make a same-author novella cover the novel. An arbitrary resolved edition id does not
override this already-held work. No Google Books lookup, add, queue or search is needed merely because the old
request id disappeared while a verified edition remains held. A failed snapshot adds no such proof.

Every automatic pairing path observes the same current coverage before mint, gone-book retry, dropped-pair
revival, landed revalidation, Skipped retry, English-edition replacement and open-want reconcile. Pair matching
and library coverage use the same current item snapshot. Existing wants record verified missing-format
coverage as landed through the Request Event writer. Proven held formats never queue or search. This prevents
a stricter pair cache or a one-time series split from acquiring a duplicate of text the library already serves,
without inventing a pair or asserting ownership from ambiguous metadata.

### Unread counterparts and conflicting metadata (2026-10-07, issue #825)

A Pairing Reservation is a derived `books_pairing_reservations` edge between the book and audio items of a
previous pair when the live book's chapter inventory is unread or includes an unidentifiable title. A prior book
already tombstoned at the first pairing run also opens this edge while a live unread or unidentifiable replacement
could still hold the work. The Format Pair can drop while this separate
edge keeps that audio's ebook acquisition deferred on subsequent runs. The reservation establishes uncertainty,
not ownership. Its single writer updates it in the pair-cache transaction before deleting stale pairs. Current
verified held coverage or a fully identifiable original chapter inventory clears it; an empty inventory is valid
no-book proof, but a multi-book inventory with an untitled chapter is not. A tombstoned original can clear only
after the complete mirror's deletion proof, with no outstanding unread or unidentifiable book inventory. This
restriction protects its former audio counterpart, without blocking unrelated new candidates merely because
another successfully read book has no identifiable title.

A genuinely unread live Book inventory (`heldBooks` absent) also defers uncovered automatic ebook acquisition
until the read succeeds. A successfully read but unidentifiable book does not block unrelated audio items; its
own pairing acquisition remains guarded, and any reservation of a prior counterpart persists. Unknown actual
chapter Writers defer the corresponding full-title audio candidate and the Book anchor's own acquisition rather
than asserting a pair or ownership.
Warnings carry total counts and bounded item/request ids so a persistent outage or metadata gap is actionable.

Known contradictory authors also defer acquisition while stronger coverage remains usable. A Book anchor whose
known row author disagrees with every actual chapter Writer cannot automatically request another format from
that uncertain identity. An audio candidate whose full title matches a held chapter, whose author agrees with
the Book row but not its actual Writers, waits for that conflict to be resolved. These guards preserve an
existing want's identity, LazyLibrarian id and state until the ambiguity clears, except
that positive current held-format proof can land it. They do not replace the declared chapter identity with the
aggregate author or guess that two authors are one.

The removed-predecessor reader also accepts strong current library coverage of the predecessor's missing format
as completed handoff. It uses the same full-work title/actual-author proof as acquisition, independently of the
one-to-one pair cache. Unknown or mismatched coverage keeps the existing fail-closed reservation rules. A live
multi-book replacement with any unidentifiable chapter remains an unknown-work blocker for a queued predecessor.

An explicit leading numbered-series decoration can survive in the preserved book title after grouping metadata
is removed. Until its full-work identity is verified, automatic missing-format acquisition waits unless positive
complete-work coverage exists. A corresponding audio title and credible author can establish uncertainty and
defer acquisition, without inventing a pair or held ownership. Unknown or fragmented Writers combined with
the same complete suffix also preserve this uncertainty. This guard does not strip arbitrary prefixes or
meaningful subtitles. Future source-context or canonical-title repair requires separate evidence; the migration
keeps every EPUB title and author field intact.

When a held chapter and an audio item have the same complete cleaned title, legacy author tolerance may
recognize plausible credit ambiguity that strict complete-name proof refuses (an abbreviated given name,
an editor label or separately formatted coauthors). This compatibility only removes automatic acquisition
permission on both anchors; it never proves a pair or held coverage, joins credits, or rewrites metadata.
The current matching-title inventories maintain the deferral across repeated runs even after the old pair
has dropped. Existing wants keep their identity and state unless positive complete-work coverage for their
preserved snapshot can land them. Clearly different authors or distinct meaningful subtitles do not meet
this uncertainty guard.

Differently decorated full titles can also make an existing counterpart uncertain. With agreeing actual
author credits, a complete cleaned title contained at a whole-word prefix or suffix boundary of the other
full title defers automatic acquisition on both anchors. The guard also examines complete titles of held
LazyLibrarian editions, including their meaningful subtitles. Character substrings and resemblance among
interior words do not qualify. Clearly different numbered or Roman-numbered sequel volumes remain distinct.
Explicit bracketed Disc, CD or Track markers may be ignored only during this uncertainty comparison. They
cannot establish complete-format ownership, and the original title remains intact.
This is negative permission only: it never shortens the stored work title, creates an alias or pair, or treats
an additional subtitle, compilation or partial work as held coverage. Positive exact full-work coverage remains
usable, and an existing uncertain request keeps its preserved snapshot. The deferral survives repeated runs
without the previous pair cache. A truly different same-author work whose full title contains another may
also wait for canonical identity evidence; bounded diagnostics and issue #835 record that limitation rather
than acquiring a potentially duplicated format.
