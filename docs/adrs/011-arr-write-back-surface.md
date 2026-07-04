# ADR-011: *arr write-back surface — add Force Search and media-hierarchy action scopes

- **Status:** Accepted
- **Date:** 2026-07-04
- **Deciders:** Tom Haynes (with agent input)

## Context and problem statement

ADR-008 fixed the write-back surface at **exactly two** audited operations — Fix (ADR-007)
and Restore — and asserted that *no other code path may call a mutating *arr endpoint*.
ADR-007 in turn described Fix as targeting a single item (a movie / an episode / an album)
via mark-failed + search or the delete + search fallback.

Two capabilities shipped since (Phase 2, `feat/hierarchy-actions`) that those ADRs no
longer fully describe:

1. **Missing content has no grab to fix.** Content that is monitored but has nothing on
   disk is *missing, not broken* — there is no bad file to blocklist or delete. Users still
   need to nudge the owning *arr to go looking for it. Fix's mark-failed/delete semantics
   are wrong for this case; a search-only action is required.
2. **The media hierarchy is not flat.** A user wants to act on a whole show or season, not
   just one episode; on a whole artist, not just one album. Fix and Force Search grew a
   **scope** (`item | show | season | episode | artist | album`), and Force Search rolls up
   to the coarsest *arr search commands (`SeriesSearch`, `SeasonSearch`, `ArtistSearch`).

This ADR records that expanded surface as decided, and states precisely how it preserves
ADR-008's invariants. It **amends** ADR-007 and ADR-008; it does not supersede them — their
decision text (mark-failed semantics, one-way sync, audit-before-action, the import guard)
stands.

## Decision drivers

1. Missing content needs a first-party remediation that is *not* destructive — no
   blocklist, no delete, no reason taxonomy (that taxonomy is about *why a file is bad*,
   which does not apply when there is no file).
2. Any new *arr write must inherit ADR-008's guarantees verbatim: audited before the call,
   attributed, rate-guarded, and reachable only through `packages/domain`.
3. Roll-up scopes must not widen the *destructive* surface. Blocklisting an entire series
   or discography is too broad a hammer for a self-service action.
4. Existing single-target callers must keep working — scope is additive, with a legacy
   default derived per kind.

## Considered options

