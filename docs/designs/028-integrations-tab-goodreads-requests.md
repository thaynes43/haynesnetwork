# DESIGN-028: Integrations tab — Goodreads shelf sync, requests/Missing, coverage

- **Status:** Accepted
- **Last updated:** 2026-07-14
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
| Q-02 | Comics acquisition route? | Parked (`unroutable_reason='comic'`) — Kapowarr wiring is the saga pairing phase. |
| Q-03 | Exact LL queueBook/searchBook `type` param names? | Sent `type=eBook|AudioBook` (LL DLTYPES vocabulary). Verify against the live LL API at the owner-present acceptance run; adjust in the write client (one place) if needed. |
| Q-04 | read / currently-reading shelves + cross-provider coverage? | Later saga phases (point 3). |
