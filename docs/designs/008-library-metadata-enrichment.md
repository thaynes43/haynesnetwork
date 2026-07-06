# DESIGN-008: Library metadata enrichment, poster proxy, and the shared filter/sort contract

- **Status:** Draft
- **Last updated:** 2026-07-06
- **Satisfies:** PRD-001 R-40..R-42 (extended) + new **R-67..R-72**; governed by **ADR-018**
  (metadata modeling), **ADR-019** (poster proxy), ADR-008 (one-way sync), ADR-003
  (Postgres/Drizzle + transactional audit), ADR-015 (no reorientation). Bounded context DDD-002
  **BC-03 Media Ledger** (extends DESIGN-005). **Companions:** DESIGN-005 (ledger), DESIGN-006
  (visual identity), DESIGN-003 (tRPC surface).

> **Split note (2026-07-06, Fable 5 autonomous run).** This plan's **backend vertical** —
> schema, harvest, the extended `ledger.search`/`ledger.filterFacets` tRPC contract with the
> generalized NULLS-LAST keyset cursor, the poster proxy route, and the e2e stubs — landed on
> this branch. The **UX layer** — **D-10** (the demo-console filter-engine port into `@hnet/ui`)
> and **D-11** (the `/library` poster-grid + chip bar + sort control + host glue, and the detail
> metadata block) — **landed with the follow-up UX change on this same branch (2026-07-06)**;
> the implemented-judgment notes inside D-10/D-11 record where the build deviated from the
> original plan text and why.

## Overview

Harvest rich, multi-source metadata for each Media Item into a 1:1 sibling table
(`media_metadata`, ADR-018), expose **sort + filter** over it through `ledger.search`, serve small
posters through an **authed proxy** (ADR-019), and reuse ONE ported filter/sort engine across
Library, Ledger (PLAN-005), and Trash (PLAN-006). The `ledger.search`/cursor contract (**D-09**)
is the load-bearing substrate PLAN-005/006 build on.

## Detailed design

### D-01 — `media_metadata` schema

The 1:1 sibling table (ADR-018), migration **0012**. Enums in
`packages/db/src/schema/enums.ts`: `METADATA_SOURCES = ['arr','arr_lookup','tautulli','maintainerr','tmdb','tvdb']`,
`RESOLUTIONS = ['2160p','1080p','720p','576p','480p','sd','unknown']`,
`POSTER_SOURCES = ['arr','tmdb']`, and `SYNC_RUN_KINDS` extended with `'metadata-refresh'`
(migration 0012 relaxes the `sync_runs.run_kind` CHECK). No new media-type enum — reuse
`ARR_KINDS`; the noun (Movie/Show/Artist) is a display map in `apps/web/lib/media.ts`. Guard:
`media_metadata`/`mediaMetadata` added to all six `no-direct-state-writes` FORBIDDEN_PATTERNS.

### D-02 — *arr harvest contract (live-verified 2026-07-06)

The *arr item resources carry metadata previously strip-dropped; the subsets now parse it
(`packages/arr/src/schemas/{radarr,sonarr,lidarr}.ts` + shared shapes in `common.ts`):

- **Radarr** `ratings` is a multi-source map — `{imdb:{value,votes}, tmdb:{value,votes},
  rottenTomatoes:{value}, metacritic:{value}, trakt:{value,votes}}` (6595/9558 movies carry RT).
  Map: `imdb → imdb_rating/imdb_votes`, `tmdb → tmdb_rating/tmdb_votes`,
  `rottenTomatoes.value → rt_tomatometer`. RT audience/popcorn is exposed by NO *arr → `rt_popcorn`
  stays null from this tier.
- **Sonarr / Lidarr** expose a SINGLE community rating `{value, votes}` → `tmdb_rating/tmdb_votes`
  (documented approximation; the `imdb_rating` filter is movie-centric until the TMDB tier fills).
- `images[]` = `{coverType, url(relative, carries ?lastWrite), remoteUrl}`. The poster is
  `coverType='poster'`; `posterFromArrImages` records `poster_source='arr'`, `poster_ref = url`.
