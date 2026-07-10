# ADR-046: Books & Audiobooks as a ledger source — dedicated `books_items` mirror, section-gated Library walls, authed cover proxy

- **Status:** Accepted
- **Date:** 2026-07-10
- **Deciders:** Tom Haynes (owner ruling 2026-07-10: "Full ledger integration in v1", PLAN-023 Q-04) · ratified by Fable 5 (PLAN-023 Phase 4 build run)
- **Relates:** extends CLAUDE.md **hard rule 4** (the \*arrs are the source of truth for media lists) to
  name Kavita/ABS as the source of truth for BOOK media; contrasts with [ADR-038](038-ytdlsub-library-direct-plex-read.md)
  (ytdl-sub content has NO server-of-record ledger and is read live — books DO get a ledger, per the owner);
  reuses the [ADR-021](021-section-level-role-permissions.md) / [DESIGN-009](../designs/009-ledger-section.md)
  Section-Permission mechanism (the `books` section, `disabled` default) and the [ADR-037](037-metrics-section-access-and-prometheus-read-path.md)
  ship-Admin-only rollout; the cover proxy extends [ADR-019](019-poster-proxy.md) (authed poster proxy, never
  hot-linked). Mirrors the mode shape of [ADR-044](044-ai-usage-metrics-ingestion.md) (`ai-usage-sync` — a
  read-only external API polled into an app-owned mirror). Realized by [DESIGN-024](../designs/024-books-library.md).
  Implements PRD **R-151..R-156**; glossary **T-136..T-138**.

## Context and problem statement

PLAN-023 revived the ebook/audiobook/comic pipeline: **Kavita** serves the *Books* (EBooks, library id 1,
1283 series) and *Comics* (id 2) libraries and **Audiobookshelf** serves *Audio Books* (id 4f5bc272…, ~800
items). Phases 1–3 stood the servers up in-cluster with OIDC. Phase 4 surfaces this content **in the
haynesnetwork app**: browsable poster walls under Library + catalog cards for the two servers.

The owner ruled (2026-07-10, Q-04): **full ledger integration in v1** — the app should ingest the book
catalog and surface it as first-class Library content, not merely link out. Two questions must be settled
before code:

1. **Where do book rows live?** The natural instinct is to reuse `media_items` (the \*arr ledger the
   Movies/TV/Music walls read). But `media_items` is hard-wired to the three \*arr kinds: an `arr_kind`
   CHECK (`sonarr|radarr|lidarr`), a per-kind external-id CHECK, and **NOT-NULL** `monitored` /
   `quality_profile_id` / `quality_profile_name` / `root_folder` columns — none of which a Kavita series or
   an ABS item has. Worse, the Fix / Restore / bulk-Add machinery, the `/ledger` admin section, and the
   metadata-harvest sibling table all assume an \*arr of record. Books have **no monitored/file semantics,
   no quality profile, no Fix path** (you cannot Radarr-search a book).
2. **How is the content read?** Books are served by Kavita/ABS behind auth; the app must sync a catalog and
   proxy cover art without leaking credentials to the browser.

hard rule 4 scopes "the \*arrs are the source of truth" to \*arr-managed media. Kavita/ABS are the analogous
**source of truth for book media** — so the app's copy must be a one-way synced mirror with **no write-back**
(no Fix, no Restore; those are \*arr-only), exactly the hard-rule-4 posture, extended to a new server class.

## Decision drivers

- **Owner ruling is normative** — books go IN a ledger (a synced, browsable app-owned copy), not a mere
  deep-link. But "in the ledger" must not corrupt the \*arr-shaped `media_items` invariants.
- **Honest schema** — model books with the columns books actually have (author, narrator, series, pages,
  duration), not \*arr-isms bent to fit. Adapt columns honestly; don't fabricate `monitored`/`root_folder`.
- **Precedent** — every recent non-\*arr ingestion (ai-usage, smart-alerts, poster-guard, authentik-users)
  writes a **dedicated mirror table** through a `@hnet/domain` single-writer; ADR-038 explicitly rejected
  putting non-\*arr content into `media_items`. Follow the grain of the codebase.
- **Read-only, no new attack surface** — `@hnet/books` is a READ client with no write subpath; covers are
  proxied server-side (never a token in the browser, never an open image proxy).
- **Ship-safe rollout** — deliver the new walls **Admin-only at deploy**; the owner opens the section per
  role after a 390px + desktop screenshot review (the ADR-037 rollout, reused).

## Considered options

### Where book rows live

1. **A dedicated `books_items` mirror table** (chosen). A leaner, honest shape keyed by
   `(source, external_id)` (`source` ∈ `kavita|audiobookshelf`; `media_kind` ∈ `book|comic|audiobook`),
   carrying title/sortTitle/author/narrator/series/year/genres/coverRef/deepLinkUrl + per-medium metrics
   (pages/wordCount for Kavita, durationSeconds/sizeBytes for ABS) + sync bookkeeping (first/last-seen,
   tombstone). Written ONLY by the `@hnet/domain syncBooks` single-writer. This is the ai-usage-chats /
   authentik-users class of rebuildable read-model.
