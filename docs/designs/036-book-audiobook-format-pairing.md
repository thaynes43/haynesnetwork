# DESIGN-036: Book ⇄ audiobook format pairing — pair cache, paced system wants, dual consume buttons

- **Status:** Draft
- **Last updated:** 2026-10-05 (a want is checked against its anchor's book, issue #693; see the amendment of that
  date). Prior: 2026-07-21 (**author-agreement tolerance** — the live pairing-gap diagnosis found the
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
  Charlaine Harris"). The author is the row's, else the book's writer (the Murtagh row has none). The ISBN is
  the book's. Two files of the same book are one book. The series name stands in only when the series holds
  one book and Kavita has no title for it.
- **`multi_book`** (several books) and **`no_book`** (no book file): one want per anchor (D-02's partial
  unique) cannot describe them. Per-book wants would need a schema change and are not built.
- **`unknown`**: the row has not been read for its held books yet (the first books-sync after the deploy
  reads every series once). The series name is never used as a guess.

**D-03 (the matcher).** A `one` Kavita series is keyed on its held book's title and author; `multi_book`,
`no_book` and `unknown` rows keep their row title, as before. A series whose row title already names its held
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
left alone: LazyLibrarian already has a book for it, and parking it would only stop its reconcile. An `unknown`
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
`parkPairingWant` as `multi_book` / `no_book`. A pushed want is left alone, as there. A parked want stays parked
(the 2026-10-03 amendment), so lifting the park is clearing the reason.

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
