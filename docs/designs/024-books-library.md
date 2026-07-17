# DESIGN-024: Books & Audiobooks Library — the `books_items` ledger, `books-sync`, section-gated walls + cover proxy

- **Status:** Draft
- **Last updated:** 2026-07-17 (D-01/D-03 amended — detail-page enrichment: five nullable columns + the
  Kavita `/api/Series/metadata` change-gate; migration 0060, R-221)
- **Satisfies:** PRD-001 **R-151..R-156**, **R-221** (detail-page enrichment data layer); governed by **ADR-046** (books ledger source + the
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
next run). Steady state issues ZERO per-series calls for the ~1,400 unchanged Kavita series - only the initial
backfill and genuine changes pay. Kavita size/ISBN/file-count would need the heavier `/api/Series/series-detail`
per series (the M2 ISBN caveat: ISBNs are usually absent) - deliberately SKIPPED, so those Details rows show
for audiobooks only (the honest gap). Unit-proven: `packages/sync/__tests__/books-enrichment.test.ts`
(HTML-strip, the metadata reduce, ABS inline mapping, the change-gate skip/refetch/carry-forward-on-failure).

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