- `genres` string[]; `runtime` int minutes (radarr/sonarr; artists have none); `added` → `arr_added_at`.
- **resolution** is the REAL per-item on-disk tier (live-validation fix 2026-07-06; the original
  quality-PROFILE-name derivation mapped the owner's live *range* profiles — every movie is on
  "Any"/"FHD-UHD"/… and every series on "FHD-UHD" — to `'unknown'`, making the facet useless in
  practice). Sources, `resolutionFromInt`/`dominantResolution` in `adapt-metadata.ts`:
  - **Radarr** — the `GET /movie` list embeds the on-disk file INLINE (`movieFile`, present on
    5473/9558 movies), so `movieFile.quality.quality.resolution` (the *arr's normalized INT tier:
    2160/1080/720/576/480; 0/absent = unknown) gives the resolution with NO extra request. A
    movie with no file ⇒ resolution `null`.
  - **Sonarr** — the series list carries no per-file data, so the harvest fetches
    `GET /episodefile?seriesId=` per LIVE target and takes the DOMINANT (modal) episode-file tier.
    Cheap: live-measured **16 ms/req in-cluster** (the earlier "~1 s/req" was pure `kubectl
    port-forward` tunnel overhead — a trivial `/system/status` measured the same 1 s), ~17 s
    serial across the 1026-series estate — well inside the 6 h cadence, so no concurrency needed.
    Per-series degradable; a series with no files ⇒ `null`.
  - **Lidarr (Music)** — resolution is meaningless for audio ⇒ always `null` (NOT `'unknown'`).
    `filterFacets` scopes resolution by `arrKind` and filters `IS NOT NULL`, so the Music tab's
    Resolution chip simply offers no values.
  - Tombstoned / lookup / direct-TMDB/TVDB rows have no file on disk ⇒ `null`. The raw int→enum
    map uses `RESOLUTIONS` unchanged (no enum/CHECK migration needed — the live ints all fit).

### D-03 — Tautulli watch-stats (cross-server) + refresh cadence

