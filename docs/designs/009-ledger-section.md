# DESIGN-009: Ledger section — spreadsheet browse + bulk Add-&-search + emergency export

- **Status:** Draft
- **Last updated:** 2026-07-06
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
> on this branch.** The **UX layer** — **D-08** (the `/ledger` page, Movie/TV/Music tabs, the
> filter table bound to `ledgerAdmin.browse`, the selection actions bar, the Modal confirm +
> per-item report, and the `/admin/roles` section-access editor) — is the **follow-up UX
> change** (Fable UX agent) built against the shipped contracts below.

## Overview

A new top-level **Ledger** section in the primary nav with **Movie / TV / Music** sub-tabs. Each
tab is a spreadsheet-style view built on the **shared `@hnet/ui` filter engine** (DESIGN-008,
T-58) over `media_items` — **everything that ever was or is on the server**: live rows AND
tombstoned rows (`deleted_from_arr_at` set, T-41). It surfaces all harvested metadata
(DESIGN-008 columns; no posters here — TODO #5). After filtering, an **Edit**-level user can
**(a)** bulk **Add & search** the set in the matching `*arr` and **(b)** **export** the set to
disk. Access is per-role at the **section** level (Edit / Read-Only / Disabled — ADR-021).

## D-01 — Nav + routing (UX)

`/ledger` is a top-level entry in `.topbar__nav` (DESIGN-004 D-11), with Movie/TV/Music sub-tabs
via `?tab=` (WAI-ARIA tablist, default Movies — mirrors `/library`). The nav entry and the route
are rendered **only when the caller's Ledger section level ≠ `disabled`** (client-hidden nav +
server-enforced route). The section level is read off the session (`role.sectionPermissions.ledger`,
D-02) — no extra query.

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
  caller is *unable* to invoke the mutation, not merely not shown it (AC-13).
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
action (D-05). **T-66 Fileless Set** names that filterable *state*, not an import. Batch by vote
tier to stay under the 1000-item search cap.

## D-08 — UI (follow-up UX change; ADR-014 / ADR-015)

The Fable UX agent builds `/ledger` against the D-04/D-05/D-06 contracts and D-02's session map:

- **Table:** the `@hnet/ui` filter engine (T-58) bound to `ledgerAdmin.browse` per `arrKind` tab;
  the column set is D-04's spreadsheet columns (no posters — TODO #5). Chip bar from
  `ledger.filterFacets`; the Ledger-only `monitored` + `hasFile` dims are extra chips/toggles.
- **Selection model:** row checkboxes → a selection set feeding the actions bar. Selection toggles
  **color/emphasis only** — it must NOT reflow neighbors (ADR-015); the actions bar reserves its
  width so arming the confirm can't shift layout.
- **Actions bar:** **"Add & search in {Radarr/Sonarr/Lidarr}"** → a **`Modal`** (multi-field /
  explanatory confirm — ADR-014 / hard rule 8; NOT `ConfirmButton`, NOT `window.confirm`)
  summarizing "adds N monitored to {arr}, monitors present-but-unmonitored, triggers search",
  then renders the per-item report from `ledgerAdmin.run` (AC-11). **"Export list"** → a plain
  download from `/api/ledger/export` with the current filter (AC-12). The Modal warns when a
  selection exceeds the 1000 search cap and guides batching by tier.
- **Read-Only behavior:** the Add-&-search control is **absent** (export stays); the server also
  rejects the mutation (AC-13). **Disabled:** no nav entry, route redirects.
- **`/admin/roles`:** a per-role **Section access** editor (Ledger: Edit/Read-Only/Disabled
  `<select>`; PLAN-006 adds Trash rows) wired to `roles.setSectionPermission`; `roles.list` already
  returns each role's `sectionPermissions`.

## Open decisions (resolved)

- **Q-01 (export format):** deterministic **JSONL** (ADR-022 C-03).
- **Q-02 (fileless mapping/dedup/synthetic keys):** **N/A** — the import is dropped (ADR-022 C-04);
  the Fileless Set is a filter state (D-07), not rows.
- **Q-03 (default section level):** **Ledger = Read-Only** for authed non-admins (ADR-021 C-01).
- **Q-04 (music):** **included** — add/monitor/search + export cover Lidarr (D-04/D-05).