2. **Overload `media_items` with `book`/`audiobook`/`comic` kinds.** Rejected: it forces a migration
   relaxing three CHECKs + four NOT-NULL columns, drags books into the `/ledger` admin's Fix/bulk-add/export
   surfaces (nonsensical for books), makes the metadata-harvest sibling and the Restore diff operate on rows
   with no \*arr, and couples the D-09 \*arr filter DSL to books. The invariant damage is far larger than a
   clean second table — the exact reason ADR-038 kept ytdl-sub content out of `media_items`.
3. **Read Kavita/ABS live per request (no ledger), like ADR-038's ytdl-sub.** Rejected by the **owner's
   explicit Q-04 ruling** (full ledger integration). Unlike ytdl-sub content (which has a Plex index the app
   can read on demand), the owner wants books browsable through the app's own filter/sort with a durable
   catalog; a per-request fan-out to two paginated APIs (1283 series) per wall paint is also far slower than
   a synced table. (The divergence from ADR-038 is deliberate and owner-directed — see below.)

### How the content is read + synced

4. **A read-only `@hnet/books` package + a `books-sync` mode into `books_items`** (chosen). `@hnet/books`
   (Kavita + ABS clients, lazy login + token cache + 401 re-auth, zod-validated) has **no write subpath** —
   read-only by construction (hard rule 4 extension). The `books-sync` mode pages both servers, normalizes
   each series/item, and hands the snapshot to `syncBooks`, which UPSERTS + tombstones in one transaction.
   Mirrors `ai-usage-sync`: standalone mode, no `sync_runs` row (the mirror is its trail), bounded, degrade-safe.
5. **A live cross-DB read of Kavita's/ABS's databases.** Rejected — the ai-usage precedent (ADR-044 C-01):
   never a live cross-DB read; the app talks to the documented REST API, read-only.

### Visibility + covers

6. **A new `books` Section-Permission, `disabled` default** (chosen). Library itself is universal/ungated;
   the new Books/Audiobooks/Comics **sub-tabs** get one section key gating all three (as `ytdlsub` gates
   Peloton+YouTube). `disabled` no-row default ⇒ Admin-only at ship; the owner opens a role to `read_only`
   after screenshot review — the ADR-037/038 mechanism verbatim.
7. **An authed cover proxy** `/api/books/cover` (chosen) — session- AND `books`-section-gated, streaming the
   Kavita series-cover (apiKey server-side) / ABS item-cover (bearer server-side) with a strong
   `(source, id, coverVersion)` ETag; a closed `source` enum + a format-validated `id` keep it from being an
   open image proxy. Extends ADR-019 (no hot-linking, no storage). A no-transcode stream suffices — Kavita/ABS
   covers are already thumbnail-sized (unlike the megabyte Plex originals ADR-041 had to transcode).

## Decision outcome

Chosen options **1 + 4 + 6 + 7**: a dedicated **`books_items`** mirror (NOT `media_items`), populated by a
read-only **`books-sync`** mode over the new read-only **`@hnet/books`** clients through the `@hnet/domain
syncBooks` single-writer; the Library Books/Audiobooks/Comics walls gate on a new **`books`
Section-Permission** (`disabled` default = Admin-only at ship); cover art streams through a session- +
section-gated **`/api/books/cover`** proxy. **Kavita/ABS are the source of truth for book media (hard rule 4
extended); the sync is one-way IN with NO write-back** — there is no Fix/Restore/add for books.

