# DESIGN-025: Library "Watch/Listen/Read here" — the *arr→Plex match, the access gate, and the availability resolver

- **Status:** Accepted
- **Last updated:** 2026-07-11
- **Satisfies:** PRD-001 R-157; glossary T-139..T-141; governed by [ADR-047](../adrs/047-library-play-here-access-aware-deep-links.md)
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

## Alternatives considered

Media-type-correspondence gating (leaks across same-type libraries) and storing the Plex link on `media_items`
(pollutes the pure *arr mirror) — both rejected in ADR-047. Deriving the home library at request time vs a second
table: chosen the request-time grouped derive (one small aggregate) over a second guarded table.

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
