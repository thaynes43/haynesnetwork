# DESIGN-024: Books & Audiobooks Library — the `books_items` ledger, `books-sync`, section-gated walls + cover proxy

- **Status:** Draft
- **Last updated:** 2026-10-08 (issue #825: one-book series migration, independent successful chapter refresh and all actual Writers). Prior: 2026-10-06 (D-03 amendment, issue #761: a carried-forward run keeps a flat-layout series'
  writers author, so its format pairs stop flapping). Prior: 2026-10-05 (D-03 amendment, issue #712: Kavita metadata edits reach the mirror via a bounded
  rolling re-read). Prior: 2026-10-04 (D-03 amendment, issue #661: the books-sync reads each Kavita book
  series' held books from `/api/Series/volumes` into `attrs.heldBooks`). Prior: 2026-07-21 (**Kavita metadata-writers author fallback** — the live pairing-gap
  diagnosis found 54 null-author ebook rows whose WRITERS sit in Kavita all along: the mirror's
  Kavita author was folder-derived ONLY (the Calibre-style author directory), so flat layouts went
  null. The enrichment reduce now carries `writers[]{name}` and `normalizeKavitaSeries` falls back
  to `writers[0]` when the folder derive is null (folder stays primary — zero churn for the 96%
  that worked). The change-gate loader treats a null-author BOOK row as never-enriched so one run
  heals the backlog, then the row re-enters the gate. Comics keep their honest null unless Kavita
  carries a writer. Prior: 2026-07-20 (ADR-075 — the **Audiobooks wall retires**: ebooks + audiobooks unify into
  ONE Books wall with a three-state Format facet, work-grain `books.search` with pair-collapse, tab list
  without Audiobooks; see the Overview + D-04 + D-06 dated amendments. Prior: 2026-07-17 — D-01/D-03
  detail-page enrichment: five nullable columns + the Kavita `/api/Series/metadata` change-gate;
  migration 0060, R-221)
- **Satisfies:** PRD-001 **R-151..R-156**, **R-221** (detail-page enrichment data layer), **R-231** (the
  unified Books wall — ADR-075); governed by **ADR-046** (books ledger source + the
  dedicated-table vs `media_items` decision), reusing **ADR-021 / DESIGN-009** (Section Permissions),
  **ADR-037** (ship-Admin-only rollout), **ADR-019** (authed poster proxy), and the **ADR-044 / DESIGN-022**
  ingestion-mode shape (`ai-usage-sync`). Bounded context DDD-002 **BC-03 Media Ledger** (a new book-media
  sub-context). Glossary **T-136..T-138** (Books Ledger, `books-sync`, Books Section). **Companion:**
  DESIGN-017 (the ytdl-sub Library sub-tabs whose idioms these walls reuse).

## Overview

Three new **Library** sub-tabs — **Books · Audiobooks · Comics** — sitting after YouTube and before My Fixes
(My Fixes stays LAST). Each renders a poster-card grid over the app-owned **`books_items`** ledger, a
one-way synced mirror of **Kavita** (Books=EBooks + Comics) and **Audiobookshelf** (Audio Books). The walls
gate on a new **`books` Section-Permission** (ships `disabled` = Admin-only; owner opens per role after a
screenshot review). Two catalog cards (Kavita, Audiobookshelf) deep-link to the servers. Read-only end to
end — Kavita/ABS are the source of truth; the app never writes back (no Fix/Restore for books; ADR-046).

> **Amended 2026-07-20 (ADR-075 — unified Books wall).** The **Audiobooks wall RETIRES**: the Books and
> Audiobooks sub-tabs unify into ONE **Books** wall over `media_kind ∈ {book, audiobook}`, with format as a
> three-state facet and paired titles collapsed to one work card. **Comics stay their own wall.** This is a
> presentation-layer merge (a registry row + one `books.search` read-model change, ADR-051 C-01) — the
> `books_items` mirror, the `books-sync` mode, the `books` section gate, and the cover proxy are UNCHANGED.
> Where this doc says "Books · Audiobooks · Comics", read **Books · Comics** (Audiobooks folds into Books);
> the D-04 search contract becomes work-grain (the pair-collapse + anchor rule + Format seg), and D-06's tab
> splice drops Audiobooks. See the dated notes in D-04/D-06 and PRD R-231.

## D-01 — Schema (`books_items`, migration 0037)

`books_items` (`packages/db/src/schema/books-items.ts`) — one row per Kavita series / ABS library item:

- Identity: `id` uuid PK; `source` (`kavita|audiobookshelf`, CHECK) + `external_id` (Kavita series id as
  text / ABS item uuid) with a `(source, external_id)` UNIQUE; `media_kind` (`book|comic|audiobook`, CHECK).
- Provenance: `library_id` / `library_name`; `deep_link_url` (the public Kavita/ABS item URL).
- Descriptive: `title`, `sort_title` (lowercased for stable ordering), `author` (nullable — ABS
  `authorName`; Kavita best-effort from the author folder), `narrator` (ABS), `series_name` (ABS), `year`
  (nullable), `genres` jsonb `string[]`, `cover_ref` (Kavita `coverImage` version string / ABS `updatedAt`
  ms — self-versioning for the cover ETag).
- Per-medium metrics (honest, all nullable): `page_count`/`word_count` (Kavita), `duration_seconds`/
  `size_bytes` (ABS); `attrs` jsonb for source-specific extras (Kavita format int; ABS numTracks/chapters/language).
- **Detail-page enrichment (amendment 2026-07-17; migration 0060 — five additive nullable columns):**
  `summary` (the About blurb — Kavita `/api/Series/metadata` summary HTML-stripped; ABS `description`),
  `publisher` (Kavita `publishers[0].name` / ABS `media.metadata.publisher`), `isbn` (ABS
  `media.metadata.isbn`; Kavita null — the M2 caveat, series-detail skipped), `file_count` (ABS
  `numAudioFiles`; Kavita null), and `metadata_synced_at` (the change-gate bookkeeping — when the
  per-series Kavita metadata call last ran). `genres` (existing) and `year` are now POPULATED for
  Kavita too (from the metadata call's genres/`releaseYear`; the series list carries neither). Language
  stays in `attrs.language` (the facet reads it there) — filled for Kavita from the metadata call.
- Sync bookkeeping: `first_seen_at`/`last_seen_at`, `deleted_at` (TOMBSTONE — null = live; the walls show
  live only), `source_added_at`/`source_updated_at`, `created_at`/`updated_at`.
- Indexes: `(media_kind, sort_title)` (the wall's ordered scan) + `(media_kind, deleted_at)` (live filter).

**Why not `media_items`:** ADR-046 option 2 — `media_items`' `arr_kind`/external-id CHECKs, its NOT-NULL
`monitored`/`quality_profile`/`root_folder`, and the Fix/Restore/`/ledger` machinery all assume an \*arr of
record. Books have none; a dedicated table is the honest, precedent-matching choice (the ai-usage-chats /
authentik-users class). Migration 0037 also rebuilds the `role_section_permissions` section CHECK (`+books`)
and the `sync_runs.run_kind` CHECK (`+books-sync`, parity only), and seeds the two catalog rows.

## D-02 — `@hnet/books` read clients (read-only, no write surface)

`@hnet/books` (`packages/books/`) exports `.` (errors + config + schemas) and `./read` (clients) — **no
`./write`**. `KavitaClient` and `AudiobookshelfClient` each manage a session token with **lazy login + one
401 re-auth**:

- **Kavita:** `POST /api/Account/login {username:'hnetadmin', password}` → `{token, apiKey}`. Reads
  `/api/Library/libraries` and `POST /api/Series/all-v2?PageNumber=&PageSize=` (a `FilterV2Dto` scoping to a
  library: `field 19 = Library`, `comparison 0 = Equal`); the per-library total comes from the `Pagination`
  response header. `fetchSeriesCover(id)` (server-side, apiKey query param) for the proxy.
- **ABS:** `POST /login {username:'root', password}` → `{user:{token}}`. Reads `/api/libraries` and
  `/api/libraries/{id}/items?limit=&page=` (`total` in the body). `fetchItemCover(id)` (bearer header) for
  the proxy.

Env contract (`assertBooksEnv`): `KAVITA_URL`/`KAVITA_USERNAME`/`KAVITA_PASSWORD`/`KAVITA_PUBLIC_URL` +
`AUDIOBOOKSHELF_*` (URLs + usernames default to the in-cluster Service DNS + bootstrap accounts; passwords
required, never echoed). The clients are zod-validated at the ACL boundary (strip mode). Unit-proven offline
via an injectable `fetchImpl` (`packages/books/__tests__/read-clients.test.ts` — login, header total,
401 re-auth, cover apiKey/bearer).

## D-03 — `books-sync` mode + `syncBooks` single-writer

`packages/sync/src/books.ts` `fetchBooksSnapshot(bundle)` pages both servers and NORMALIZES each row to a
`BooksItemInput` (the wire-shape parsing + the Kavita author-folder heuristic live here). A source joins
`syncedSources` ONLY when ALL its libraries paged without error. `@hnet/domain syncBooks` then, in one
transaction: UPSERTS on `(source, external_id)` (a re-sync REPLACES each row and clears any tombstone —
re-appeared items go live again) and TOMBSTONES rows of a fully-synced source whose `last_seen_at` predates
the run (`deleted_at` set — never hard-deleted). Tombstoning is scoped to `syncedSources` so a partial run
never tombstones the source it couldn't read. No `sync_runs` row (the mirror is its trail); guard-listed
(`no-direct-state-writes` — INSERT/UPDATE forms). Orchestrator branch mirrors `ai-usage-sync`; a
neither-source-complete run is a `totalFailure`. Unit-proven: `packages/domain/__tests__/books.test.ts`
(upsert, idempotent re-sync, tombstone-on-vanish, un-tombstone, scoped tombstoning, per-kind counts).

**Enrichment + change-gate (amendment 2026-07-17).** `fetchBooksSnapshot(bundle, logger, {existingKavita, now})`
now ENRICHES each row for the detail page (D-01 columns). **ABS** enrichment is INLINE - description/publisher/
isbn/numAudioFiles ride the existing `/api/libraries/{id}/items` list read, so ABS costs no extra request.
**Kavita** enrichment needs a per-series `GET /api/Series/metadata?seriesId=` (summary/genres/publishers/
language/releaseYear - the series list carries none), so it is **change-gated**: the orchestrator reads the
existing live-Kavita enrichment once (`loadExistingKavitaEnrichment` - source updated-stamp + last-enriched-at
+ the enrichment columns), and the fetcher calls the metadata endpoint ONLY for a series that is new, never
enriched (`metadata_synced_at` null), or whose `lastChapterAddedUtc` changed since the last run; an unchanged
series CARRIES its last enrichment forward (no request) so the upsert stays a clean full-replace. The calls are
paced (a small concurrency pool); a per-series metadata failure is non-fatal (carry existing forward, retry
next run). The gate alone would issue ZERO per-series calls for the ~1,400 unchanged Kavita series; since the 2026-10-05
amendment below (issue #712) a bounded rolling re-read adds a capped batch per run, because Kavita gives no
metadata change signal for the gate to compare. Kavita size/ISBN/file-count would need the heavier `/api/Series/series-detail`
per series (the M2 ISBN caveat: ISBNs are usually absent) - deliberately SKIPPED, so those Details rows show
for audiobooks only (the honest gap). Unit-proven: `packages/sync/__tests__/books-enrichment.test.ts`
(HTML-strip, the metadata reduce, ABS inline mapping, the change-gate skip/refetch/carry-forward-on-failure).

**Metadata edits reach the mirror (amendment 2026-10-05, issue #712).** The change-gate above compares
`lastChapterAddedUtc`, and Kavita has no signal that fires when a series' METADATA is edited: the series list
carries only `created` and `lastChapterAddedUtc`, and `/api/Series/metadata` has no modified stamp or hash (probed
live 2026-10-05 against the deployed Kavita: correcting `language` and `languageLocked` on a series moved nothing
the list returns). So on 2026-10-05 eighteen series whose language was corrected to `en` kept their old tags in
`attrs.language` (`metadata_synced_at` still July) and the #700 pairing block could not clear. The fetcher now
re-reads metadata beyond the gate, per library, in two tiers (`selectMetadataRefresh`, pure and unit-tested):

1. **Foreign-language series every run.** A series whose stored `attrs.language` classifies as foreign
   (`classifyBookLanguage`, DESIGN-036 amendment of #700) is re-read on every run, whatever its last read, so a
   language correction lands on the very next run. This is a handful of calls today and shrinks as items are fixed.
2. **A bounded rolling refresh of the rest.** The series whose last read is OLDEST, and at least
   `KAVITA_METADATA_REFRESH_MIN_AGE_MS` (6 hours) old, up to `KAVITA_METADATA_REFRESH_CAP` (150) per library per
   run, foreign ones first. About 1,400 series at 150 a run is a full cycle in roughly ten hourly runs, so ANY
   metadata edit (summary, genres, publisher, year, writers) lands within about ten hours, at 150 cheap GETs a run
   (the initial backfill read all of them in one run). A series never read (`metadata_synced_at` null) is the
   gate's job, not the refresh's. Both options can be overridden per run (`metadataRefreshCap`, 0 turns it off;
   `metadataRefreshMinAgeMs`).

The run log reports `kavitaRefreshed` (re-reads the gate alone would have skipped) next to `kavitaEnriched`. The
held-books read is untouched (a metadata edit does not change them). **Audiobookshelf has no such blind spot:** its
language, description, publisher and ISBN ride the library-items list read, which is re-read in full every run, so
an edit there lands on the next run (the two Audiobookshelf corrections of 2026-10-05 did). Unit-proven:
`packages/sync/__tests__/books-enrichment.test.ts` (`selectMetadataRefresh`, the foreign and stale re-reads, the
cap-0 gate) and `books-sync-metadata-refresh.test.ts` (end to end on embedded PG16: a metadata-only edit reaches
`attrs.language`, then the series is gated again).

**The held books (amendment 2026-10-04, issue #661).** A Kavita row is a SERIES and its `title` is the series
name, so the mirror said nothing about which book a series holds: the series "A Song of Ice and Fire" can hold
one file, Fire & Blood. The fetcher now also calls `GET /api/Series/volumes?seriesId=` (`listSeriesVolumes`)
for each **book** series (never comics) and stores the result as `attrs.heldBooks`: one entry per chapter,
which in an EBooks library is one book file, holding the chapter's own `titleName` (else a non-numeric chapter
`title`), its first writer and its ISBN (blank is null). Values are kept raw (no cleaning, no de-duplication);
the pairing leg decides what they mean (DESIGN-036 amendment 2026-10-04). The read is change-gated like the
metadata call: a series that is new or changed is read, an unchanged one carries its list forward, and a row
with no `heldBooks` key yet is read once (the backfill, about 1,700 series on the first run). A failed read
carries the last list forward, or leaves the key absent, and the next run retries. An absent key means "not
read"; an empty list means the series holds no book file. A book row with no author stays in the gate map
with its `metadata_synced_at` read as null, so its metadata is still re-fetched every run (the writers
fallback) while its held books carry forward; it used to be left out of the map, which would have re-read
its volumes every run too. The dev:local/e2e stub Kavita answers the call (one book per series). No migration
(`attrs` is the existing jsonb catch-all). Unit-proven in the same test file (the reduce, read-new,
carry-forward, backfill, failure, comics) and end to end through `runSync` in `books-sync-held-books.test.ts`.

> **Amendment 2026-10-06 (issue #761 — a carried-forward run keeps the writers author).** The change gate rebuilt an
> unchanged Kavita series' enrichment from the stored row with an empty `writers` list, so a flat-layout series (no
> author folder, its author from the metadata writers) was written back with a null author on every carried-forward
> run; the next run saw an authorless row and re-fetched it. About 35 series alternated hourly, and because the pair
> matcher skips a book with no author, their format pairs dropped and came back every run (`paired` 712 then 715,
> each `revived` re-pushing a landed pairing want). `loadExistingKavitaEnrichment` now carries the stored author as the
> writers fallback. The folder-derived author stays primary, and the rolling refresh (issue #712) still re-reads the
> writers, so an author edited in Kavita lands within its window. Tested end to end in `books-sync-held-books.test.ts`
> (three runs over an unchanged flat-layout series: one metadata call, the author stays).

## D-04 — The Books read contract (`books.search` / `books.filterFacets`)

`packages/api/src/routers/books.ts`, gated by `booksProcedure` (`sectionProcedure('books','read_only')`):

- `books.access` (authed) — the caller's own `{ level, visible }` for the client tab gate.
- `books.search` — input `{ mediaKind, query?, genres?, sort, limit, cursor }`. WHERE `media_kind = kind AND
  deleted_at IS NULL`; `query` ILIKE title/author; `genres` via `jsonb_array_elements_text` membership.
  Sort options (direction baked): `title` (asc), `author` (asc nulls last), `added` (source_added desc),
  `year` (desc nulls last), `duration` (desc nulls last), each with `sort_title`/`id` tiebreakers. **Offset
  pagination** (`cursor` = offset; `nextCursor` = offset+limit while a full page returns) — the walls are
  bounded, so offset is honest (vs the ledger's keyset for 17k+ rows). Returns `BooksListItem`s carrying the
  authed `posterUrl` (`/api/books/cover?source=&id=&v=<coverRef>`, or null → fallback tile) + the
  `deepLinkUrl`.
- `books.filterFacets` — distinct genres for a kind (empty for Kavita book/comic; ABS carries genres).

Reuses the DESIGN-008 D-10 `@hnet/ui` filter/sort ENGINE idioms on the client **without** overloading the
\*arr-shaped D-09 wire contract (which has no author/narrator/duration and carries \*arr-only
monitored/resolution dims). Unit-proven: `packages/api/__tests__/books.test.ts` (the level seam +
filter/sort/pagination + the cover-url builder + facets).

> **Amendment 2026-07-20 (ADR-075 C-02/C-03/C-04 — `books.search` returns WORK cards).** On the unified
> Books wall `books.search`'s `mediaKind` widens to the pair `{book, audiobook}`: live `book`/`audiobook`
> rows LEFT-JOIN `books_format_pairs`, and a paired (book, audio) duo **collapses to ONE card anchored on
> the ebook row** (deterministic — the `BOOKS_MEDIA_KINDS` tie-break precedent), carrying the partner's
> metadata (narrator, duration, language, read state) for facets/sorts and linking to the anchor's detail
> page (both consume buttons already render, ADR-065). The **anchor rule is TOTAL**: an unpaired audio-only
> row anchors on itself — no card vanishes for lacking an ebook (PLAN-060 E-2); divergent pair metadata
> matches facets on the UNION, displays the anchor's values (E-3). Facet/sort/pager counts become **WORK
> counts**. A three-state **Format** segmented control rides the wire — All · Ebook · Audiobook (`?format=`;
> "Ebook" = works holding an ebook, paired + ebook-only) — and the old Books-wall `fmt` (epub/…) facet
> **relabels File** (keeps its param). Facets union with **data-gating** (no dead chip, ADR-051 C-06):
> Author/Genre/Wanted universal; Narrator/Series/Language/Length/Read gate on audio-carrying works;
> Pages/File gate on ebook-carrying works. Mixed-format sorts stay partial + honest (Length sorts
> audio-carrying works, Pages ebook-carrying, NULLS LAST). Comics are untouched (no pairing, no format
> seg). The pair cache is the collapse join — see DESIGN-036 (2026-07-20 amendment) — and PRD R-231/R-167.

## D-05 — The cover proxy (`/api/books/cover`, ADR-019/-046 C-05)

`apps/web/app/api/books/cover/route.ts` (Node runtime) — session-gated AND `books`-section-gated
(`effectiveSectionLevel(role,'books') === 'disabled'` → 404, the same server-authoritative posture as the
ytdl-sub proxy). Validates `source` (closed enum) + `id` (numeric for Kavita, uuid-shaped for ABS), answers
`If-None-Match` with a 304, else serves the upstream via `@hnet/api getBooksCover` (Kavita apiKey /
ABS bearer applied **server-side** — never the browser). Strong `(source, id, coverVersion)` ETag +
`Cache-Control: private, max-age=86400, stale-while-revalidate=604800`; any miss → 404 →
`MediaPoster` KindIcon fallback tile (`book`/`audiobook`/`comic` glyphs, currentColor). No storage.

**Amended 2026-07-12 (F-06 — wall-scroll cover latency; the ADR-041 idiom ported).** The original
"no transcode (covers are already thumbnail-sized)" note was half-wrong, measured live 2026-07-12:
Kavita pre-generates covers at tile-ish dimensions but encodes **PNG** — 309 KB median / 400 KB max
over a 20-series sample (~15–30× the Movies/TV `poster-250.jpg` tile), and `/api/Image/series-cover`
**ignores resize params**; ABS originals are modest (10–24 KB JPEG) but every request re-fetched
upstream (~70–140 ms in-cluster) with no server-side memoization. The port (same shape as DESIGN-017
D-07, no new ADR — no deviation from ADR-041's pattern):

- **ABS sized variant** (`@hnet/books` `fetchItemCover(id, variant?)` + `@hnet/api` `ABS_COVER_VARIANT`
  = `{width: 300, format: 'webp'}`, FIXED server-side — never client-chosen): ABS resizes + re-encodes
  upstream (`?width=300&format=webp` ⇒ ~10–14 KB WebP, verified live), width-only so native cover
  aspect is kept. A sized-variant miss degrades to the **original-cover fallback tier** (ADR-041 C-02
  mirror): served with `max-age=300`, **no ETag, never memoized** — a transient resize quirk can't make
  originals sticky. Kavita has no resize seam, so its pre-generated cover is served as stored.
- **LRU** (`booksCoverCache()` — a second `ThumbLruCache` singleton, default caps 32 MiB / 1 MiB per
  entry, separate from the ytdl-sub one): memoizes the primary tier for BOTH sources keyed
  `source:id:coverVersion` (version-scoped ⇒ replaced art misses; stale entries age out). Memoization,
  NOT a store — the ADR-019 no-image-storage posture stands. Estate context: ABS fits whole
  (~823 items × ~12 KB ≈ 10 MB); Kavita (1333 series × ~268 KB avg) keeps its hot ~2 wall pages.
- **ETag**: unchanged formula for Kavita (`source:id:version` — bytes identical, existing browser
  caches stay valid); ABS bakes in the variant token (`…:w300webp`) so pre-variant JPEG caches
  revalidate once into the smaller WebP.
- **Residual + the remaining lever**: repeat scrolls are now 304s/memory hits everywhere, and
  Audiobooks first-paint tiles drop to ~10–14 KB — but Kavita first-paint payload stays ~300 KB/tile
  because only Kavita itself can re-encode its covers. The ops-side lever (owner decision, not this
  app) is Kavita's admin setting **Media → "Save Media As" = WebP**, which regenerates covers ~10×
  smaller; the proxy needs no change to benefit.

## D-06 — Library UI (tabs + the three walls)

`apps/web/app/(app)/library/`:

- `page.tsx` resolves `booksVisible = effectiveSectionLevel(role,'books') !== 'disabled'` server-side and
  threads it (alongside `ytdlsubVisible`) to `library-client.tsx`.
- `library-client.tsx` splices `BOOKS_TABS` (Books/Audiobooks/Comics) in **after** the ytdl-sub tabs and
  **before** `MY_FIXES_TAB` (My Fixes always LAST), only when `booksVisible`. Tab order:
  **Movies · TV · Music · Peloton · YouTube · Books · Audiobooks · Comics · My Fixes**. A hidden caller who
  deep-links `?tab=books` falls back to Movies (validated against the visible set).
- `books-browser.tsx` — the wall body: a debounced search box + a single-select sort bar (`.sort-btn`) +
  the `.media-list.poster-grid` of `.poster-card` tiles (`MediaPoster` + fallback glyph), driven by
  `books.search.useInfiniteQuery` and **scroll-paginated** (see the amendment below). Tiles are **external
  deep-links** to Kavita/ABS (`target="_blank" rel="noopener noreferrer"`). Reflow-free (ADR-015): fixed 2:3
  poster boxes, dim-in-place on refetch, fixed-height sort row, skeleton tiles on first load, a one-line
  ellipsized author subtitle (`.media-card__subtitle`). No new hex.

> **Amendment (2026-07-11, UX parity fix — presentation-layer only):** the three Books walls originally
> paginated with a manual "Load more" button. To unify with the Movies/TV/Music (and every other) Library
> wall, `books-browser.tsx` now reuses the shared **scroll-pagination idiom** verbatim from
> `library-client.tsx` `MediaBrowser` (DESIGN-008 D-11): an `IntersectionObserver` sentinel below the grid
> (`rootMargin: '600px 0px'`, gated by `hasNextPage && !isFetchingNextPage && !isPlaceholderData`) calls
> `fetchNextPage()` as it nears the viewport. The "Load more" button is removed. No endpoint/schema change —
> the existing `books.search` offset pagination (`limit`/`cursor`/`nextCursor`) feeds the same
> `useInfiniteQuery`; only page-append plumbing moved from a click to the sentinel. Appending pages below the
> grid is reflow-free (ADR-015 — existing tiles never move); the fetching hint sits under the grid. The
> URL-synced tab state (and the search/sort draft state) survive pagination unchanged.

> **Amendment 2026-07-20 (ADR-075 C-01 — the Audiobooks tab retires).** `library-client.tsx` splices
> `BOOKS_TABS` as **Books · Comics** (no Audiobooks) after the ytdl-sub tabs and before `MY_FIXES_TAB`. Tab
> order becomes **Movies · TV · Music · Peloton · YouTube · Books · Comics · My Fixes** (My Fixes still
> LAST). The single Books wall renders both formats as work cards (D-04 amendment) with the three-state
> **Format** seg; `books-browser.tsx` gains the seg beside the already-shipped coverage badge (DESIGN-036
> D-09). A caller deep-linking the old `?tab=audiobooks` REDIRECTS to `?tab=books&format=audiobook` (C-07 —
> shared links keep meaning). The `books` section still gates both walls with **no permission migration**
> (C-01); the per-user `audiobooks` wall preference key retires (orphaned rows dropped, C-06). Reflow-free
> (ADR-015).

## D-07 — Section gating (`books`, ADR-046 C-04)

`SECTION_IDS += 'books'`, `SECTION_DEFAULT_LEVELS.books = 'disabled'` (ships Admin-only; an `is_admin` role
implies `edit`). `booksProcedure = sectionProcedure('books','read_only')` gates the tRPC surface; the cover
route applies the same check; the page gate + client splice hide the tabs. Server-authoritative — a
non-permitted caller gets neither the tabs, the data (FORBIDDEN), nor the covers (404). The owner opens a
role to `read_only` via the existing `/admin/roles` section editor (audited, reversible). Unit-proven:
`packages/api/__tests__/books.test.ts` (Disabled → FORBIDDEN; a Read-Only role row opts in; Admin sees it),
plus the section CHECK + session-hydration coverage inherited from the shared `SECTION_IDS` machinery.

## D-08 — Catalog cards (ADR-012/-013, migration 0037)

Two `app_catalog` rows seeded idempotently by slug: `kavita` → `https://kavita.haynesnetwork.com` and
`audiobookshelf` → `https://audiobookshelf.haynesnetwork.com`, icons `kavita`/`audiobookshelf` (new
code-shipped `ICON_KEYS` + inline SVGs, currentColor). **No role grants seeded** — Admin sees them
implicitly; the owner grants Default/Family via `/admin/catalog` + `/admin/roles` after review. Adding a new
app needs NO schema change (ADR-012) — pure data + the icon-key code addition.

## D-09 — Ops (haynes-ops)

`books-sync` runs as a haynes-ops CronJob mirroring `sync-ai-usage` (`tsx /sync/src/scripts/sync.ts
--mode=books-sync`, `Forbid` concurrency). haynes-ops change = image bump + one `sync-books` CronJob block +
`KAVITA_PASSWORD`/`AUDIOBOOKSHELF_PASSWORD` templated into the app ExternalSecret (targeted `data[]`
remoteRefs from the `kavita`/`audiobookshelf` 1Password items — the `OPENWEBUI_API_KEY` precedent). URLs
default in code to the in-cluster Service DNS. The web pod carries the same two passwords (the cover proxy
authenticates from it). Read-only against both servers.

## Open decisions (owner, morning)

- **Q-01 (roles):** which role(s) get the `books` section (`read_only`) after the screenshot review, and
  which roles get the Kavita/ABS catalog cards (Default/Family). Defaults ship Admin-only.
- **Q-02 (card copy):** the two catalog cards' name/description copy (seeded "Read — ebooks & comics" /
  "Listen — audiobooks").
- **Q-03 (genre chips):** whether to add genre filter chips to the walls now (the facets endpoint ships +
  is unit-proven; the chip UI is a deferred follow-up) — mostly relevant to Audiobooks (Kavita carries no
  series genres).

## Amendment: 2026-10-07, one Kavita series per book (issue #825, ADR-105)

The library's EPUB converter removes grouping metadata while preserving book titles, authors and identifiers.
Kavita groups these EPUBs by book title. The series id can survive when the old series name is a book title, or be
replaced by new book series ids; chapters and volumes may change. Books-sync keeps its scoped tombstone semantics
and refreshes Held Books when scanner/detail signals change. The backfill verification must prove exact file
coverage and current Held Books for retained ids as well as replacements before pairing runs. Same-title groups
remain a Kavita limitation. Removed anchors are history and are excluded from pairing acquisition and coverage;
see DESIGN-036's amendment of the same date. Libretto refreshes the replaced reading-list items from live chapters.

Held Book refresh must also run on the bounded rolling metadata pass and when page count, title or scanner stamp changes,
not only when `lastChapterAddedUtc` changes. Removing a chapter can leave that stamp unchanged; rolling metadata
refresh without the volumes read leaves the old book identity indefinitely. A detail-read failure on a known changed or forced-refresh series leaves its Held Books unread, so pairing waits
and the next run retries. An unchanged rolling refresh may retain its last successful value. Neither failure is
reported as an empty held-book set. Run a complete held-book refresh for
the backfill verification before computing format pairs.

Chapter rotation has its own successful-read timestamp (`attrs.heldBooksSyncedAt`), independent of metadata refresh.
An authorless row's metadata refresh is deliberately retried, so that timestamp cannot bound chapter freshness.
Only a successful volumes read advances the chapter timestamp; rotation remains capped per library. The one-off
sync exposes `KAVITA_FORCE_HELD_BOOKS_REFRESH=1` to read all book series after regrouping.

A Held Book also retains every actual chapter Writer name in optional `authors`, alongside its existing first
writer `author`. Coauthored books must not lose a verified author merely because Kavita orders another Writer
first. Pairing may prefer the row's author only when an actual chapter Writer agrees with it; otherwise the
chapter's writer remains authoritative. A known chapter writer list never licenses an unverified aggregate author.
Older records without `authors` keep their existing first-writer semantics until a successful refresh.

The metadata migration holds `Daniel Silva/Ransom` because it has saved reading-location and session state.
Zero page/read counters do not prove an empty location. Before and after each migration scan, compare every
progress, location, session, bookmark and annotation field against the exact source file.

**Q-04 resolved, coordinator ruling 2026-10-08:** keep the whole folder held with its series tag; no progress
migration engineering. A held folder becomes eligible for the series-only strip once its Kavita reading activity
has been idle for 30 days. Measure from the latest actual reading timestamp across all users, rather than from
when the hold was created. Refresh the exact source-file mapping and all reading state before releasing a hold;
unknown timestamps or recent activity retain it. The retained July 27 Ransom evidence already exceeds 30 days,
so its owed check calls for immediate fresh evaluation, not a new 30-day delay. Release and scan verification
remain separate from the completed bulk edit. See [issue #840](https://github.com/thaynes43/haynesnetwork/issues/840).

**Amendment 2026-10-08, coordinator rulings for #830 and #831:** unrelated books with the same title receive an
explicit series tag `<title> (<author>)` and index 1, derived only from verified title and author metadata.
This disambiguation also applies to untagged collision peers. Other title, author, identifier and content metadata
is preserved. Same-work duplicate consolidation keeps the EPUB LazyLibrarian's BookFile names. An extra copy
moves to the retained backup area outside EBooks only after complete, fresh dependency evidence proves that
LazyLibrarian pointers, census repairs and `.ll_ignore` protections, Kavita reading state and app wants do not
rely on it. Unknown or protected copies stay in place and are listed for review. These moves never delete files.