`packages/arr/src/tautulli.ts` — one client per estate instance. Auth is an `apikey` QUERY param
(not a header); every call is `GET /api/v2?cmd=…`. Commands: `get_history` (rows carry
`rating_key`, `grandparent_rating_key`, `media_type`, `date`/`stopped` unix-seconds,
`watched_status`) and `get_metadata` (returns `guids: ['imdb://…','tmdb://…','tvdb://…']` — the
join key; history rows' `tmdb_id`/`imdb_id` are null, so guids come from `get_metadata`).
Three instances (`assertTautulliEnv` via `resolveTautulliInstances`, NOT in `ARR_SERVICES`):
HaynesOps (`TAUTULLI_API_KEY`, `http://tautulli.media.svc.cluster.local:8181`), HaynesKube
(`TAUTULLI_K8PLEX_API_KEY`, `http://tautulli-k8plex.media.svc.cluster.local:8181`), HaynesTower
(`TAUTULLI_HAYNESTOWER_API_KEY` + `TAUTULLI_HAYNESTOWER_URL` — external legacy box, no cluster
default). **Unified signal:** `play_count` = SUM, `last_viewed_at` = MAX across instances;
per-instance breakdown → `extra.tautulli` (`mergeWatchContributions`). Movies join by tmdb/imdb;
episodes attribute to their SERIES via `grandparent_rating_key` → tvdb/tmdb. Env ABSENT ⇒ tier
skipped with one log line (local-dev default).

The harvest is a new sync mode `metadata-refresh` (`packages/sync/src/metadata-refresh.ts`),
dispatched per *arr kind by the orchestrator (Seerr excluded); the cross-kind Tautulli + Maintainerr
context is built ONCE and shared. `selectMetadataTargets` picks rows missing OR
`fetched_at < now()-6h`, oldest-first. Extend `SYNC_RUN_KINDS`, the orchestrator dispatch, and the
`scripts/sync.ts` parser (`--mode=metadata-refresh`). CronJob `sync-metadata` `15 */6 * * *`,
`concurrencyPolicy: Forbid`.

```mermaid
sequenceDiagram
  participant Cron as sync-metadata (6h)
  participant Ctx as buildMetadataContext (once)
  participant Kind as runMetadataRefreshForKind (×3)
  participant DB
  Cron->>Ctx: Tautulli ×N (get_history → get_metadata guids) + Maintainerr collections
  Note over Ctx: each tier fails independently → logged, recorded in `sources`
  loop radarr, sonarr, lidarr
    Cron->>Kind: shared context + arr read clients
    Kind->>DB: selectMetadataTargets (missing OR stale 6h)
    Kind->>Kind: arr list → else /lookup → else TMDB/TVDB; + tags, resolution, watch, maintainerr
    Kind->>DB: upsertMediaMetadataBatch (500/tx, ON CONFLICT replace, fetched_at=now())
  end
```

### D-04 — Maintainerr (best-effort)

`packages/arr/src/maintainerr.ts` — `GET /api/collections` (svc `:6246`, answered without a key
2026-07-06; `MAINTAINERR_API_KEY` rides `x-api-key` when set). Provenance (`tmdbId → [collection
titles]`) → `extra.maintainerr`. Opt-in (`MAINTAINERR_URL` or `MAINTAINERR_API_KEY`); absent ⇒
skipped.

### D-05 — deleted-item lookup + TMDB/TVDB fallback

The `arr_lookup` tier (READ, no add): `GET /movie/lookup?term=tmdb:{id}` (Radarr),
`/series/lookup?term=tvdb:{id}` (Sonarr), `/artist/lookup?term=lidarr:{mbid}` (Lidarr) — full
metadata + `remotePoster`. For remaining holes, the direct `tmdb`/`tvdb` tiers
(`packages/arr/src/{tmdb,tvdb}.ts`, optional env): TMDB v4 bearer (`TMDB_API_READ_ACCESS_TOKEN`)
or v3 key (`TMDB_API_KEY`); TVDB v4 login-token flow (`TVDB_API_KEY`). Keys absent ⇒ tier skipped.
RT stays *arr-only.

### D-06 — poster proxy

See ADR-019. `poster_source`/`poster_ref` on `media_metadata`; the authed route resolves the
upstream via `@hnet/api resolvePosterUpstream` and streams (arr MediaCover variant with the key
header, or the TMDB CDN). Cache `private, max-age=86400, stale-while-revalidate=604800` + ETag.

### D-07 — *arr-tag semantics

`parseArrTags` (packages/domain): `/^\d+-(.+)$/` → `requesters[]`; all other tags →
`source_collections[]` verbatim. Raw `media_items.arr_tags` untouched. Exposed as first-class
filter facets (D-09).

### D-08 — the single writer

`upsertMediaMetadataBatch({ db, rows })` (packages/domain) — `inTransaction`, upsert on
`media_item_id` (ON CONFLICT DO UPDATE → full replace from `excluded.*`, `fetched_at = now()`),
batched by the caller. Not an audit aggregate (synced descriptive data, same class as
`media_items`); single-writer-confined for the guard.

### D-09 — the `ledger.search` / cursor contract (THE substrate PLAN-005/006 reuse)

`ledger.search` LEFT JOINs `media_metadata` (unharvested rows still list). The **exact zod input**
(`packages/api/src/routers/ledger.ts`):

```ts
z.object({
  query: z.string().trim().max(200).optional(),
  arrKind: z.enum(ARR_KINDS).optional(),               // 'sonarr' | 'radarr' | 'lidarr'
  onDisk: z.enum(['any','complete','partial','none']).default('any'),
  wanted: z.boolean().optional(),                       // monitored + nothing on disk
  includeTombstoned: z.boolean().default(false),
  // metadata facet filters — within a facet OR, across facets AND (chip semantics):
  genres: z.array(z.string().min(1)).max(50).optional(),
  resolutions: z.array(z.enum(RESOLUTIONS)).max(RESOLUTIONS.length).optional(),
  requesters: z.array(z.string().min(1)).max(50).optional(),
  sourceCollections: z.array(z.string().min(1)).max(50).optional(),
  ratingMin: z.number().min(0).max(10).optional(),      // on COALESCE(imdb_rating, tmdb_rating)
  ratingMax: z.number().min(0).max(10).optional(),
  sort: z.object({
    field: z.enum(['title','imdb_rating','tmdb_rating','rt_tomatometer',
                   'added_at','play_count','last_viewed','runtime']).default('title'),
    dir: z.enum(['asc','desc']).default('asc'),
  }).default({ field: 'title', dir: 'asc' }),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
```

Response `items[]` add `posterUrl` (`/api/posters/{id}` when a poster tier resolved, else null)
and `metadata` (`{imdbRating, imdbVotes, tmdbRating, tmdbVotes, rtTomatometer, rtPopcorn,
runtimeMinutes, resolution, genres[], addedAt(ISO), playCount, lastViewedAt(ISO), requesters[],
sourceCollections[]}`; numeric columns coerced to number, dates to ISO, jsonb defaulted to `[]`),
alongside the existing `{id, arrKind, title, year, monitored, onDiskFileCount, expectedFileCount,
sizeOnDisk, qualityProfileName, tombstoned}`. Facet filters: `genres`/`requesters`/
`sourceCollections` use jsonb overlap `col ?| ARRAY[$1,…]::text[]`; `resolutions` uses `IN`;
`ratingMin/Max` compares `COALESCE(imdb_rating, tmdb_rating)` (fix 2026-07-06 — was `imdb_rating`
only, which starved TV/Music whose single *arr rating lands in `tmdb_rating`; ADR-018 C-07). A
row with neither rating never satisfies a bound (`COALESCE(NULL,NULL) → NULL`).

**The generalized keyset cursor** (`packages/api/src/keyset.ts`) — the load-bearing algorithm.
It generalizes DESIGN-005's `(sort_title, id)` to `(sortValue, id)` over an ARBITRARY nullable
sort column, **NULLS LAST in both directions**, id ASC tiebreaker (stable, regardless of dir):

```
ORDER BY  <expr> <dir> NULLS LAST,  id ASC

-- rows strictly AFTER the cursor (value, id):
value IS NULL   →  (expr IS NULL AND id > cursorId)          -- among the trailing nulls
value not null  →  ( <expr </> value>                        -- '>' asc, '<' desc
                     OR (expr = value AND id > cursorId)      -- tie broken by id
                     OR expr IS NULL )                        -- all nulls sort last (both dirs)
```

Cursor encoding: `base64url(JSON.stringify([sortValue, id]))` where `sortValue` is a string
(title), a number (ratings/runtime/counts), an ISO string (dates — compared with `::timestamptz`),
or `null` (the row lacked the field). `decodeKeysetCursor` rejects a malformed/tampered cursor
with `BAD_REQUEST`. `encodeKeysetCursor(sortValue, id)` / `keysetOrderBy(expr, dir, idCol)` /
`keysetAfter({expr, idCol, kind, dir, value, id})` are the reusable primitives. **PLAN-005/006
import these verbatim — do not re-implement.** Hard unit coverage: nulls, numeric, string, both
directions, page boundaries across the null frontier (`packages/api/__tests__/ledger-metadata.test.ts`).

`ledger.filterFacets({ arrKind? })` returns `{ genres[], resolutions[], requesters[],
sourceCollections[] }` — cheap SELECT-DISTINCTs over the harvested jsonb (`jsonb_array_elements_text`),
scoped per media tab. `resolutions` is returned in **RESOLUTIONS enum order** (2160p→sd→unknown),
not the DISTINCT's alphabetical order, so the client renders it best-first without a re-sort (fix
2026-07-06). `ledger.detail` gains the same `metadata` block + `posterUrl`; the block is **always
the object shape** — all-null fields when unharvested, identical to `search` — so no consumer
null-checks the block itself (fix 2026-07-06 — `detail` previously returned `metadata: null`).

