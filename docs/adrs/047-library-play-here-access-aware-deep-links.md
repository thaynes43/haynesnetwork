# ADR-047: Access-aware "Watch/Listen/Read here" deep links — the *arr→Plex match, the library-access invariant, and the availability resolver

- **Status:** Accepted
- **Date:** 2026-07-11
- **Deciders:** Tom Haynes (owner idea + LOCKED decisions 2026-07-11 AM — PLAN-028 Q-01/Q-A/Q-B/Q-C/Q-D) · ratified by Fable 5 (PLAN-028 build run)
- **Relates:** REUSES the [ADR-024](024-role-scoped-all-libraries.md) / [ADR-017](017-plex-library-sharing.md) /
  [DESIGN-007](../designs/007-plex-library-self-service.md) effective-library-access resolver
  (`effectiveAllowedLibrariesForUser` — `role_library_grants` + `role_plex_server_all_grants` + admin-implies-all)
  as the sole access authority (does NOT reinvent it); extends the [ADR-018](018-library-metadata-and-posters.md) /
  [DESIGN-008](../designs/008-library-metadata-posters-filters.md) Library read model (`media_items` + the shared
  `buildLibraryWhere` DSL + the [ADR-019](019-poster-proxy.md) poster proxy) with a server-side access gate; builds
  the Plex deep link for [ADR-038](038-ytdlsub-library-direct-plex-read.md) ytdl-sub content (live ratingKeys) and
  reuses the [ADR-046](046-books-library-ledger-source.md) `books_items.deep_link_url` for books/AV; mirrors the
  synced-mirror single-writer + sync-mode shape of ADR-046 (`syncBooks`) / [ADR-044](044-ai-usage-metrics-ingestion.md)
  (`ai-usage-sync`). Realized by [DESIGN-025](../designs/025-library-play-here-links.md). Implements PRD **R-157**;
  glossary **T-139..T-141**.

## Context and problem statement

The Library shows a lot of read-only content but nothing ties an item back to WHERE you actually consume it.
The owner wants: from a non-"missing" Library item, go straight to the page you can watch/listen/read it on
(Plex / Audiobookshelf / Kavita) — "people shouldn't even have to think about it." This has a hard
access-control dependency: **if a role can't access a Plex library, that content — and its play link — must
never surface to them.** Two facts make this non-trivial:

1. **`media_items` has no Plex link.** A Radarr/Sonarr/Lidarr ledger row carries `arr_kind` + external ids
   (`tmdb_id`/`tvdb_id`/`imdb_id`/`musicbrainz_artist_id`) but **no `plex_library_id`, no `ratingKey`**. So the
   app cannot (a) build a Plex deep link to the exact title, nor (b) decide which Plex library the item lives in
   to gate it.
2. **The Movies/TV/Music walls were ungated.** `ledger.search`/`detail`/`filterFacets`/`wanted`, the admin
   `ledger.browse`/`count`/export, and the poster proxy were all `authedProcedure` / session-gated only — ANY
   authenticated user saw the WHOLE ledger regardless of their Plex library grants. Books gate on their section
   grant (ADR-046); ytdl-sub gated only on the coarse `ytdlsub` section, never per-library.

## THE INVARIANT (the security requirement this ADR exists to satisfy)

> A user must **NEVER** receive — in any tRPC/API payload — a Library item that lives in a Plex library their
> role cannot access.

It is enforced **server-side in the query/resolver**, never as UI filtering, and it reuses the existing
effective-library-access resolution (it does not fork or reinvent access logic).

## Decision drivers

- **Security first (Q-01 → HIDE, not teaser).** Inaccessible content is intentionally withheld — never shown,
  no teaser, no request-flow. This is a security invariant, not a UI nicety.
- **Reuse the built access model.** ADR-024's `effectiveAllowedLibrariesForUser` already answers "which Plex
  libraries can this role access." Do not build a parallel access path.
- **`media_items` stays a pure *arr mirror** (hard rule 4). The Plex linkage is a rebuildable derived side-table.
- **Exact links, degrade safely.** Deep-link to the precise title where resolvable; a present-but-not-yet-in-Plex
  item simply gets no link (never a broken one), and match failure never changes what is hidden.

## Considered options

- **A — Gate by media-type correspondence** (radarr⇒any movie library, etc.). Rejected: leaks across multiple
  same-type libraries (e.g. "Movies" vs "4K Movies") a role may hold only one of.
- **B — Store a `plex_library_id`/`ratingKey` on `media_items`.** Rejected: pollutes the pure *arr mirror with a
  nullable, rebuildable Plex-derived fact absent for titles Plex hasn't imported yet.
- **C — A dedicated `media_plex_matches` side-table, resolved by a shared-GUID match sync (chosen).** One row per
  **(matched item, Plex library)** — a title mirrored across several libraries yields several rows; the item-level
  match gives BOTH exact gating AND the exact deep link, and a per-(arr_kind, arr_instance) **candidate library
  set** derived from the matches gates the unmatched items.

## Decision outcome

Chosen option: **C** — a `media_plex_matches` derived cache + a server-side availability resolver.

- **The match (Q-B).** A new `plex-match` sync mode reads the ledger's live `media_items` (their ids, already
  synced) + the Plex libraries READ-ONLY, and resolves each item to ALL its exact Plex `{library, ratingKey}`
  tuples by **shared GUID** (`tmdb`/`imdb` for Radarr, `tvdb`/`imdb` for Sonarr, `musicbrainz` for Lidarr — the ids
  BOTH the *arr AND Plex carry). Stored in `media_plex_matches` (one row per `(media_item, plex_library)`,
  UNIQUE on that pair), a rebuildable READ-MODEL written ONLY by the `syncPlexMatches` single-writer (guard-listed;
  no per-row audit — the *arrs + Plex are the sources of truth). No *arr call (ids are in the DB); no write to Plex.
