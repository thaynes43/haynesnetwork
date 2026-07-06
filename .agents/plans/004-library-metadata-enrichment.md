# PLAN-004: Library metadata enrichment + posters + the shared filter/table engine

- **Status:** Draft _(Fable 5 flips Draft→Executing→Completed)_
- **Satisfies:** PRD-001 R-40..R-42 (extended — see §Docs) + new **R-67..R-72**; new **DESIGN-007** (D-01..D-14); new **ADR-016** (metadata modeling), **ADR-017** (poster storage). Governed by ADR-008 (one-way sync, two write-backs), ADR-003 (Postgres/Drizzle + transactional audit), ADR-010 (test layers), ADR-015 (no reorientation). Bounded context DDD-002 **BC-03 Media Ledger** (extends DESIGN-005).
- **Depends on:** none. **FOUNDATION for PLAN-005 (Ledger) + PLAN-006 (Trash)** — both reuse the metadata schema, the filter engine, and the filter/sort query contract this plan lands.
- **TODO source:** #3 of `.agents/plans/TODO.md` (metadata harvest + posters + high-powered filters).

## Goal

Harvest rich metadata from the *arrs (then Tautulli for watch-stats, then Maintainerr where it adds computed properties) into our DB, tied 1:1 to `media_items` (`packages/db/src/schema/media-items.ts:34`); expose **sort + filter** over it through `ledger.search`; render **server-side-cached small posters** in Library instead of the generic `KindIcon` (`apps/web/app/(app)/library/page.tsx:184`); and **port `demo-console`'s `packages/shared/filters` into `@hnet/ui` as the ONE filter/table engine** (mechanism only, our own look per DESIGN-006 + memory `distinct-visual-identity-per-app`) reused by Library now and by PLAN-005/006. Include a metadata path for **ledger-only / tombstoned / DELETED items** (not live in any *arr) via the *arr LOOKUP endpoints, and a **periodic refresh job** (ratings/votes/watch-stats go stale).

Sources, in priority order (owner-fixed): **1) *arr** (`ratings`/`images`/`genres`/`runtime` already on the live resources, currently dropped by strip-mode schemas), **2) Tautulli** legacy haynestower instance (most history; key `TAUTULLI_HAYNESTOWER_API_KEY`) for watch-stats, **3) Maintainerr** computed properties where cheap. *arr-first, but **direct TMDB/TVDB is now a sanctioned fallback tier** for metadata holes (keys staged in 1Password 2026-07-05 — `TMDB_API_KEY` v3, `TMDB_API_READ_ACCESS_TOKEN` v4 bearer, `TVDB_API_KEY`), used ONLY where the *arrs + Tautulli can't supply a field (esp. deleted / ledger-only items and fields an *arr doesn't expose). **RT stays *arr-only** — Rotten Tomatoes has no public API.

## Docs-first artifacts to author (no code before docs — `docs/PROCESS.md`)

**PRD-001 edits** (`docs/prds/001-haynesnetwork.md`, "Media ledger & fix (Phase 2)" table @ :101):
- Amend **R-40** wording note: the ledger also mirrors *arr-provided metadata (ratings, votes, genres, runtime, images) alongside the existing fields.
- Add a `> Note (2026-07-06 — metadata enrichment)` block above the table (mirror the existing R-43/R-46 note @ :110) pointing at DESIGN-007.
- New requirements (next free block after R-66; **confirm R-67 is free** — `grep -oE 'R-[0-9]+'` max is currently R-66):
  - **R-67** (Must) — The ledger stores per-item metadata harvested from the *arrs: IMDb/TMDb rating, IMDb/TMDb vote counts, Rotten Tomatoes tomatometer + audience (popcorn), runtime, resolution, genres, added date.
  - **R-68** (Must) — Watch-stats (play count, last-viewed) are harvested from Tautulli and stored per item.
  - **R-69** (Must) — Posters are cached server-side as small thumbnails (not hot-linked) and shown in Library.
  - **R-70** (Must) — Users can sort and filter the library by any stored metadata field.
  - **R-71** (Must) — Metadata is refreshed periodically (ratings/votes/watch-stats are volatile); a per-item source + fetched-at is recorded.
  - **R-72** (Should) — Ledger-only / deleted items (absent from every *arr) get metadata via the *arr lookup-by-external-id endpoints, without re-adding the item.

