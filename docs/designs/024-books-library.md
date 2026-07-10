# DESIGN-024: Books & Audiobooks Library — the `books_items` ledger, `books-sync`, section-gated walls + cover proxy

- **Status:** Draft
- **Last updated:** 2026-07-10
- **Satisfies:** PRD-001 **R-151..R-156**; governed by **ADR-046** (books ledger source + the
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
`If-None-Match` with a 304, else streams the upstream via `@hnet/api fetchBooksCover` (Kavita apiKey /
ABS bearer applied **server-side** — never the browser). Strong `(source, id, coverVersion)` ETag +
`Cache-Control: private, max-age=86400, stale-while-revalidate=604800`; any miss → 404 →
`MediaPoster` KindIcon fallback tile (`book`/`audiobook`/`comic` glyphs, currentColor). No transcode (covers
are already thumbnail-sized), no storage.

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
  `books.search.useInfiniteQuery` with a "Load more" button. Tiles are **external deep-links** to Kavita/ABS
  (`target="_blank" rel="noopener noreferrer"`). Reflow-free (ADR-015): fixed 2:3 poster boxes, dim-in-place
  on refetch, fixed-height sort row, skeleton tiles on first load, a one-line ellipsized author subtitle
  (`.media-card__subtitle`). No new hex.

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
