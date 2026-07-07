# DESIGN-009: Ledger section — spreadsheet browse + bulk Add-&-search + emergency export

- **Status:** Draft
- **Last updated:** 2026-07-07
- **Satisfies:** PRD-001 new **R-74..R-78**, **US-09**, **AC-11..AC-13** (R-56 reframed — see
  ADR-022 C-04); governed by **ADR-021** (section-level role permissions) + **ADR-022**
  (generalized `*arr` add + export + fileless reframe); reuses **ADR-018 / DESIGN-008 D-09**
  (the shared filter/sort/keyset contract) and **DESIGN-005 D-16/D-17** (Restore / search).
  Bounded contexts DDD-002 **BC-02 Entitlements** (Section Permission) + **BC-03 Media Ledger**
  (browse / bulk add / export). **Companions:** DESIGN-005 (ledger + Restore), DESIGN-008
  (metadata + filter engine), DESIGN-004 (UI shell / nav), ADR-014 (Modal confirm), ADR-015
  (no reorientation).

> **Split note (2026-07-06, Fable 5 autonomous run).** This plan's **backend vertical** —
> the `role_section_permissions` schema + enums + migrations (0013/0014), the
> `setSectionPermission` single-writer + session hydration + `sectionProcedure` gate, the
> generalized `executeArrAdd`, the `ledgerAdmin` tRPC surface (browse / bulkAddAndSearch /
> run / runs), the JSONL export route, the guard/test additions, and the e2e stubs — **landed
> on this branch first.** The **UX layer** — **D-08** (the `/ledger` page, Movie/TV/Music
> tabs, the filter table bound to `ledgerAdmin.browse`, the selection actions bar, the Modal
> confirm + per-item report, and the `/admin/roles` section-access editor) — **landed as the
> follow-up UX change on the same branch** (Fable UX agent, 2026-07-06); D-08 below records
> the as-built decisions.

## Overview