### D-10 — the ported filter/sort engine (IMPLEMENTED 2026-07-06)

Port `demo-console/packages/shared/filters` → `packages/ui/src/filters/` (mechanism only; hnet
keeps its own look via the token seam + an `hnet-` class namespace — memory
`distinct-visual-identity-per-app`). Move VERBATIM: the pure `chipModel` (`ChipGroup`/`groupPairs`/
`chipCsv`), `filterMap` (`FilterMap<F>` + `filterFirst/values/has/toggle/add/remove/setDrill`),
and `sort` (`nextSort`/`arrowFor`/`sortRowsClientSide`/`FieldSpec`) modules + their tests + the
no-`useTranslation` guard test. Port the 3 `.tsx` (`FilterChip` + inline editor, `Autocomplete`,
`cells` = `FilterCell`/`BinChip`/`CopyableId`) with `classPrefix` default `'hnet'`, React-19 JSX
fixes (`import type { JSX } from 'react'`; `React.CSSProperties`/`React.KeyboardEvent` → named
imports), and a `'use client'` directive (Next RSC — the demo SPA didn't need it). Rename
`filters.css` `dtf-` → `hnet-` (all 8 tokens it uses already exist in `tokens.css`); export it as
`@hnet/ui/filters/filters.css` (imported by the app root layout, NOT a JS side-effect import).
Authorized repo-convention change: add `jsdom` + `@testing-library/react` + `@vitejs/plugin-react`
devDeps to `@hnet/ui`, and keep the runner env `node` with the component tests opting into jsdom
via a `// @vitest-environment jsdom` docblock (so the existing node-based token-contract test keeps
working). Export everything from `@hnet/ui`. The host owns the field union + labels + predicate.

**Implemented — deliberate divergences from the donor (2026-07-06 UX run):**

- **Popover positioning: `absolute` → viewport-clamped `position: fixed`** (pure helper
  `chipPopoverStyle(anchor, viewport)`, exported). The donor SPA anchored chips in a wide
  static toolbar; here the chip bar is a horizontally-scrolling row (D-11) whose `overflow`
  would never clip a fixed-position editor, and 390px viewports need the left/height clamp so
  the editor always fits on screen. The popover closes on outside click, Escape, resize, and
  any outside scroll (a fixed overlay must not detach from its anchor).
- **The ✕ clear button renders only while the field HAS values**, the chip gains an
  `is-empty` class, and a new optional `labels.noValues` message covers an empty enum facet —
  because the Library host keeps every field's chip PERMANENTLY in the bar (the empty chip is
  the "add a filter" affordance), where the donor only mounted chips for active fields.