- **Option A** — Add Force Search as a **third** sanctioned write-back (search command
  only, its own audited `search_requested` ledger event, sharing Fix's hourly budget), and
  give both Fix and Force Search a media-hierarchy `scope` with per-kind allow-lists —
  whole-show/whole-artist reserved to Force Search.
- **Option B** — Overload Fix to also cover missing content (a "search-only" Fix path). Muddies
  the reason taxonomy and the fix_requests record (a Fix with no bad file, no path taken).
- **Option C** — Trigger searches client-side / out of band. Violates ADR-008 (unaudited,
  unattributed *arr write) and hard rule 4.
- **Option D** — Allow whole-show/whole-artist Fix too (blocklist every backing grab across
  a series). Rejected — far too destructive for a self-service action.

## Decision outcome

Chosen option: **Option A** — it keeps missing-content remediation distinct from Fix
(right record, right audit event, no misapplied reason taxonomy) and confines the
destructive surface while letting search roll up freely.

- **Force Search — a third audited write-back (search only).**
  `packages/domain/src/search-flow.ts` `runForceSearch` triggers ONLY the owning *arr's
  search `POST /command` — never `history/failed`, never a file delete, no reason. Before
  the *arr call it commits one audited `search_requested` ledger event
  (`packages/domain/src/search-requests.ts` `recordSearchRequest`; source `app`, attributed
  to the requester, carrying `scope` + `seasonNumber` + `targetLabel`). It draws down the
  **same** per-requester hourly budget as Fix — `FIX_RATE_LIMIT_PER_HOUR = 5`
  (`packages/domain/src/fix-requests.ts`) under the same `pg_advisory_xact_lock` key — so
  the two actions cannot be alternated to dodge the limit. Admins bypass the budget.
- **Media-hierarchy action scopes.** `packages/domain/src/action-scope.ts` defines the
  scope union and validates each `(kind, scope, child, season)` tuple against per-kind
  allow-lists, shared by the Fix writer, the Force Search writer, and both orchestrators so
  the audit row and the *arr command can never disagree:

  | Kind | Force Search scopes (`resolveSearchTarget`) | Fix scopes (`resolveFixTarget`) |
  |------|---------------------------------------------|---------------------------------|
  | radarr | `item` (`MoviesSearch`) | `item` |
  | sonarr | `show` (`SeriesSearch`), `season` (`SeasonSearch {seriesId, seasonNumber}`), `episode` (`EpisodeSearch`) | `season`, `episode` |
  | lidarr | `artist` (`ArtistSearch`), `album` (`AlbumSearch`) | `album` |

  A missing/omitted scope derives the legacy per-kind default (radarr → `item`; sonarr →
  `episode` when a child id was given else the whole-show search for Force Search / `episode`
  for Fix; lidarr → `album`), so pre-scope callers are unchanged.
- **Whole-show / whole-artist FIX is deliberately Force-Search-ONLY.** `resolveFixTarget`
  omits `show` and `artist` from its allow-lists; requesting them throws
  `FixTargetRequiredError`. Blocklisting an entire series or discography is too broad. The
  new write methods `SonarrWriteClient.searchSeries` / `searchSeason` and
  `LidarrWriteClient.searchArtist` (`packages/arr/src/write.ts`) exist for the roll-up
  search path only.
- **Season Fix is a roll-up orchestration, not a widened primitive.**
  `fix-flow.ts` `runSeasonFix` blocklists every DISTINCT backing grab of the on-disk
  episodes (a season pack shares one grab id — deduped via a `Set`), then fires ONE
  `SeasonSearch`; with no grab records it falls back to deleting the season's episode files
  (AC-08). One `fix_requests` row (scope `season`) is the audit.

### Invariants carried forward from ADR-007 / ADR-008 (unchanged)

- **Audit before action.** Both new/expanded flows commit their ledger/audit row in a
  single transaction BEFORE any mutating *arr call, attributed to the requester (Fix keeps
  its `fix_requested` → `actioned` → `search_triggered` record; Force Search commits
  `search_requested`). Idempotent no-ops still write no row.
- **`@hnet/arr/write` stays confined to `packages/domain`.** The new write methods live
  behind the same entrypoint; the import guard
  (`packages/domain/__tests__/arr-write-import-guard.test.ts`) still fails the build on any
  `@hnet/arr/write` reference outside `packages/domain` / `packages/arr`.
- **The *arrs remain the source of truth.** Force Search adds no state to the ledger beyond
  the audit event; sync stays one-way; nothing here reconciles or writes back media lists.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: missing content gets a correct, non-destructive remediation — a search-only write-back with its own `search_requested` audit event — without abusing Fix's mark-failed/delete/reason machinery. |
| C-02 | Good: the destructive surface stays narrow — whole-show/whole-artist can only Force-Search, never Fix, so no self-service action can blocklist an entire series or discography. |
| C-03 | Good: Fix and Force Search share one hourly budget under one advisory-lock key, so a user cannot alternate the two to exceed `FIX_RATE_LIMIT_PER_HOUR`. |
| C-04 | Good: one `action-scope.ts` validates the `(kind, scope, child, season)` tuple for both the writer and the orchestrator, so the audit row and the fired *arr command cannot disagree. |
| C-05 | Neutral: "exactly two write-backs" (ADR-008) is now three — Fix, Restore, Force Search. All three obey the same audit-before-action + domain-confinement invariants; the import guard and the single-writer pattern are unchanged. |
| C-06 | Neutral: `search_requested` is a new `ledger_events` event type (DB CHECK relaxed by migration `0004`, `LEDGER_EVENT_TYPES` extended in `packages/db/src/schema/enums.ts`); it is search intent, not a synced *arr fact. |
| C-07 | Bad: `SeriesSearch` / `SeasonSearch` / `ArtistSearch` command names/fields are not enumerable read-only via REST — they are verified against each *arr's `develop` command-class source. A future *arr rename would silently 4xx until re-verified (mitigated by the fix/force-search records capturing the *arr response). |

## More information

- Amends **ADR-007** (Fix semantics — Fix now carries a `scope`; season Fix is a roll-up
  orchestration) and **ADR-008** (write-back surface — Force Search is the third sanctioned,
  audited write-back). Neither is superseded; their decisions stand.
- ADR-010 — the CI guard style that keeps the write surface domain-confined.
- DESIGN-005 (`docs/designs/005-arr-ledger-and-fix.md`) D-15 (Fix flow + season roll-up),
  D-17 (Force Search, tRPC surface, `search_requested` migration `0004`), and the
  media-hierarchy actions amendment (`feat/hierarchy-actions`).
- Code: `packages/domain/src/{search-flow,search-requests,action-scope,fix-flow,fix-requests}.ts`;
  `packages/arr/src/write.ts`; `packages/domain/__tests__/arr-write-import-guard.test.ts`.
- PRD-001 R-43..R-47 (Fix); the missing-content search action is the Phase-2 extension of US-06.