A new top-level **Ledger** section in the primary nav with **Movie / TV / Music / Runs**
sub-tabs (the fourth — run history — added on owner feedback 2026-07-07, D-08). Each media
tab is a spreadsheet-style view built on the **shared `@hnet/ui` filter engine** (DESIGN-008,
T-58) over `media_items` — **everything that ever was or is on the server**: live rows AND
tombstoned rows (`deleted_from_arr_at` set, T-41). It surfaces all harvested metadata
(DESIGN-008 columns; no posters here — TODO #5). After filtering, an **Edit**-level user can
**(a)** bulk **Add & search** the set in the matching `*arr` and **(b)** **export** the set to
disk. Access is per-role at the **section** level (Edit / Read-Only / Disabled — ADR-021).

## D-01 — Nav + routing (UX)

> **Amended by ADR-032 (2026-07-07 / DESIGN-004 D-16):** the Ledger entry moved from
> `.topbar__nav` into the **user menu** (role-gated menuitem), and the section's no-row
> default flipped to **`disabled`** — out of the box only admins see it. The level gating,
> route gate, sub-tabs, and everything below are otherwise unchanged.

`/ledger` is a top-level entry in `.topbar__nav` (DESIGN-004 D-11, between Library and My Plex),
with Movie/TV/Music/Runs sub-tabs via `?tab=` (WAI-ARIA tablist, default Movies — mirrors
`/library`; `runs` is the run-history destination, D-08).
The nav entry and the route are rendered **only when the caller's Ledger section level ≠
`disabled`** (client-hidden nav + server-enforced route). The section level is read off the
session (`role.sectionPermissions.ledger`, D-02) — no extra query. A **Disabled** caller who
navigates to `/ledger` directly gets a clean **"not available on your account"** page state
(the server page gate — `apps/web/app/(app)/ledger/page.tsx`), never a raw error; the tRPC
surface additionally rejects them (AC-13).

## D-02 — Section-permission model (shipped; ADR-021)

A role carries one access **level** per top-level section (`role_section_permissions`, D-03).
Levels: **Edit** (full), **Read-Only** (browse + export, no mutation), **Disabled** (section
hidden). The default with no row is **`read_only` for `ledger`** (Q-03), **`disabled` for
`trash`** (reserved for PLAN-006). **Admin implies Edit everywhere** with no rows (ADR-021 C-03).

- **Session:** `SessionRole` gains `sectionPermissions: Record<SectionId, Level>`, resolved in
  `getSessionExtension` (one extra query for non-admins; admin short-circuits to all-`edit`).
- **Gate:** `sectionProcedure(sectionId, minLevel)` composes `authedProcedure` and returns
  `FORBIDDEN` below `minLevel` (`disabled < read_only < edit`; admin passes). Browse/export/run
  gate at `read_only`; bulkAddAndSearch gates at `edit`. **Server-authoritative** — a Read-Only
  caller is _unable_ to invoke the mutation, not merely not shown it (AC-13).
- **Writer:** `setSectionPermission` (`@hnet/domain`) upserts the level + co-writes an
  `update_section_permission` `permission_audit` row in the same tx; the Admin role is immutable
  (`ROLE_IMMUTABLE`).

## D-03 — Schema (shipped)

`role_section_permissions` — `role_id` (FK `roles.id`, cascade), `section_id` (CHECK
`SECTION_IDS`), `level` (CHECK `SECTION_PERMISSION_LEVELS`), `created_at`/`updated_at`, composite
PK `(role_id, section_id)`. Migration **0013** creates it and rebuilds the `permission_audit.action`
CHECK for `update_section_permission`. Migration **0014** adds `restore_runs.reason`
(`NOT NULL DEFAULT 'restore'`, CHECK `ARR_ADD_REASONS`). Both are on the `no-direct-state-writes`
guard list.

## D-04 — Browse query surface (shipped)

`ledgerAdmin.browse` — `sectionProcedure('ledger','read_only')`. Delegates to the **EXACT same**
WHERE/keyset assembly as `ledger.search` (the shared `buildLibraryWhere` + `SORT_SPECS` + the
NULLS-LAST keyset cursor — DESIGN-008 D-09), so the filter DSL never forks. Differences:

- **`includeTombstoned` is FORCED true** — the Ledger is "everything that ever was on the server".
- Adds the **Ledger-only filter dims**: `monitored?: boolean` and
  `hasFile: 'any' | 'none' | 'some' | 'all'` (the completeness facet — `none` + `monitored:false`
  is exactly the **Fileless Set**, T-66, D-07).
- Returns the **spreadsheet columns**: title, year, kind, monitored, on-disk grain
  (`onDiskFileCount`/`expectedFileCount`/`sizeOnDisk`), `tombstonedAt`, quality profile, root
  folder, `arrTags`, external ids (`tvdbId`/`tmdbId`/`imdbId`/`musicbrainzArtistId`), the harvested
  `metadata` block (votes/ratings/genres/watch-stats/requesters/source-collections — DESIGN-008),
  poster URL, `addedAt` (`first_seen_at`), `lastSyncedAt` (`last_seen_at`).
- `ledger.filterFacets` is reused **as-is** for the chip values (genres / resolutions /
  requesters / source-collections), scoped per `arrKind` tab. **Music is included** (Q-04) — the
  lidarr add/monitor/search plumbing already exists; year is nullable.

## D-05 — Bulk Add-&-search (shipped; ADR-022)

`ledgerAdmin.bulkAddAndSearch` — `sectionProcedure('ledger','edit')`. Input = explicit
`mediaItemIds` (min 1, **max 1000**) + `searchOnAdd` (default true). Delegates to
`executeArrAdd({ reason:'ledger_add', searchOnAdd })` with the three per-item outcomes
(absent → add + search; present-unmonitored → monitor-flip + search; present-monitored → skip —
ADR-022 C-01). Returns `{ runId, status }`; the per-item report (AC-11) is read via
`ledgerAdmin.run` (and browsed via `ledgerAdmin.runs`), **scoped to `reason='ledger_add'`** so
the section never surfaces failsafe Restore runs. Over-cap selections reject
(`ARR_ADD_SEARCH_CAP_EXCEEDED`) before any `*arr` call.

`ledgerAdmin.runs` (read_only gate, like `run`) lists the newest 100 runs and, since the Runs
tab (D-08, 2026-07-07), takes an **optional `arrKind`** so the tab's media-type filter narrows
**server-side** — the newest-first window and the filter always agree (a client-side trim of a
fixed page could hide older runs of the filtered kind). Each row carries a **server-computed
outcome summary** (`added` / `monitored` / `skipped` / `failed` — the same D-05 classification
the web report applies: `ok`+`outcome` decide success, `'skipped:'`-prefixed errors are skips,
error text on an ok row is only a search caution) instead of the raw per-item `results` jsonb,
so the list stays light; the expanded report still reads `run({id})`.

**Best-effort search / report semantics (ADR-022):** the add-or-monitor is the durable outcome;
the follow-on search is best-effort. A per-item result can therefore be `ok:true` **and still
carry `error`/`searchError` text** (the add succeeded but the search command failed — the item is
`searched:false`, no `search_requested` event). The report UX must key success off **`ok`**
(item added/monitored) and the search badge off **`searched`** — **never** treat error-text
presence as failure, or an added-but-search-throttled item reads as a false failure.

## D-06 — Export (shipped; ADR-022 C-03)

`GET /api/ledger/export` — a Next route handler, session-gated + **section-gated to Read-Only+**
(mirrors the poster route's auth pattern; Disabled → 403). Parses the current filter from query
params (tombstone gate forced open), then **streams deterministic JSONL** — one round-trippable
object per row (`{ kind, title, year, tmdbId, tvdbId, musicbrainzArtistId, qualityProfileName,
rootFolder, tags, monitored, onDisk, tombstonedAt }`), ordered `(sort_title, id)`,
keyset-paginated server-side (bounded memory), with a `content-disposition` attachment. No `*arr`
write.

## D-07 — The Fileless Set, not an import (shipped; ADR-022 C-04)

Draft R-56's "import the radarr fileless backlog as tombstoned rows" is **dropped**: a live probe
found all 4,008 backlog ids already exist as live Radarr rows (3,910 unmonitored, 3,971 no-file),
with `imdb_votes` present for ~99%. The backlog's need is met by **browse filters**
(`monitored:false` + `hasFile:'none'` + vote tiers + facets — D-04) plus the `ledger_add` bulk
action (D-05). **T-66 Fileless Set** names that filterable _state_, not an import. Batch by vote
tier to stay under the 1000-item search cap.

## D-08 — UI (shipped; ADR-014 / ADR-015)

`/ledger` is built against the D-04/D-05/D-06 contracts and D-02's session map
(`apps/web/app/(app)/ledger/` — a server page gate + the `ledger-client.tsx` browser). As built:

- **Table:** a spreadsheet — sticky header row + frozen select/Title columns inside ONE
  internally-scrolling pane (`.ledger-tablewrap`, both axes; the page body never scrolls
  horizontally — hard rule 9). Columns = D-04's set (Title→`/library/[id]`, Year, Monitored ✓/—,
  on-disk grain `x/y`, Size, Quality profile, Root, Rating ★ null-safe, Votes, Requesters,
  Collections, Removed-at, Added). Sortable headers (shared `nextSort`/`arrowFor` cycle) for the
  D-09 fields the sheet shows: Title, Rating (`imdb_rating` on Movies / `tmdb_rating` on
  TV+Music — ADR-018 C-07), Added (`added_at`). Keyset infinite scroll inside the pane;
  refetches dim the previous rows in place (ADR-015 — no collapsing spinner).
- **Filter bar:** the exact `/library` chip engine + URL contract (`q/genre/res/req/col/rmin/
rmax/sort`) PLUS the Ledger-only dims as **single-select chips** over the same `FilterChip`
  skin (onAdd replaces — a radio in checklist clothing): **Monitored** ↔ `?mon=yes|no` and
  **Has file** ↔ `?file=none|some|all` (absent = any). Deep-linkable; tab switches keep only
  `?tab`. The shared `RatingChip`/chip copy moved to `apps/web/components/filter-chips.tsx`.
- **Selection + actions bar:** row checkboxes + page-level select-all (edit level only —
  Read-Only gets no selection column) feed a **persistent** actions bar: "N selected" · Clear ·
  **"Export filtered (M rows)"** · **"Monitor & search…"**. Constant-width controls and an
  always-rendered bar mean selection recolors/recounts but never reflows (ADR-015). The export
  count is honest under keyset paging: exact when fully loaded, `M+` while pages remain (browse
  has no COUNT — deliberate).
- **Monitor & search:** the bar button opens a **`Modal`** (explanatory confirm — ADR-014 /
  hard rule 8) stating the three per-item outcomes (absent → add+search; present-unmonitored →
  monitor+search; monitored → skip), a `searchOnAdd` toggle (default on), and a blocking
  over-cap alert above 1000 items (guides batching by filter tier). Submit →
  `ledgerAdmin.bulkAddAndSearch` → the same Modal renders the per-item report from
  `ledgerAdmin.run` (AC-11): added/monitored/skipped/failed badges keyed off
  **`ok`/`outcome`**, the search badge off **`searched`** (never off error text — D-05).
  Titles for skipped items come from a submit-time selection snapshot (skips are persisted
  without titles and never enter `preview`).
- **Runs tab (owner feedback 2026-07-07):** run history is a **fourth sub-tab** — originally a
  "Recent runs" card BELOW each media tab's spreadsheet, which meant scrolling the whole ledger
  to reach it; the media tabs now end at the sheet. The tab lists **all** `ledger_add` runs
  newest-first (one row per run: when · media kind · status badge · the D-05 outcome counts ·
  initiator) with an **All / Movies / TV / Music** single-select pill filter riding
  `?kind=` (URL-held like every Ledger dim; tab switches keep only `?tab`) and passed to
  `ledgerAdmin.runs` as `arrKind` (server-side narrowing — D-05). Each row's header is an
  expand toggle: the per-item report (`ledgerAdmin.run`, the same `RunReport` rendering the
  post-submit Modal uses) opens **in place** below it — a sanctioned ADR-015 expansion (like
  the catalog inline editor); filter switches dim the list in place (`placeholderData`), never
  collapse it. The tab is visible at **Read-Only** (runs read at `read_only`, matching
  `run`/`runs` — AC-13); only the run-creating bulk action on the media tabs is edit-gated.
  Runs are synchronous, so fetch-on-load suffices (no polling).
- **Export:** a plain `<a download>` to `/api/ledger/export?…` mirroring the CURRENT filter
  (AC-12) — the FILTER, never the selection (the label + tooltip say so).
- **Read-Only behavior:** the Monitor-&-search control and the selection column are **absent**
  (export stays); the server also rejects the mutation (AC-13). **Disabled:** no nav entry; the
  route renders the D-01 "not available" state.
- **`/admin/roles`:** a per-role **Ledger** access column (Edit/Read-Only/Disabled
  `<select>`, applies on change; PLAN-006 adds Trash rows) wired to
  `roles.setSectionPermission`; the Admin row shows its implicit **Edit**, uneditable (C-03).
  `roles.list` already returns each role's `sectionPermissions`.

## Open decisions (resolved)

- **Q-01 (export format):** deterministic **JSONL** (ADR-022 C-03).
- **Q-02 (fileless mapping/dedup/synthetic keys):** **N/A** — the import is dropped (ADR-022 C-04);
  the Fileless Set is a filter state (D-07), not rows.
- **Q-03 (default section level):** **Ledger = Read-Only** for authed non-admins (ADR-021 C-01).
- **Q-04 (music):** **included** — add/monitor/search + export cover Lidarr (D-04/D-05).