- **CSV values render in the body face** (`hnet-chip-csv`), not the donor's mono — hnet's
  filter values are human words (genres, requesters), not opaque ids. `hnet-mono` remains for
  the cells/BinChip surface.
- **`filters.css` is a re-skin, not a rename**: pill chips with ghost empty state and
  ghost hovers, `--radius` (16px) editor panels, ≥40px checklist rows, accent `accent-color`
  checkboxes, and the DESIGN-006 D-04 light-theme deepen
  (`color-mix(accent 62%, text)`) on active chip/token text. Donor selectors and structure
  are otherwise 1:1 so the ported interaction tests run unchanged.
- The pure modules (`chipModel`/`filterMap`/`sort`/`filterSuggestions`) + their tests + the
  no-i18n guard moved VERBATIM (only `!` non-null tweaks for this repo's stricter TS).

### D-11 — Library poster grid + host glue + detail metadata (IMPLEMENTED 2026-07-06)

Replace the `/library` icon LIST (`page.tsx`) with a **poster-card GRID**: fixed **2:3** poster
boxes (reserve space so image load/failure never reflows — ADR-015), KindIcon fallback inside the
box, title + year + rating badge. Above the grid: a filter chip bar (one enum checklist per facet —
Genre/Resolution/Requester/Collection, values from `ledger.filterFacets`) + a sort control built
on `nextSort`/`arrowFor`, host-glued to the extended `ledger.search`. URL-state sync
(`useSearchParams` + `router.replace` — deep-linkable, Back/Forward safe; filters/sort reset on
tab switch). Keep the Movies·TV·Music·My Fixes sub-tab shell + infinite scroll. Mobile-first: 2
columns at 390px scaling to ~6 at desktop; tap targets ≥44px. Detail (`/library/[id]`) gains a
poster + a metadata block (ratings row, genres/requester/collection chips, runtime/resolution,
watch stats) — static layout, no reorientation on any interaction. Host-glue references: the
`LibraryField` union = `'genres'|'resolutions'|'requesters'|'sourceCollections'`; each maps to a
URL param and to the same-named `ledger.search` input; `resolutions` values are the `RESOLUTIONS`
enum (labels via `RESOLUTION_LABELS`). A `<MediaPoster>` component (fixed box, `posterUrl` with
KindIcon fallback on null/error) serves both the grid and the detail head.

**Implemented — judgment calls (2026-07-06 UX run; ADR-015 is the ruling constraint):**

- **URL-state contract** (documented at the top of `page.tsx`): `?q` (search text, input
  debounced 250 ms → URL), `?disk`, `?wanted=1`, `?genre/res/req/col` as **repeated params**
  (comma-safe for arbitrary tag labels), `?rmin`/`?rmax`, `?sort=field:dir` (`title:asc`
  normalizes to absent). Every edit uses `router.replace` — the URL always mirrors state
  (deep-linkable/shareable) while Back/Forward cross PAGES, not individual filter edits.
  **Tab switch keeps ONLY `?tab`** (fresh start per tab; the tab-keyed remount re-reads the
  cleaned URL) — a Movies filter can never leak into TV/Music.
- **Chip bar = a permanent filter rail**: one chip per facet, always mounted — empty chips are
  ghost pills (the add-affordance), active chips carry the OR-ed CSV + ✕. The bar is a
  **fixed-height single row that pans horizontally** when crowded (the mobile filter-rail
  pattern) — it can never wrap/grow, so the grid below never shifts; the same pattern serves
  the sort bar. Editors overlay via D-10's fixed positioning.
- **Rating range = a bounded chip** (host glue wearing the shared `hnet-` chip skin): a
  Min/Max select pair → `ratingMin`/`ratingMax`, CSV label `≥ 7` / `≤ 9` / `7–9`. **On ALL tabs**
  (**superseded 2026-07-06** the original "Movies tab only" judgment call): D-09's rating filter
  now compares `COALESCE(imdb_rating, tmdb_rating)`, so the single Sonarr/Lidarr community rating
  (which lands in `tmdb_rating`, ADR-018 C-07) filters too — the chip is a live control on TV and
  Music, not a dead one. The editor hint reads "Rating, 0–10" (no longer IMDb-specific).
- **Sort control**: pill buttons on the ported `nextSort`/`arrowFor`. Each column cycles
  best-first → reversed → default (`title:asc`); "best-first" = desc for Rating/Added/Plays/
  Watched/Runtime, asc for Title. The **Rating column maps to `imdb_rating` on Movies and
  `tmdb_rating` on TV/Music** (the single Sonarr/Lidarr community rating lives in the tmdb
  slots — ADR-018 C-07); **Music drops Runtime** (artists have none, D-02). Every button
  reserves a fixed-width arrow slot so the ▲/▼ appearing never nudges neighbors (ADR-015,
  the ConfirmButton reserve-the-widest idiom).
- **Loading states**: initial load renders a grid of skeleton 2:3 poster boxes (identical
  geometry); a filter/sort refetch keeps the previous grid rendered and dims it
  (`placeholderData` + `.is-refreshing`) — results swap in place, nothing collapses.
- **Infinite scroll**: an IntersectionObserver sentinel (600px lookahead) on the Load-more
  row pulls the next keyset page; the button remains as the visible/manual + a11y fallback.
- **Grid geometry** (densified per owner feedback 2026-07-06 — posters tell media apart at a
  glance, not hero display): `auto-fill minmax(132px, 1fr)`, gap 12px (**≈9 columns at 1440px**,
  was ≈6 at 190px), pinned to exactly **3 columns ≤480px** (was 2). The card caption slims to a
  **single-line title with an ellipsis** (the trailing year truncates with it) and a slimmer
  badge row — the **kind badge is dropped** (the active tab already names the kind), leaving the
  rating star + on-disk state (smaller). The card rating badge shows IMDb first, else TMDb
  (`★ 7.7`, source on the tooltip). The 2:3 reserved boxes + KindIcon fallback are unchanged (ADR-015).
- **Detail**: the head swaps the kind icon for the 96px poster box + a runtime·resolution
  meta line; the About card (ratings pills with vote-count tooltips, watch/added facts,
  genre/requester/collection chips) renders only when there is harvested content to show.
  Since `ledger.detail.metadata` is now the always-object shape (fix 2026-07-06), that gate is a
  **content predicate** (`hasAbout` — any rating / watch fact / added date / chip present), not
  the old `metadata !== null` object check (dead under the normalized shape). Its facts `<dl>` is
  `.about-facts`, NOT a second `.meta-grid` — the Details section owns that class and the
  e2e suite targets it singularly.

### D-12 — env contract (deploy-time — NOT this plan)

All metadata sources are OPTIONAL and skip-if-absent (the app + harvest boot cleanly with none
set — local-dev default). Added commented to root `.env.example`.

| Env var | Purpose | Default | Secret? |
|---------|---------|---------|---------|
| `TAUTULLI_API_KEY` | HaynesOps Tautulli | url `http://tautulli.media.svc.cluster.local:8181` | yes (1P homepage) |
| `TAUTULLI_K8PLEX_API_KEY` | HaynesKube Tautulli | url `http://tautulli-k8plex.media.svc.cluster.local:8181` | yes |
| `TAUTULLI_HAYNESTOWER_API_KEY` + `TAUTULLI_HAYNESTOWER_URL` | legacy external Tautulli | no cluster default | yes |
| `TMDB_API_READ_ACCESS_TOKEN` (v4) or `TMDB_API_KEY` (v3) | TMDB fallback | `https://api.themoviedb.org` | yes (1P, staged 2026-07-05) |
| `TVDB_API_KEY` | TVDB fallback | `https://api4.thetvdb.com` | yes |
| `MAINTAINERR_URL` / `MAINTAINERR_API_KEY` | Maintainerr props | `http://maintainerr.media.svc.cluster.local:6246` | key optional |

ExternalSecret plan: add the Tautulli×3 + TMDB + TVDB + Maintainerr keys to `haynesnetwork-secret`
(they exist in the `HaynesKube` / homepage 1Password items) feeding the app + the `sync-metadata`
CronJob (`15 */6 * * *`, `concurrencyPolicy: Forbid`).

### D-13 — poster route

See ADR-019 / D-06.

### D-14 — e2e stubs

Extend `stub-arr` with the MediaCover route (serves a checked-in 1×1 PNG for any
`/mediacover/**/poster-250.jpg`), `ratings`/`images`/`genres`/`runtime` on the series/movie
resources, and the `/movie|/series|/artist/lookup` routes. Add `stub-tautulli` (`/api/v2`
get_history/get_metadata) — **optional-env**, NOT wired into the default stack, so the existing
specs are unaffected. Seed `media_metadata` through `upsertMediaMetadataBatch` in `seed-ledger`.
Backend contract spec `poster-proxy.spec.ts` (authed image, unknown→404, unauth→401). The grid/
filter e2e journeys landed with D-10/D-11 (`library-grid.spec.ts`, 8 specs): poster streaming via
the proxy + KindIcon fallback, the genre-chip and bounded-rating journeys (result set changes, no
reflow — geometry asserted), the sort cycle, deep-link restore, tab-switch reset, the untouched
Music tab, and the 390×844 pass (2-column grid, single-row chip bar, viewport-clamped popover).
`seed-ledger.ts` gained a second radarr movie (`Stub Runner`, disjoint genres/requester/rating)
so a filter/sort visibly CHANGES the result set.

## Alternatives considered

- Columns on `media_items` vs the separate table — see ADR-018 (rejected: sync bloat, Restore
  preview pollution).
- PVC/`sharp` and Postgres `bytea` posters — see ADR-019 (rejected: storage/backup/complexity).
- Quality-PROFILE-name resolution derivation — shipped first, then **rejected** on live
  validation (2026-07-06): every live profile is a range ("Any"/"FHD-UHD"/"HD - 720p/1080p"), so
  it mapped ALL 17,713 rows to `'unknown'`. Replaced by real per-item derivation (D-02): Radarr's
  inline `movieFile` (free) + Sonarr's per-series `episodefile` (cheap, ~16 ms/req in-cluster).
  The originally-feared "per-item file fetch across ~17.7k items" cost turned out not to apply —
  Radarr embeds the file inline, and Sonarr is a per-SERIES (1026) loop, not per-episode.
- A per-series concurrency pool for the Sonarr episodefile loop — unnecessary: the serial loop is
  ~17 s in-cluster, far inside the 6 h cadence (D-02). Kept serial (simpler, gentler on Sonarr).

## Test strategy

Unit: the pure metadata mappers + tag parsing + watch-stat SUM/MAX merge
(`packages/sync/__tests__/adapt-metadata.test.ts`), the single writer + CHECK constraints
(`packages/domain`/`packages/db`), the *arr `/lookup` + Tautulli clients
(`packages/arr/__tests__/metadata-clients.test.ts`). Integration: the `ledger.search` sort/filter
+ **keyset across the null boundary in both directions** + `filterFacets`
(`packages/api/__tests__/ledger-metadata.test.ts`). Component: the ported filter-engine suite
runs verbatim in `@hnet/ui` (`src/filters/*.test.*` — jsdom via per-file docblocks, D-10). e2e:
the stubs above + the poster-proxy contract spec + the D-10/D-11 grid/filter journeys
(`library-grid.spec.ts`, see D-14).

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-09 | Backfill real per-file resolution (vs profile-derived) | **Resolved** (live-validation fix 2026-07-06): the harvest now reads Radarr `movieFile.quality.quality.resolution` (inline) + Sonarr per-series `episodefile` dominant tier; Lidarr → null. Profile-derivation retired (mapped every live row to 'unknown'). See D-02. |
| Q-10 | Dedupe one account watching a title on two servers | Deferred — SUM across servers is the current signal (PLAN-006 refines if needed). |
