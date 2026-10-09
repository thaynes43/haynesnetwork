# DESIGN-028: Integrations tab — Goodreads shelf sync, requests/Missing, coverage

- **Status:** Accepted
- **Last updated:** 2026-10-09 (duplicate-copy proof windows, issue #831). Prior: 2026-10-07 (amendment: admins read a want's Request Events on its Wanted detail, issue #792). Prior: 2026-10-07 (Books Census follow-up, issue #799: the first live run and its repair; titles that are one string without a leading article). Prior: 2026-10-07 (Books Census follow-up: a file whose title is the record's with words cut, issue #799). Prior: 2026-10-06 (amendment: the collection force-search and the one re-request read the language again after their own addBook, issue #794). Prior: 2026-10-06 (amendment: the Books Census, a daily observe-only census of wrong files and the English-only rule, issues #744 and #781; the two #781 books repaired). Prior: 2026-10-06 (amendment: every write to a book request records a Request Event, issue #741, ADR-101). Prior: 2026-10-06 (amendment: LazyLibrarian's `.mobi` / `.azw3` books are converted to EPUB, issue #770). Prior: 2026-10-06 (amendment: the Author Check, a collection want on another author's book is resolved again, issue #771). Prior: 2026-10-06 (amendment: a collection want LazyLibrarian downloaded reads Downloaded, issue #759). Prior: 2026-10-06 (amendment: `grabbed` follows LazyLibrarian, and LazyLibrarian is told when a want is given up, issues #734 and #735). Prior: 2026-10-05 (amendment: a want on a non-English LazyLibrarian book asks for the English edition, issue #719). Prior: 2026-10-05 (amendment: a landed format stays truthful, issue #715). Prior: 2026-10-05 (amendment: a request is never satisfied by another volume, issue #693). Prior: 2026-07-14
- **Satisfies:** PRD-001 R-178..R-184; governed by ADR-055 (linking + app-side sync + confined LL
  write + the Missing model), ADR-046 (books_items stays a pure mirror), ADR-021 (section
  permissions), ADR-015 (reflow-free UI), ADR-054 (MAM governor — untouched).

## Overview

The Integrations tab lets a user link a **public Goodreads profile** and turns their **want-to-read
shelf** into **book requests**. The `goodreads-sync` mode polls each linked shelf RSS read-only,
mirrors it, matches each want against the `books_items` library mirror, mints a request per want,
and pushes the routable-unmatched wants to LazyLibrarian (BOTH formats, paced) via a confined write
client — then reconciles LL statuses back onto the requests and computes **coverage %** ("we have
N% of your shelf"). Missing entries support an audited manual **Search again**. Comics are parked
out of the LL route (Kapowarr's domain). Ships **Admin-only** (the `integrations` section defaults
`disabled`).

## Detailed design

### D-01 — Data model (migration 0045, three tables)

- **`user_integrations`** (single-writer `packages/domain/user-integrations.ts`, guard-listed):
  `(user_id, provider)` unique; `provider` ∈ `INTEGRATION_PROVIDERS` (v1 `'goodreads'`);
  `external_user_id` (the numeric Goodreads id), `profile_ref` (display/audit copy), `status` ∈
  `linked|unlinked|error`, `shelves` (default `['to-read']`), `last_synced_at`, `last_sync_error`.
  **link/unlink co-write a `permission_audit` row** (`link_integration`/`unlink_integration`) in the
  same tx; `markIntegrationSynced` (sync bookkeeping) is UNaudited (synced-content exemption).
- **`integration_shelf_items`** (single-writer `integration-shelf-items.ts`, guard-listed): the
  synced shelf-RSS MIRROR, `(integration_id, shelf, external_book_id)` unique; title/author/isbn/
  `gb_volume_id`/cover_url/shelved_at + first/last-seen + tombstone. Rebuildable read-model (the
  `books_items` class) — no per-row audit; upsert + scoped-tombstone in one tx.
- **`book_requests`** (single-writer `book-requests.ts`, guard-listed): one row per shelf want,
  `shelf_item_id` unique; `matched_books_item_id` (nullable — the library match once present),
  `ll_book_id` (the GB volume id the pushes used), per-format `ebook_status`/`audio_status` ∈
  `requested|wanted|grabbed|landed|missing`, `unroutable_reason` (null | `'comic'`),
  `last_searched_at`, `last_reconciled_at`. ADR-046 STANDS — request/Missing state lives here, never
  on `books_items`. Sync mint/reconcile UNaudited; the manual re-search co-writes a
  `permission_audit` `request_book_search` row.

### D-02 — The confined LazyLibrarian client (`@hnet/lazylibrarian`)

`./read` `LazyLibrarianReadClient.getBook(id)` → raw per-format status strings (the domain maps
them). `./write` `LazyLibrarianWriteClient` (import-confined to `packages/domain` — the
arr-write-import-guard extended): `addBook(id)`, `queueBook(id, 'ebook'|'audiobook')`,
`searchBook(id, format)`. The API is the query-string command form `GET {base}/api?apikey&cmd&…`;
the http layer redacts the apikey in errors and RETRIES with backoff on 5xx/429/network/timeout (GB
`backendFailed` bursts surface as transient 503s on keyed LL calls too — the F-10 lesson).
`queueBook` is MANDATORY after `addBook` (addBook alone lands `Skipped`).

### D-03 — The read-only Goodreads source (`@hnet/goodreads`)

`GoodreadsRssClient`: `resolveUserId(ref)` (a bare id / `/user/show/<id>` URL is parsed directly; a
**vanity URL** like `.../haynesnetwork` is resolved by following the redirect to `/user/show/<id>`),
`fetchShelf(userId, shelf)` → parses the shelf RSS (CDATA-aware, sparseness-tolerant, isbn13
preferred, `nan`→null). `GoogleBooksClient.resolveVolume({isbn,title,author})` → a GB **volume id**
(ISBN first, then intitle+inauthor), the **LL addBook key** — mandatory retry/backoff. No secret for
RSS; the GB key is optional (absent ⇒ enrichment degrades to skipped — the want stays honestly
un-pushable).

**Comic classification (`classifyComic`, hardened after the v0.49.0 live acceptance — BOTH of the
owner's comics leaked into LazyLibrarian).** GB categories alone are insufficient: (a) the `/volumes?q=`
SEARCH endpoint TRUNCATES `categories` (the Scott Pilgrim ISBN edition came back `["Fiction"]` while the
`/volumes/{id}` GET carries `"Comics & Graphic Novels / Literary"`), and (b) a sparse GB volume can have
NO categories at all (Batman "Zero Year" resolved to an Eaglemoss catalog entry). So classification now
unions three signals: `isComicCategory` (the GB category substring, suffix-tolerant); `isComicText` — a
high-precision marker in the shelved title/author/publisher (a comic publisher/imprint like "DC Comics",
or "graphic novel"/"manga"), which catches the "DC Comics - The Legend of Batman" title GB categories
drop; and a **full-category confirm GET** (`/volumes/{id}`) fired only when the search returned a
possibly-truncated (non-empty, non-comic) category list, which recovers Scott Pilgrim. The goodreads-sync
+ the fresh-link fast path also apply `isComicText(title, author)` as a fallback when GB returns no match
(a comic must NEVER blind-fire into LL). Residual: a comic with neither a GB comic category nor a text
marker still routes (a documented honest gap — no ISBN column on the mirror, ADR-055 C-06).

### D-04 — The sync flow (`goodreads-sync` mode → domain orchestrator)

`packages/sync/goodreads.ts` `runGoodreadsSync`: for each LINKED integration, fetch+enrich each
shelf (external reads), then hand the enriched snapshot to the domain orchestrator. Per-integration
isolation — a private/unreachable shelf marks THAT integration `error` and continues.

`packages/domain/goodreads-sync.ts` `syncGoodreadsIntegration` (an orchestrator — external LL calls
stay OUT of any transaction, the fix-flow discipline): (1) `upsertShelfItems` (mirror + tombstone),
(2) `loadLibraryMatcher` (one bounded `books_items` read → a normalized-title (+author) matcher),
(3) `syncShelfRequests` (mint one request per want — matched ⇒ landed; unroutable comic ⇒ parked
Missing; routable-unmatched ⇒ `requested` with the GB id), (4) push the routable-unmatched to LL
BOTH formats, PACED: `addBook → queueBook(eBook) → queueBook(AudioBook) → searchBook(eBook) →
searchBook(AudioBook)`, (5) reconcile LL statuses (`getBook` → `mapLlStatus`, never regressing a
positive), (6) `markIntegrationSynced` + `computeCoverage`.

`mapLlStatus`: Open/Have→landed, Snatched→grabbed, Wanted→wanted, Skipped/Ignored/Matched→missing,
unknown→null. **Coverage** = (requests with a library match OR either format landed) / (live shelf
wants), rounded. Comics count for coverage but never route to LL.

### D-05 — API (`integrations` router, `integrationsProcedure` — the `integrations` section)

`status` (link card), `link` (resolve vanity → id + PROBE the public want shelf is reachable BEFORE
persisting → `linkIntegration` → then FIRE the first shelf sync in the BACKGROUND — a fired-and-forgotten
`syncGoodreadsIntegration` for just the new integration, mirroring the sync mode's per-integration
read+enrich so the coverage card shows real data instead of a "0 of 0" dead-end until the hourly CronJob;
the link is already committed so a sync failure never fails the link, and `markIntegrationSynced` is
guarded `status <> 'unlinked'` so an in-flight sync can't resurrect an unlinked account), `unlink`,
`shelf` (summary + coverage), `requests` (the wall),
`search` (ownership re-checked → `runManualBookSearch` → audited `request_book_search` then a real
LL `searchBook`). Unauth ⇒ UNAUTHORIZED; a non-admin whose section is the default `disabled` ⇒
FORBIDDEN (server-authoritative). `InvalidGoodreadsProfileError` → 422; `LazyLibrarianUpstreamError`
→ 502.

### D-06 — UI (the Integrations tab)

New top-level nav entry (`showIntegrations`, gated by the `integrations` section). The page stacks
three views (ADR-015 reflow-free, tokens-only, 320/390 portrait-safe): the **link card** (a
token-themed text input `.integrations-input` sharing the search-box surface — dark surface + token
colors in both themes, so it never falls through to the browser-default white input; the invalid state
changes only the border/tint via the global `input[aria-invalid]` while the text stays readable → then
the linked state + shelves + last-sync error; **Unlink** is the `@hnet/ui` `ConfirmButton` two-step,
hard rule 8, inline-start not full-width), the **shelf summary + coverage %** (a big `%` stat + "N of M
books" — OR, while a just-linked integration awaits its first sync, a **"First sync in progress"** pending
state with a spinner; the stat box + card reserve a stable min-height so the pending → coverage swap never
reflows the requests wall below, ADR-015; the client polls `status`/`shelf`/`requests` every ~4 s while
`last_synced_at` is null, then stops), and the **requests/Missing wall**
(a card grid: a book KindIcon tile, title/author, two per-format `PhaseChip`s [requested→info,
wanted→warning, grabbed→progress (blue), landed→success, missing→danger], and a fixed-height action
slot: a plain "Search again" `.btn.sm` on a Missing routable request [non-destructive ⇒ NOT a
ConfirmButton], "In your library" / "Queued — searching" / the comic note otherwise). The
`/admin/roles` grid gains an Integrations toggle column (2-state Enabled/Disabled).

## Alternatives considered

- LL-native wishlist (config-only): rejected (ADR-055 option A — Prowlarr fullSync clobber, not
  per-user, no app-side observability).
- Storing request/Missing state on `books_items`: rejected — ADR-046 keeps the mirror pure.
- Rendering external Goodreads cover images on the wall: deferred — CSP-safe KindIcon tiles for the
  MVP (cover-proxy art is a polish item).

## Test strategy

- **Unit (no DB):** RSS parse (CDATA / sparse / isbn13 / id-less skip), vanity resolve via redirect,
  GB enrichment (isbn hit / title fallback / comic classification / 503 retry-backoff), LL client
  (getBook shapes, addBook/queueBook/searchBook params, apikey redaction, retry).
- **Domain (embedded PG):** link/unlink audited (no-op writes no audit), library matcher, the full
  vertical (mirror → mint → both-format queueBook push → comic parked → Skipped→Missing reconcile →
  coverage 1/3=33%), audited manual re-search fires a real searchBook.
- **API (embedded PG):** section gate (unauth 401 / non-admin FORBIDDEN / opted-in read_only ok),
  link resolve+probe+persist, private-shelf → 422.
- **e2e (hermetic):** stub Goodreads RSS + stub LL in the harness; spec covers link → run
  `goodreads-sync` → requests/Missing wall + coverage → manual "Search again" asserts the LL stub
  recorded a `searchBook`.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | ISBN match against `books_items`? | Deferred — the mirror has no ISBN column; normalized-title match for MVP (ADR-055 C-06). A books-sync ISBN column enables it. |
| Q-02 | Comics acquisition route? | **RESOLVED by ADR-056 / PLAN-046 (see the amendment below):** comics route to KAPOWARR (monitored ComicVine volume + `comic_status` reconcile), no longer merely parked. |
| Q-03 | Exact LL queueBook/searchBook `type` param names? | Sent `type=eBook|AudioBook` (LL DLTYPES vocabulary). Verify against the live LL API at the owner-present acceptance run; adjust in the write client (one place) if needed. |
| Q-04 | read / currently-reading shelves + cross-provider coverage? | Later saga phases (point 3). |

## Amendment — ADR-056 / PLAN-046: comic acquisition (Kapowarr routing)

The comics leg deferred at Q-02 is now built (backend; the full Comics-wall poster redesign is PLAN-045).

- **Data.** `book_requests` gains `comic_status` (the five statuses or NULL), `kapowarr_volume_id`, and
  `comicvine_id` (migration 0046). `comic_status IS NOT NULL` is the durable "is a comic" discriminator; a
  comic's ebook/audio stay `missing` (N/A). A comic that can't be routed (Kapowarr down / no ComicVine match)
  stays PARKED (`unroutable_reason='comic'`, `comic_status='requested'`); once routed `unroutable_reason`
  clears and `comic_status='wanted'`.
- **Routing (goodreads-sync).** A comic resolves to a ComicVine volume via Kapowarr's own search
  (`pickBestVolume` — shared-title-token rank, prefer the ORIGINAL `translated=false` edition), is added
  MONITORED with auto-search, and reconciles its per-volume state back into `comic_status`
  (`mapKapowarrVolumeStatus`). The confined `@hnet/kapowarr/write` surface stays domain-only.
- **Requests wall (the 044 tab, kept coherent).** `RequestCard` renders a comic with a single **Comic** status
  chip (not Ebook/Audio); a parked comic shows the routing note; a routed comic gets the **Search again**
  button. Reflow-free (ADR-015), tokens-only — no layout change. PLAN-045 supersedes this with the poster wall.
- **Force-search dispatch.** `integrations.search` (the endpoint PLAN-045's Library Force-Search button calls)
  routes a comic to Kapowarr's `auto_search` task (`runComicVolumeSearch`) and a book/audiobook to LL's
  `searchBook` (`runManualBookSearch`) — both audited `request_book_search`, both `integrations`-gated with
  server-side ownership re-check. Signature: `search({ requestId: uuid }) → { target: 'kapowarr' | 'lazylibrarian', searched, reason?, formats? }`.

## Amendment — ADR-057 / PLAN-045: the D-06 UI shape is superseded by DESIGN-029

The flat single-page tab this design's **D-06** described (link card + coverage + the text-tile
Requests & Missing wall stacked on `/integrations`) is SUPERSEDED by **DESIGN-029**: `/integrations` is
now a provider-card HUB and Goodreads a `?tab=` sub-section (Overview stats + a Library-idiom Items
poster wall with Helpdesk-semantics shelf chips); the Requests & Missing wall folded into the
sub-section. **D-01..D-05 STAND** (tables, clients, sync flow, API — extended, not replaced): ADR-057
widens the synced shelves to all four (`GOODREADS_SHELVES`, migration 0047 — every shelf acquires, the
owner's A1-overruled ruling), adds the absent-custom-shelf tolerance (A3), and composes the Library
Wanted overlay from `book_requests` (`books.wanted` — the mirror stays pure). Q-04 above is thereby
RESOLVED (read / currently-reading / did-not-finish now sync AND acquire; cross-provider coverage stays
a later saga phase).

## Amendment — 2026-07-15: reconcile via `getAllBooks` + the Skipped-want usenet-first sweep

**The bug.** D-04's reconcile step read per-book LL status with `cmd=getBook` — a command the deployed
LL build (`linuxserver/lazylibrarian:version-40a389ea`) does not have (its API answers
`Unknown command: getBook`). The tolerant ACL schema parsed that error object as an empty book row, so
reconcile had been a **silent no-op since PLAN-044 shipped**: request rows never learned LL's statuses
(`reconciled` counted null-writes). Found 2026-07-15 while verifying overnight MAM landings.

**The fix.** `@hnet/lazylibrarian/read` replaces `getBook(id)` with **`getAllBookStatuses()`** —
one `cmd=getAllBooks` fetch per sync run returning a BookID-keyed map (cheaper than N per-book calls;
immune to per-call GB 503 bursts). A book absent from the map is one LL doesn't know — the request
stays untouched (the honest gap). The e2e LL stub now mirrors the real build: `getAllBooks` serves the
canned statuses and `getBook` answers the real 405 unknown-command shape.

**The sweep (owner-directed 2026-07-15).** A live want whose LL status is **raw `Skipped`** is a book
LL is NOT looking for — the `addBook` race and the pre-`searchBook` PLAN-044 pushes both leave rows in
this state (the RUN-5 field observation: "minted, never actually searched, Skipped in LL"). Reconcile
now **re-queues + re-searches** each such format immediately (`queueBook → searchBook`, paced, request
advances `missing → wanted`, `requestsRequeued` reported): usenet (SAB) grabs it first on LL's
usenet-first provider priority (OPS-013 §5), and MAM only fills gaps when its gate is open — the
PLAN-039 governor still caps that side. **Raw `Skipped` ONLY**: `Ignored` is an owner ruling and
`Matched` means LL believes it already holds a file — neither is ever swept. The dead-end Missing
(+ manual "Search again") UX therefore keys on `Ignored`/unknown books from here on; e2e fixture
`gb-tog` pins `Ignored`.

## Amendment — 2026-07-17: the wrong-work resolve guard + ComicVine overlap floor

**The incident.** "The Serpent and the Wings of Night (Crowns of Nyaxia, #1)" — a prose novel — was
durably classified a COMIC and routed to Kapowarr as ComicVine volume 100145 **"Wings"**, a 1982
Japanese magazine with 319 issues. Two compounding failures: (1) the GB title-search leg queried
`intitle:` with the RAW Goodreads title (series parenthetical included) and trusted `items[0]`
unconditionally — GB resolved a different work whose categories said comic, and ADR-056's durable
`comic_status` then (correctly) refused to let later enrichment outages declassify it; (2)
`pickBestVolume` accepted a single shared token ("wings") as a match for a six-token title. The junk
volume's monitored auto-search then made ~1,500 getcomics requests and rate-limited the pipeline's
egress IP (the Kapowarr 429 storm).

**The guards (all three shipped together).**
1. **De-noised GB query** — `gbQueryTitle` strips the TRAILING Goodreads series parenthetical for the
   `intitle:` leg only; the raw title still feeds `isComicText` and `pickBestVolume`.
2. **Resolve-title guard** — a TITLE-SEARCH resolve (never the ISBN leg) is rejected unless the
   resolved volume's `title + subtitle` covers ≥60% of the query's distinctive tokens
   (`gbResolveTitleMatches`). The GB volume id is BOTH the LL `addBook` key and the comic-classification
   source, so a wrong-work resolve could mint the wrong book or mis-classify — null (an honest,
   retried-next-sync gap) is strictly better.
3. **ComicVine overlap floor** — `pickBestVolume` now requires ≥2 shared distinctive tokens when the
   shelf title has ≥2 (single-token titles like "Hobbit" keep the 1-token path).

**Data repair (live, 2026-07-17):** the request row was un-comic'd (`comic_status`/`kapowarr_volume_id`/
`comicvine_id` → NULL — it re-enters the LL book route on the next sync) and Kapowarr volume 3 deleted.

## Amendment — 2026-09-22: the LL PUSH GUARD — never queue a format LazyLibrarian already holds

**This amendment is normative for EVERY LazyLibrarian acquisition push in the app**, not just D-04's
shelf push: the pairing mint + sweep (DESIGN-036), the find-missing collection force-search — cron AND
on-demand (DESIGN-043 D-14), and the books Force Search (DESIGN-033 D-09). It is recorded here because
D-02/D-04 define the confined write surface and the ordered chain. A FIFTH site — the search-only manual
"Search again" behind the Wanted page's per-format Force Search — is covered by the follow-up at the end
of this amendment; it never queued, and was wrong for the other half of the same LL fact.

**The defect.** `queueBook` is, in the deployed LL build (`api.py::_queuebook`), an **unguarded**
`UPDATE books SET Status='Wanted' WHERE BookID=?` (`AudioStatus` for the audiobook leg). It has no
held-file check of any kind. Every push site issued it unconditionally — D-04's shelf push queued BOTH
formats for every routable want, the 2026-07-15 sweep re-queued any raw-`Skipped` format, the pairing
mint queued the missing format, the hourly find-missing collection pass queued every want our own row
did not call `landed`, and Force Search queued "regardless of landed state". So any push to a
format LL had **already imported** clobbered an `Open` book back into LL's search backlog. There it is
re-searched on every `SEARCH_BOOKINTERVAL` tick, re-found on the same indexer, re-grabbed — and
qBittorrent rejects the grab as a duplicate hash. The book never leaves `Wanted`, and the loop repeats
every day, forever.

**The measurement (live LL sqlite, 2026-09-22).** LL tracked 812 books — 1624 per-format rows:

| format    | `Wanted`, no file | `Wanted`, file + library date | `Skipped`, file | `Snatched`, file | `Open` |
| --------- | ----------------- | ----------------------------- | --------------- | ---------------- | ------ |
| eBook     | 88                | **155**                       | 24              | 10               | 184    |
| AudioBook | 184               | **137**                       | 15              | 19               | 119    |

**564 rows read `Wanted`, and 292 of them were books LL already had on disk** — the daily re-search
engine. Note the third and fourth columns: `BookFile`/`BookLibrary` were set on 39 `Skipped` and 29 `Snatched` rows too, so a
status-only guard is not sufficient — the file signals are load-bearing.

**The guard.** `llFormatAlreadyHeld(status, format)` (packages/domain, beside `mapLlStatus` — the ACL
parses, the domain decides) returns true when the format's LL status is `Open`/`Have` **or** when LL
carries an import date (`BookLibrary`/`AudioLibrary`) or an on-disk path (`BookFile`/`AudioFile`) for
it. The ACL (`LlBookStatus`) now carries those four fields; `getAllBooks`'s projection serves the two
library dates (the file paths ride through when a build serves them). Blank spellings LL actually
emits — `null`, `''`, whitespace, the literal `'None'` — all normalize to "not held".

Three invariants a reviewer must not let regress:

1. **The guard may only ever SUPPRESS a write, never invent one.** An absent book, an unknown status,
   or a failed LL read all mean "not held" → push exactly as before. There is no path where the guard
   causes a push that would not otherwise have happened.
2. **It is per FORMAT, never per book.** A want whose ebook LL holds and whose audiobook it does not
   still pushes the audiobook. Only an all-held want skips whole (`addBook` included).
3. **A suppressed push is not a failure and not a phantom push.** The want is still marked pushed (it
   carries its `llBookId` and leaves the worklist); `requestsPushed` counts only runs that issued real
   writes; the suppression is counted separately and logged.

**Counters + log event.** `SyncGoodreadsReport.pushesSkippedHeld` (rolled up to
`GoodreadsSyncReport.pushesSkippedHeld` and into the `goodreads-sync complete` / `sync finished` log
lines) and `FormatPairingReport.skippedHeld` (mint-push + sweep, already spread into
`format-pairing complete`) count **format legs** suppressed. Each suppression also logs one line whose
_message_ is the snake_case event token **`ll_push_skipped_have`** — deliberately unlike this repo's
prose-message convention, so the event is greppable in Loki as a token rather than a sentence — with a
`site` discriminator (`goodreads-sync.push`, `goodreads-sync.skipped-sweep`,
`format-pairing.mint-push`, `format-pairing.skipped-sweep`), the request + LL ids, and the formats.

**Read budget.** The pairing run reuses its ONE existing `getAllBookStatuses` (D-18's seat-gate read
now feeds a third consumer — zero extra calls). The shelf sync takes a **second** `getAllBooks`, before
the push, and only when there is something to push: one snapshot cannot serve both honestly — a
pre-push snapshot would reconcile freshly-pushed wants from stale rows and re-sweep the very formats
that run just queued. It is an LL sqlite read, not a Google Books leg. Force Search takes one read per
user click, already bounded by the ADR-080 media-action budget enforced before it.

**What is NOT guarded, deliberately: the books Fix (DESIGN-033 D-05).** A Fix is the user asserting the
copy on disk is defective and asking for a replacement, with a durable `book_fix_requests` row and a
reason. Making LL want that book again is the _point_, so Fix keeps the unguarded chain. It is now also
the only sanctioned way to make LL re-acquire a format it already holds — which is what the Force
Search decline points users at.

### Follow-up — 2026-09-22: the SEARCH-ONLY leg (`runManualBookSearch`) declines too

The amendment above enumerated four LL sites, every one of which **queues**. There is a fifth, and it was
missed because it does not. The audited manual
"Search again" (D-06's `runManualBookSearch`, which the Wanted detail page's per-format Force Search
fires through `integrations.search` / `books.searchPairingWant`, DESIGN-029 amendment-2 / DESIGN-038
D-13) calls `searchBook` **alone** and has never called `queueBook`. It therefore never clobbered LL's
state and is **not** part of the 292-row measurement above. It was still wrong, for the _other_ half of
the same LL fact: `searchbook.py::search_book` only enqueues a book whose `Status`/`AudioStatus` is
literally `'Wanted'`, so a `searchBook` aimed at a format LL has filed (`Open`, or a `Skipped`/`Snatched`
row with a real file) is a **silent no-op** — LL drops it on the floor — while the UI reported "Search
fired". That is a claim the user has no way to check, on the surface where our own `book_requests` mirror
is most likely to be the thing that is stale (it is why they are on that page at all).

So the search leg now reads the same snapshot, drops the formats `llFormatAlreadyHeld` reports, and
returns `{ searched: false, formats: [], reason: 'already_held' }` when that leaves nothing. The three
invariants hold unchanged — suppression only (a failed LL read searches everything, exactly as before);
per format, never per book (a held ebook + a missing audiobook still searches the audiobook); and a
decline is not a failure. The **audit is untouched**: `recordManualSearch` commits the
`request_book_search` row before any of this, so a declined click is still recorded, as it always was.
The pre-existing reason-less "nothing fired" (every candidate format already reads `landed` in OUR row)
is a different statement — about our mirror, not LL's shelf — and keeps its own copy.

**The one-book read is now shared.** `readLlHeldSignals(ll, llBookId)` (packages/domain, beside the
predicate) is the single per-click read for both click sites — the same `getAllBooks` snapshot, narrowed
to one BookID, with the degrade-to-`undefined` catch in one place instead of two. `runBookItemForceSearch`
was refactored onto it in the same change; there is no second LL call pattern, and no `getBook` (the
deployed build answers `Unknown command`).

## Amendment — 2026-10-03: ONE `searchBook` per book per run (issue #644)

LazyLibrarian's `cmd=searchBook&id=<id>&type=<eBook|AudioBook>` **ignores `type`**. In LL's
`api.py::_searchbook` the parameter only becomes the `library` argument of `searchbook.search_book`, which
uses it for log text; the search itself covers every format of the book whose `Status` or `AudioStatus` is
`Wanted`. Calling it once per format therefore searched a book wanted in both formats twice, and every
indexer saw every query twice (seen live 2026-10-02: both formats of one book searched twice within two
seconds). Hitting an indexer twice for the same thing is the owner's "very bad".

The rule now, at every call site that can reach more than one format of the same book in one run:

- **`syncGoodreadsIntegration`** queues every needed format first (`queueBook` per format, still mandatory),
  then calls `searchBook` **once per `llBookId`**. The push leg and the Skipped-want sweep share one
  per-run `LlSearchCoverage` map (llBookId → formats a search already covered), so a book the push just
  searched is not searched again by the sweep, and a second request row for the same book (another
  user's want) is marked pushed without a second `addBook`/`queueBook`/`searchBook`. The cron caller
  (`syncGoodreads`, packages/sync) passes ONE map to every integration it syncs in the run, so two users
  wanting the same book cost one search, not two.
- **`runManualBookSearch`** (the wall puck, both formats not yet landed) fires one `searchBook` for the
  formats it covers; its result still lists every covered format.
- **The collection force-search** (DESIGN-043 D-14) groups its worklist by `llBookId` — see its amendment.

`searchBook` keeps its `format` argument (the wire shape is unchanged and LL tolerates it); callers pass
the first covered format and must not rely on it narrowing the search. **Bookkeeping is per format and per
request row, unchanged:** every row a shared call covered still gets its own `last_searched_at` stamp
(the cooldown) and its own audit row; only the LazyLibrarian call is shared. A call that fails leaves every
row it would have covered un-stamped, so the next run retries them all.

### Follow-up — 2026-10-03: the cross-job leg (format-pairing, and a shared `last_searched_at` signal)

goodreads-sync, `format-pairing` and the collection force-search run as **separate cron jobs**, so they
cannot share the in-memory coverage map above. They share `book_requests.last_searched_at` instead
(`recentlySearchedLlBookIds`, `stampRequestsSearched`, `llRecentSearchCovers` in `book-requests.ts`):

- **Every leg stamps the rows it searched** (goodreads push + Skipped sweep, pairing mint-push + sweep,
  force-search as before). The stamp is unaudited, like `markRequestPushed`.
- **Each unattended leg skips only the `searchBook`** (never `queueBook`) when the book was searched by any
  row within `LL_RECENT_SEARCH_WINDOW_MS` (1 hour) **and** LazyLibrarian already shows every format the leg
  would search as raw `Wanted`. That condition is what makes the skip safe: a search covers exactly the
  formats that were `Wanted` when it ran, so a format the leg is about to flip to `Wanted` (the common
  pairing case, where the missing format is `Requested`) is never skipped. The on-demand collection Force
  Search never skips — the caller asked for the search now. A skip is logged as `ll_search_skipped_covered`.
  In the collection force-search the rows a recent search covered are stamped (the cooldown settles them)
  but **not audited and not counted as `searched`** — nothing was asked of LL by that pass — and are
  reported as `skippedRecent`. That cooldown stamp is also read as search recency, so one chained skip can
  extend the same-hour window to at most about two hours after the last real `searchBook` (bounded, one link
  only: the pairing and goodreads legs stamp only rows they actually searched). It errs toward fewer
  indexer hits, which is the safe direction, and the stamp cannot be separated from the cooldown without a
  new column.
- **`format-pairing`** also shares a per-run, per-format coverage map between the mint push and the Skipped
  sweep (one search per book and format per run, including two wants that reuse one `llBookId`; a second
  want flipping the OTHER format is still searched).
- An LL read failure leaves the status map empty, so nothing is ever treated as covered: the rule may only
  remove a call, never add one.

## Amendment — 2026-10-03: the OMNIBUS guard on the title-search resolve

**What happened.** The resolve-title guard above compares the query to the volume's `title + subtitle`. An
omnibus lists its contents in the subtitle, so a lookup for ONE member of a set covers its own tokens and
resolves to the whole bundle. Live: the Odd Thomas collection's missing "Odd Interlude #1/#2" resolved to *The
Odd Thomas Series 7-Book Bundle* and *The Complete Odd Thomas 8-Book Bundle*, which the collection force-search
then added to LazyLibrarian as Wanted and searched (seven books already owned individually). A format-pairing
want for the library file "Dean R Koontz - Winter Moon" resolved to a compilation titled "Dean Koontz" with the
subtitle "Winter Moon; Icebound", and Libretto's resolve broker shares the same guard shape.

**The guard.** `gbIsOmnibusVolume` (`@hnet/goodreads`) runs in the TITLE leg of `resolveVolume` only (an
exact ISBN hit is never second-guessed) and returns null (an honest gap, retried next sync) when the resolved
volume carries a packaging marker (bundle, omnibus, box/boxed set, compendium, starter
pack or "N-Book" in the title or subtitle; "collection" or "trilogy" in the title only, because a single
novel's subtitle often reads "The Grisha Trilogy, Book 1") or a contents-list subtitle (a `;`, or four or more comma-separated parts), **unless the query
itself carries the same signal** — a want for a "Complete Collection" boxed set must still resolve to one.
Libretto's resolve broker got the identical guard in its own repo.

**Data repair (live, 2026-10-03).** The two bundle LL rows were set Skipped (eBook); the two collection wants
were cleared of the bundle id and parked with `unroutable_reason='wrong_volume'` (which the collection
force-search and `isRequestSearchable` already treat as not searchable), so a stale resolve can never push
them again. Duplicate-volume wants (Julius House, The Sea and Little Fishes, the Dark Artifices boxed set) were
repointed to the canonical LL row, and the two pairing wants for junk-titled duplicate Kavita files were
repointed with the audio format marked landed (the audiobook is held under the paired twin).

**Bundle audit (later 2026-10-03).** Every LazyLibrarian row with a format Wanted and a bundle pattern was traced to
its want: 2 wants repointed to the single volume, 20 parked `wrong_volume`, 21 bundle formats set Skipped. That
includes the Dark Artifices boxed-set wants above, now parked: the recipe lists the boxed set next to its three
novels and all three audiobooks are held, so it only duplicated held books. Parking a pairing want took a code fix
first (DESIGN-036 amendment of the same date). Record: `.agents/context/2026-10-03-bundle-audit.md`.

## Amendment — 2026-10-04: a want whose LazyLibrarian book is gone (issue #665)

**What was seen.** About 900 open wants pointed at LazyLibrarian ids that `getAllBooks` does not return (747
pairing, 103 collection, 51 goodreads on 2026-10-04). The 2026-07-15 amendment above treats a missing id as "LL
doesn't know this book, the request stays untouched", so every reconcile skipped them: they read `wanted` or
`grabbed` forever, and nothing pushed them again, because each mint pushes only a `requested` format.

**Why the ids are gone.** `getAllBooks` is complete: it is LazyLibrarian's whole `books` table joined to
`authors`. The ids are not in that table any more. LazyLibrarian deletes books on its own:

- At every start, `dbupgrade.check_db` recounts each author with `TotalBooks = 0` (`update_totals`, which counts
  through the `bookauthors` table) and deletes the ones still at zero ("Removing N authors with no listed books").
  `books.AuthorID` references `authors` with `ON DELETE CASCADE`, so the author's books go with it.
- `cmd=addBook` (`gb.py::add_bookid_to_db`, the call every app push makes) creates the author but never writes a
  `bookauthors` row. An author LazyLibrarian knows only through books the app added therefore counts zero, and
  the next LazyLibrarian restart deletes that author and every one of those books.

Evidence (read-only, 2026-10-04): the restart at 2026-10-03 19:47Z logged "Removing 25 authors with no listed
books"; 216 pairing wants were last found by the 2026-07-30 05:32Z pairing run and never again, 159 of them with
LazyLibrarian snatch history under the same id (Orson Scott Card 39 wants, V.C. Andrews 27, John Grisham 23); those
authors were re-created on 2026-09-22 holding none of the old books. Only about 60 of the 900 have a row under
another id with the same title and author (a re-key); the rest have no row at all. Only 46 were still in the
2026-08-09 backup. The 80 collection wants never force-searched (`last_searched_at` NULL) were never handed to
LazyLibrarian and are not part of this. The LazyLibrarian fix (write the `bookauthors` row on `addBook`, and never
delete an author that still owns a book) is a patched-file overlay in `haynes-ops`, like the earlier
`librarysync.py` and `searchbook.py` fixes. Record: `.agents/context/2026-10-04-ll-gone-wants.md`.

**What it cost.** The goodreads and pairing legs made no LazyLibrarian call for these wants. The collection
force-search did: each 12-hour (now 7-day) cooldown re-added a lost book (`addBook`), queued and searched it, and
the next LazyLibrarian restart deleted it again. Its audit rows show 276 such chains in the 7 days to 2026-10-04, on
16 books, plus LazyLibrarian's own daily search of each while it existed.

**The rule** (`packages/domain/src/ll-gone.ts`; run by the format-pairing reconcile, the goodreads-sync reconcile
and the collection force-search cron):

1. **Gone.** A want is gone when its id is absent from a **non-empty** `getAllBooks` snapshot (an LL error answer
   parses to an empty map and decides nothing), it has a format we pushed that has not settled (`wanted` or
   `grabbed`; for a collection want, its active format, which stays `requested` through its force-searches), and
   LazyLibrarian has not shown it for **24 hours** (`LL_GONE_GRACE_MS`), measured from `last_reconciled_at`
   (stamped by the push and by each reconcile that finds the book). A collection want has no such stamp, only
   `last_searched_at` from its force-search, which the cron renews every cooldown, so its grace is **1 hour**
   (`LL_GONE_COLLECTION_GRACE_MS`, and never more than half the cooldown): a longer one would never be reached and
   the cron would keep re-adding the lost book. `addBook` runs with `wait`, so an hour is plenty. A want pushed
   this run carries a fresh stamp, so the grace keeps it out.
2. **Re-key first.** When the same snapshot holds exactly one row whose title matches (normalized, subtitle kept,
   so "The Kane Chronicles: Survival Guide" never matches "The Kane Chronicles") and whose author agrees (the want
   must have one), and that row already holds the want's format or shows it `Wanted` or `Snatched`, the want is
   repointed to that row and reconciled from it through `applyRequestReconcile`. A matching row that holds the
   format `Skipped` is not used here: the next Skipped sweep would queue and search it, so the want settles
   instead and that re-key waits for a person's Search again (rule 5).
3. **Otherwise settle.** Each such format becomes `missing`: the dead-end Missing state the walls already show,
   with Search again. This deliberately overrides the no-regress rule: a `grabbed` format whose book row is gone
   has no row for LazyLibrarian to import into. (Follow-up, v0.105.5: the pairing reconcile reads every open
   want's format from its anchor's media kind and sets the anchor-held format `landed` where it was not, see
   DESIGN-036's amendment of this date.)
4. **No LazyLibrarian call.** Detection, re-key and settle use the snapshot the reconcile already read. The
   collection cron reads it once per run (only when a candidate exists) and hands it to its worklist, which no
   longer reads its own. It settles across every find-missing collection regardless of cooldown, so the backlog
   settles on the first run; its gather then skips `missing` wants.
5. **Recovery is a person's search.** `runManualBookSearch` (Search again, and the Wanted detail page's
   per-format Force Search) used to fire `searchBook` alone, which LazyLibrarian ignores for a book it does not
   hold. When its snapshot is non-empty and lacks the book: if LazyLibrarian holds the same book under another id
   (the rule 2 match, whatever its status), the want is repointed and reconciled from that row, and the formats
   that row does not hold are queued and searched there (`rekeyedTo`, no `addBook`); otherwise the book is re-added
   (`addBook`, `queueBook` per format, the one `searchBook`, `reseated: true`). Either way the searched formats read
   `wanted` again. A failed or empty read keeps the old search-only call. The on-demand collection Force Search re-adds a settled collection want and
   returns its active format to `requested`.
6. **`addBook` only seats a book LazyLibrarian does not hold, at every push site** (DESIGN-039 D-18 was pairing
   only): `add_bookid_to_db` is an upsert that resets BOTH formats to the new-book status (`Skipped`) on a book it
   already holds, which dropped the other format's `Wanted` (and overwrote an imported format's status). The
   collection force-search, the books Force Search and the books Fix now skip it when their snapshot holds the
   row; a failed read keeps the old always-`addBook`.

Each run report carries `llGoneRekeyed` and `llGoneSettled`; each changed want logs `ll_book_gone` with its
`site` and `outcome`. Re-acquiring the settled wants in bulk is not automatic: a paced re-push of hundreds of
books is an indexer-load decision for the owner: ruled the same day (issue #668), next section.

## Amendment — 2026-10-04 (later): re-request every settled want once (issue #668, owner ruling)

**The ruling** (Tom, 2026-10-04, "Add them all back now", replacing an earlier "people's now, the rest about 20 a
day"): every want the rule above settled `missing` is handed back to LazyLibrarian **once**, goodreads, pairing and
collection alike, all at once, with no daily budget. The SEARCH rides LazyLibrarian's own daily backlog search
(category-only, one query per wanted format per indexer, the DELAYSEARCH back-off; haynes-ops #3322 / #3328), never a
per-book `searchBook` from the app. A lost format the library or LazyLibrarian already holds is settled `landed`
instead. A want lost again after its re-request stays settled `missing`.

**How** (`runLlRerequests` in `ll-gone.ts`, run last by each unattended job on the snapshot it already read: the
format-pairing run, the goodreads-sync reconcile, the collection force-search cron):

1. **Eligible:** the re-request not ended (`ll_rerequested_at` NULL, migration 0089), not parked, the id absent from
   a non-empty snapshot, and at least one of the want's own formats `missing` (both for goodreads; the
   anchor-missing one for pairing, on an anchor still in the library; the active one for a collection want of a
   find-missing collection). Fewest refusals first, then oldest.
2. **Held lands, no LL write:** a pairing anchor that is paired now (the library holds the format); a format the
   re-key match (same title, agreeing author) holds in LazyLibrarian (the want is repointed there). A goodreads want
   the library holds was already landed by the library match; a collection member the library holds was already
   dropped by Libretto's missing list.
3. **Hand back:** where LazyLibrarian holds the book (the re-key match), `queueBook` on that row, no add. Otherwise
   `addBook` (`wait`: it answers `true`, or `false` when LazyLibrarian refused), then `queueBook` once per (book,
   format) unless the row already reads it `Wanted` or `Snatched`. Paced; **never `searchBook`**. One more
   `getAllBooks` confirms each add. The want reads `wanted`, and `ll_rerequested_at` (never cleared) plus
   `last_reconciled_at` are stamped; a collection want also gets `last_searched_at`, so its force-search cooldown
   keeps the cron's own `searchBook` off it.
4. **Refusals are retried, a few times:** an add answered `false` (or a book that never appears) is a refusal: no
   queue, the want stays `missing`, and it is stamped (`ll_rerequest_failed_at`) to wait for the next Google Books
   quota-day (07:00 UTC). Three refusals in a row stop the pass's adds; when an add already went through that
   quota-day (`ll_rerequest_added_at`, migration 0090: set only by a real `addBook`, never by a queue-only hand-back)
   they are the shared quota running out, so they are NOT counted, otherwise they count. A refusal
   followed by a successful add (or one or two trailing ones) counts (`ll_rerequest_failures`). Stamping every
   refusal keeps a few refused books from blocking the rest. The third counted refusal ends its re-request.
5. **The Google Books key is shared, so adds are gated:** LazyLibrarian's `addBook` looks the volume up on the SAME
   Google Books key the app uses (verified 2026-10-04 by hash; the 2026-07-19 note in `gb-call-budget.ts` says the
   key was split, but LazyLibrarian's config carries the app's key), and the app already spends about 900 of its
   1,000 daily queries. So adds wait while the app's quota breaker is open, three refused adds in a row end a pass's
   adds, and the pairing and collection passes defer their adds while a person's (goodreads) re-request is still
   waiting (on a linked integration whose shelf a sync read within 26 hours, so a shelf that keeps failing to read
   cannot hold them back), so people's wants get the quota first. Deferred wants count in `llRerequestDeferred` and are untouched.
   In practice the re-adds drain over several quota-days, not one run, unless LazyLibrarian gets its own key
   (issue #674, an owner decision).
6. **A person's Search again is separate:** it still re-adds and searches on demand.

**What it costs:** no app-side search. LazyLibrarian's daily backlog run searches each newly `Wanted` format like any
other, one query per format per indexer: about 840 formats in all (716 pairing, 100 goodreads from 50 wants, 23
collection), spread over the days the adds take. Report fields `llRerequested`, `llRerequestLanded`,
`llRerequestNotAdded`, `llRerequestDeferred`; each changed want logs `ll_rerequest` with its `outcome`. The
goodreads push leg also stopped calling `addBook` for a book LazyLibrarian holds (rule 6 of the amendment above, the
site the first pass missed).

## Amendment — 2026-10-05: a request is never satisfied by another volume (issue #693)

**What happened.** A want reads `landed` from the per-format status of the LazyLibrarian book its `ll_book_id` names,
and every push site queues that book. The 2026-10-05 cross-volume repair found wants pinned to another volume or
another work, reading `landed` for books the library does not have. Four mechanisms put them there:

1. **The resolve guard ignored volume numbers.** The title-coverage guard drops numbers and the words "book", "vol" and
   "part", so "Court of Thorns and Roses bk 2" covered *A Court of Thorns and Roses* (book 1) at 3 of 4 tokens.
2. **The pairing reuse key cut subtitles.** `normTitle` cuts at the first `:`, so "Mistborn: Wax & Wayne" and
   "Mistborn: Secret History" reused the id of *Mistborn: The Final Empire* (DESIGN-036 amendment of this date).
3. **A want kept its id when its anchor became another book.** The 2026-09-29 library repair renamed audiobooks
   ("Court of Thorns and Roses bk 2" became *A Court of Mist and Fury*, "Shadowhunter Academy" became *Midnight Sun*),
   and #661 re-keyed Kavita series on the book they hold. The mint replaced the title snapshot but kept the id, so the
   Twilight series' want read "Breaking Dawn" on Twilight's id. Read against the live mirror (2026-10-05 14:27Z):
   95 pairing wants whose title no longer names their anchor's book. 73 of them hold an id that does not name the new
   book, or one LazyLibrarian no longer has.
4. **A collection resolve named another work.** Libretto's broker resolved the member "Terry Pratchett: The BBC Radio
   Drama Collection" (ISBN 9781785298226) to *Terry Pratchett's Discworld* (`YVfJMgEACAAJ`). LazyLibrarian searched
   that vague title and took 32 Discworld releases for it (repaired 2026-10-05). The broker now answers `no_match` for
   that member.

**The rule.** A want is never landed from, and its book is never queued on, a LazyLibrarian book that names another
volume or work. One pure check (`ll-book-check.ts`) reads the title LazyLibrarian holds for the id: `BookName` and
`BookSub` (now in the ACL row) and `AuthorName`, from the `getAllBooks` snapshot every job already takes.

- **Lenient (`llBookMismatch`), for a want whose title is current.** It reports a mismatch only on clear evidence:
  - `volume`: the want names its volume and the book names another one, or names none when the want's volume is not
    the first (`volumeNumbersAgree`).
  - `work`: the two titles share no distinctive word once both authors' names, stop words and numbers are set aside.

  A title that differs only in decoration matches ("Caliban's War: The Expanse, Book 2" and *Caliban's War*, "The
  Globe" and *The Science of Discworld II: The Globe*).
- **Strict (`llBookNamesTitle`), for a want whose identity changed.** The old id is kept only when LazyLibrarian holds
  it under exactly the new title, decoration aside.
- **The volume a title names (`titleVolumeNumbers`, `@hnet/goodreads`).** It is a marked number in the main title
  ("bk 2", "Book Two", "Vol. 3", "#4") or at the start of a later colon segment ("Beacon 23: Part Four: Company").
  These are series positions, not the title's own volume, and never count: a later segment ("Caliban's War: The
  Expanse, Book 2"), a trailing series parenthetical, a leading index ("Lily Bard #05 - "), and "Book N of …".
  On the candidate side any marked or bare number counts, except a count after "of" ("Book 1 of 2" names volume 1).
  Roman numerals are not read.

**Where it applies.**

- **The Google Books resolve (mechanism 1).** `resolveVolume`'s title leg refuses a volume whose title and subtitle
  disagree on the volume (`volumeNumbersAgree`), read off the original title so the pre-colon fallback cannot drop the
  number. This covers goodreads-sync, format-pairing and book-fix. An exact ISBN hit is still never second-guessed.
- **Pairing (mechanisms 2 and 3).** See the DESIGN-036 amendment of this date: the identity check, the reuse key, the
  resolve check, and the reconcile guard.
- **Collection (mechanism 4).** See the DESIGN-038 D-13 amendment of this date: the force-search parks a mismatched
  want, and a park holds through the wants pass.
- **Goodreads.** The push skips a want whose pre-push book mismatches: no `addBook`, `queueBook` or `searchBook`, and
  the want stays `requested`. The reconcile skips `applyRequestReconcile` and the Skipped sweep for one. Both log
  `ll_push_skipped_wrong_volume` / `ll_book_mismatch`. No status is changed at run time. The one-off repair below
  re-points the one goodreads want found.

**An empty snapshot decides nothing.** An LazyLibrarian error answer parses to an empty map, and a book absent from
the snapshot gives the check nothing to read, so the lenient check passes (the gone rule of 2026-10-04 owns absent
books). The pairing identity check runs only on a usable snapshot (`llSnapshotUsable`).

**The repair (one-off, `wrong-volume-requests-repair.ts`, `--dry-run` then `--apply`).** It runs
`repairWrongVolumeRequests` (`@hnet/domain`, every write through a guarded single writer, no LazyLibrarian call):

- pairing wants on a live anchor: the DESIGN-036 identity check;
- collection wants whose book mismatches: parked `wrong_volume`, the id cleared (both BBC Radio Drama Collection rows);
- goodreads wants whose book mismatches: re-pointed to the shelf item's current Google Books volume and re-opened
  `requested` when that is another id, else settled `missing`;
- the two Mistborn sequel wants on removed Kavita anchors: the id cleared, the missing format settled `missing`;
- (v0.107.2) the four Chroniken der Unterwelt pairing wants the cross-volume repair parked `wrong_volume` with a
  direct write: conformed through `settleParkedPairingWant`. They stay parked with no id, and the missing format no
  longer reads `landed`/`wanted` from the German omnibus: `missing`, or `landed` when the anchor is paired. Pairing
  parks write no audit row; they are the unaudited sync class.

Rows pointing at `ik6xzgEACAAJ`, which the cross-volume repair owns, are skipped. Record: HANDOFF, 2026-10-05.

## Amendment — 2026-10-05 (later): a `landed` format stays truthful (issue #715)

**What was seen.** The Goodreads request for *Azazel* read `landed` for both formats after its library match was
removed (an Italian Kavita series, taken out under the English-only rule) and while LazyLibrarian held neither format
(its book is a Spanish edition: eBook `Skipped`, audiobook `Wanted`, no file). The wall read "have" for a book the
estate does not have, and nothing ever searched for it.

**Why.** Two things made `landed` permanent for a want the library no longer matched:

1. `advanceStatus` never moves a positive status back to a searching one, and every reconcile goes through it. So a
   `landed` set by a library match survived the match, and a `landed` set by a LazyLibrarian `Open` survived LazyLibrarian
   losing the file.
2. `collectTargets` handed only wants with a format still open to the reconcile. A both-landed want was never read
   against LazyLibrarian again, so even a correct rule would not have run on it.

**The rule: `landed` is only true while something holds the format.** For a want the library does not hold
(`matched_books_item_id` NULL), a `landed` format is true only while the LazyLibrarian book the want points at holds it
(`llFormatAlreadyHeld`: `Open`/`Have`, or a library date or file path). Otherwise it leaves `landed` for the status that
is true now, per format:

| What is true now | The format reads |
| --- | --- |
| LazyLibrarian shows it `Snatched` | `grabbed` |
| LazyLibrarian shows it `Wanted` | `wanted` |
| `Skipped`, `Ignored`, `Matched` or no status | `missing` (the dead end that offers Search again; the Skipped sweep below may queue it again) |
| the book names another volume or work (T-280) | `missing`, and nothing is queued on that book |
| LazyLibrarian no longer has the book, past the gone rule's 24 hour grace | re-keyed to the row that holds it, else `missing` (the 2026-10-04 gone rule, now also for `landed`; the #668 re-request then hands it back once) |
| the want has no LazyLibrarian id and no match | `requested`, so the push mints it once a Google Books id resolves |

A want the library still holds is never touched: the match is what lands it, and nothing about LazyLibrarian can change
that. A status LazyLibrarian shows that we cannot read decides nothing, and so does an empty `getAllBooks` read.

**How.**

- `syncShelfRequests` hands a both-landed want without a match to the reconcile (`collectTargets`), and moves a
  `landed` format with no LazyLibrarian id back to `requested`.
- The reconcile (`syncGoodreadsIntegration` step 5) calls `unheldFormatStatus` (pure) per format, before
  `applyRequestReconcile`, and applies the answer through `revertLandedFormats`: the one writer that takes a format out
  of `landed`. It reverts only a format that reads `landed` now, only for a want with no library match, and only while
  the want still points at the id the decision read. It leaves `last_reconciled_at` alone, so the gone grace keeps
  running from when LazyLibrarian last showed the book. Unaudited, like every synced or derived status write
  (`applyRequestReconcile`, `settleRequestLlGone`); each change logs `request_landed_reverted` with its `reason`
  (`ll_not_held`, `ll_book_mismatch`, `no_kapowarr_volume`, `kapowarr_not_held`).
- The gone rule (`decideLlGoneWant`, `settleRequestLlGone`) takes `includeLanded` for a want the library does not hold. A
  re-key is only taken when the new row holds every format that reads `landed`.
- **Comics.** A landed comic with no library match is reconciled against Kapowarr every run (`toRouteComics` used to skip
  it) and leaves `landed` when the volume no longer holds every issue; with no Kapowarr volume at all it goes back to
  `requested`.
- **The Skipped sweep refuses a foreign edition.** The goodreads sweep never re-queues a `Skipped` format whose
  LazyLibrarian book is labelled non-English (`BookLang`, the DESIGN-036 #700 table: blank and unknown still pass). The
  format stays `missing` and a person's Search again can still lift it. Without this, taking Azazel out of `landed`
  would have queued and searched the Spanish edition.
- Report field `requestsLandedReverted` (requests changed this run), on the goodreads-sync and format-pairing reports.

**Other sources.**

- **Pairing** had the same blind spot for the missing format (DESIGN-036 amendment of this date).
- **Collection** has none. A collection want's inactive format is `landed` by construction (the pairing idiom, nothing
  held), and its active format leaves `requested` only through the #668 re-request's held hand-back, after which the
  library import drops the member from Libretto's missing list and the wanted pass deletes the want. Live data on
  2026-10-05: 0 collection wants with an active format `landed`.

**Not decided here.** What an Azazel-like want should ask for when its Google Books volume is a foreign edition is
decided in the amendment below (issue #719).

**Tests:** `packages/domain/__tests__/landed-truth.test.ts` (landed stays landed while held; reverts when the file is
gone, when the library match is gone, when the book names another volume, when LazyLibrarian lost the book, when there
is no book; a library match is never reverted; the comic follows Kapowarr; pairing).

## Amendment — 2026-10-05 (latest): a want on a non-English book asks for the English edition (issue #719)

**What was seen.** After #715 the goodreads sweep refuses to queue a LazyLibrarian book labelled non-English, so *Azazel*
(request `415e4d34`, Google Books volume `PitFPgAACAAJ`, LazyLibrarian `BookLang` `es`) sat `missing` and nothing
looked for the English edition. The same shape can hit any request: the Google Books resolve takes the top title hit
and does not care about its language.

**Ruling (coordinator, 2026-10-05; applies to goodreads, pairing and collection wants).** When a want's LazyLibrarian book
is non-English (the DESIGN-036 #700 table: `foreign` only, blank and `Unknown` still pass), the app looks for the English
edition of the same work. Found: the want switches to it and flows through the existing addBook, queueBook, searchBook
path. Not found: the want is parked `no_english_edition` and nothing is ever pushed to LazyLibrarian for it.

**The English-edition pass** (`runEnglishEditionPass`, `english-edition.ts`). One pass per goodreads-sync run, over every
non-comic request of every origin, from the run's one `getAllBooks` snapshot (an LL database read, no Google Books call).
It runs BEFORE the shelf enrichment, so its lookups take the `goodreads` budget slice first and a switch is pushed by the
same run. A request is due when:

- it has no library match, a LazyLibrarian id, and open formats (`englishEditionOpenFormats`). A goodreads want is
  left alone once either format has landed: a format that landed from the foreign book is a file the library holds, which
  the F10 audit owns, and switching the book under it would make that `landed` untrue. A pairing or collection want has
  one acquired format (the other sits `landed` by construction), so it is every format that has not landed;
- it is unparked and the snapshot says its book is foreign; or it is a pairing want parked `foreign_language` whose
  anchor reads English or unknown and whose book is foreign (a park on the BOOK; an anchor that is itself foreign is the
  anchor's problem and is untouched); or it is parked `no_english_edition` and the book is still foreign or gone (the
  retry);
- it has not been looked at since the quota-day began (`english_edition_tried_at`, migration 0091).

**The lookup** is `GoogleBooksClient.resolveVolume({ title, author, language: 'en' })` with the WANT's own title and
author (the foreign edition's title is no evidence of what was asked for), through `guardedGbResolve` (the shared breaker).
With a language the client: sends `langRestrict=en`; skips the ISBN leg (an ISBN names the foreign edition); skips the
`/volumes/{id}` comic-confirm GET (the want is already known not to be a comic); tries the structured `intitle:` /
`inauthor:` query and, when that finds nothing, the plain words (title and author), because Google Books answers the
structured query for some works with no hit at all (live 2026-10-06: *Azazel*, where the plain words list the English
edition first), so a lookup costs at most four legs (each for the full and the pre-colon title); walks the five hits and takes the first whose own `volumeInfo.language` is positively `en` (or `en-*`) AND that passes
every existing guard (title coverage, omnibus, #693's volume rule, author). The domain then checks the result again
(`acceptEnglishEdition`): it is not the id the want already has, GB does not call it foreign, and `llBookMismatch` (#693's
Volume Check) agrees its title names the want's volume and work. A rejected edition counts as none.

**Rationing (the Google Books budget is about 900 of 1,000 a day).**

- At most ONE lookup per request per Google Books quota-day (07:00 UTC), whatever the answer: `english_edition_tried_at`
  is stamped by the switch, the park and a failed lookup alike, so a lookup that found nothing is not repeated every run.
  A parked want looks again only after seven quota-days (`ENGLISH_EDITION_PARK_RETRY_DAYS`): Google Books gains editions, but
  a work with none today almost never has one tomorrow, and a pairing want whose title is the foreign library title can
  never be answered by an English lookup, so a daily retry would burn the slice on them forever.
- The daily call budget: `GbBudgetTracker.canSpend()` (reserve-before-commit) is checked before each lookup and its legs are
  charged to the `goodreads` slice through the call meter. A budget or breaker refusal is not a lookup: nothing is stamped,
  the want is due again as soon as quota allows.
- A per-run cap (`ENGLISH_EDITION_CAP_PER_RUN`, default 10).
- One lookup per (title, author) per run: a goodreads want and a pairing want for the same work share it (`reused`), each
  applying the answer through its own checks. An error or a quota refusal is not an answer and is never shared. Once the
  cap, the budget or the breaker stops the lookups, a want an answer in hand covers is still settled; the rest wait.

**The writers** (`book-requests.ts`, unaudited, the `revertLandedFormats` class, each guarded on the id the pass read):

- `switchRequestToEnglishEdition`: `ll_book_id` becomes the English volume, every acquired open format returns to
  `requested`, a `foreign_language` / `no_english_edition` park clears, the lookup is stamped. The want is then an ordinary
  never-pushed want: the next push (this run's, for a goodreads want) runs addBook on the English id, queueBook, searchBook.
  `syncShelfRequests` keeps an existing `ll_book_id`, so the shelf mirror's Spanish volume id does not pull it back, and
  `LlRekeyIndex` skips a foreign row so the gone rule cannot re-key onto the Spanish book either.
- `parkRequestNoEnglishEdition`: `unroutable_reason = 'no_english_edition'`, the lookup stamped. Every job already skips a
  parked want (push, reconcile and Skipped sweep, gone rule, re-request, collection force-search). A goodreads want's open
  formats settle `missing` (the honest dead end); a pairing or collection want keeps its working status, like its other
  parks. `syncShelfRequests` preserves this park (it recomputes `unroutable_reason` every run otherwise).
- `liftNoEnglishEditionPark`: a `no_english_edition` park whose book now reads English or unknown (fixed in LazyLibrarian)
  clears; a goodreads want's `missing` formats return to `requested`; the stamp clears. Free: not rationed.
- `stampEnglishEditionTried`: a lookup that failed (a Google Books error), so it is not retried every run.

**Never pushed while foreign.** The pass moves a want off a foreign book, but two other places must not queue it first:

- the goodreads push skips a book LazyLibrarian already holds as non-English, and re-reads the language after the push's
  own addBook seats a new book (LazyLibrarian only labels it then): a foreign one is left as seated (`Skipped`), no
  queueBook, no searchBook, and the want is not marked pushed. Report field `pushesSkippedForeign`, log
  `ll_push_skipped_foreign` (site `goodreads-sync.push`);
- the collection force-search skips a want on a foreign book (report field `skippedForeign`; `last_searched_at` stamped, no
  audit) until the pass has switched or parked it.

**Pairing.** DESIGN-036 parks a pairing want `foreign_language` when LazyLibrarian labels its book non-English at the push or
in the Skipped sweep. The pass takes up exactly those parks whose anchor is not itself foreign. DESIGN-036's amendment of this
date has the pairing side.

**Report fields and logs.** `englishEditions` on the goodreads-sync report (`due`, `looked`, `reused`, `switched`, `parked`, `lifted`,
`skippedBudget`, `skippedQuota`, `skippedCap`, `failed`); logs `english_edition_switched`, `english_edition_none`,
`english_edition_refused`, `english_edition_park_lifted`. The wall shows a parked goodreads want as `missing` with no Search
again (`isRequestSearchable` is false for any park); it does not render the reason yet (a user-visible change, not made here).

**Tests:** `packages/domain/__tests__/english-edition.test.ts` (English edition found and switched, then pushed on the English
id only; none found and parked, the park surviving a sync; another volume and another work refused; once per request per
quota-day; the budget gate; the breaker; the per-run cap; a lifted park; pairing and collection wants; the push guards;
the re-key guard), `packages/sync/__tests__/goodreads-english-edition.test.ts` (the run end to end: Azazel),
`packages/goodreads/__tests__/google-books.test.ts` (the language-restricted resolve).

**First live run (2026-10-06 07:41Z, v0.107.7) and the follow-up.** The first run looked up ten of twelve due wants (the daily
`goodreads` slice had been spent by the enrichment the evening before, so nothing could run until the 07:00Z reset; the pass
runs first so it gets the new day's budget). It switched one and parked nine. Eight of the nine were pairing wants whose title is the foreign
library title ("De Silmarillion", "Der Ritt anc"), for which no English lookup by that title can succeed, so those parks
are right (and why a park now waits a week). The ninth was Azazel, parked wrongly: the structured query returned no hit
for it in any language. The plain-words leg above, and migration 0092 (clears the stamp on every non-pairing
`no_english_edition` park, once), let the wrongly parked wants be looked at again on the next run.

**Cadence (issue #737).** The `goodreads` slice is spent by the shelf enrichment by evening, so in practice the pass makes its
lookups in the first goodreads-sync run after the 07:00Z quota roll and is deferred (`skippedBudget`, nothing stamped) for
the rest of the day: a once-a-day pass of up to 10 wants. A want that turns up mid-day waits for the next 07:41Z run. A
reserved slice charged to the pass first is the alternative if that proves too slow; not taken, to keep the budget as ruled.

## Amendment — 2026-10-06: `grabbed` follows LazyLibrarian, and LazyLibrarian is told when a want is given up (issues #734, #735)

Both found by the adversarial review of the books rollout (issue #731, `.agents/context/2026-10-06-books-rollout-adversarial-review.md`,
findings L-01 and L-02).

### #734: a failed grab stopped reading `grabbed`

**What was seen.** On 2026-10-06 01:55Z, 59 request formats read `grabbed`. Joined read-only against LazyLibrarian: 53
pointed at a book whose format reads `Wanted` with a `Failed` last grab (the oldest from 2026-07-17), 4 were really
`Snatched`, 2 `Skipped`. The wall called them downloading, some for two and a half months.

**Why.** `grabbed` comes only from LazyLibrarian's `Snatched` (`mapLlStatus`). When a download fails, LazyLibrarian marks its
`wanted` row `Failed` and puts the book's format back to `Wanted`; the app's reconcile goes through `advanceStatus`, which
never moves a positive (`grabbed`, `landed`) back to a searching state. #715 added the one writer out of `landed` and left
`grabbed` alone.

**The rule: `grabbed` is only true while LazyLibrarian shows the format `Snatched` (or holds it).** For a request the
library does not hold, an ebook or audiobook that reads `grabbed` reads what LazyLibrarian shows now:

| LazyLibrarian shows the format | The format reads |
| --- | --- |
| `Snatched` | `grabbed` (unchanged) |
| `Open`/`Have`, or a library date or file | `landed` (the reconcile, as before) |
| `Wanted` (the grab failed, or was reset) | `wanted` |
| `Skipped`, `Ignored`, `Matched` or no status | `missing` (the Skipped sweep may queue it again, as for any `missing`) |
| the book names another volume or work (T-280) | `missing` (a download of another work is not this want's) |
| LazyLibrarian no longer has the book | the gone rule (T-279), which already settles `grabbed` |

**How.** No new writer: `revertLandedFormats` (the #715 writer, `book-requests.ts`) is widened. It still takes a format
out of `landed` to any status a caller names, and now also takes an ebook or audiobook out of `grabbed` when the answer is
`wanted`, `missing` or `requested`; never `grabbed` to `grabbed` or `landed`. Same guards (no library match, the id the
caller read), same transaction discipline, unaudited like every synced status write. The goodreads reconcile already passed
`unheldFormatStatus` for every format before `applyRequestReconcile`, so the widened writer fixes that path as it stands;
the pairing open-want reconcile now does the same for its missing format (DESIGN-036 amendment of this date). Each change
logs `request_grab_reverted` (separate from `request_landed_reverted`); report field `requestsGrabReverted` on the
goodreads-sync and format-pairing reports. A comic's `grabbed` is untouched (Kapowarr's reconcile owns it).

**No grace.** LazyLibrarian never reads `Wanted` between a snatch and its import: the format stays `Snatched` until the
post-processor writes `Open`, and only a failure path writes `Wanted` ("reset status so we try for a different version",
`postprocess.py` in the pinned build). A one-run flip is
possible only when one job decides from a snapshot older than another job's newer one (the #715 class); the next run
corrects it.

**The census.** format-pairing reports `grabbedNotSnatched` every run (log `request_grabbed_not_snatched` with the rows):
live request formats of every origin that read `grabbed` while LazyLibrarian shows them neither `Snatched` nor held.
Expected 0 after each run's reconciles; a non-zero value names wants the reconcile could not judge (another volume, a lost
book within its grace).

### #735: LazyLibrarian is told when the app gives a want up

**What was seen.** LazyLibrarian had 367 books with a format `Wanted` or `Snatched`, and 22 of them had no request pointing at
them: books the app had queued for a want it later re-identified (79 re-identifies in three days) or parked
(`foreign_language`, `no_english_edition`), and stopped looking at. LazyLibrarian searched each of them every day, one query
per indexer, and could still grab the wrong work (the #686 shape). The twelve `foreign_language` parks of 2026-10-05 had to
be unqueued by hand.

**The rule: when the app gives a want up, the LazyLibrarian format it had queued for that want is unqueued, unless another
live request still asks for that book and format.** "Gives up" is every writer that ends the app's own work on a book for a
want:

| Writer | Release reason |
| --- | --- |
| `reidentifyPairingWant` (`clear`), and `upsertPairingWant` re-pointing a want to another id | `reidentified` |
| `parkPairingWant` (`foreign_language`, `multi_book`, `no_book`) | `parked:<reason>` |
| `parkCollectionWant` | `parked:wrong_volume` |
| `parkRequestNoEnglishEdition` | `parked:no_english_edition` |
| `switchRequestToEnglishEdition` (the foreign book) | `english_edition_switched` |
| `syncCollectionWants` dropping a want (member held, or a pairing want carries the work) | `collection_want_dropped` |
| `upsertShelfItems` tombstoning a shelf item (the person took the book off the shelf) | `shelf_removed` |
| `unlinkIntegration` | `unlinked` |
| the #693 one-off repair writers (`reopenWrongVolumeRequest` re-pointing, `settleRemovedAnchorPairingWant`) | `repaired:*` |

**"Had queued"** is the app's own evidence that it put LazyLibrarian to work for that want (`llQueuedFormats`): a goodreads or
pairing format reading `wanted` or `grabbed` (only a push or a re-queue sets those), or a collection want's format that was
force-searched (`last_searched_at`) and has not landed. A format the app never queued (`requested`, a settled `missing`,
`landed`) records nothing, so a book a person queued by hand under the same id is never the app's to unqueue.

**The LazyLibrarian Release (T-283).** The writer records the book and format in `ll_format_releases` (migration 0093) in
the same transaction as the write that gives the want up (`recordLlReleases`, `ll-release-record.ts`). Each goodreads-sync
run (once, after every integration) and each format-pairing run (after its mints, pushes and reconcile) drains the table
(`drainLlReleases`, `ll-release.ts`) from one fresh `getAllBooks` read, taken only when a release is pending:

| At drain time | Outcome |
| --- | --- |
| a live request asks LazyLibrarian for that book and format (the owner rule below) | dropped, nothing written (`owned`) |
| LazyLibrarian no longer has the book | dropped (`gone`) |
| LazyLibrarian holds the format | dropped (`held`) |
| the format reads `Snatched` | kept pending until the download ends either way |
| the format reads `Wanted`, and still does when read again just before the write | `unqueueBook` (back to `Skipped`), dropped; log `ll_format_unqueued` |
| anything else | dropped (`not_wanted`) |

An empty or failed read, or a failed `unqueueBook`, decides nothing: the row stays for the next run. Report fields
`llReleasesUnqueued`, `llReleasesSettled`, `llReleasesPending`, `llReleasesFailed` (format-pairing report; `llReleases` on
the goodreads-sync run report); logs `ll_format_unqueued`, `ll_release_settled`.

**The owner rule (`liveLlFormatOwners`) is how another person's request is never cancelled.** A live owner of a book format
is an unparked, non-comic request pointing at that LazyLibrarian id whose formats include it: both for a goodreads want
(while its shelf item is on the shelf and its link is not `unlinked`), the anchor's missing format for a pairing want (a
removed anchor's want included, since the reconcile still works it), the collection's format for a collection want. It is
read at drain time, after the run's own mints and pushes, so a want that took the same book in the meantime keeps it.

**The confined write surface.** `unqueueBook` joins `@hnet/lazylibrarian/write` (`cmd=unqueueBook&id=&type=`), imported only
by `packages/domain`. LazyLibrarian's `_unqueuebook` is, like `_queuebook`, an unguarded
`UPDATE books SET Status|AudioStatus='Skipped' WHERE BookID=?`: it would overwrite an imported or downloading format as
readily, which is why the drain sends it only for a format the fresh read shows `Wanted` and not held, and reads the book
once more right before each write (LazyLibrarian's backlog search could have snatched it meanwhile; there is no per-book
read, so this is `getAllBooks` narrowed, one per unqueue). The window left is the time between that read and the write; a
format snatched inside it still imports (the post-processor works from LazyLibrarian's own `wanted` row), and a failed one
stays `Skipped`, which is where the release was taking it. A re-recorded release always moves `updated_at` forward
(`GREATEST(old + 1 ms, now)`), so the drain, which deletes only the row it read, never drops a release recorded after its
read. No LazyLibrarian database write, only its API.

**Coming back.** Every way back into a want re-queues it through paths that already exist: a lifted `foreign_language` or
`no_english_edition` park and a re-shelved book reconcile, read `Skipped` (`missing`), and the Skipped sweep queues and
searches the format again; a re-linked account does the same; an English-edition switch pushes the English book.

**The census: the Orphan LazyLibrarian Want (T-284).** format-pairing reports `llOrphanWanted` every run, from its snapshot,
after its drain (log `ll_orphan_wanted` with up to 50 `<id>:<format>` keys): LazyLibrarian formats that read `Wanted`, are
not held and have no live owner. It is the measurement the review asked for (R-02). A non-zero value names books a person
queued by hand, or a gap in the release.

**The one-off repair.** The orphans that predate the release are sent back to `Skipped` by
`packages/sync/src/scripts/ll-orphan-unqueue.ts --dry-run|--apply` (`unqueueOrphanLlWants`), run as a frontend Job from the
format-pairing CronJob template, dry run first, with the same last read before each write. Its keep list always holds
`F10_HAND_REWANTS` (`--keep=<id>:<format>,…` adds to it; only `--no-default-keep` drops it): the English records the
2026-10-05 F10 sweep re-wanted by hand to replace removed foreign copies (Solitaire, Israel Potter, Murtagh, The Other
Emily, and the rest named in that HANDOFF block). No request names some of them, so they read as orphans, and they stay
wanted until LazyLibrarian grabs them.

**Tests:** `packages/domain/__tests__/ll-release.test.ts` (#734: grabbed to wanted or missing, never to grabbed or landed,
refused for a library match or a moved id, a comic untouched; the goodreads and pairing reconciles; the census. #735: every
writer records its release and a never-pushed want records nothing; the drain's six outcomes; another live request owns it
(goodreads, a pairing want's own format only), while a removed shelf item or a park does not; a park in a format-pairing run
is unqueued in the same run; an empty read, a failed read and a failed unqueue keep the row; the census and the one-off with
its keep list and dry run), `packages/domain/__tests__/landed-truth.test.ts`, `packages/lazylibrarian/__tests__/client.test.ts`
(`unqueueBook`), `packages/sync/__tests__/ll-orphan-unqueue-script.test.ts`, `packages/db/__tests__/migrations.test.ts`
(0093).

## Amendment — 2026-10-06 (later): the Volume Check covers the title, and a held `Skipped` format lands (issues #739, #752)

#739 is finding L-05 of the adversarial review (issue #731, `.agents/context/2026-10-06-books-rollout-adversarial-review.md`).
#752 was found while fixing #734 and #735. The Google Books budget half of that review (L-06, #740) is DESIGN-036's
amendment of this date.

### #739: the lenient Volume Check is a coverage rule

**What was seen.** `llBookMismatch` (T-280, lenient) called two titles the same work when they shared any one distinctive
word, so two volumes of a series passed on the series name: "Mistborn: Secret History" ⇄ "Mistborn: The Final Empire", "Harry
Potter and the Prisoner of Azkaban (Harry Potter, #3)" ⇄ "Harry Potter and the Philosopher's Stone", "Wild Cards 2: Aces
High" ⇄ "Wild Cards". It is the backstop of the pairing identity check and landed check, the goodreads push and reconcile,
the collection force-search and `acceptEnglishEdition`.

**The rule.** The check now cuts each title into its work title and its series decoration, then asks, in order:

| Step | Verdict |
| --- | --- |
| The want names its volume and the book names another, or none past the first (`volumeNumbersAgree`, unchanged). A whole title that is a series name and a bare number ("Wild Cards 2") names its volume the same way. | `volume` |
| The want's series position and the book's disagree ("Dune (Dune, #1)" ⇄ "Dune Messiah: Dune Book 2"), unless every word of the book's title is the want's (two sources number some series differently: Narnia). A position with a decimal ("#2.5") is no position. | `volume` |
| Either title is only a series designation ("Red Queen Novella #1", "A Court of Thorns and Roses 6", "Harry Potter Boxed Set, Books 1-5"). It names no work to cover, so one shared word is a match, as before. | match or `work` |
| The book's title COVERS the want's work title: 60 percent of its distinctive words (the `gbResolveTitleMatches` ratio), and half of those that are not series-name words. | match |
| The book's title is the want's without its subtitle ("Picasso: A Biography" ⇄ "Picasso", "The Hobbit, or There and Back Again" ⇄ "The Hobbit", "Beacon 23: The Complete Novel" ⇄ "Beacon 23"): the book adds no word, holds the want's whole first part and its number, and the words it lacks do not name a separate work (epilogue, prologue, novella, novelette, prequel, sequel, companion, bonus). | match |
| Otherwise: the book's title is only the series name ("Wild Cards") | `volume` |
| Otherwise | `work` |

The decoration cut: a trailing parenthetical or bracket ("(Harry Potter, #3)"), a leading series index ("Wheel of Time [09]:
", "Lily Bard #05 - ", "02 - "), a first part that is a series name and an index before a subtitle ("Wild Cards 2: Aces
High", "Chroniken der Unterwelt (4): City of Fallen Angels"; not when the title names its volume elsewhere, "Beacon 23: Part
Four: Company"), and a later part that positions the book ("The Expanse, Book 2", "Book One of the Stormlight Archive").
Parts meet at a colon, a spaced dash or ", or". Author names, stop words, numbers and position markers are never
distinctive; a plural and its singular are one word. The strict check (`llBookNamesTitle`) is unchanged.

**Measured before shipping (2026-10-06 07:10Z, read-only).** All 1,282 non-comic requests whose `ll_book_id` LazyLibrarian
holds were judged by both rules against LazyLibrarian's `BookName`/`BookSub`/`AuthorName`. The old rule flagged none. A
plain 60 percent rule flagged 32, about 20 of them the same book under a subtitle LazyLibrarian lacks; the subtitle and
designation steps above come from those. The rule as shipped flags 7, each checked by hand:

| Want | Origin | LazyLibrarian book | Verdict | Hand check |
| --- | --- | --- | --- | --- |
| The Duke and I: The 2nd Epilogue | collection | The Duke And I | `work` | right: the epilogue is a separate novella |
| An Offer From a Gentleman: the 2nd Epilogue | collection | An Offer From a Gentleman | `work` | right |
| On the Way to the Wedding: 2nd Epilogue | collection | On the Way to the Wedding | `work` | right |
| The Heroes of Olympus: The Demigod Diaries | pairing | The Heroes of Olympus, Book Three The Mark of Athena | `work` | right |
| Tolkien's World - Paintings of Middle-Earth | pairing | Tolkien's Middle-Earth (a 44-page postcard book) | `work` | right |
| Ghosts of the Shadow Market 8 | pairing | Ghosts of the Shadow Market (the anthology) | `volume` | right: the anthology is not the member (the omnibus rule) |
| Steel Scars | collection | Small Scars | `work` | Google Books' title for the same novella (same date, 100 pages); the title is all the check sees |

The three pairing wants are re-identified by the next format-pairing run (id cleared, re-minted, refused again if Google
Books gives the same book, then the Mint Backoff); the four collection wants are parked `wrong_volume` by the collection
force-search when it next reaches them. `acceptEnglishEdition` judges Google Books volumes at lookup time, so it has no
stored population to measure; its tests run unchanged.

**Known gap.** A want "<series>: <volume title>" against a book titled only by the series name ("Diary of a Wimpy Kid:
Rodrick Rules" ⇄ "Diary of a Wimpy Kid") still passes: it is textually the "Picasso: A Biography" shape. Telling them apart
needs series data, which neither LazyLibrarian (`series` and `member` are empty) nor the library mirror carries for most
items (15 of 1,075 pairing anchors have a series name). No live want has that shape today.

### #752: a `Skipped` format LazyLibrarian holds a file for lands

**What was seen.** 27 live formats (17 pairing wants reading `missing`, 1 pairing want reading `grabbed`, 9 collection wants
reading `requested`) pointed at a LazyLibrarian format that reads `Skipped` with an import date and a file. The revert
(`unheldFormatStatus`) already kept a `landed` format on those signals, but the reconcile read the raw status through
`mapLlStatus` alone, so a format that was not `landed` yet never got there.

**Verified on disk first (2026-10-06, read-only in the LazyLibrarian pod).** All 27 files exist. The 15 ebooks' OPF title,
creator and language name the want's book in English. The audiobooks' folders and ID3 tags name the want's book. Two
exceptions, neither landed wrongly by this rule: the "Ghosts of the Shadow Market 8" audiobook is the 19-part anthology (the
#739 rule re-identifies that want first, and a mismatched book is never landed from); and LazyLibrarian's `AudioFile` for
"The Voyage of the Dawn Treader" points at part 1 of a Japanese edition (`ナルニア国物語5 …`) stored in the same folder as the
English audiobook (`C.S. Lewis - The Voyage of the Dawn Treader (full color).mp3`, tagged English, and two English library
items). The English copy is there, so the want's audiobook is held; the mixed folder is a data problem, reported on #752.

**The rule: a format lands while LazyLibrarian holds it, whatever its status says.** `llReconcileStatus(row, format)`
(`book-requests.ts`) answers `landed` when `llFormatAlreadyHeld` (`Open`/`Have`, or an import date or file), otherwise the
status through `mapLlStatus`. It is the landing twin of `unheldFormatStatus`: one predicate lands a format and keeps it
landed, so landing and reverting cannot disagree, and a format that lost its file leaves `landed` the next run. Every
LazyLibrarian reconcile uses it: the goodreads-sync reconcile and the Search-again re-key, the pairing open-want reconcile,
and the gone rule's re-key. `getAllBooks` in the pinned build serves the import dates (`booklibrary`, `audiolibrary`) and not
the file paths (`api.py` `_getallbooks`), so the import date is the signal the app reads.

**Collection wants are unchanged.** A collection want has no LazyLibrarian reconcile by design (the #715 amendment above):
it leaves `requested` when the library holds the member and Libretto drops it from the missing list. The 9 collection rows
of #752 are part of a wider gap, 57 collection wants whose LazyLibrarian book holds the file while Libretto still lists the
member missing; that needs its own decision and is issue #759.

**Tests:** `packages/domain/__tests__/wrong-volume-guards.test.ts` (the #739 table, positions, the subtitle and designation
steps, the seven live verdicts, the known gap), `packages/domain/__tests__/landed-truth.test.ts` (`llReconcileStatus`, its
twin property with `unheldFormatStatus`, a goodreads audiobook landing from an import date under `Skipped` and leaving
`landed` when it goes, a pairing `missing` and a `grabbed` landing).

## Amendment — 2026-10-06 (latest): a collection want LazyLibrarian downloaded reads Downloaded (issue #759)

**What was seen.** 59 collection wants read `requested` ("Wanted" on the collection drill) while LazyLibrarian held
their book. The audit (`.agents/context/2026-10-06-held-collection-wants.md`) traced each one. 40 were held by the
library and only read missing because of two bugs, fixed where they lived: the app gave each Audiobookshelf collection the
Kavita missing list (DESIGN-038 D-13 amendment), and Libretto's matcher missed books the library files differently
(DESIGN-037 D-04 amendment). Of the 19 left, 5 are a real gap: LazyLibrarian holds the file and the library cannot show
it, because Kavita's Books library opens epub and pdf only and LazyLibrarian took a `.mobi` or `.azw3` (Eragon, Shatter
Me, We Can Be Mended, Four: The Transfer, Four: The Son). Calling those "Wanted" says the estate is still looking for a
book it has downloaded. The other 14 stay `requested`, truthfully: 7 point at a LazyLibrarian book that is another work
or edition, and 7 are in the library under a title that differs from the member's in words.

**The rule: a collection want's own format reads `landed` while LazyLibrarian has downloaded it and the library cannot
show it.** This supersedes the "Collection has none" note of the #715 amendment and the "Collection wants are unchanged"
note of the #752 amendment, for the collection's own format only. A collection want still exists only while Libretto lists
the member missing from the collection's library, and the wants pass still deletes it once the library holds the member,
so for a collection want `landed` means exactly **downloaded, not in the library yet**. It is decided once an hour, after
the wants pass, and the format reads `landed` while all three hold:

1. LazyLibrarian holds the format (`llFormatAlreadyHeld`: `Open`/`Have`, or an import date or file);
2. LazyLibrarian's book is the member's: the lenient Volume Check finds no mismatch and the strict one reads the member's
   own title (`llBookMismatch`, `llBookNamesTitle`, T-280), so another work's book never says the member was downloaded;
3. the library shows nothing named like LazyLibrarian's book (`libraryShowsTitle` over the live `books_items` of that
   format: the same title, or one containing the other as whole words, the contained side two words or six letters
   long). When it does, the file reached the library and only the pairing failed, and the want stays `requested`.

When any of the three stops holding, the format goes back to `requested`, the collection want's resting status. An empty
or failed `getAllBooks` read decides nothing. The force-search already skips a `landed` format, so nothing searches for a
book LazyLibrarian holds.

**How.**

- `reconcileCollectionWantsDownloaded` (`collection-want-downloaded.ts`), in the `books-collections-sync` job after the
  wants pass and before the force-search, when a LazyLibrarian client is configured. One `getAllBooks`, one read of the
  live library titles. Report field `collectionWantsDownloaded` (`downloaded`, `reverted`, `skipped`); each change logs
  `collection_want_downloaded` or `collection_want_download_reverted`.
- The one writer is `setCollectionWantDownloaded`: the own format to `landed` or back to `requested`, guarded on the want
  still being an unparked, unmatched collection want on the same LazyLibrarian id, and on the format reading what the
  decision was made from. Unaudited, like every synced status write.
- The drill no longer hides a collection want whose own format reads `landed` (`getCollectionWantedBookRequests`). The
  tile's badge reads **Downloaded** (blue, the Grabbed tone; its tooltip "Downloaded, not in the library yet") in place of
  Wanted. The want's detail page shows only the collection's own format (the other sits `landed` by construction, holds
  nothing, and read "Have it"); a downloaded format reads "Downloaded, not in the library yet" and the hero badge
  Downloaded, never "Have it".

**Not decided here.** Whether LazyLibrarian should stop taking formats Kavita cannot open, and whether the books it holds
only as `.mobi` or `.azw3` should be searched again for an epub, is an owner decision (57 LazyLibrarian books, and 48
pairing wants that already read their ebook `landed` on one), issue #770. Three collection wants on another work's book
that the Volume Check cannot see (Gray Dawn, Shift, Four: The Traitor) are issue #771.

**Tests:** `packages/domain/__tests__/collection-want-downloaded.test.ts` (the library-title test on the live shapes; a held
`.mobi` lands; another work's book, an unheld format and a title the library shows do not; a downloaded want stays on the
drill and goes back when the library shows the book or LazyLibrarian loses the file; an empty read decides nothing; a park
is left alone), `packages/api/__tests__/books-wanted.test.ts` (a collection want's detail lists only its format; a landed
one is downloaded and not searchable).

## Amendment — 2026-10-06 (latest): a collection want on another author's book is resolved again (issue #771)

**What was seen.** The collection wants "Gray Dawn" (Easy Rawlins) and "Shift" (Silo) read `requested` for days and
were never searched. Their `ll_book_id` named another author's book: Stewart Edward White's *The Gray Dawn* and Stephen
King's *Night Shift*. A `hardcover_series` member carried no author, so Libretto's resolve ran on the title alone and
took the first match; the force-search queued that book and LazyLibrarian downloaded it. From then on the push guard
saw LazyLibrarian holding the want's book and skipped the want as held, stamping `last_searched_at`, and the cron's
cooldown (seven days in production) brought it back only to skip it again. It was reached every week and never searched.
The cap and the gather order played no part (the cron gathered 0 to 7 wants a run). The lenient Volume Check (T-280)
passed both, because the titles share their distinctive words.

A read-only replay with each member's Hardcover authors found 13 open collection wants in the same state, all in
find-missing collections and all another author's book: Gray Dawn (ebook on White's, audiobook on Matt Howarth's),
Shift, Compulsory (John Taylor Gatto's *Dumbing Us Down*), The Last Flight of the Cassandra, After the Bridge (ebook and
audiobook), The Kane Chronicles Survival Guide (ebook and audiobook), Death and What Comes Next, Theatre of Cruelty
(ebook and audiobook) and The Infinite Extent. Ten of them had LazyLibrarian searching the other author's book. None
of the 1,148 goodreads and pairing wants with an author fails the check: their resolves always carried one.

**The rule: the Author Check (T-286).** A collection want's LazyLibrarian book must be credited to the member's author.
`llBookAuthorMismatch` (`ll-book-check.ts`, pure) compares the want's author (any credit of a comma, semicolon, "&" or
"and" list) with LazyLibrarian's `AuthorName` by surname, a title or suffix aside, or one surname run together in the
other ("Le Guin" and "LeGuin"). A shared first name is no agreement ("Rick Riordan" and "Rick Harrison"); one family's
series agrees ("Frank Herbert" and "Brian Herbert"). No author on either side decides nothing, so a member that carries
none is never judged by it.

**What happens to a want that fails it.** It gives the book up and stays open, unlike a `wrong_volume` park, because the
member's own book is still worth finding. `releaseWrongAuthorCollectionWant` (`book-requests.ts`, single writer, one
transaction, unaudited like every synced collection-want write) clears the id, remembers it in `wrong_author_ll_book_id`
(migration 0095), clears `last_searched_at` so the want is due the moment it has a book again, puts an active format the
wrong book moved to `wanted` or `grabbed` back to `requested`, and releases the format LazyLibrarian was searching for it
(T-283, reason `released:wrong_author`), so the drain unqueues another author's book nobody else asked for. The next
wants pass resolves the member again with its author (the Google Books title leg is author-guarded), and the force-search
then searches the book it names. If that resolve names the same book again, it vouches for it (the author is written
another way in LazyLibrarian): the check no longer applies to that book, so nothing loops.

**Where it runs.**

- **The sweep** (`releaseWrongAuthorWants`, `collection-force-search.ts`), in the `books-collections-sync` cron after the
  gone rule and the re-request and before the gather, over every open want of the find-missing collections whatever its
  cooldown (unparked, unmatched, an id and an author, its own format neither `landed` nor settled `missing`), from the
  run's one `getAllBooks` read. A want held on another author's book was stamped by the held-skip, so waiting for its
  cooldown would leave it a week. Report field `releasedWrongAuthor`; each release logs `collection_want_wrong_author_released`.
- **The push guard** (`runForceSearchWorklist`), before the Volume Check: a gathered want whose book fails the check is
  released, never queued and never counted held (`ll_push_skipped_wrong_author`).
- **The on-demand Force Search** runs the sweep before it refreshes the collection's wants, so a released want is
  resolved again and its own book searched in the same click.
- **The Downloaded rule** (#759 amendment, condition 2): another author's book never says the member was downloaded,
  unless a resolve vouched for it.

No LazyLibrarian write comes from the check itself; an empty or failed `getAllBooks` read decides nothing.

**Where the member's author comes from.** Libretto's `hardcover_series` builder now reads each book's Author credits
and reports them as the missing member's `authors` (DESIGN-037 D-05 amendment of this date), and the wants pass already
stores `authors[0]` as the want's author and passes it to the resolve. Libretto's own acquisition is author-guarded the
same way (D-09 amendment).

**Not this rule.** "Four: The Traitor" (Divergent) is on its own book, by its own author: LazyLibrarian imported the
four-story collection as its file. "Shift" may come back the same way: LazyLibrarian's own Hugh Howey *Shift* holds the
file of *First Shift: Legacy*. A right book with a wrong file is not a matter of identity: issue #781.

**Tests:** `packages/domain/__tests__/wrong-author-wants.test.ts` (the pure check on the live names; the sweep releases a
held want whatever its cooldown, writes nothing to LazyLibrarian for it and releases its book; the member's own book is
searched once the wants pass resolves it; a vouched book is left alone; an audiobook on another author's `Wanted` book
goes back to `requested`; the on-demand Force Search releases, resolves and searches in one click; the Downloaded rule),
`packages/domain/__tests__/collections.test.ts` (a re-PUT keeps targets, category, title fallback and aliases),
`packages/db/__tests__/migrations.test.ts` (0095).

## Amendment — 2026-10-06 (EPUB conversion): LazyLibrarian's `.mobi` / `.azw3` books are converted to EPUB (issue #770, owner ruling)

**What was seen.** LazyLibrarian accepts `epub, mobi, pdf, azw3`; Kavita's Books library opens epub and pdf only. 57
LazyLibrarian books held only a `.mobi` or `.azw3` (125 folders under `EBooks` in all, counting books LazyLibrarian does not
track), so Kavita never showed them while every want on them read held: 48 pairing wants and 2 goodreads wants read their
ebook `landed`, and 6 collection wants read Downloaded (the amendment above).

**The ruling ("Convert to EPUB"; glossary T-288 EPUB Conversion).** LazyLibrarian keeps accepting `.mobi` and `.azw3`, because some books only come that
way. They are converted to EPUB after import, beside the original; the original is kept; nothing is searched or
downloaded again. The backlog was converted at once (113 EPUBs; 8 folders were second copies of a book Kavita already
showed, 4 were held, none carried DRM); new ones convert on their own.

**How (cluster side, haynes-ops `kubernetes/main/apps/downloads/lazylibrarian/app/`).**

- **The converter** is the hourly CronJob `lazylibrarian-epub-convert` (`epub-convert/epub_convert.py`, the calibre CLI
  image pinned by digest; the LazyLibrarian image has no calibre). It walks `EBooks`; a folder that holds any `.epub` or
  `.pdf` is never touched; a folder holding a `.mobi` / `.azw3` and neither is converted with `ebook-convert`, one book at
  a time (CPU limit 1, `nice`), into the pod's scratch space. One source per folder: `.azw3` before `.mobi`, then
  LazyLibrarian's own naming (`<Title> - <Author>`), then the newest.
- **Never a second copy.** A folder whose sibling under the same author holds the same book (the same title words, any
  punctuation: "Dirk Gently's ..." and "Dirk Gentlys ...") as an epub or pdf is skipped and counted `duplicate`: Kavita
  already shows the book, and Libretto refuses a member it holds twice as ambiguous (the bulk run's first pass flipped
  "Dirk Gently's Holistic Detective Agency" to missing until the 8 second copies it wrote were removed). It converts on
  its own if the sibling copy goes.
- **The check before it lands.** `ebook-meta` must read a title and an author from the EPUB, and the title must name the
  book the folder is filed under (LazyLibrarian's `$Title`: one main title contained in the other as words, or half the
  words shared). A book with no author gets LazyLibrarian's (the author folder) written into the new EPUB; the original is
  never edited. Only then is the EPUB copied in under a hidden name and renamed to `<original basename>.epub`, the name
  LazyLibrarian gave the original. LazyLibrarian's library scan links the book to that file (`EBOOK_TYPE` lists epub
  first), so LazyLibrarian and Kavita see one book; a record whose `BookFile` has another basename, or that the scan does
  not match, keeps pointing at the original (14 of the 57). The app reads LazyLibrarian's status, never its `BookFile`.
- **A book that fails is left as it is.** DRM, a conversion error, a timeout, an EPUB with no title or author, or a title
  that names another book: the folder is untouched and the source is listed in `books/.epub-convert/held.tsv` (outside
  every library root), so it is reported once and not retried hourly. Deleting its line retries it.
- **Kavita.** The converter touches the book and author folders (on this NFS share adding a file does not reliably move
  the folder mtime a non-forced scan compares) and queues one Kavita library scan per run that converted something.
- **Census and alerts** (Loki ruler, `lokirule.yaml`, all warning): each run logs `epub_convert` per attempt and an
  `epub_convert_census` line, `unconverted` (mobi/azw3-only folders the run should have converted) expected 0 after every
  run, plus `held`, `duplicate` and `settling` (an import younger than 15 minutes). `LazyLibrarianEbooksNotConverted` fires on a
  non-zero `unconverted`, `LazyLibrarianEpubConvertHeld` on a new held book, `LazyLibrarianEpubConvertSilent` when no run
  finished in 3 hours.

**What changes in the app.** Nothing in code. A converted book reaches Kavita, so the library mirror and Libretto see it:
a collection want that read Downloaded is deleted by the wants pass once Libretto pairs the member (or reverts to
`requested` for the hour between Kavita listing the title and Libretto's refresh, which the rule above allows), and the
`landed` ebook of a pairing or goodreads want is now true in the library too. Questions 2 and 3 of #770 (search the 57
again for an epub; stop counting a format the library cannot open as held) are moot under the ruling: the format the
library cannot open no longer stays that way. The push guard is unchanged.

**Owed:** OC-023 (the first automatic conversion of a newly imported `.mobi` / `.azw3`). Record:
`.agents/context/2026-10-06-epub-conversion.md`.

## Amendment — 2026-10-06 (Request Events): every write to a book request records a Request Event (issue #741, ADR-101)

**What was missing.** Every writer of `book_requests` below was "unaudited (the sync class)": the push, the reconcile, the
gone rule's re-point and settle, the one re-request, the Landed Truth revert, the English Edition switch and park, the
pairing mint, re-identify and parks, the collection wants pass, the Author Check and the issue #693 repair. In the three
days before this amendment they changed what the estate downloads thousands of times, and only Loki kept a trace.

**The ruling (ADR-101; glossary T-292 Request Event).** Every mint, change and delete of a `book_requests` row records
one append-only `book_request_events` row in the same transaction. Each "unaudited" in the amendments above now reads
"records a Request Event"; nothing a writer decides or writes to LazyLibrarian or Kapowarr changes.

- **One write path.** `packages/domain/src/book-request-events.ts` is the only domain module that writes
  `book_requests` (`__tests__/book-request-write-paths.test.ts` fails the build otherwise; the repo-wide guard keeps
  both tables inside the domain). `updateBookRequests(tx, audit, where, set)` reads and locks the rows `where` matches,
  updates them under the same `where`, and records one `update` event per row whose recorded fields changed.
  `insertBookRequest` records the `mint`, `deleteBookRequests` the `delete` (the collection wants pass dropping a want
  no longer missing), and `recordCascadedRequestDeletes` the wants a books collection takes with it when it leaves its
  server (`syncBooksCollections`, before its delete). `stampBookRequests` writes only the bookkeeping stamps and
  records nothing; it refuses any other field.
- **What an event holds.** `request_id` (no foreign key: a dropped want keeps its history), `kind` (`mint`, `update`,
  `delete`), `reason`, `writer` (the function), `site`, `actor` (`sync`, `repair`, `user`) and `actor_user_id`,
  `before` / `after` (the changed recorded fields by column name: `{"ll_book_id": "a"}` → `{"ll_book_id": "b"}`; a mint
  has `before` `{}`, a delete `after` `{}`), `detail` (the writer's context) and `created_at`.
- **Recorded fields.** The want's identity (`origin`, its keys, `title`, `author`) and state (`matched_books_item_id`,
  `ll_book_id`, the three statuses, `kapowarr_volume_id`, `comicvine_id`, `unroutable_reason`, the four
  `ll_rerequest_*` columns, `wrong_author_ll_book_id`). Not recorded: `last_searched_at`, `last_reconciled_at`,
  `english_edition_tried_at`, the Mint Backoff columns, `created_at`, `updated_at`. So the hourly reconcile of a want
  whose statuses did not move records nothing.
- **Reasons, by writer.**

  | Writer | Reason | `detail` |
  |---|---|---|
  | `syncShelfRequests` | `shelf_want_minted`, `shelf_want_refreshed` | |
  | `markRequestPushed`, `markPairingWantPushed` | `ll_pushed` | |
  | `applyRequestReconcile` | `ll_reconciled` | |
  | `markRequestFormatsRequeued` (the Skipped sweep) | `ll_requeued` | `formats` |
  | `markComicRouted`, `applyComicReconcile` | `comic_routed`, `comic_reconciled` | |
  | `revertLandedFormats` | `landed_reverted` | `cause` (`ll_not_held`, `ll_book_mismatch`, …), `llBookId` |
  | `repointRequestLlBook`, `settleRequestLlGone` | `ll_book_gone_repointed`, `ll_book_gone_settled` | settle: `llBookId`, `formats` |
  | `recordLlRerequest` | `ll_rerequest` (every outcome) | `outcome`, `llBookId`, `toLlBookId`, `land`, `request`, `viaAdd` |
  | `upsertPairingWant` | `pairing_want_minted`, `pairing_want_refreshed` | `statusReset` |
  | `syncFormatPairs` (a broken pair) | `pairing_want_revived` | |
  | `landPairingHeldFormat` | `pairing_held_format_landed` | |
  | `reidentifyPairingWant` | `pairing_want_reidentified`, `pairing_want_retitled` | `cause` (`identity`, `volume`, `work`) |
  | `parkPairingWant`, `parkCollectionWant`, `parkRequestNoEnglishEdition` | `parked` (`after.unroutable_reason` names the park) | `llBookId` |
  | `unparkForeignLanguageWant`, `liftNoEnglishEditionPark` | `unparked` | |
  | `switchRequestToEnglishEdition` | `english_edition_switched` | |
  | `syncCollectionWants` | `collection_want_minted`, `collection_want_refreshed`, `collection_want_dropped` | |
  | `syncBooksCollections` | `collection_removed` | |
  | `setCollectionWantDownloaded` | `collection_want_downloaded`, `collection_want_download_reverted` | `llBookId`, `format` |
  | `releaseWrongAuthorCollectionWant` | `wrong_author_released` | |
  | `runForceSearchWorklist` (a `missing` want a search reopens) | `force_search_reopened` | |
  | `reopenWrongVolumeRequest`, `settleRemovedAnchorPairingWant`, `settleParkedPairingWant` | `wrong_volume_repaired`, `removed_anchor_settled`, `parked_want_conformed` | ids |

  `reason` is the `BOOK_REQUEST_EVENT_REASONS` union in `@hnet/db` enums, without a CHECK: a new writer adds its reason
  in code. `kind` and `actor` are CHECK-enforced.
- **Who and where.** The sync orchestrator runs each mode inside `withRequestEventScope({ actor: 'sync', site: mode })`,
  so an event's `site` is at least its job (`goodreads-sync`, `format-pairing`, `books-collections-sync`); the gone rule,
  the re-request, the Landed Truth revert and the force-search reopen name their leg (`format-pairing.rerequest`). The
  issue #693 repair (`repairWrongVolumeRequests`) runs as `actor: 'repair'`, site `wrong-volume-requests-repair`; a
  future repair script opens the same scope with its own site. A person's on-demand collection Force Search runs as
  `actor: 'user'` with their id. The manual "Search again" only stamps, so it records no event; its
  `request_book_search` `permission_audit` row is unchanged.
- **Reading it.** Admins read one want's history on its Wanted detail (the 2026-10-07 amendment below, issue #792); the
  rows are also read by SQL, e.g. a request's history:
  `SELECT created_at, kind, reason, writer, site, actor, before, after, detail FROM book_request_events WHERE
  request_id = $1 ORDER BY created_at` (index `book_request_events_request_created_idx`), or one decision across the
  estate: `WHERE reason = 'll_book_gone_repointed' AND created_at > now() - interval '1 day'`.
- **Cost.** One extra primary-key read per recorded update and the event inserts; no retention cap (ADR-101 C-03).
- **Not covered.** Hand-written SQL in `psql` (repairs go through a script that calls the writers), and a user
  deletion's cascade (ADR-101 C-04, C-05).

**Tests.** `packages/domain/__tests__/book-request-events.test.ts` (mint, unchanged re-run, retitle, drop, collection
removal, re-point with site, settle / revert / park, stamps record nothing, scopes, a failed event rolls the change
back, a lost mint conflict records nothing); `book-request-write-paths.test.ts` (the write-path guard);
`wrong-volume-guards.test.ts` (the repair records `actor: 'repair'`, and a dry run or a second apply records nothing).

## Amendment — 2026-10-06 (Books Census): a daily, observe-only census of wrong files and the English-only rule (issues #744, #781)

**What was seen.** Two problems with no detector.

- **#781: LazyLibrarian holds a book with another book's file.** "Four: The Traitor" (`RZZRAQAAQBAJ`) held the four-story
  collection: LazyLibrarian grabbed "Four- A Divergent Story Collection (The Transfer; The Initiate; The Son; The Traitor)"
  for it and filed it under the record's own name. "Shift" (`Qw30DwAAQBAJ`) held *First Shift: Legacy* (Silo 6). The
  Volume Check (T-280) and the Author Check (T-286) compare a want with LazyLibrarian's record, never a record with its
  file, so nothing saw either; every want on those books read held.
- **#744: the English-only rule (F10) had no continuous enforcement.** The 2026-10-05 sweeps moved about 6,500 foreign
  files out of the libraries; nothing measured the state afterwards: no count of foreign files held, of foreign books
  LazyLibrarian wants, or of library items tagged non-English. The library tags were wrong in both directions.

**The ruling.** One census for both (owner-approved queue item #744, extended with #781's detection by the coordinator). It
is observe-only: it reads, logs and alerts; it never writes to a source and never repairs. Repairs stay with people and
agents, under the cross-volume repair rules (the two #781 books below).

### The Books Census (T-289)

A daily CronJob, `books-census` (haynes-ops `kubernetes/main/apps/downloads/books-census/`, 10:15Z, after LazyLibrarian's
09:10Z library scan), runs `packages/sync/src/scripts/books-census.ts` from the app image. Its sources are the owed-check
runner's (DESIGN-053 D-04), opened the same read-only ways: LazyLibrarian's SQLite `mode=ro` with `PRAGMA query_only`
(its RWO volume, so the pod is pinned to LazyLibrarian's node), the books NFS share mounted read-only at LazyLibrarian's
own path, and the app's Postgres through `postgres16-ro` in a `default_transaction_read_only` session with every query
`BEGIN READ ONLY`. One pass reads every LazyLibrarian `books` row, then the metadata of every file a row points at
(`BookFile`, `AudioFile`), four at a time (the share is NFS: latency, not CPU), with positioned reads of the few blocks that
hold it (`file-meta.ts`):

| File | What is read |
|---|---|
| EPUB | the zip directory, then the OPF: `dc:title`, `dc:language`, the calibre or EPUB 3 series; and a text sample, the first spine documents up to 3,000 words |
| MOBI / AZW3 | record 0: EXTH 503 (title) and 524 (language), else the full name and the header locale |
| MP3 | ID3 v2.2 to v2.4: TALB (album), TIT2 (track title), TLAN (language) |
| M4B / M4A | the `moov` atom (found by walking atom headers past `mdat`): `©alb`, `©nam` |
| PDF and anything else | nothing (`unsupported`); the name side below still judges it |

The first live pass (1,267 records, 981 eBook files and 569 audiobook files) took 22 to 25 seconds.

**Five kinds of finding**, each with a key a Census Hold can name (`census.ts`):

| Kind (key) | Finding |
|---|---|
| `wrong_file` (`wrong_file:<id>:<format>`) | The Held File Check (T-290, below) says the file is another book. `basis` says whether the file's own title or, when it has none worth judging, its folder and file name decided. |
| `missing_file` (`missing_file:<id>:<format>`) | The row points at a file that is not on disk. A stale pointer makes LazyLibrarian, and the landed truth (T-281), read the format held. |
| `foreign_held` (`foreign_held:<id>:<format>`) | The file is not English (F10), by the first signal that says anything: the text sample (an EPUB's function words, `language.ts`: foreign when a foreign language has 30 hits and three times English's, or the letters are mostly a non-Latin script), else the file's declared language, else LazyLibrarian's `BookLang` when no file of that book reads English (LazyLibrarian labels a record by the edition it resolved: Goldmann's German "Grey" holds an English file). |
| `foreign_wanted` (`foreign_wanted:<id>`) | A book LazyLibrarian labels non-English that it reads `Wanted` in either format, or that an unparked want with an open format points at. The finding names those wants. |
| `foreign_item` (`foreign_item:<source>:<externalId>`) | A live library item (`books_items`, not a comic) whose language tag reads non-English, counted per library. |

The language classes are DESIGN-036's #700 table (`classifyBookLanguage`; blank, `und`, `XXX` and `Unknown` are not
foreign), with ISO 639-2 `mul` and `zxx` also unknown.

### The Held File Check (T-290)

`heldFileNamesBook` (`ll-book-check.ts`, pure) asks whether a title the file carries names its LazyLibrarian record
(`BookName`, with `BookSub`). LazyLibrarian writes a colon as a period ("Four. The Traitor", "Reckoners 1. Steelheart"),
so that period is read back as a part break (`llTitleText`). Both titles are evened out first: a file extension left in
a title, a double hyphen, bullet or underscore as a part break, "Vs." for "Versus", British "-our". Two titles that are
one string once spaces and punctuation go are the same book. Otherwise:

1. **No other volume.** The Volume Check with the record as the want and the file as the book must not say `volume`
   ("Warriors" is not "Warriors 3"; "The Expanse Origins #2" is not "#3").
2. **No title to judge.** A title that is only a series designation ("Redwall - 08", "Throne of Glass bk 5", "Wild Cards
   VII", "Disc 01"), a placeholder ("Unknown", "read by Hugh Laurie") or no title at all decides nothing. Audiobook album
   tags are often the series, so this matters there most.
3. **The same work, either way round.** The Volume Check must find no other work with the record as the want (with its
   subtitle or without it), or with the file as the want, unless the words the file lacks name a separate work and it
   lacks the record's own head: "The Golden Compass" is LazyLibrarian's "His Dark Materials. The Golden Compass (Book
   1)", "The Churn" is "The Churn. an Expanse Novella", but "Outlander" is not "A Plague of Zombies. An Outlander
   Novella".
4. **Nothing the record does not name** (`namesNothingElse`). The Volume Check passes a file whose title contains the
   record's, which is exactly how a collection or another part looks ("Four Divergent Stories: The Transfer, The
   Initiate, The Son, and The Traitor" for "Four: The Traitor"; "First Shift - Legacy" for "Shift"). So one part of the
   file's title, its decoration and any leading series index cut ("Expanse 05 ", "[The Expanse 3.0] ", "SSQ4 ", "The
   History of Middle-earth Vol-7- "), must have only words of the record (title, subtitle, the file's own series name),
   packaging words aside ("Omnibus", "Edition", "Kindle Single", "Deluxe", "Box Set"), or the title must start with the
   record's whole title of two words or more and only add a subtitle after it ("NINE TOMORROWS Tales of the Near Future").

The census judges a file by its content when it can (`contentNamesBook`): the primary title (the EPUB or MOBI title, the
album tag) decides, and the other titles can only clear it, never condemn it. An album tag is often the series
("Shadowhunter Academy") while the track title names the book ("07 Bitter of Tongue"), and track titles are too often
chapter names or codes ("01: High Chasaline", "WHITESAND01P04") to condemn a file. When the content cannot judge, the
name does (`heldFileNameNamesBook`): the folder and the file name, the author and track markers cut, with rules 1 and 4
only (a name is shorter than a title: LazyLibrarian's "The Traitor" folder holds "Four: The Traitor"). A file is
another book when no name names the record.

Known limits, held or reported rather than coded around: a record named shorter than its book ("The Knights of
Crystallia" for "Alcatraz versus the Knights of Crystallia"), an unnumbered series album with no track title, a US and UK
title of one book ("Philosopher's Stone", "Sorcerer's Stone").

### Census Holds (T-291)

`.agents/books-census-holds.yaml` lists findings a person has looked at and declared fine for now: a key, optionally the
file the hold was declared for (a hold on a `wrong_file` stops covering it when LazyLibrarian links another file), a
reason, an `opened` day and an optional `until` day. The CronJob reads the file from main on GitHub, so a docs PR sets or
lifts a hold without a release; `packages/sync/__tests__/books-census.test.ts` parses the repo's file, so a malformed hold
fails the `test` check. A held finding is still logged, `held: true` with the reason, and never counts toward an alert. An
unreadable holds file is logged (`books_census_holds_invalid`) and the run goes on with no holds: it over-reports rather
than hide a finding. A hold that matched nothing is listed in the run's `unusedHolds`, so it can be deleted.

### What it logs, and the alerts

JSON lines, namespace `downloads`, container `main`, pods `books-census-*`: one `books_census_finding` per finding (kind,
key, held, the record, the path relative to the books root, the file's titles, the language signals, the wants on it), a
`books_census_unreadable` warning when files could not be parsed, and one `books_census` line per run (the counts above
per kind, the held counts, `foreignItemsBySource`, `unusedHolds`, up to five sample titles per kind, `appDb`, `holds`,
`durationMs`). `books_census_failed` (exit 1) when LazyLibrarian's database cannot be read; an unreachable app database
is logged (`books_census_app_db_failed`) and the LazyLibrarian side still runs (`appDb: error`). Findings are not job
failures: the job exits 0 whatever it found.

Loki rules (haynes-ops `downloads/books-census/app/lokirule.yaml`), all `severity: warning` like every estate warning (the
owner's rule for a census: it does not page): `BooksCensusWrongFile`, `BooksCensusMissingFile`, `BooksCensusForeignHeld`,
`BooksCensusForeignWanted` and `BooksCensusForeignItems` when the run's count of unheld findings of that kind is above
zero (26 hours, one daily run), and `BooksCensusSilent` when no run finished in 26 hours. The human- and agent-facing
signal is the session-start step in `.agents/KICKOFF.md`: read the latest `books_census` line and triage.

**What is not built.** The monthly content-based sample #744 proposed (stopwords, diacritics, ID3, ISBN group) became
part of the daily pass for the files LazyLibrarian holds: the EPUB text sample, the declared language of every EPUB,
MOBI and MP3. Audiobook audio is not listened to (no speech model runs here), so an audiobook is foreign only by its
tags or its label; the 2026-10-05 sweep's whisper checks stay a hand step. Library items LazyLibrarian does not track
are covered by their tags only.

### The two #781 books, repaired (2026-10-06 21:39Z)

Under the cross-volume repair rules (the #782 precedent), by `.agents/context/ll-library-audit/fix_781.py` (dry run, then
`--go`; declared activity act-213826-23403; LazyLibrarian backup `/config/lazylibrarian.db.pre-781-20261006`, integrity
ok). Content was read first (OPF titles and md5s, read-only). Neither book was searched again: both right books were
already on disk, and a search would have put a second copy in Kavita, which Libretto refuses as ambiguous.

| Record | Was | Now |
|---|---|---|
| `RZZRAQAAQBAJ` Four. The Traitor | the four-story collection, `Four. The Traitor/` | re-pointed to the Kindle Single already in `The Traitor/` (Kavita series 1950; that folder's LazyLibrarian opf already named this record). The collection copy is held `duplicate` (the collection keeps its own folder, `Four - A Divergent Story Collection/`, Kavita series 256), its cover and opf `off_catalog`. |
| `TYETAQAAQBAJ` The Traitor. A Divergent Story | the same book under its UK title, `Wanted` with no file for pairing want `0841d533` | linked to the same file, `Open`: a grab would have been a second copy. |
| `Qw30DwAAQBAJ` Shift | *First Shift: Legacy* in `First Shift - Legacy/`; its own `Shift/` folder held *Third Shift: Pact* (epub) and *First Shift: Legacy* (mobi); `Wool Omnibus/` held another *Third Shift: Pact* | The right book, "Shift Omnibus Edition (Shift 1-3)", was downloaded on 2026-08-22 (grab 6086, still seeding) and imported as `Shift/Shift - Hugh Howey.epub`; grab 9282 (*Third Shift*, 2026-09-27) overwrote it under the same name. It is copied back from the torrent folder (the torrent keeps seeding) beside the folder's own opf and cover, and the record re-pointed. The four wrong books and the two stray opfs naming `Qw30DwAAQBAJ` (LazyLibrarian's library scan reads a folder's opf before the file, so each would be linked to Shift again) are held `off_catalog`: no record or request names *First Shift* or *Third Shift*, both parts of the omnibus. |

Three folders emptied and removed; manifest and sort rows in `quarantine/crossvolume-2026-10-05/`, so the holding-folder
purge (OC-009) takes them. Kavita (one user, no pages read on the series that lost a file) was rescanned for both authors:
series 1661 (the collection copy) and 291 (*Third Shift*) are gone, series 1221 *Wool* holds only Wool again, and series
2062 "Shift Omnibus Edition (Shift 1-3) (Silo Saga)" is new. Owed: OC-028 (The Traitor) and OC-029 (Shift).

**First live run** (v0.109.0, 2026-10-06 23:25Z, a manual Job): 1,268 records and 1,550 files in 32 seconds; 24 wrong
files, 1 missing file, 1 foreign file held, 1 foreign book wanted, no foreign library tag. The Divergent eBook (the four-story
collection) was repaired at once the #781 way (`fix_census_divergent.py`: re-pointed to the Divergent PDF already in its
folder, the collection's stray opf held; OC-031). The other 23 wrong files are issue #795, the Italian Crescent City want
issue #794. Record: `.agents/context/2026-10-06-wrong-file-census.md`.

**Tests:** `packages/domain/__tests__/held-file-check.test.ts` (the #781 files and every flag and false alarm of the first
live pass: another volume, another work, a collection; a series in front of the record's name; a series index, a
bracket, a spelling, an edition word; designations; the name side), `packages/sync/__tests__/books-census.test.ts` (the
readers on EPUB, MOBI, ID3 v2.3 and v2.4 and MP4 files built byte by byte, a missing file, a PDF, a broken EPUB; the
language guess; every kind of finding on the live shapes; holds by key, file and day, and unused holds; a whole pass over a
real SQLite file and real files, an unreadable holds file, and the app reads on the embedded Postgres 16 through a
read-only session).

### Follow-up — 2026-10-07: a file whose title is the record's with words cut (issue #799)

**What was seen.** Repairing #795 found LazyLibrarian `QGPZEAAAQBAJ` "Wonderful Alexander and the Catwings" (Catwings 3)
holding Catwings, book 1 (OPF `dc:title` "Catwings", no series, ASIN B00MEWSDOW). The census logged nothing. Rule 3 above
reads the Volume Check either way round, and with the file as the want, "Catwings" is covered by the record's title, so
the file passed. The same rule would pass "Dune" held as "Dune Messiah", "Wild Cards" held as "Wild Cards. Lowball", and
"A Secret Rage" held as the two-novel "A Secret Rage and Sweet and Deadly".

**The rule (`cutTitleNamesBook`, applied before rule 3).** It applies when every word of the file's title (its
decoration cut, packaging words aside) is a word of the record's `BookName` and the record has words the file lacks: the
file's title is the record's with words cut. Otherwise rules 3 and 4 decide as before, so a file whose title adds words
(an omnibus held as one of its books, "Shift Omnibus Edition" for "Shift") is judged as it was. The record's subtitle is
not part of the comparison: a file that drops it is caught first by the exact-title check. The kept words are the
shortest stretch of the record's title that holds every word of the file's ("Wild Cards XII. Turn of the Cards" keeps
"Turn of the Cards", not "Cards XII. Turn"). The file is the record's book only when every cut says nothing about which
book it is:

| Cut | Passes when | Passes | Fails |
|---|---|---|---|
| after the kept words | it is whole parts (a subtitle or edition part after a part break), packaging ("LP", "Hardcover", "Hufflepuff Edition"), or a collection's tail ("and Other ...") | "Dune" for "Dune: Deluxe Edition"; "A Plague of Zombies" for "A Plague of Zombies. An Outlander Novella"; "The Martian Way" for "The Martian Way and Other Stories" | "Dune" for "Dune Messiah"; "A Secret Rage" for "A Secret Rage and Sweet and Deadly"; "Code to Zero" for "Code to Zero [and] The Man from St Petersburg" |
| before the kept words | it is whole earlier parts (a series in front); whatever it cuts from the kept words' own part is packaging ("Sneak Peek for", "ILL/"), the file's declared series, the record's own decoration, or words another LazyLibrarian title of the author starts with | "The Golden Compass" for "His Dark Materials. The Golden Compass (Book 1)"; "The Sea of Monsters" for "Percy Jackson and the Sea of Monsters" beside "Percy Jackson and the Olympians. ..." | "Catwings" for "Wonderful Alexander and the Catwings" (no other Le Guin title starts "Wonderful Alexander"); "Dune" for "Children of Dune" and for "Dune Chronicles. God Emperor of Dune"; "Disciple" for "Merge / Disciple" |
| between the kept words | it is packaging | | |

Two guards then apply. A cut in front that names a separate work fails, as rule 3 already said ("Towers of Midnight" is not
"Distinctions. Prologue to Towers of Midnight"). And a file whose kept words are only a series name fails unless all the
record adds is packaging: the file's declared series, the record's decoration, or words at least two other titles of the
author start with and go on past ("Wild Cards" for "Wild Cards. Lowball", "Four" for "Four. The Traitor", "Mistborn" for
"Mistborn: The Final Empire (Mistborn #1)"; "Dune" for "Dune. Deluxe Hardcover Edition" passes). One other title that goes
on past the file's words is not enough: it can be another edition of the same book ("The Golden Compass Graphic Novel,
Volume 1"), and a twin record titled exactly like the file is not a series either ("Theodore Boone" beside "Theodore
Boone. Kid Lawyer").

A series in front never vouches for words cut from the kept part (the code review of #805 traced "Dune" passing for "Dune
Chronicles. God Emperor of Dune" before this was added). The trade-off: a record that puts a series and a sub-series in
front, with no other title of the author to vouch for the sub-series, is flagged although its file is the book ("A Crash of
Fate" for "Star Wars. Galaxy's Edge A Crash of Fate"). The one such record in the library carries a Census Hold. A missed
wrong file stays unseen, while a false flag is read once and held, so the rule takes the false flag.

Why the author's titles. LazyLibrarian has no series data here (its `series` and `member` tables are empty, 2026-10-07),
and the file rarely declares one (Catwings does not). The two titles alone cannot tell "Percy Jackson and the Sea of
Monsters" held as "The Sea of Monsters" from "Wonderful Alexander and the Catwings" held as "Catwings": both cut a name and
"and the" off the front. What separates them is that "Percy Jackson" starts other titles of the author and "Wonderful
Alexander" does not. The census passes every `BookName` LazyLibrarian holds for the record's author
(`HeldFileCheckOptions.authorTitles`). ISBN and ASIN were considered and not used: the file's identifiers are often an
ASIN or another edition's ISBN, so a mismatch says nothing, and Catwings carries only an ASIN.

**Trial pass, before release.** A one-off Job from the v0.109.1 image (the CronJob's mounts and read-only sources)
dumped the LazyLibrarian rows and every held file's metadata, 2026-10-07 01:30Z: 1,315 records, 1,547 files. The branch's
census ran over that snapshot. Before the change it found 0 unheld wrong files (6 held).

| Pass | wrong_file (unheld) | What changed |
|---|---|---|
| 1 | 35 | first rule: the record's subtitle took part (its words matched the file's by chance), and one other title going on past the file's words counted as a series |
| 2 | 7 | `BookName` only; two other titles for a series name |
| 3 | 5 | the shortest kept stretch (a repeated word); "ILL/" is packaging |
| 4 | 6, one held | the code review's fix: a series in front does not vouch for words cut from the kept part; "Star Wars. Galaxy's Edge A Crash of Fate" is flagged and held (Census Hold) |

Five are the new shape, one book held for a record that names more: "Merge / Disciple" (eBook "Disciple"), "Code to Zero
[and] The Man from St Petersburg" (eBook "Code to Zero"), "A Secret Rage and Sweet and Deadly" (eBook and audiobook "A
Secret Rage"), and "The Ultimate Hitchhiker's Guide to the Galaxy" (audiobook "1-The Hitchhiker's Guide To The Galaxy").
No Catwings-shaped file is left: #795 repaired the one known.

**Tests:** `held-file-check.test.ts` "a cut title (issue #799)" (an earlier book or the series name cut from a longer
title; one book of a record that names two; a subtitle, edition note or collection tail cut off the end; a series or
character name cut off the front, with and without the author's titles; one extending title and a twin record are not a
series; a series in front does not vouch for the kept part; a prologue in front), `books-census.test.ts` (the census passes the author's titles: Catwings is found, The Sea of
Monsters is not).

**First live run and repair (v0.109.2, deployed 2026-10-07 03:00Z; manual Job at 03:00Z).** 1,315 records, 981 eBook and
566 audiobook files: `wrongFile` 5, the trial's pass 4 exactly (Galaxy's Edge held), nothing else. Repaired at 03:02Z by
`.agents/context/ll-library-audit/fix_census_799.py`. It ran as a dry run first, then `--go`, under declared activity
act-030227-269854. The LazyLibrarian backup is `/config/lazylibrarian.db.pre-799-20261007` (integrity ok). Each file was
read first: epub OPF titles, identifiers and tables of contents, audio tags, Audiobookshelf durations, and the app's wants.

| Record | Was | Now |
|---|---|---|
| `83Hv_EYvHgEC` Merge / Disciple (eBook) | Disciple alone | re-pointed to `Merge + Disciple - Two Short Novels from Crosstown to Oblivion/`, already on disk and linked to no record (OPF "Merge and Disciple", both title pages). Disciple stays in its own folder; its opf naming this record is held. |
| `4bLbswEACAAJ` A Secret Rage and Sweet and Deadly (eBook) | A Secret Rage alone | re-pointed to the two-novel omnibus in `Sweet and Deadly/`, which Sweet and Deadly also links under its Census Hold. A Secret Rage stays; its opf is held. |
| `4bLbswEACAAJ` (audiobook) | the A Secret Rage recording alone (7.85 h) | re-wanted for pairing want 6593ef4e under the owner's #795 ruling. The recording stays in `A Secret Rage/`; its opf is held. OC-038 tracks the re-download. |
| `K3wuAAAACAAJ` Code to Zero [and] The Man from St Petersburg (eBook) | Code to Zero alone | no want asks for it, so the pointer is cleared and the format set to Skipped, as for the #795 Catwings audiobook. Code to Zero stays in its folder; its opf is held. The Man from St. Petersburg has its own record. |
| `4m0Qj9xKksYC` The Ultimate Hitchhiker's Guide to the Galaxy (audiobook) | book 1 alone (4.96 h) | cleared and set to Skipped (no want asks for it); its opf is held. The other four books are their own Audiobookshelf items. The tracks are linked to book 1's own record, `zaynQgAACAAJ` "The Hitch Hiker's Guide to the Galaxy" (audiobook Skipped, now Open). |

The rule for a format with no right copy anywhere: re-want it when an app want asks for it, otherwise clear it and set it
to Skipped. A wrong file whose folder names it correctly stays where it is, and only the LazyLibrarian opf naming the wrong
record is held, as in #795. Nothing was deleted. The five opfs are in `quarantine/crossvolume-2026-10-05/` (manifest and
sort rows).

The second run read 1 unheld wrong file: book 1's audiobook on `zaynQgAACAAJ`. Its track title is "Hitchhikers Guide To The
Galaxy", against "The Hitch Hiker's Guide to the Galaxy". The comparator now treats two titles as one string when they
match once spaces and punctuation are removed, a leading article is dropped, and the possessive "'s" is read either way. With that
change the file passes. Owed: OC-037 (the five records keep their state after the library scan) and OC-038.

## Amendment — 2026-10-06 (language after the seat): the collection force-search and the one re-request read the language again after their own addBook (issue #794)

**What was seen.** The Books Census's first live run (`foreign_wanted`) found LazyLibrarian `LgDwDwAAQBAJ`, "Crescent City -
La casa di terra e sangue" (Sarah J. Maas, `BookLang` `it`), with its eBook `Wanted`. It came from collection want
`76848581` in the `crescent-city` collection (Kavita), whose member is Hardcover's unmerged Italian book. The find-missing
cron took the want at 14:28Z: LazyLibrarian did not hold the book, so the cron ran addBook, then queueBook and searchBook.
The check before the push (the #719 amendment above, "Never pushed while foreign") reads the language from the run's
snapshot, which cannot show a book that addBook has only just seated: LazyLibrarian labels the language during the add.
The goodreads push already reads the language again after its own addBook; the collection force-search did not. The book
was unqueued by hand at 23:48Z (eBook `Wanted` to `Skipped`, nothing searched;
`.agents/context/ll-library-audit/unqueue_794.py`). The Libretto Hardcover builder that listed the Italian book as a
member is fixed in thaynes43/libretto separately.

**The rule.** Every unattended push site that seats a book with addBook reads that book's language again before it queues
anything, through one shared read (`readLlLanguage`, `book-language.ts`, one `getAllBooks`). A book LazyLibrarian labels
non-English (the #700 table: `foreign` only) is left as seated (`Skipped`): no queueBook, no searchBook. A failed read, or a
book the read does not show, is unknown, and the push goes on (the guard may only withhold a write). The sites:

- **The goodreads push** (unchanged, the #719 amendment): the want is not marked pushed; `pushesSkippedForeign`.
- **The collection force-search** (`runForceSearchWorklist`, the cron and a person's on-demand Force Search alike): when
  addBook seated the book and it reads non-English, every want of that book in the run is handled as the check before the
  push handles a foreign book: counted in `skippedForeign`, logged `ll_push_skipped_foreign` (with `seated: true`), and
  stamped `last_searched_at` with no `request_book_search` audit row, so the cooldown keeps it out of the next run. On that
  next run the book is in the snapshot and the check before the push skips it; the English-edition pass switches the want
  to the English edition or parks it. An addBook or read that throws counts the wants in `failed`, as before.
- **The one re-request** (`runLlRerequests`, the #668 amendment above; run by format-pairing, goodreads-sync and the
  collection force-search): after an addBook that went through (not answered `false`), the language is read again. A
  non-English book is not queued, and no re-request outcome is recorded for the want: it stays `missing` with
  `ll_rerequested_at` empty. The next pass skips it, because its id is now in the snapshot (`planLlRerequest` hands back
  only a want whose id the snapshot lacks), and the English-edition pass switches or parks it (it takes every unparked
  want whose LazyLibrarian book reads non-English, a `missing` one included). A second want on the same book in the pass is
  skipped too, with no second add. New report field `llRerequestSkippedForeign` on every job report that carries the
  re-request tally; log `ll_push_skipped_foreign` (site = the job's re-request site, `seated: true`). A want the re-request
  queues on a row LazyLibrarian already holds needs no read: that row is the re-key match, which never names a non-English
  book (`LlRekeyIndex`). The refusal streak is unchanged: a foreign seat is an add that went through.
- **Format-pairing** already read the language after its own addBook (#700, DESIGN-036); it now uses the same shared read.

**Left alone, on purpose.** These add a book only on a person's explicit action, and are not unattended pushes:

- `book-force-search.ts` (a person's per-format Force Search on a library item): addBook runs only when the held read
  failed;
- `book-fix.ts` (a person's Fix of one library item, and the retry pass that only completes a Fix a person filed and
  that waited on Google Books quota): the Fix records the language the person asked for (`languagePref` on a
  `wrong_language` Fix), so a guard here would overrule the person's own request;
- the re-seat in `recordManualSearch` / `runManualBookSearch` (a person's Search again): it re-adds the id the want already
  had, on that person's click.

**Tests:** `packages/domain/__tests__/english-edition.test.ts` (the collection force-search seats a book that reads
non-English: one addBook, no queueBook or searchBook, `skippedForeign`, stamped, no audit, and no second add on the next
run; a book that reads English is queued and searched as before; a failed read goes on),
`packages/domain/__tests__/ll-gone.test.ts` (the re-request: a seat that reads non-English is not queued, not recorded and
not tried again; two wants on that book share the one add; an English seat is queued as before; the collection leg's
report and its next run).

## Amendment — 2026-10-07 (Request Event history): admins read a want's Request Events on its Wanted detail (issue #792, owner ruling)

**What was missing.** The Request Events amendment above records every write to a book request, and the rows were read by
SQL only. No screen showed why a want changed: a reviewer had to query `book_request_events` to learn that a want was
re-pointed, parked or re-requested.

**The ruling (owner, 2026-10-07: "admins only").** Admins see a want's history. Nobody else does, the person who shelved
the want included: the API refuses them, so a row never reaches their browser. Glossary T-292 (Request Event) gains the
line; no new term (the history is the Request Events of one want, shown).

### Where it shows

- **The Wanted detail** (`/library/books/wanted/[requestId]`, DESIGN-029 amendment 2): a **History** card below Details,
  headed "History · Admins only", for an admin only (the page wrapper passes the session's `isAdmin`; the API decides).
- **A want that is gone.** A deleted want keeps its events (no foreign key, ADR-101). When the Wanted detail is
  `NOT_FOUND` (a collection want dropped or removed with its collection, a goodreads want whose shelf item is gone), an
  admin sees "Not on the wanted list" and the History below it, so the page still says what happened. Everyone else sees
  the not-found message as before. The page no longer retries a `NOT_FOUND` (it waited through three retries before
  saying so).
- **The book detail** (`/library/books/[id]`, DESIGN-025 D-08): each linked request in its History gains, for an admin, a
  "Show changes" toggle that opens the same list in place (the ADR-015 in-place expansion: it grows its own row only) and
  an "Open the want" link to the Wanted detail. The list loads only when opened. The rows are unchanged for everyone else
  (one fix rides along: a collection want's row read the raw `collection`; it now reads "Collection").

### The read

- **`books.requestEvents`** (`adminProcedure`: anonymous `UNAUTHORIZED`, every non-admin `FORBIDDEN`). Input `requestId`,
  an opaque `cursor`, `limit` (default 20, at most 50). Returns `events` (wire rows: `kind`, `reason`, `writer`, `site`,
  `actor`, `actorName`, `before`, `after`, `detail`, ISO `createdAt`), `refs`, `want` (below) and `nextCursor`.
  Read-only.
- **`listRequestEvents`** (`@hnet/domain`, book-request-events.ts, the one read of the record):
  `WHERE request_id = $1 [AND (created_at, id) < cursor] ORDER BY created_at DESC, id DESC LIMIT n + 1`, on
  `book_request_events_request_created_idx`, with a LEFT JOIN to `users` for the person's display name (a `user` event
  only; null once the account is gone). The want need not exist: an unknown or deleted id is an empty page, not
  `NOT_FOUND`.
- **The cursor keeps microseconds.** `created_at` is a `timestamptz` to the microsecond; a cursor holding a JS `Date`
  would round to the millisecond and skip an older event inside the same millisecond. The cursor carries the text
  `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and the id. A malformed cursor is
  `BAD_REQUEST`.
- **Order inside a transaction.** Every event one transaction writes shares its `created_at` (Postgres `now()` is the
  transaction's start), so those are ordered by id: their order inside the transaction is not recorded.
- **`refs`.** The titles of the library items (`matched_books_item_id`, `pairing_books_item_id`) and books collections
  (`collection_id`) the page's events name, with whether each item is still live, so the screen shows titles, not ids.
- **Sizing.** On 2026-10-07, read-only on a replica: 749 events on 495 requests in the record's first day, at most 6 on
  one request (median 1, p95 3, p99 5). There is no retention cap (ADR-101 C-03), so a want that churns for months must
  page: 20 a page with an "Older changes" button (the movie History's load-more idiom) shows nearly every want in one
  page and bounds the rest.

### What a row shows

The shared History presentation: the `.timeline` list the movie and book detail pages use, newest first. The words live in
one pure module, `apps/web/lib/request-events.ts`; the list is `apps/web/components/request-event-history.tsx`.

1. **Why**: the `reason` in plain words (the table below); the writer's function name is the hover title.
2. **What changed**, one line per field, label then value. An `update` shows each changed field `before → after`; a
   `mint` shows each field it set; a `delete` shows each field the want held (empty fields left out of both). Field
   labels (every recorded field is labelled or named in the hidden list, never neither and never both;
   `apps/web/lib/__tests__/request-events.test.ts` fails otherwise):

   | Column | Label | Column | Label |
   |---|---|---|---|
   | `ebook_status` | Ebook | `ll_rerequest_failures` | Re-request refusals |
   | `audio_status` | Audiobook | `ll_rerequest_failed_at` | Last re-request refusal |
   | `comic_status` | Comic | `ll_rerequest_added_at` | Re-request added |
   | `unroutable_reason` | Park | `wrong_author_ll_book_id` | Other-author book |
   | `ll_book_id` | LazyLibrarian book | `title` | Title |
   | `matched_books_item_id` | In the library as | `author` | Author |
   | `kapowarr_volume_id` | Kapowarr volume | `origin` | Origin |
   | `comicvine_id` | ComicVine volume | `pairing_books_item_id` | Paired with |
   | `ll_rerequested_at` | Re-request ended | `collection_id` | Collection |
   | `collection_member_ref` | Collection member | | |

   **Hidden** (`REQUEST_EVENT_HIDDEN_FIELDS`, display only; the record keeps them): the app's own row ids
   `integration_id` and `shelf_item_id`, which name nothing a person can read or look up.

   Values: a status in the Wanted detail's words (Requested, Wanted, Grabbed, Have it, Missing); a park in words (`comic`
   Waiting on a ComicVine match, `wrong_volume` Wrong volume, `multi_book` Series holds several books, `no_book` Series
   holds no book, `foreign_language` Not in English, `no_english_edition` No English edition, none: Not parked); the
   origin (Goodreads shelf, Format pairing, Collection); a time as a date and time; a library item or collection by title
   (a live item links to its book detail; a removed one says "no longer in the library"; one whose row is gone reads
   "A title no longer in the library" or "A removed collection", never a bare id); a LazyLibrarian, Kapowarr or
   ComicVine id in full, in monospace; an empty value reads "Not set".

   **A collection want reads as its Wanted detail does** (issue #759): the detail shows only the format its collection
   uses (Kavita: ebook, Audiobookshelf: audiobook) and reads that format's `landed` as "Downloaded, not in the library
   yet". The read returns `want` (`origin`, `collectionFormat`, from the live row, else from the deleted want's mint or
   delete snapshot and its collection), and the History leaves out the other format's status and uses the same words
   for the own format's `landed`. Where the format is unknown (the collection is gone) both show, as on the detail.
   (A collection want is never matched to a library item: 0 of 142 on 2026-10-07.)
3. **The writer's context** (`detail`), "Label: value" pairs in a fixed order (Postgres `jsonb` does not keep the
   writer's key order): `outcome` (the re-request: LazyLibrarian already had it, took
   it back, refused it, waiting for the next quota day), `cause` (LazyLibrarian does not hold it, has not grabbed it,
   holds a different book, holds another volume or work; the library title changed), the LazyLibrarian ids, the formats.
   A key the module does not know is shown with its name in words, never hidden; an empty list or a repeated id is left
   out.
4. **When and who**: the date and time, then "Sync", "Repair script" or the person's display name ("A removed account" when
   it is gone), then the job and leg in words (`format-pairing.rerequest` reads "Format pairing, re-request").
5. **Empty and partial.** No events: "No changes recorded for this want yet. Changes are recorded from Oct 6, 2026." (the
   day migration 0096 shipped, in the viewer's locale). When the whole history is loaded and its oldest event is not the
   mint, the want began before recording did: "Changes before Oct 6, 2026 were not recorded."

**Reasons in words** (every `BOOK_REQUEST_EVENT_REASONS` member; the map is typed against the union, so a new reason
without words fails the typecheck):

| Reason | Words |
|---|---|
| `shelf_want_minted` / `shelf_want_refreshed` | Added from a Goodreads shelf / Updated from the Goodreads shelf |
| `ll_pushed` / `ll_reconciled` / `ll_requeued` | Sent to LazyLibrarian / Status updated from LazyLibrarian / Queued again in LazyLibrarian |
| `comic_routed` / `comic_reconciled` | Sent to Kapowarr / Status updated from Kapowarr |
| `landed_reverted` | Status corrected after a LazyLibrarian check |
| `ll_book_gone_repointed` / `ll_book_gone_settled` | LazyLibrarian book replaced, pointed at the new one / LazyLibrarian book gone, marked missing |
| `ll_rerequest` | Re-requested from LazyLibrarian |
| `pairing_want_minted` / `pairing_want_refreshed` | Added by format pairing / Updated by format pairing |
| `pairing_want_revived` | Reopened: the paired copy left the library |
| `pairing_held_format_landed` | Held format set to Have it |
| `pairing_want_reidentified` / `pairing_want_retitled` | Cleared to look for the right book / Renamed to match the library title |
| `collection_want_minted` / `collection_want_refreshed` | Added as a missing collection member / Updated from the collection |
| `collection_want_dropped` / `collection_removed` | Removed: no longer missing from the collection / Removed with its collection |
| `collection_want_downloaded` / `collection_want_download_reverted` | Downloaded, not in the library yet / Downloaded status taken back |
| `force_search_reopened` | Reopened by a Force Search |
| `wrong_author_released` | Released: the book was by another author |
| `parked` / `unparked` | Parked / Unparked (the Park field names which park) |
| `english_edition_switched` | Switched to an English edition |
| `wrong_volume_repaired` / `removed_anchor_settled` / `parked_want_conformed` | Repaired: it pointed at the wrong volume / Settled: its library title was removed / Statuses corrected on a parked want |

**Layout.** The field list wraps (label and value on one line where they fit, the value under the label where they do not);
ids and titles wrap anywhere, so a phone (390 px) never scrolls sideways. Tokens only (hard rule 2). Opening "Show changes"
or loading older changes grows the list in place and moves nothing beside it (hard rule 9).

**Not built.** The requester's own view (ruled out). An estate-wide feed of one decision (`WHERE reason = …`) stays a SQL
read (the queries in the Request Events amendment above).

**Tests.** `packages/domain/__tests__/book-request-history.test.ts` (newest first, one want only; paging at sizes 1, 2 and
4 neither skips nor repeats through a shared transaction timestamp and through timestamps a microsecond apart; the cursor
keeps microseconds; the person's name, and none once the account is gone or for a sync event; `refs`; a deleted want's
mint, change and delete through the real writers; a collection want's format, live and deleted; an unknown want is
empty), `packages/api/__tests__/books-request-events.test.ts`
(anonymous `UNAUTHORIZED`; the requester and a household reader `FORBIDDEN`; an admin's wire rows; cursor paging; a
malformed cursor `BAD_REQUEST`; an unknown want empty), `apps/web/lib/__tests__/request-events.test.ts` (every recorded
field labelled or hidden by name, every reason worded, no em-dash; updates, mints, deletes, titles and links, no bare
row id; a collection want's one format; the context; who and where), and the e2e admin journey in `apps/web/e2e/integrations.spec.ts` (the Wanted detail's History shows the shelf mint
as its oldest event in words, at 390 and 1280 px with no sideways scroll).

## Amendment: 2026-10-07, one Kavita series per book (issue #825, ADR-105)

The EPUB converter also removes grouping metadata from existing EPUBs and newly converted output. Its conversion
eligibility rule still skips folders already holding EPUB/PDF; the metadata pass visits EPUBs independently.
Remove `calibre:series`, `calibre:series_index`, every EPUB 3 `belongs-to-collection`, and the `collection-type` and
`group-position` refinements of removed collections. Keep collection titles (`title-type=collection`), every
unrelated OPF byte and every other ZIP member. Refuse a file whose edit would leave dangling refinements or require
changing unrelated metadata. Untagged books retain their original bytes and modification times unless the
owner-approved same-title rule below requires a dedicated grouping tag.

The shared converter lock serializes both passes. Refuse unsafe paths, symlinks, hardlinks, changing or unsettled
files and invalid archives. Backups live under `books/.epub-convert/backup/`, outside `EBooks/`, with verified
checksums and a record of the original relative path. Retention is indefinite until an explicit owner decision;
restore validates that backup and the current file before an atomic replacement, then scans Kavita. Write each
candidate to a sibling temporary file, validate its ZIP (including first, stored `mimetype`), parse its OPF, prove
only the approved metadata was removed, and atomically replace the unchanged source. A failed file stays intact
and is reported. Touch its book/author folders and queue one Kavita scan after successful edits.

Ship disabled, with read-only dry run and explicit targeted-folder mode. Before enabling: run the Held File Check
against metadata with the series removed, repair or record a justified Census Hold for new findings, deploy pairing
safeguards, and complete the adversarial review. The original stage used the two Suzanne Collins folders.
Each further stage uses a fresh inventory and exact approved paths. Before pausing, checkpoint the schedules and
prepare one reviewed GitOps inverse with a recovery watchdog. Pause only for metadata edits, scans, file validation
and reading-state comparison. Restore schedules and Libretto acquisition immediately on success, failure or
uncertainty, before app, pairing or recipe checks. Keep the strip gate off through those checks. Enable
the hourly step only after the full run is verified. Preserve the extracted series name/index in the backfill
inventory to restore reading order through Libretto. The next nightly scan is a dated Owed Check.

**Collision preflight and Q-05 ruling (2026-10-08, ADR-106).** Before mutation, project grouping across the entire EPUB
library. For the same title by different authors, write `calibre:series` as `<title> (<author>)` and
`calibre:series_index` as `1`, including both tagged and untagged peers. The owner approved this in
[issue #830](https://github.com/thaynes43/haynesnetwork/issues/830). Keep titles, creators and identifiers unchanged.
Require an unambiguous author-role credit. Combined credits, unknown roles and conflicting spellings sharing an
author or folder alias stay held; a spelling difference does not establish a different person. The unchanged
author and title supply the qualifier. An already correct pair is unchanged.

A manual grouping-only proof may resolve an ambiguous role for one exact existing file. It binds the file and OPF
hashes, title, ISBN, ordered raw creators and owned title/copyright-page evidence to a verified primary publisher
source. It selects an existing creator without altering the raw credits. Missing or changed evidence refuses the
override. Hourly stripping and duplicate eligibility remain conservative without that proof. For The Face, the
publisher's [eBook ISBN 9781439121573](https://www.simonandschuster.com/books/The-Face/R-L-Stine/Fear-Street-Superchillers/9781439121573)
and the owned copyright page identify R.L. Stine as author and Bill Schmidt as
cover artist. This permits the qualifier while preserving both original creator entries.

Report unresolved holds in every census with their paths and reasons. The Fowl
Twins projected census warning is covered by a path-scoped hold: creator, UK EPUB ISBNs and publisher synopsis
confirm the correct third novel, while LazyLibrarian names the US edition. No title or identifier changes are needed.

**Reading-state hold (2026-10-08).** The converter also supports exact normalized library-relative folder holds,
validated before mutation. They preserve every file and metadata field through stripping, conversion, cleanup and
restore, including scoped Jobs, while remaining part of the read-only collision census. Malformed or unconfined
configuration stops the job before writes. Holds are reported separately from untagged books.
`Daniel Silva/Ransom` remains held: one progress row and one reading-session entry retain a nonempty XPath despite
zero numeric read counters. Compare all saved progress/session/bookmark/annotation state before and after each
migration scan. The hold remains configured when hourly stripping is enabled.

**Q-07 ruling (2026-10-08).** Keep Ransom's folder held during this migration and perform no progress migration or
reading-state writes. A held folder becomes eligible for a separately verified series-only strip after 30 days
without actual Kavita reading activity. OC-046 records the fresh assessment and release procedure in
[issue #840](https://github.com/thaynes43/haynesnetwork/issues/840). Use the actual last activity timestamp; recording
the hold does not restart the idle clock.

**Q-06 ruling (2026-10-08, ADR-106).** For same-title copies by the same verified author, keep the unique copy that
LazyLibrarian's BookFile points to. Move each unprotected extra into the retained backup area outside EBooks;
never delete it. This is a separate manual operation under the owner's
[issue #831 ruling](https://github.com/thaynes43/haynesnetwork/issues/831), never part of hourly stripping.
Check complete LazyLibrarian pointers, census repairs and `.ll_ignore` protections, Kavita reading dependencies
and app wants. Unknown dependencies, ambiguous authors and nonunique keepers leave the copies in place for review.

Dependency snapshots must begin after real writer fences are established and finish before those fences expire.
Require explicit capture start and completion timestamps for every source, a complete filesystem census, exact
path/hash/source identities and a short validity deadline. Snapshot flags alone do not establish quiescence.
The controlled window stops LazyLibrarian and Kavita through GitOps, suspends their relevant jobs and Libretto
acquisition, and holds primary PostgreSQL read-only SHARE locks on book requests and mirror items while capturing
and moving copies. Supervise lock health and abort on loss or expiry. Prepare and validate the exact GitOps inverse
while workloads are still running, then bound the service outage and restore immediately before further scans or
app checks. A move verifies its retained bytes before removing the original directory entry. Restoration verifies
the retained copy and publishes a fresh inode only to an absent original path, preserving the backup.

The complete byte and OPF census may be collected while production is running. It is
not a dependency snapshot or permission to move files. It must retain SHA-256, raw OPF
and parsed identity for every EPUB, plus device, inode, size, modification time, change
time, link count, mode, UID and GID for every library file. The collector must prove
a complete stable traversal, unchanged source descriptors and paths, and its actual
Pod/node/mount and immutable program identity. Partial or portable fingerprints that
omit device identity cannot support reuse.

Inside the short window, SOURCE still owns its primary PostgreSQL 16 read-only SHARE
fence and freshly captures all app and vendor dependencies after the service stops.
It traverses the entire library again. The trusted assembly compares the complete
path set and every full fingerprint with the reviewed live census while SOURCE's
lease remains healthy. Only exact matches may reuse those
byte and OPF facts; additions, removals, races, unsafe links or any changed field
refuse the operation and restore production. Retain the original byte-capture clocks
and hashes alongside the distinct current validation clocks. No old capture becomes
a new byte read. This proof concerns the configured publishing paths and does not
claim privileged storage or undiscovered aliases incapable of arbitrary writes.

MAIN owns its own primary read-only SHARE fence, independently validates the complete
current path/fingerprint set, and rehashes and parses every selected keeper and extra
before the first move. It checks descriptor/path identity and PostgreSQL health at
every file boundary and retains the first verified archive before continuing the
exact remainder. Unknown or changed inputs refuse; no refresh, retry or new census
is performed while paused. This removes redundant whole-corpus byte reads from the
pause without reducing selected-file or dependency checks. Normal hourly behavior
is unchanged. Keep the existing absolute expiry, exact writer ownership and restore
watcher. Any performance claim must come from actual completed captures, not the
faster of inconsistent earlier timings.
