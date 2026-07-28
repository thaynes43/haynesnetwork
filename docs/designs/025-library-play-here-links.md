# DESIGN-025: Library "Watch/Listen/Read here" — the *arr→Plex match, the access gate, and the availability resolver

- **Status:** Accepted
- **Last updated:** 2026-07-28 (D-09 added — the ADR-081 library-access bootstrap seed + registration
  auto-grant, the boot-triggered first plex-match sync, and the honest cold-start empty-reason on the gate;
  R-237, glossary T-232..T-234)
- **Satisfies:** PRD-001 R-157, **R-221** (D-08 — books detail-page parity), **R-237** (D-09 — bootstrap +
  cold-start contract); glossary T-139..T-141, **T-232..T-234**; governed by [ADR-047](../adrs/047-library-play-here-access-aware-deep-links.md)
  and **[ADR-081](../adrs/081-library-access-bootstrap-and-cold-start.md)** (the bootstrap/cold-start contract layered on top)
  (reusing [ADR-024](../adrs/024-role-scoped-all-libraries.md)/[ADR-017](../adrs/017-plex-library-sharing.md) access,
  [ADR-018](../adrs/018-library-metadata-and-posters.md)/[DESIGN-008](008-library-metadata-posters-filters.md) Library
  read model, [ADR-038](../adrs/038-ytdlsub-library-direct-plex-read.md) ytdl-sub reads, [ADR-046](../adrs/046-books-library-ledger-source.md)
  books deep links).

## Overview

Surface a per-item deep link from every non-"missing" Library item to the app that serves it, and gate ALL
Plex-backed content to the caller's accessible Plex libraries — **server-side**, satisfying THE INVARIANT
(ADR-047). Three pieces: (1) a `plex-match` sync that resolves each *arr `media_item` → `{plex_library,
ratingKey}` by shared GUID; (2) an access gate + availability resolver that reuses `effectiveAllowedLibrariesForUser`;
(3) the UI play button + tab hiding.

## Detailed design

### D-01 — `media_plex_matches` (migration 0038)

One row per **`(media_item, plex_library)`** (UNIQUE on the pair — a title mirrored across libraries gets several
rows) → `plex_library_id` (FK `plex_libraries`), `rating_key`, `matched_via` ∈ `{tmdb,imdb,tvdb,musicbrainz}`
(CHECK), plus `first/last_seen_at`. A rebuildable derived cache (the books_items/ai_usage_chats class): written
ONLY by `syncPlexMatches`; guard-listed for INSERT/UPDATE/DELETE (it reconciles by hard-delete); no per-row audit.
`sync_runs.run_kind` CHECK grows `plex-match` (parity — the mode writes no `sync_runs` row; its trail is the table).
`machineIdentifier` is NOT denormalized — it is joined off `plex_servers` when building a deep link (single source
of truth).

### D-02 — the `plex-match` sync (READ-ONLY)

`fetchPlexMatchSnapshot({db, plex})` (`@hnet/sync`): reads live `media_items` + available `plex_libraries` from the
DB, then for each server in the Plex bundle enumerates its `movie`/`show`/`artist` sections, **pages** each section
(`listSectionContentsPage`, ≤1000/page), parses each title's `Guid` array (`parsePlexGuids` — handles `scheme://id`
+ legacy `com.plexapp.agents.*://` prefixes), and builds a GUID index → `{plex_library_id, ratingKey}`. Each ledger
item matches on its kind's preference order (radarr `tmdb`→`imdb`; sonarr `tvdb`→`imdb`; lidarr `musicbrainz`). A
section absent from the `plex_libraries` registry is counted `unmapped` and skipped (cannot FK); a server/section
that errors is not "scoped" (never reconcile-dropped). The snapshot → `syncPlexMatches` (`@hnet/domain`): UPSERT on
`media_item_id`, then RECONCILE (delete rows of a fully-read library whose `last_seen_at` predates the run — the
title left Plex). Reports the per-kind `{total, matched}` **match rate**. Wired into the orchestrator + CLI
(`--mode=plex-match`, no `--source`) exactly like `books-sync`. Needs only `DATABASE_URL` + `PLEX_*_TOKEN`.

