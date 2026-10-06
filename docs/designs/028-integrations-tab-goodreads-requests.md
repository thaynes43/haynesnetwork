# DESIGN-028: Integrations tab — Goodreads shelf sync, requests/Missing, coverage

- **Status:** Accepted
- **Last updated:** 2026-10-05 (amendment: a want on a non-English LazyLibrarian book asks for the English edition, issue #719). Prior: 2026-10-05 (amendment: a landed format stays truthful, issue #715). Prior: 2026-10-05 (amendment: a request is never satisfied by another volume, issue #693). Prior: 2026-07-14
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