**ADR-016 — Metadata modeling: separate `media_metadata` table vs columns on `media_items`** (MADR 3.0, next free `docs/adrs/016-*.md`; Fable 5 authors AND Accepts per driver contract). Decision to record (default **separate 1:1 `media_metadata` table**): media_items is the Sync/Restore aggregate written by `upsertMediaItemsBatch` (DESIGN-005 D-12) whose columns are the *arr-settings snapshot Restore replays; metadata is a *different write cadence* (refresh job, multi-source, volatile) and mixing it bloats every sync upsert and Restore preview. A sibling table keyed by `media_item_id` (unique FK) isolates the volatile columns, carries its own `source`/`fetched_at`, and lets tombstoned rows keep metadata after the parent tombstones. `C-01..C-0N` consequences; enumerate the rejected "columns on media_items" alt with the sync-bloat + Restore-preview reasons.

**ADR-017 — Poster storage location** (next free `docs/adrs/017-*.md`; author + Accept). Decision (default **server-side small thumbnails on a dedicated PVC**, referenced by a stored relative `poster_path`, served through a Next.js route handler that streams from the volume): NOT hot-linked from TMDB/the *arr (CLAUDE.md privacy + offline-DR intent; TODO #3 "stored server side not pulled from the web, kept small"). Record: format (WebP), max dimension, the PVC mount, the eviction/orphan policy, and that the poster route is `authedProcedure`-gated (no public image endpoint). `C-01..C-0N`.

**DESIGN-007 — Library metadata enrichment, posters, and the shared filter/table engine** (next free `docs/designs/007-*.md`; copy `docs/designs/000-template.md`; **Companions:** DESIGN-005 (ledger), DESIGN-006 (visual identity), DESIGN-001 (conventions), DESIGN-003 (tRPC surface)). D-NN to author:
- **D-01 metadata schema** — the `media_metadata` table field set (below) + enums; 1:1 with `media_items`; tombstone-survivable.
- **D-02 *arr harvest contract** — the additional `ratings{imdb,tmdb,rottenTomatoes}`, `images[]`, `genres[]`, `runtime` fields to add to `radarrMovieSchema`/`sonarrSeriesSchema`/`lidarrArtistSchema` (currently strip-mode-dropped — `packages/arr/src/schemas/radarr.ts:22`, `sonarr.ts:24`); the map to `media_metadata` columns. Amends **DESIGN-005 D-02** (note the extension there).
- **D-03 Tautulli read client** — endpoints (`get_library_media_info` / `get_metadata` / `get_history` / `get_home_stats` via `/api/v2?apikey=&cmd=`), the watch-stats fields (play_count, last_played) and the tmdb/tvdb/rating-key join to `media_items`.
- **D-04 Maintainerr harvest (best-effort)** — which computed rule-properties are cheaply pullable now vs deferred; explicit "as much as we can" list mapped to Maintainerr's rule catalog. Maintainerr is being stood up tonight (PLAN-006 dep); this plan consumes it read-only if reachable, else degrades (the field stays null with `source` unset).
- **D-05 deleted-item lookup** — `GET /movie/lookup?term=tmdb:{id}` (Radarr), `GET /series/lookup?term=tvdb:{id}` (Sonarr), `GET /artist/lookup?term=...` (Lidarr): returns full metadata + images WITHOUT adding the item; used for tombstoned rows (`media_items.deleted_from_arr_at` set) and any row the full-sync harvest never populated. Where the *arr lookup falls short (or the title is unknown to that *arr), fall back to a **direct TMDB/TVDB lookup by id** (keys now in 1Password; record `source='tmdb'`/`'tvdb'`) — this supersedes the old "add-unwatched-and-snag-then-remove" idea (now unnecessary; keep only as a documented Q-NN).
- **D-06 refresh cadence** — a new sync mode/job that re-harvests ratings/votes/watch-stats on a schedule; `fetched_at` staleness threshold drives which rows refresh.
- **D-07 poster cache** — fetch → resize → store pipeline; PVC layout; the serving route; eviction.
- **D-08 the ported filter/table engine** — what moves from `demo-console/packages/shared/filters` (index @ `.../index.ts`) into `@hnet/ui`: `chipModel` (`ChipGroup`/`groupPairs`/`chipCsv`), `FilterChip` + inline editor, `FilterCell`/`BinChip`/`CopyableId`, the pure `FilterMap` helpers, generic `sort` (`nextSort`/`arrowFor`/`sortRowsClientSide`/`FieldSpec`) — all i18n-free (host injects `labels`), theme-free (host picks `classPrefix`; ours defaults to an `hnet-`/token-driven namespace, NOT demo-console's `dtf-`/`wk-` look). Host owns the field union + predicate/match-mode (handoff prompt "What STAYS in Work"). No `useTranslation` in any ported component (add the guard test).
- **D-09 sort/filter query contract** — the `ledger.search` input extension (`sort: {field, dir}`, `filters: FilterMap<LibraryField>`, metadata range/enum predicates) and the field union shared with PLAN-005/006. This is the load-bearing contract those plans build on — spec it fully here.
- **D-10 Library poster cards** — the card grid replacing the icon list (`page.tsx:179`), no-reorient rule (ADR-015): filter/sort changes swap the result set, they don't reflow neighbors mid-interaction; poster load uses fixed-aspect boxes so late image loads don't shift the grid.
- **D-11 migration numbering** — continues DESIGN-005 D-13; next is `0009_media_metadata.sql`.
- **D-12 new single-writers** — `upsertMediaMetadataBatch` / `refreshMediaMetadata` in `packages/domain`; `media_metadata` added to the D-12 guarded list.
- **D-13 poster write client confinement** — the poster-fetch client is a NEW external-write-ish surface; confine it like `@hnet/arr/write` (see §Domain).
- **D-14 e2e stubs** — stub *arr `/lookup` + `ratings`/`images`, stub Tautulli, stub Maintainerr for hermetic e2e.

**DDD glossary** (`docs/domain-driven-design/001-ubiquitous-language.md`, "Media ledger & fix" @ :62; next free is **T-46**): add
- **T-46 Media Metadata** — harvested descriptive/quality data per Media Item (ratings, votes, RT meters, runtime, resolution, genres, added/watch stats); `media_metadata`; multi-source, refreshed, tombstone-survivable.
- **T-47 Poster Cache** — the server-side small-thumbnail store; `media_metadata.poster_path` + the PVC.
- **T-48 Watch Stats** — Tautulli-sourced play_count/last_viewed on a Media Item; `media_metadata.play_count`/`last_viewed_at`.
- **T-49 Filter Engine** — the `@hnet/ui` shared filter/chip/sort/table primitives (ported from demo-console) reused by Library, Ledger, Trash; mechanism-shared, look-per-app.
(All added in the SAME change that introduces the terms — glossary is normative.)

## Data model

New table `packages/db/src/schema/media-metadata.ts` (mirror the `pgTable` + CHECK-from-enums shape of `media-items.ts:34`; conventions DESIGN-001 D-01 — uuid PK, snake_case, `timestamptz`, text+CHECK enums):

```
media_metadata
  id                uuid pk defaultRandom
  media_item_id     uuid NOT NULL  references media_items.id onDelete cascade   -- UNIQUE (1:1, ADR-016)
  media_type        text NOT NULL  -- CHECK: MEDIA_TYPES enum
  imdb_rating       numeric(3,1)   -- 0.0..10.0
  imdb_votes        integer
  tmdb_rating       numeric(4,1)
  tmdb_votes        integer
  rt_tomatometer    integer        -- 0..100 (critics)
  rt_popcorn        integer        -- 0..100 (audience)
  runtime_minutes   integer
  resolution        text           -- CHECK: RESOLUTIONS enum ('sd','720p','1080p','2160p','unknown')
  genres            jsonb NOT NULL default []  -- string[]
  added_at          timestamptz    -- *arr `added`
  play_count        integer        -- Tautulli
  last_viewed_at    timestamptz    -- Tautulli
  poster_path       text           -- relative path on the poster PVC; null until cached
  poster_fetched_at timestamptz
  source            text NOT NULL  -- CHECK: METADATA_SOURCES enum ('arr','arr_lookup','tautulli','maintainerr')
  fetched_at        timestamptz NOT NULL defaultNow   -- refresh staleness key (D-06)
  extra             jsonb NOT NULL default {}  -- Maintainerr computed props + any harvested-but-unmodeled fields
  created_at / updated_at  timestamptz
  -- unique(media_item_id); index(media_item_id); index(fetched_at) for the refresh scan
```

New enums in `packages/db/src/schema/enums.ts` (single source of truth for TS types + SQL CHECK — HARD RULE; follow the `ARR_KINDS` pattern @ `enums.ts:26`):
- `METADATA_SOURCES = ['arr','arr_lookup','tautulli','maintainerr','tmdb','tvdb'] as const` <!-- tmdb/tvdb = direct fallback for holes; keys in 1Password -->
- `RESOLUTIONS = ['sd','720p','1080p','2160p','unknown'] as const`
- `MEDIA_TYPES = ['movie','show','artist'] as const`  _(distinct from `ARR_KINDS` — the human media noun the UI filters on; document why in DESIGN-007 D-01, or reuse `ARR_KINDS` and record that choice as a Q-NN. Fable 5 decides.)_

Export from `packages/db/src/schema/index.ts`; add `MediaMetadataRow`/`Insert` types.

**Guard-list updates (HARD RULE — same change):**
- `packages/domain/__tests__/no-direct-state-writes.test.ts` — add `media_metadata` / `mediaMetadata` to every FORBIDDEN_PATTERNS branch (INSERT/UPDATE/DELETE SQL + `.insert()`/`.update()`/`.delete()` Drizzle), exactly as `media_items` appears @ lines 41/51/56/61/66. Reads stay unguarded.
- `packages/db/__tests__/media-ledger.test.ts` may stay in the `ALLOWED_FILES` set if it exercises the new CHECK constraints directly.

**Migration `0009_media_metadata.sql`** — `drizzle-kit generate` from the schema; hand-verify CHECK constraints render from the enum arrays. No seed (rows arrive via harvest).

## Domain

New single-writers in `packages/domain` (each wrapped in `inTransaction`; mirror `upsertMediaItemsBatch` in the DESIGN-005 D-12 table). Metadata is NOT a guarded-audit aggregate like Fix/Restore (no per-row audit event required — it is synced descriptive data, same class as `media_items` itself), but it IS single-writer-confined so the guard test passes:
- `upsertMediaMetadataBatch({ db, rows })` — upsert on `media_item_id` (ON CONFLICT DO UPDATE), set `source`/`fetched_at`; batched like the 500/tx media-items upsert (DESIGN-005 D-14 step 3).
- `refreshMediaMetadata` — re-harvest rows whose `fetched_at < now() - STALE_THRESHOLD` (D-06); same writer, different selection.
- `setPosterPath({ db, mediaItemId, posterPath })` — records the cached poster reference after the resize step commits the file.
- Poster fetch/resize is an **injected client bundle** (like `resolveArrBundle` in `ledger.ts:9`) so the writer stays pure and testable.

**Invariants:** metadata upsert never mutates `media_items`; a tombstoned parent keeps its metadata (cascade only fires on hard delete, which never happens — T-41). Deleted-item lookup (D-05) re-derives fresh from the *arr lookup endpoint (avoid TOCTOU — mirror the DESIGN-005 orchestrator re-derive rule) and writes `source='arr_lookup'`.

**Write-client confinement (HARD RULE):** the *arr `/lookup` reads go through `@hnet/arr` READ surface (no mutation — safe outside domain). The **poster-fetch client** reaches an external host to download images: if implemented as its own entrypoint, confine it exactly like `@hnet/arr/write` — extend `packages/domain/__tests__/arr-write-import-guard.test.ts` (or add a sibling guard) so only `packages/domain` + its own package import it. Fable 5 decides whether the poster fetch lives in `@hnet/sync` (CronJob-only, already domain-adjacent) or a new confined client; record as ADR/Q-NN.

## Client / integration

- **Extend `@hnet/arr` read** (`packages/arr/src/schemas/radarr.ts:22`, `sonarr.ts:24`, `lidarr.ts`): add `ratings` (`{imdb?:{value,votes}, tmdb?:{value,votes}, rottenTomatoes?:{value}}` — shapes vary per *arr; verify live), `images[]` (`{coverType:'poster', remoteUrl, url}`), `genres[]`, `runtime`. Strip-mode keeps unknown fields dropped; these become parsed. Add `getMovieByLookup`/`getSeriesByLookup`/`getArtistByLookup` READ methods for D-05 (`GET /movie/lookup?term=tmdb:{id}` etc.) with their own zod schemas.
- **New Tautulli read client** — `packages/arr/src/tautulli.ts` (or a new `@hnet/tautulli` package if Fable 5 prefers isolation; decide + record). `GET {TAUTULLI_URL}/api/v2?apikey={TAUTULLI_HAYNESTOWER_API_KEY}&cmd=get_library_media_info|get_metadata|get_history`. Join to `media_items` by tmdb/tvdb/imdb id (Tautulli exposes guids). Env: `TAUTULLI_URL` (in-cluster svc DNS — EXEMPT from the arbitrary-URL rule, it's a server-side base URL), `TAUTULLI_HAYNESTOWER_API_KEY`. Config lives beside `packages/arr/src/config.ts` `assertArrEnv` pattern.
- **Poster pipeline** (`@hnet/sync` step or confined client): pick the `coverType:'poster'` image, fetch bytes, resize to the ADR-017 max dimension (WebP; a small pure-TS/`sharp` resizer — confirm `sharp` is acceptable in the standalone image + CronJob, else a lighter lib; Fable 5 decides), write to the PVC path `{mediaItemId}.webp`, call `setPosterPath`.
- **Extend `@hnet/sync`** (`packages/sync/src/adapt.ts`, `orchestrator.ts`, `scripts/sync.ts`): the full-sync pass already adapts *arr items (`adapt.ts:49/81/107`); add a metadata-adapt + `upsertMediaMetadataBatch` step and the poster step. Add a new `--mode=metadata-refresh` (D-06) invoking `refreshMediaMetadata` + Tautulli harvest + deleted-item lookup for stale/missing rows.
- **Maintainerr read** (best-effort, D-04): `GET {MAINTAINERR_URL}/api/...` for computed props into `media_metadata.extra`; guarded by reachability (skip silently if the tonight-deployed instance isn't up).

## API

- **`ledger.search` extension** (`packages/api/src/routers/ledger.ts:23`, `authedProcedure`): add optional `sort: { field: enum(LIBRARY_SORT_FIELDS), dir: 'asc'|'desc' }` and `filters` (the ported `FilterMap` serialized shape) covering the metadata columns (ratings, votes, RT, resolution, genres, runtime, added/watch). Keyset pagination must incorporate the chosen sort field + a stable id tiebreaker (extend the existing `(sort_title, id)` cursor in `ledger.ts:65-70` — generalize to `(sortValue, id)`). Response `items` gain `metadata` (the harvested fields) + `posterUrl` (the authed poster route, null if uncached). Keep the existing `query`/`arrKind`/`onDisk`/`wanted` inputs.
- **New poster route** — a Next.js route handler `apps/web/app/api/poster/[id]/route.ts` (authed via the existing session; NOT a public endpoint per ADR-017) streaming the PVC file; or a tRPC-signed short-lived URL. Fable 5 picks; record in ADR-017.
- **`ledger.detail`** (`ledger.ts:114`) response gains the metadata block + posterUrl for the detail page.
- No new write procedures — harvest is CronJob-only; the UI is read + the existing Fix/Force-Search actions (unchanged).

## UI

- **Port `demo-console/packages/shared/filters` → `@hnet/ui`** (`packages/ui/src/` — new `filters/` dir beside `controls`/`layout`). Move `chipModel`, `FilterChip` (+ inline editor), `cells` (`FilterCell`/`BinChip`/`CopyableId`), `filterMap` helpers, `sort` (`nextSort`/`arrowFor`/`sortRowsClientSide`/`FieldSpec`) — **verbatim mechanism** per the handoff prompt's "what moves" list; strip the demo's `dtf-`/`wk-` classes and re-express structure against `@hnet/ui` tokens (`tokens.css` is the ONLY hex home — HARD RULE / `pnpm lint:css`). Add the no-`useTranslation` guard test (`noI18n.guard.test.ts` analog). Export from `packages/ui/src/index.ts`. Host (Library) injects `labels` + the `LibraryField` union + the match-mode predicate.
- **Library page rebuild** (`apps/web/app/(app)/library/page.tsx`): replace the icon list (`page.tsx:179-203`) with a **poster card grid**; wire the filter chips + sortable column/field controls to the new `@hnet/ui` engine and the extended `ledger.search`. Keep the existing Movies·TV·Music·My Fixes sub-tab shell (`page.tsx:17`, DESIGN-005 D-17) — filters/sort live inside each media tab, remounted per tab (the existing `key={activeTab.key}` pattern @ :99). Music tab shows posters where available (artist images), no watch-stats requirement.
- **No-reorient (HARD RULE ADR-015):** poster cards use fixed-aspect containers so async image loads never shift the grid; applying a filter/sort swaps the result set (a deliberate content change, allowed) but does not reflow neighbors mid-interaction; chip edit is the deliberate in-place expansion exception. Filter/sort controls: no destructive actions here, so no ConfirmButton/Modal needed on this surface.
- **Poster component** — `<MediaPoster>` in `@hnet/ui` or `apps/web/components`: fixed box, `posterUrl` with the `KindIcon` (`page.tsx:184`) as the fallback when null.

## Ops

- **1Password / ExternalSecret** (reference names only — never values, never commit): add `TAUTULLI_HAYNESTOWER_API_KEY` and `TAUTULLI_URL` (+ `MAINTAINERR_URL`/`MAINTAINERR_API_KEY` if D-04 lands tonight) to the `haynesnetwork-secret` ExternalSecret feeding the app + sync CronJobs (envFrom pattern already used @ `haynes-ops .../helmrelease.yaml` sync containers). Key already exists in the `HaynesKube`/media-stack vault per TODO.md.
- **Poster PVC** — add a PersistentVolumeClaim + mount to the `apps/web` Deployment AND the sync CronJobs (both write/read posters) in the haynes-ops HelmRelease. Size small (thumbnails). Document mount path in ADR-017.
- **Refresh CronJob** — add a `sync-metadata` CronJob (mirror `sync-incremental`/`sync-full` in the HelmRelease) running `tsx /sync/src/scripts/sync.ts --mode=metadata-refresh`, `concurrencyPolicy: Forbid`. Cadence per D-06 (e.g. every 6h) — Fable 5 sets it.
- **e2e stubs** (`apps/web/e2e`, D-14): extend the stub *arr servers to return `ratings`/`images`/`genres`/`runtime` on item + `/lookup` responses; add a stub Tautulli (`/api/v2` watch-stats) and a stub Maintainerr; serve a tiny fixture poster so the cache pipeline runs hermetically. LIVE validation hits the real services.

## Open decisions for Fable 5 (authorized to decide + record as ADR/Q-NN)

1. **Separate `media_metadata` table vs columns on `media_items`** — plan defaults to separate (ADR-016); Fable 5 ratifies or overrides.
2. **Poster size / format / eviction** — WebP + a max dimension + orphan-cleanup policy (ADR-017); and the serving mechanism (route handler streaming vs signed URL).
3. **Refresh cadence + staleness threshold** — the `--mode=metadata-refresh` schedule and `fetched_at` window (D-06).
4. **Deleted-item lookup mechanics + fallback** — exact `/lookup?term=` forms per *arr, which stale/missing rows to backfill, and whether the "add-unwatched-and-snag-then-remove" fallback is ever needed (default: lookup-only, fallback documented as Q-NN not built).
5. **Which Maintainerr rule-properties to harvest now vs later** (D-04) — depends on the tonight-deployed instance being reachable; degrade gracefully if not.
6. **`MEDIA_TYPES` new enum vs reuse `ARR_KINDS`** for the metadata/filter media noun.
7. **Poster-fetch client home** — `@hnet/sync` (CronJob-only) vs a new import-confined client; and whether `sharp` is acceptable in the standalone image.
8. **Tautulli client home** — inside `@hnet/arr` vs a new `@hnet/tautulli` package.

## Verification

**Unit (ADR-010 unit layer, embedded PG16 where DB-touching):**
- Metadata mappers: *arr `ratings`/`images`/`genres`/`runtime` → `media_metadata` columns (fixture-driven, like `adapt.ts` tests in `packages/sync/__tests__/`).
- Deleted-item lookup adapter: `/lookup?term=tmdb:{id}` fixture → metadata, no add call issued.
- Tautulli mapper: `get_metadata`/`get_history` fixture → play_count/last_viewed; id-join to media_items.
- Ported filter engine: bring over the demo-console `chipModel`/`FilterChip`/`sort`/`cells` tests, re-pointed at `@hnet/ui`; add the no-`useTranslation` guard.
- `ledger.search` sort/filter contract: keyset pagination stable across a sorted metadata field with ties.
- **Guard tests green:** `media_metadata` in `no-direct-state-writes.test.ts`; poster client (if confined) in the arr-write import guard.
- `packages/db/__tests__/media-ledger.test.ts` (or a new metadata test): the CHECK constraints reject bad `source`/`resolution`/`media_type`.

**Integration (embedded PG16 + stubs):** full-sync harvest populates `media_metadata` for stub *arr items; refresh mode re-harvests a stale row; poster pipeline writes a fixture file + `poster_path`; `ledger.search` returns metadata + posterUrl filtered/sorted.

**e2e (hermetic, `apps/web/e2e` stubs, D-14):** Library renders poster cards; apply a rating filter + a sort → result set changes with no layout reflow; a stub tombstoned item shows lookup-sourced metadata.

**LIVE Playwright (real staging `https://haynesnetwork.haynesops.com` + real Sonarr/Radarr/Lidarr/Tautulli after deploy):**
1. Library Movies tab: real posters render (server-cached, not remote-hotlinked — assert the img src is the app poster route), real IMDb/TMDb rating + votes + RT tomatometer/popcorn populate on cards/detail.
2. TV + Music tabs: posters + ratings where the *arr has them.
3. Watch-stats: a known-watched title shows play_count / last-viewed from Tautulli haynestower.
4. Sort by rating and filter by a genre/resolution/rating-range → correct, keyset-paginated, no reflow.
5. A DELETED/tombstoned item (from `radarr-fileless-backlog.md` or a known-removed title) gets metadata via `/lookup` after the metadata-refresh CronJob runs.

## Definition of Done

Docs authored + ADR-016/017 Accepted + glossary T-46..T-49 landed in the same PR as behavior → local merge gate green (`pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`) → branch `feat/library-metadata-enrichment` → PR → required checks (`lint-and-typecheck`, `test`, `build`) green → squash-merge → image tag bumped in `haynes-ops .../helmrelease.yaml` + `flux reconcile` (per `docs/ops/004-deploy-runbook.md`) with the poster PVC + `sync-metadata` CronJob + Tautulli secret applied → the 5 LIVE Playwright journeys pass against real staging + real backends → mark Completed + `git mv` this plan to `.agents/plans/completed/`.

## Out of scope

- Ledger section UI (PLAN-005) and Trash section (PLAN-006) — they REUSE this plan's `media_metadata`, filter engine, and `ledger.search` contract but are separate verticals.
- A direct **Rotten Tomatoes** integration (no public RT API — RT ratings stay *arr-sourced). _(TMDB/TVDB direct is now IN scope as a fallback tier — keys staged 2026-07-05.)_
- The "add-unwatched-and-snag-then-remove" deleted-item fallback (documented Q-NN, not built unless lookup proves insufficient live).
- Posters for the Ledger (TODO #5 explicitly: ledger needs no posters).
- Perma-save / whitelist pin on Library cards (that's PLAN-006 Trash scope).

## Rollback

- Revert the app image tag in `haynes-ops .../helmrelease.yaml` + `flux reconcile` → prior image (no metadata UI). `media_metadata` is additive (new table, cascade-on-delete FK) — leaving the migration applied is harmless; `ledger.search` ignores the new optional inputs when the client doesn't send them.
- The `sync-metadata` CronJob + poster PVC can be removed independently; posters degrade to `KindIcon` fallback (`page.tsx:184`) when `poster_path` is null, so an un-primed cache never breaks Library.
- Migration `0009` is forward-only (project convention — no down migrations); rollback is image-revert, not schema-revert.

---

## Addendum (2026-07-05, owner) — harvest ALL THREE Tautullis for cross-server watch history

Widen the watch-stats source from the single HaynesTower Tautulli to **all three Tautulli
instances**, so watch history is complete across the estate. The owner keeps the legacy
HaynesTower Plex live and not all users will migrate, so any single server's history is always
partial:

- **Sources:** HaynesOps `TAUTULLI_API_KEY`, HaynesKube `TAUTULLI_K8PLEX_API_KEY`, HaynesTower
  `TAUTULLI_HAYNESTOWER_API_KEY` (all already in 1Password — the homepage ExternalSecret already
  references the first two). Add all three to the haynesnetwork app ExternalSecret / env.
- **Matching:** correlate each Tautulli's history to our `media_items` by **TMDB / IMDb GUID**,
  NOT Plex rating key — the three servers have different machine identifiers and rating keys, so
  rating-key matching would not line up. This is our own code; we control the join.
- **Unified signal on `media_metadata`:** `last_watched_at` = MAX across servers, `play_count` =
  SUM across servers (keep a per-server breakdown if cheap), optionally `watched_by`. This unified
  watch signal is the substrate PLAN-006 uses to protect actively-watched media from deletion.
- Populate it on the same metadata refresh job.

Open decision for Fable 5: per-server columns vs one unified row + a per-source side table;
whether to dedupe one account watching the same title on two servers.

---

## Addendum (2026-07-05, owner) — *arr tag semantics (requester + source-collection)

The raw *arr tag LABELS are ALREADY synced into `media_items.arrTags` (`media-items.ts`). This
plan adds tag **semantics** — parse those labels into structured, filterable metadata. The owner
is porting tags from the legacy instances that encode:
- **Seerr / requester tags** — who personally requested a title → a strong **KEEP** signal.
- **Kometa / collection tags** — which auto-collection added a title → provenance of **where
  unwanted media comes from**.
Store parsed dimensions on `media_metadata` (e.g. `requesters text[]`, `source_collections text[]`,
derived from `arrTags` by naming convention) and expose them as first-class **filter facets** in
the ported filter engine; keep the raw `arrTags` too. Fable: discover the live tag naming
conventions (prefixes) from the *arr tag list before parsing. Feeds PLAN-005 filters + PLAN-006
rules; the requester signal also complements the exclusion-tag `dnd` + the watch-history guardian.
