# ADR-016: Subtitle Fix routes to Bazarr; missing_subtitles is not offered for Music

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (autonomous run, KICKOFF mandate)

## Context and problem statement

Fix (ADR-007, R-43..R-47) remediates a broken ledger item by marking the offending grab
failed in the owning *arr (blocklisting it) + triggering a replacement search, falling back
to delete-file + search when there is no grab history. The reason taxonomy (R-45, DDD-001
T-30) includes `missing_subtitles` — but a **missing/wrong subtitle is not a bad grab**. The
media file is fine; only its subtitles are absent. Applying ADR-007 Option A to
`missing_subtitles` is the wrong tool: it would blocklist a perfectly good release and
re-grab the whole file (or delete it) to solve a subtitle gap — destructive, slow, and it
does not even fetch subtitles.

The Haynes estate already runs **Bazarr** (`bazarr.media.svc.cluster.local:6767`, ingress
`bazarr.haynesops.com`), the first-party subtitle manager for the Radarr movie and Sonarr
episode libraries. It is the correct remediation surface for `missing_subtitles`. Bazarr's
REST API covers movies (Radarr) and episodes (Sonarr) only — it has **no music support**, so
the reason cannot be offered for Lidarr.

This ADR records how `missing_subtitles` is remediated, and resolves PLAN-002's open
decisions #1..#5 with live verification against Bazarr 1.5.6 on 2026-07-06.

## Decision drivers

1. Use the right tool: a subtitle gap must fetch subtitles, not re-grab or delete the media
   file (which stays untouched).
2. Never leave a false blocklist entry: a good release must not be marked failed for a
   subtitle problem.
3. Reuse the estate's first-party subtitle manager (Bazarr) and the existing
   `@hnet/arr` HTTP/zod/error stack + the audited, domain-confined write-back invariants
   (ADR-008, D-12).
4. Fail closed: if Bazarr is unreachable the fix fails visibly (like any *arr upstream
   failure), touching no file.
5. Offer the reason only where it is meaningful: Movies/TV, never Music.

## Considered options

- **Option A** — Keep ADR-007's Option A paths (blocklist+search / delete+search) for
  `missing_subtitles`. Rejected: re-grabbing/deleting a good file is the wrong tool for a
  subtitle gap and leaves a false blocklist entry; it does not fetch subtitles at all.
- **Option B (CHOSEN)** — Route `missing_subtitles` to **Bazarr's async `search-missing`
  action**: movie → `PATCH /api/movies?radarrid=&action=search-missing`, sonarr episode/season
  → the series-level `PATCH /api/series?seriesid=&action=search-missing`. Fire-and-forget
  (verified live 2026-07-06: HTTP 204 in ~18ms, queued internally).
- **Option C** — Bazarr's **synchronous per-episode** subtitle download endpoint
  (`PATCH /api/episodes/subtitles`, requires a `language`/`forced`/`hi` triplet and holds the
  request open while it queries providers). Rejected: blocking UX inside a fire-and-forget
  flow, and Bazarr 1.5.6 offers **no async per-episode action** — only the series-level
  `search-missing` is async.
- **Option D** — Poll Bazarr to auto-complete subtitle fixes. Rejected: a new background loop
  for marginal value; completion is not observable via the ledger's `imported` events, so the
  fix simply rests at `search_triggered`.

## Decision outcome

Chosen option: **Option B** — route `missing_subtitles` to Bazarr's async subtitle search.

- **New FixPath `bazarr_subtitle`** (`packages/db` `FIX_PATHS`; migration `0009` relaxes the
  `fix_requests_path_enum` CHECK). `missing_subtitles` does **not** mark-failed/blocklist,
  does **not** delete the file, does **not** trigger an *arr `*Search` command.
- **Endpoints (verified live 2026-07-06 against Bazarr 1.5.6):** header `X-API-KEY`, base path
  `/api` (no `v3`).
  - Movie: `PATCH /api/movies?radarrid=<RadarrMovieId>&action=search-missing` → 204.
  - Sonarr (episode OR season scope): `PATCH /api/series?seriesid=<SonarrSeriesId>&action=search-missing`
    → 204. Bazarr 1.5.6 has no async per-episode action, so both episode- and season-scoped
    subtitle fixes trigger the series-level search — only *missing* subtitles are searched, a
    safe superset covering the target.
  - Pre-read (audit color, records the missing languages): movie
    `GET /api/movies?radarrid[]=`, episode `GET /api/episodes?episodeid[]=`; season scope has
    no single target, so no pre-read.