### D-03 — the access gate (THE INVARIANT)  ·  `packages/domain/src/library-access.ts`

`resolveLibraryAccessGate(userId)` → `{unrestricted, allowedLibraryIds, allowedKindKeys, visibleArrKinds}`.
Admin ⇒ `unrestricted` (sees all). Else: `allowedLibraryIds` = `effectiveAllowedLibrariesForUser(userId)`
(the ADR-024 resolver, verbatim); the CANDIDATE library set per `(arr_kind, arr_instance)` = every library that
kind's matched items appear in (grouped over `media_plex_matches`); `allowedKindKeys` / `visibleArrKinds` = the
kinds whose candidate set INTERSECTS the allowed set. `isMediaItemAccessible(gate, {arrKind, arrInstanceId,
matchLibraryIds})`: matched ⇒ the role can access AT LEAST ONE of `matchLibraryIds`; unmatched ⇒ its kind is
accessible; unrestricted ⇒ true. `buildPlexWebDeepLink(machineIdentifier, ratingKey)` builds the `app.plex.tv` URL.

### D-04 — server-side enforcement  ·  `packages/api/src/library-access.ts`

`libraryAccessWhere(gate)` returns the WHERE predicate (`null` for admin) as EXISTS subqueries — NOT a join, so a
multi-library item is never row-multiplied: `EXISTS(a match in an allowed library) OR (NOT EXISTS(any match) AND
(arr_kind||':'||arr_instance) ∈ allowedKindKeys)`. Empty grants ⇒ `false` ⇒ zero rows. Applied to EVERY
`media_items` read: `ledger.search`, `ledger.wanted`, `ledgerAdmin.browse`/`count`, `streamLedgerExportRows` (via a
raw-SQL variant `libraryAccessConditionRaw` for `ledger.filterFacets`). Direct-id paths
(`ledger.detail`/`events`/`children`) re-gate with `itemAccessById` (which reads `matchLibraryIdsForItem`) and
return **NOT_FOUND** for a hidden item (never reveal its existence/external ids). The **poster proxy**
(`/api/posters/[id]`) calls `isMediaItemAccessibleToUser` (same gate) → 404 for a hidden item — closing the
art-by-id leak. `resolvePlexPlayTargets(db, gate, id, present)` attaches the detail's `play` — an ARRAY of
`{app,label,libraryName,url}`, ONE per Plex library the caller can access, present-and-matched only.

### D-05 — ytdl-sub per-library gate  ·  `packages/api/src/routers/ytdlsub.ts`

`accessibleYtdlsubLibraries(userId, isAdmin)` matches the caller's ADR-024 hayneskube libraries by the same title
regex the router resolves sections with (admin ⇒ both). `list`/`detail`/`episodes`/`libraries` return empty /
NOT_FOUND for a withheld library; the drill-in carries a `playUrl` (`buildPlexWebDeepLink(hayneskube machineId,
ratingKey)`). The coarse `ytdlsub` section knob is layered on top.

### D-06 — UI (ADR-015 reflow-free, no new hex; owner UX ruling 2026-07-11)

- The poster ALWAYS opens the item's DETAIL page (never a jump-out on the wall). `/library/[id]` renders a
  `.detail-head__play` row with ONE `btn primary` anchor per accessible library ("Watch on Plex — <library> ↗",
  wrapping); the ytdl-sub drill-in renders "Watch on Plex ↗". Static per item — never re-orients on interaction.
- Books gain a NEW in-app detail page `/library/books/[id]` (server wrapper gates the `books` section + resolves
  the `?from=` back-link; client `books-detail.tsx` reads `books.detail`): cover + title/year + author/series +
  page-count/duration + genres + last-synced, with "Read in Kavita ↗" / "Listen on Audiobookshelf ↗" as the
  PRIMARY action (from `deep_link_url`) — no Fix/Force-Search. The books wall tiles now `<Link>` to it (with
  `?from=<tab>`), not the external URL.