- **The gate (THE INVARIANT).** `resolveLibraryAccessGate(userId)` composes the ADR-024 allowed-library set with
  the per-`(arr_kind, arr_instance)` **candidate library set** (the set of libraries that kind's matched items
  appear in). An item is accessible iff: **matched** → the role can access AT LEAST ONE of its libraries;
  **unmatched** → the role can access at least one of its kind's candidate libraries; **admin** → always
  (unrestricted). The gate becomes an EXISTS-subquery WHERE predicate (`libraryAccessWhere` — NOT a join, so a
  multi-library item is never row-multiplied) applied to EVERY `media_items` read path (search, detail, events,
  children, wanted, filterFacets, admin browse/count, export) and the poster proxy — server-side, never UI.
- **Web targets (Q-C).** Plex = `https://app.plex.tv/desktop/#!/server/<machineIdentifier>/details?key=%2Flibrary%2Fmetadata%2F<ratingKey>`
  (machineIdentifier joined off `plex_servers`); books/AV = the existing `books_items.deep_link_url`
  (Audiobookshelf/Kavita). Hands off to native apps where installed.
- **The button (Q-D / decision 5 + owner UX ruling 2026-07-11).** The poster ALWAYS lands on the item's DETAIL
  page (never a jump-out on the wall). The detail renders the app-specific PRIMARY action(s) with an external-jump
  ↗ affordance: for Movies/TV/Music, **ONE "Watch on Plex — <library>" button per Plex library the caller's role
  can access** (a title in several libraries gets several, each gated independently); for ytdl-sub, "Watch on Plex";
  for books, a NEW lean detail page (cover, title/year, author/narrator/series, page-count/duration, genres,
  last-synced) with "Read in Kavita ↗" / "Listen on Audiobookshelf ↗" (no Fix/Force-Search — books have no *arr
  semantics, ADR-046). Only for a PRESENT item (a missing/unfiled *arr item gets no play link). ADR-015 reflow-free;
  no new hex (tokens only).
- **Gate ALL Plex-backed tabs (Q-A).** Movies/TV/Music (mapped item→Plex library) + Peloton/YouTube (the k8plex
  per-library grant, resolved off the SAME effective-library resolver by name regex). Books/audiobooks/comics stay
  gated by their section grant (ADR-046) — this ADR adds only their deep-link button, no new gating. A fully
  withheld library's tab hides entirely (server-resolved, like `ytdlsubVisible`/`booksVisible`).

### Access tightening (a deliberate, owner-approved behavior change)

Before this ADR, every authenticated user saw all Movies/TV/Music. After it, a **non-admin** user sees only the
content of Plex libraries their role grants (admins are unrestricted). This is the intended security posture (Q-A),
not a regression — but it is a real change in what non-admin members see, gated entirely by the existing
role→library grant matrix (`/admin/roles`). Cold-start: a kind with ZERO matches has no derived home and is
deny-by-default (the safe direction) until the `plex-match` sync populates ≥1 match; the deploy runs the sync
before members rely on it.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: THE INVARIANT is enforced in ONE place per surface (the shared WHERE predicate + per-item check) and reuses the audited ADR-024 access model — no parallel access logic to drift. |
| C-02 | Good: the item-level match yields exact deep links AND exact gating; the derived home library gates unmatched items so hiding is by ACCESS, never by match state. |
| C-03 | Good: `media_plex_matches` is a rebuildable cache — a bad run is fixed by re-running `plex-match`; `media_items` stays a pure *arr mirror. |
| C-04 | Neutral: non-admin Library visibility now depends on role→library grants (a deliberate tightening; admins unrestricted). Owner-approved. |
| C-05 | Bad/accepted: match yield depends on GUID overlap between the *arrs and Plex; a low-yield kind still ships gating + the links that DID resolve (unmatched items are gated by home, just without a deep link). The sync reports the per-kind match rate. |
| C-06 | Bad/accepted: gating requires the Plex libraries to exist in the `plex_libraries` registry (a registry refresh) and ≥1 match per kind for the home library; before that a kind is deny-by-default. Mitigated by running a registry refresh + `plex-match` at deploy and by admins being unrestricted. |
| C-07 | Good: the cover/poster proxy applies the same per-item gate, closing the parallel art-by-id leak vector. |

## More information

- Realized by **DESIGN-025**; migration **0038** (`media_plex_matches` + `sync_runs.run_kind` += `plex-match`).
- Enforcement points (all server-side): `packages/domain/src/library-access.ts` (the gate + deep-link builder),
  `packages/api/src/library-access.ts` (the WHERE predicate + per-item + poster-proxy + tab-visibility helpers),
  the `ledger`/`ledger-admin`/`ytdlsub` routers, the ledger-export + poster Next routes.
- The `plex-match` sync mode: `packages/sync/src/plex-match.ts` (GUID resolve) → `packages/domain/src/plex-match.ts`
  (`syncPlexMatches` single-writer). Run by a `haynes-ops` CronJob.
- Proof: `packages/api/__tests__/library-access.test.ts` (end-to-end zero-leak across search/detail/wanted/poster +
  ytdl-sub per-library), `packages/sync/__tests__/plex-match.test.ts` (GUID match rate + reconcile), plus a live
  hnet-e2e withheld-library test.