> **Divergence from ADR-038 (read-live, no ledger):** ADR-038 kept ytdl-sub content out of the ledger
> because Plex is its only index and the owner ruled "don't fabricate a ledger for content the ledger can't
> own." Books are the mirror image: the owner **explicitly ruled** (Q-04) that books DO belong in a ledger,
> and Kavita/ABS ARE dedicated servers-of-record with stable per-item identity — so a synced mirror is honest
> and owner-directed. The two ADRs agree on the principle (a source-of-record owns the media; the app mirrors
> read-only) and differ only on whether that mirror is a table or a live read, per each content type's owner.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | **A new `books_items` table** (migration 0037, guard-listed) is the app-owned, one-way synced mirror of Kavita + ABS. `(source, external_id)` UNIQUE identity; `source`/`media_kind` text+CHECK; live rows carry `deleted_at IS NULL` (tombstoned on vanish, never hard-deleted). `media_items`/`media_metadata`/`ledger_events` and the \*arr Fix/Restore/`/ledger` surfaces are **untouched** — books never enter them. |
| C-02 | **`@hnet/books` is READ-ONLY** — `KavitaClient` + `AudiobookshelfClient` behind `./read`, with **no `./write` export and no write client** (the strongest form of the arr/plex-write import-confinement: there is nothing to confine). Both manage a session token (Kavita JWT + apiKey, ABS bearer) with lazy login + one 401 re-auth; credentials travel only in the Authorization header / login body, never in a URL or error. |
| C-03 | **`books-sync` mode** (`@hnet/sync`) pages Kavita (`/api/Series/all-v2` per Books/Comics library) + ABS (`/api/libraries/{id}/items`), normalizes each row, and calls `syncBooks` (`@hnet/domain`) which UPSERTS on `(source, external_id)` and TOMBSTONES rows of a **fully-synced** source not seen this run — all in one tx. Tombstoning is **scoped to `syncedSources`** so a partial run (Kavita OK, ABS down) never wrongly tombstones the unread source. Standalone mode: no `--source`, **no `sync_runs` row** (the mirror is its trail; `SYNC_RUN_KINDS += books-sync` for CLI `--mode` parity), bounded, degrade-safe. A run where NEITHER source could be fully read is a `totalFailure` (nonzero exit → visible in the CronJob history). |
| C-04 | **Visibility reuses `role_section_permissions`.** `'books'` joins `SECTION_IDS` with a **`disabled`** no-row default (`SECTION_DEFAULT_LEVELS.books`), so at deploy only Admin sees the three sub-tabs; the owner opens the Default (or any) role to `read_only` in the existing role editor after his review — one audited, reversible action (the ADR-037 C-02 mechanism; migration 0037 rebuilds ONLY the section CHECK to admit `'books'`). `booksProcedure = sectionProcedure('books','read_only')` gates `books.search`/`books.filterFacets` server-side; the `/library` page resolves `effectiveSectionLevel(role,'books')` and renders the walls only when not `disabled`. The cover route applies the SAME gate (AC-13 — never client-hidden only). |
| C-05 | **Covers via a new authed proxy** `apps/web/app/api/books/cover/route.ts` (Node runtime, session- + `books`-section-gated). It streams the Kavita series-cover (`apiKey` server-side query param) / ABS item-cover (`Authorization: Bearer` server-side header) with a strong `(source, id, coverVersion)` ETag; `source` is a closed enum and `id` is format-validated per source, so it is **not an open image proxy**. `Cache-Control: private, max-age=86400, stale-while-revalidate=604800`; any miss → 404 → the `MediaPoster` KindIcon fallback tile (`book`/`audiobook`/`comic` glyphs added, currentColor only). No image storage (ADR-019 posture). |
| C-06 | **UI reuses the Library idioms wholesale** — the `.library-tabs` grammar, `.poster-grid`/`.poster-card`, `MediaPoster` (with the new fallback glyphs), and the `.library-toolbar`/`.library-sortbar` chrome. Tab order is **Movies \| TV \| Music \| Peloton \| YouTube \| Books \| Audiobooks \| Comics \| My Fixes** (My Fixes LAST — the standing owner rule; the Books tabs sit after YouTube). Rows **deep-link OUT** to the item in Kavita/ABS (public URLs, new tab) — books have no in-app detail page. A leaner books-specific `books.search` contract (offset paging + title/author query + per-medium sort) reuses the `@hnet/ui` filter/sort ENGINE without overloading the \*arr-shaped D-09 wire contract; no new hex (hard rule 2), reflow-free (ADR-015). |
| C-07 | **Two catalog cards** (Kavita, Audiobookshelf) are seeded as `app_catalog` rows (migration 0037, arbitrary http(s) URLs per ADR-013) with the new code-shipped `kavita`/`audiobookshelf` icon keys. **No role grants are seeded** — Admin sees them implicitly; the owner opens them to Default/Family via `/admin/roles` after review (the ship-Admin-only discipline; adding a new app needs NO schema change — ADR-012). |
| C-08 | (Cost/risk) **The walls depend on a fresh `books_items` and on the sync creds** (`KAVITA_PASSWORD`/`AUDIOBOOKSHELF_PASSWORD` in the app secret, templated from the `kavita`/`audiobookshelf` 1Password items). A stale/failed sync shows the previous snapshot; an absent cred makes the cover proxy/sync 404/no-op cleanly (never a crash). The cover proxy authenticates from the WEB pod, so both the pod and the CronJob carry the two book-server passwords. |

## More information

- **Ship gate / rollout.** Deploy with `books` `disabled` for all non-admin roles (Admin-only). After the
  owner's morning 390px + desktop screenshot review he sets the chosen role(s)' `books` section to
  `read_only` and grants the Kavita/ABS catalog cards to Default/Family (both audited, reversible). Owner
  must-decide: which roles see the Books walls + the two catalog cards; the card copy.
- **Ops.** `books-sync` runs as a haynes-ops CronJob mirroring `sync-ai-usage` (image bump + one CronJob
  block + `KAVITA_PASSWORD`/`AUDIOBOOKSHELF_PASSWORD` templated into the app ExternalSecret from 1Password).
  In-cluster URLs default in code to `kavita.media.svc.cluster.local:5000` /
  `audiobookshelf.media.svc.cluster.local:13378`. The mode is read-only against both servers.
- **Out of scope (v1):** any write-back to Kavita/ABS (no Fix/Restore for books — by design); an in-app book
  *request* flow; genre filter chips on the walls (the `books.filterFacets` endpoint ships + is unit-proven;
  the chip UI is a follow-up); a keyset (vs offset) pager (books are bounded — offset is honest here).