- `/library/page.tsx` resolves per-kind + per-ytdl-sub-library visibility server-side and passes it to the client,
  which SPLICES only accessible Movies/TV/Music/Peloton/YouTube tabs (a fully-withheld library's tab is ABSENT).

### D-07 — the detail-page MISSING-state affordance (owner UX polish 2026-07-11; ADR-015, no new hex)

D-06 renders green `.btn.primary` "Watch on Plex — <library> ↗" pill(s) in `.detail-head__play` for a PRESENT,
matched, accessible item; a NOT-on-disk item previously rendered NOTHING in that slot (just the "Not on disk" /
"Wanted" badge + "Size on disk: —"), so the missing state had no affordance to balance the on-disk one. The two
states now share the ONE slot: an item with nothing on disk — `item.onDiskFileCount <= 0`, the same signal
`onDiskSummary` reads for the badge — shows a DISABLED, muted **"Not on Disk"** pill (`NotOnDiskButton`, a single
shared component so the control is identical everywhere). It mirrors the play pill's shape/size but reads INERT:
`disabled` (not clickable), neutral surface + muted text over the existing disabled/secondary tokens
(`--color-surface-2` / `--color-text-muted` / `--color-border`) — NO accent (green), NO alarm-red, no new hex.
The `*arr` pages (Movies/TV/Music) add a small caption directly UNDER the pill — "Force Search can add this title to
your library if a release is found." — tying the missing state to the page's existing Force Search action; a
fully-missing sonarr SHOW shows the pill at the head while a PARTIAL show keeps its per-season / per-episode grain in
the Episodes table below (unchanged). Tombstoned items are EXCLUDED (their "Removed from the manager" badge already
explains the state and their Force Search is disabled). Media without a Force Search (books / ytdl-sub) are
Plex-native and normally always carry a deep link, so they show nothing here; IF one ever presents a not-on-disk /
no-play item it renders the SAME disabled pill WITHOUT the caption. The pill + caption ride a flex column with
`.detail-head__play`'s top margin, and the on-disk vs missing state is fixed per item load (never a live toggle), so
the swap never re-orients neighbours (ADR-015).

### D-08 — books/audiobooks/comics detail-page PARITY (owner directive 2026-07-17; ADR-015, tokens-only; R-221)

The books drill-in (`/library/books/[id]`, `BooksDetail`) originally showed only the hero + a thin Details block.
It now mirrors the movie-detail anatomy (`/library/[id]`, `ItemDetail`) as far as the sources honestly allow — the
owner's "get these closer to matching" ask — reusing the movie page's exact classes (`.card.detail-head`,
`.about-facts`, `.meta-chips`/`.chips`/`.chip`, `.meta-grid`, `.fix-list`, `.timeline`; one new `.about-summary`
prose rule, tokens-only). The parity map (movie section → book equivalent → data source):

- **Hero** — unchanged play/pairing/Fix (ADR-065/ADR-062 kept, never regressed); adds a kind badge (Book /
  Audiobook / Comic) and a format badge (EPUB/CBZ-CBR/PDF for Kavita, Audiobook for ABS) beside the author/series
  badges, the movie hero's "kind + On-disk badges" peer.
- **About** (movie: ratings/added/genres/collections) → **summary prose** (`books_items.summary`), a **released /
  publisher / language** fact line (`year` / `publisher` / `attrs.language`), a **GENRES** chip row (`genres`), and
  a **COLLECTIONS** chip row — the mirrored `books_collections` this title is a live member of (the ADR-066
  membership the walls read), each chip a `Link` into the wall's collection drill
  (`/library?tab=<wall>&view=grouped&by=collection&group=<books_collections.id>`). The whole section renders only
  with content; each row collapses when empty (the movie-page idiom).
  - **Amendment 2026-07-17 (owner live-verify — the summary CLAMP):** Kavita/ABS `summary` values
    frequently carry the whole jacket copy (the blurb *plus* "Praise for…" review pull-quotes),
    which rendered as one untamed block that dwarfed the page and buried the fact line / genres /
    collections beneath it. The prose now clamps to six lines with an in-place **Show more / Show
    less** toggle (`AboutSummary`), shown only when the text overflows the clamp. The toggle is a
    deliberate in-place expansion — the ADR-015 exception — revealing this block only, never
    reflowing a neighbour.
- **Details** (movie: quality/root/size/files/tags/last-synced) → library, format, then kind-aware metrics —
  **duration + narrator** for audiobooks, **pages** for books/comics — plus **files** (`file_count`) and **size on
  disk** (`size_bytes`) when known, **ISBN** when present, **added** (`source_added_at`), and **last synced**. Size/
  files/ISBN are ABS-populated; Kavita keeps them null (the honest gap — series-detail skipped), so those rows show
  for audiobooks only, collapsing cleanly for Kavita.
- **History** (movie: fix-list + ledger timeline) → this app's OWN records: a **"Fixes on this item"** section over
  the audited `book_fix_requests` trail (DESIGN-033 — reason + status + who + when, the `.fix-list` idiom) and a
  **"History"** section over the linked `book_requests` lifecycle (origin + per-format status, the `.timeline`
  idiom), both newest-first. Real owner-visible value (fixes ran the day this shipped). Empty ⇒ collapsed.

The API is `books.detail` extended in place (same `booksProcedure` gate — a Disabled caller is still FORBIDDEN):
the enriched `item`, `collections[]`, `fixes[]`, `requests[]`. All static per load — no interaction re-orients a
neighbour (ADR-015). The enrichment DATA layer (the five `books_items` columns + the sync's change-gated Kavita
metadata call) is DESIGN-024 D-01/D-03 (migration 0060).

### D-09 — the library-access bootstrap seed + the cold-start contract (ADR-081; C-01..C-07)

ADR-047 gates correctly but assumes two facts are already TRUE by configuration: (1) the Default role holds
library grants, and (2) `media_plex_matches` is populated. D-09 makes both a CODE guarantee for a from-scratch
deploy and makes the transient gap between them HONEST. It layers on ADR-024 (the grant model) and ADR-047 (the
gate invariant) — both unchanged — and touches four seams. Nothing here weakens THE INVARIANT: deny-by-default
stays the failure direction; the only thing that widens Default is an explicit, audited grant.

- **The bootstrap seed (C-01/C-02/C-03) · `packages/domain/src/library-access-bootstrap.ts`.**
  `seedDefaultServerAllGrantsIfBootstrap({db, actorId})` grants the Default role an `role_plex_server_all_grants`
  row on EVERY registered Plex server — but ONLY when the DB holds ZERO users, the distinguishing fact of a fresh
  bootstrap (before the first OIDC login mints a user row). Each grant is idempotent (`ON CONFLICT DO NOTHING`) and
  co-writes the SAME `update_role_libraries` `permission_audit` row a manual server-all grant produces (hard rule
  6), tagged `reason: 'bootstrap_default_all_grant'`. On the populated live estate it is a clean no-op: it adds no
  rows (C-02 — the owner's configured grants are neither widened nor rewritten) and cannot re-assert a revoked
  grant (a revocation implies an admin, hence a user row, so the guard is already closed). Non-default roles are
  never touched (C-03). NO migration and NO backfill — the seed is a runtime bootstrap, not a schema change; the
  three servers of record stay migration-0010 seeded (immutable infra facts).

- **The registration auto-grant (C-01/C-06) · same module.** `registerPlexServer({db, server, actorId})` inserts
  a `plex_servers` row (idempotent on slug) and, on a genuinely NEW registration, auto-grants the Default role an
  all-libraries grant on it IN THE SAME TRANSACTION as the insert (C-06 — a crash can never register a server
  invisibly to Default), audited identically. The auto-grant fires ONLY at first registration (the server row was
  newly inserted); a re-registration of an existing slug never re-asserts, so an admin revocation is respected
  forever. This is the forward-looking guarantee — the live server set is migration-seeded and slug-CHECK-capped,
  so `registerPlexServer` is not on the live seed path today, but it is the writer any future registration flows
  through, and it shares the same guarded single-writer + audit discipline.

- **The boot-triggered first sync (C-04) · `packages/sync/src/first-plex-match.ts` + `apps/web/instrumentation.ts`.**
  On app start (the Next.js `instrumentation.ts` `register()` hook), when `media_plex_matches` is EMPTY the app runs
  ONE plex-match sync itself via `maybeRunFirstPlexMatch({pool, db, run})`: a cheap emptiness pre-check short-circuits
  every steady-state boot; the cold path takes a session-level `pg_try_advisory_lock` (NON-blocking — the PLAN-062
  migrator-lock precedent, a DISTINCT key so the two never contend) so at most one of the three replicas runs it and
  the losers skip rather than queue; it re-checks emptiness inside the lock (TOCTOU) and then runs
  `fetchPlexMatchSnapshot` → `syncPlexMatches`. It is fire-and-forget (never blocks serving or `/api/health`),
  fully isolated (a Plex/DB failure is caught and returned, never propagated into the boot path), and
  production-only (dev:local / e2e / tests exercise the helper directly and never fire a boot sync). The recurring
  CronJob stays the steady-state owner of match freshness.

- **The honest cold-start empty-reason (C-05) · `packages/domain/src/library-access.ts`.** The gate gains
  `matchTableEmpty` (true when `media_plex_matches` holds zero rows — computed server-side; skipped on the hot path
  where a candidate match already exists) and a pure helper `libraryEmptyReason(gate)` → `'cold_start'` (the whole
  match table is empty, so EVERY non-admin derives zero visible kinds regardless of grants) | `'no_access'` (the
  table has rows but the role's grants intersect none — a true denial, the existing empty state) | `null`. The
  `/library` page resolves the gate ONCE and passes a server-decided banner to the client: a MEMBER in the
  cold-start window sees a friendly "still syncing" state, an ADMIN (always all tabs) sees a "first sync is
  running" banner, and the no-access case is unchanged. Reflow-safe (ADR-015, static per load), tokens-only (the
  shared `.card`/`.empty-state` classes), owner copy rules (no em-dashes, no time-grounding).

- **Layering (C-07).** ADR-024 and ADR-047 remain Accepted and unedited; this design adds the bootstrap/cold-start
  contract on top. The seed/registration writers are the single writers of `role_plex_server_all_grants` alongside
  the existing `setRoleLibraries` (all in `packages/domain`, guarded); the gate change is additive (a new field +
  a pure helper), so every existing gate consumer is unaffected.

## Alternatives considered

Media-type-correspondence gating (leaks across same-type libraries) and storing the Plex link on `media_items`
(pollutes the pure *arr mirror) — both rejected in ADR-047. Deriving the home library at request time vs a second
table: chosen the request-time grouped derive (one small aggregate) over a second guarded table.

**ADR-081 alternatives (D-09):** a backfill migration seeding Default grants — rejected (C-02: it would widen the
owner's configured live estate and re-assert revoked grants); a Default-bypasses-the-gate code path — rejected
(inverts deny-by-default, makes restricting Default a special case); blocking the first sync at boot / running it
from a health probe — rejected (must never block serving or health). The zero-user guard is the chosen
fresh-vs-live signal because it is the one fact that is TRUE on a from-scratch deploy and FALSE forever after the
first login, so the seed is a true one-shot with no marker table.

## Test strategy

- **Unit / integration (embedded PG16):** `packages/api/__tests__/library-access.test.ts` — a role lacking a
  library's grant gets ZERO items across search/detail/wanted/filterFacets/poster-proxy and the ytdl-sub per-library
  gate, incl. admin-implies-all, server-all grant, no-grants, matched-vs-unmatched. `packages/sync/__tests__/plex-match.test.ts`
  — `parsePlexGuids`, the GUID match rate, and reconcile.
- **Live:** as hnet-e2e-member with a deliberately-withheld library — the walls return 0 items from it and the tab
  is hidden; 390px + desktop screenshots (a play button on an accessible item; a withheld library absent).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Hide vs teaser inaccessible content? | HIDE — a security invariant (ADR-047 Q-01). |
| Q-02 | Gate ytdl-sub per-library or keep the section-only gate? | Per-library (k8plex grant), section knob layered on top (ADR-047 Q-A / D-05). |
| Q-03 | Cold-start (a kind with no matches yet)? | Deny-by-default until `plex-match` derives ≥1 match; run the sync at deploy; admins unrestricted (C-06). |