- **Id mapping (verified):** Bazarr `radarrId` ≡ Radarr movie id ≡ `media_items.arr_item_id`
  (radarr); `sonarrSeriesId` ≡ Sonarr series id ≡ `arr_item_id` (sonarr); `sonarrEpisodeId` ≡
  Sonarr episode id ≡ `fix_requests.target_arr_child_id`. Single Bazarr instance today;
  multi-instance selection is out of scope.
- **Lifecycle: fire-and-forget.** Reuse the existing two-step `recordFixAction`:
  `pending → actioned (path_taken='bazarr_subtitle') → search_triggered`. The fix rests at
  `search_triggered` and never auto-completes.
- **`completeFixRequests` excludes `bazarr_subtitle`.** Bazarr downloads subtitles, producing
  no `imported` event; an unrelated later import on the same item (a normal re-grab of another
  file) would otherwise spuriously flip the subtitle fix to `completed` — especially for a
  movie/season fix whose child is null (the completer matches *any* import). The completer's
  `open` query now filters `path_taken IS DISTINCT FROM 'bazarr_subtitle'`.
- **Per-kind offer rule (NOT an enum edit).** `FIX_REASONS` is unchanged; a new
  `fixReasonsForKind(kind)` (domain) + a framework-free mirror (`apps/web/lib/media.ts`) omit
  `missing_subtitles` for Lidarr. A defensive `SubtitleFixUnsupportedError` guards the domain
  path (before any `fix_requests` row) and maps to TRPC **`UNPROCESSABLE_CONTENT`**.
- **Client placement.** The Bazarr client lives in `@hnet/arr` (`BazarrClient` on
  `@hnet/arr/read`, `BazarrWriteClient` on `@hnet/arr/write`) — the D-12 write-import
  confinement holds unchanged. `BAZARR_API_KEY` is required in the bundle env
  (`assertBazarrEnv`); `BAZARR_URL` defaults to the in-cluster service DNS.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: the right tool — subtitles are fetched by the estate's subtitle manager and the media file is left untouched (no re-grab, no delete). |
| C-02 | Good: no false blocklist entry — a good release is never marked failed for a subtitle gap. |
| C-03 | Bad: Bazarr is a new upstream dependency in the Fix path — one more failure surface. Mitigated: it fails closed via `ArrUpstreamError` (D-17 / BAD_GATEWAY), touching no file, and the other Fix reasons are unaffected. |
| C-04 | Neutral: subtitle fixes rest at `search_triggered` and never auto-complete — completion is not observable via ledger `imported` events (the fire-and-forget trade-off; poll-to-complete was rejected as Option D). |
| C-05 | Neutral: the Sonarr trigger is series-wide (`search-missing` searches only *missing* subs — a safe superset covering the target). Per-episode precision is deferred until Bazarr grows an async per-episode action. |
| C-06 | Neutral: `BAZARR_API_KEY` becomes a required field of the fix/restore client bundle env; because the sync CronJobs share the same ExternalSecret-fed env they now carry it too — operationally a no-op (sync never calls Bazarr). |

## More information

- **Extends ADR-007** (Option A) for the single reason `missing_subtitles`, which now routes
  to Bazarr (no blocklist/delete/re-grab) and is not offered for Music. ADR-007's header gains
  an `Amended by: ADR-016` line (repo precedent: ADR-002/007/008 carry such status links);
  ADR-007's decision text otherwise stands.
- Resolves PLAN-002 open decisions #1..#5 with the live verification above (endpoints,
  fire-and-forget resting state, id mapping, Bazarr-in-`@hnet/arr`, `BAZARR_API_KEY` required).
- DESIGN-005 D-19 (`docs/designs/005-arr-ledger-and-fix.md`) is the design; DDD-001 T-50
  (Bazarr) / T-51 (Subtitle Fix) and the amended T-30 are the glossary; PRD-001 R-44/R-45 gain
  a dated note. Code: `packages/arr/src/{config,http,read,write,schemas/bazarr}.ts`;
  `packages/domain/src/{arr-clients,fix-flow,fix-requests,fix-reasons,errors}.ts`;
  `packages/api/src/trpc.ts`; `apps/web/{lib/media.ts,app/(app)/library/[id]/fix-dialog.tsx,app/(app)/admin/fixes/page.tsx}`;
  migration `packages/db/migrations/0009_bazarr_subtitle_fix_path.sql`.
