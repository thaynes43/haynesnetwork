# PLAN-005: Ledger section — spreadsheet browse + bulk Add-&-search + emergency export

- **Status:** Draft _(Fable 5 flips Draft → Executing → Completed)_
- **Satisfies:** PRD-001 **R-53..R-57** (new; R-54 generalizes R-50..R-52 Restore), **US-09**, **AC-11..AC-13**; new **ADR-016** (section-level Role permissions) + **ADR-017** (generalized *arr add + export); new **DESIGN-007** (Ledger section)
- **Depends on:** **PLAN-004** — the demo-console `packages/shared/filters` engine ported into `@hnet/ui` (the ONE filter/table engine; DESIGN-006 keeps our own look), and the harvested/enriched metadata columns on `media_items` that the Ledger sorts/filters by
- **TODO source:** #5 of `.agents/plans/TODO.md`
- **Coordinates with:** **PLAN-006** (Trash) — 005 is lower-numbered and executes first, so **005 authors the shared section-permission ADR/DDD/table** (ADR-016) and 006 reuses it; 005 leaves `/admin/restore` intact (its re-add power now lives on in the Ledger), **006 removes the Restore nav** per its own plan

---

## Goal

A new **top-level "Ledger" section** in the primary nav (`.topbar__nav`, DESIGN-004 D-11)
with **Movie / TV / Music** sub-tabs (same tab mechanism as `/library`, DESIGN-004 D-11).
Each tab is a spreadsheet-style view built on the **ported `@hnet/ui` filter engine** (PLAN-004)
over `media_items` — **everything that ever was or is on the server**: live rows, tombstoned
rows (`deleted_from_arr_at` set — T-41), and the imported **radarr fileless backlog** (4008
deleted snapshot rows from `.agents/plans/radarr-fileless-backlog.md`). It shows all harvested
metadata (PLAN-004 columns); missing metadata for non-`*arr` rows is filled via the PLAN-004
lookup path (no posters here — TODO #5). After filtering, an Edit-level user can:

- **(a) Add & search in the corresponding `*arr`** — the native disaster-recovery restore:
  select the filtered set → add monitored with recorded profile/root/tags → trigger search.
  This **generalizes `executeRestore`** (`packages/domain/src/restore-flow.ts:273`).
- **(b) Export the filtered set to disk** as an emergency Radarr/Sonarr/Lidarr list.

Access is per-role at the **section** level: **Edit / Read-Only / Disabled** (Disabled hides
the whole section; Read-Only hides the mutation, keeps browse + export). This is the shared
Section-Permission model 006 reuses for Trash.

---

## Docs-first artifacts to author (same PR as the behavior)

### PRD-001 (`docs/prds/001-haynesnetwork.md`)
Add under "Media ledger & fix (Phase 2)" (after R-52, before the R-60 platform block):

- **R-53** — A top-level **Ledger** section, Movie/TV/Music sub-tabs, spreadsheet-style over
  the high-powered filters (R-5x cross-ref to PLAN-004), listing **every** ledger row (live +
  tombstoned + imported fileless backlog) with all harvested metadata.
- **R-54** — From a filtered Ledger set, an authorized user can **bulk Add & search** the items
  in the matching `*arr` (monitored, recorded quality profile / root folder / tags, then search).
  _Generalizes R-50..R-52: Restore is the admin-only, diff-driven special case of this action._
- **R-55** — The filtered Ledger set is **exportable to disk** as an emergency
  Radarr/Sonarr/Lidarr import list (deterministic format) for catastrophic-failure recovery.
- **R-56** — The **radarr fileless backlog** (`.agents/plans/radarr-fileless-backlog.md`) is
  imported into the ledger as tombstoned rows so deleted-but-recorded titles are browsable/restorable.
- **R-57** — **Section-level role access**: each role has an access level per top-level section —
  **Edit** (full), **Read-Only** (browse/export, no mutations), **Disabled** (section hidden).
  Applies to Ledger now; Trash reuses it (PLAN-006).
- **US-09** — "As a household admin, last week's disk sweep removed 200 movies; I open Ledger →
  Movies, filter to `removed in the last 7 days`, select all, **Add & search in Radarr**, and
  also **Export** the list as a backup." → AC-11, AC-12.
- **AC-11** — A bulk Add-&-search over N filtered items adds exactly those absent from the live
  `*arr` (monitored, stored profile/root/tags), triggers search, and reports per-item success/skip/fail.
- **AC-12** — Export produces a deterministic file listing exactly the filtered set with the
  external ids needed to re-import into the target `*arr`.
- **AC-13** — A role set to **Disabled** for Ledger never sees the nav entry or route; **Read-Only**
  sees browse + export but no Add-&-search control (server-enforced, not just hidden).

### ADRs (MADR 3.0 — Fable 5 authors AND ratifies → Accepted)

- **ADR-016 — Section-level Role Permissions (Edit/Read-Only/Disabled).**
  - **C-01** Decision: a role carries one access **level** per **section id** in a new
    `role_section_permissions` table (`role_id`, `section_id`, `level`), NOT a boolean or an
    app-grant. `section_id` and `level` are const-array enums in `enums.ts` (single source of
    truth for TS + SQL CHECK — the CLAUDE.md/enums convention). Default (no row) = a documented
    fallback per section (Ledger default = **Read-Only** for authed users; decide + record).
  - **C-02** Written by a `@hnet/domain` single-writer that co-writes a `permission_audit` row in
    the same tx (CLAUDE.md hard rule 6). Session (`@hnet/auth`) is extended to carry the caller's
    section levels so nav + `sectionProcedure` gating need no extra query (mirrors
    `middleware/role.ts:6` reading `ctx.user.role.isAdmin`).
  - **C-03** Admin (`roles.is_admin`) implies **Edit** on every section (no rows needed), same as
    the implicit all-apps rule (`roles.ts` / T-49).
  - **Shared with PLAN-006:** Trash adds its own `section_id` value(s) and (per its plan) a
    finer per-action model layered on top; 005 owns the base table/enum/writer/session wiring.

- **ADR-017 — Generalize Restore into `executeArrAdd` + emergency export contract.**
  - **C-01** `packages/domain/src/restore-flow.ts` `executeRestore` (currently searches-OFF, Q-04)
    is generalized into an `executeArrAdd` orchestrator taking an explicit id list + a
    **`searchOnAdd`** flag + an **initiation reason** (`restore` | `ledger_add`). Restore becomes
    `executeArrAdd({ searchOnAdd: false, reason: 'restore' })`; Ledger bulk-add is
    `executeArrAdd({ searchOnAdd: true, reason: 'ledger_add' })`. The re-add mechanics
    (`fetchLiveTargetState`, `resolveTagIds`, `addItemToArr`, fresh-diff TOCTOU re-validation,
    per-item report) are unchanged; only search-command triggering + the run's `reason` are added.
  - **C-02** The durable record stays the `restore_runs` row (rename conceptually to "arr-add runs"
    in DDD; **keep the table name** to avoid a rename migration — decide + record). Add a `reason`
    column (enum) so the report distinguishes Restore vs Ledger-add. The audited write-back stays
    `recordRestoreResult` (`restore-runs.ts:66`) — clears tombstone + writes the `restored` ledger
    event; add a `search_requested` ledger event when `searchOnAdd` (reuse the T-44 event type).
  - **C-03** Export format: a deterministic, `*arr`-round-trippable list (candidate: newline JSON
    of `{ title, year, externalId, qualityProfileName, rootFolder, tags }`, or a Radarr/Sonarr
    "custom list" JSON). Fable 5 decides the concrete format (Q-01 below) and records it here.

### DDD / glossary (`docs/domain-driven-design/`) — normative, same change
- `001-ubiquitous-language.md`: **T-50 Ledger Section** (the top-level Movie/TV/Music browse over
  the whole ledger incl. tombstones + fileless import; the home of bulk Add-&-search + export —
  supersedes the admin-only Restore page as the re-add surface); **T-51 Section Permission**
  (a role's Edit/Read-Only/Disabled level for a top-level section; `role_section_permissions`);
  **T-52 Fileless Backlog Import** (the one-time load of `radarr-fileless-backlog.md` into
  `media_items` as tombstoned radarr rows). Amend **T-35 Restore** to note it is now the diff-driven
  special case of the generalized `executeArrAdd` (ADR-017). Add a changelog row.
- `002-bounded-contexts.md`: **Section Permission is BC-02 Entitlements** (a permission concern,
  alongside Effective Permissions); **Ledger browse / bulk add / export is BC-03 Media Ledger**
  (extends "admin Restore commands; ledger browse/search queries" at line ~81). Note the split.

### DESIGN-007 — Ledger section (NEW `docs/designs/007-ledger-section.md`, copy `000-template.md`)
- **D-01** Nav + routing: `/ledger` top-level entry in `.topbar__nav` (DESIGN-004 D-11 table gets a
  row), Movie/TV/Music sub-tabs via `?tab=` (WAI-ARIA tablist, default Movies — mirror `/library`).
  Rendered only when the caller's Ledger section level ≠ Disabled.
- **D-02** Query surface: a cursor-paginated filtered query over `media_items` scoped to one
  `arrKind` per tab, **including** tombstoned + fileless rows (the `ledger.search` route already
  has `includeTombstoned` — `ledger.ts:31,64`; the new route ships the full PLAN-004 filter DSL,
  keyset on `(sort_title, id)` like `ledger.ts:88`).
- **D-03** Bulk Add-&-search: selection → **Modal** (multi-field/explanatory confirm per ADR-014 —
  same class as the Restore confirm dialog, `restore/page.tsx`) summarizing "adds N monitored to
  {radarr}, triggers search"; calls the Edit-gated mutation; renders the per-item report (AC-11).
- **D-04** Export: **Read-Only-and-above** action → deterministic file download (AC-12; format per
  ADR-017 C-03). No `*arr` write.
- **D-05** Fileless import (T-52): mapping from the markdown line format + dedup rule (D below).
- **D-06** Section-permission gating: nav hidden when Disabled; Add-&-search control absent under
  Read-Only; server enforces via `sectionProcedure` (never client-only). No layout reorientation
  on selection/arming (ADR-015): selection toggles color/emphasis, the confirm reserves width.
- Enumerate **Q-01** export format, **Q-02** fileless mapping/dedup, **Q-03** default section level,
  **Q-04** music inclusion for add/export (see Open decisions).

---

## Data model (`packages/db`)

### Enums (`packages/db/src/schema/enums.ts` — single source of truth, TS + SQL CHECK)
```ts
export const SECTION_IDS = ['ledger', 'trash'] as const;        // 006 adds/uses 'trash'
export type SectionId = (typeof SECTION_IDS)[number];
export const SECTION_PERMISSION_LEVELS = ['edit', 'read_only', 'disabled'] as const;
export type SectionPermissionLevel = (typeof SECTION_PERMISSION_LEVELS)[number];
export const ARR_ADD_REASONS = ['restore', 'ledger_add'] as const;   // ADR-017 C-02
export type ArrAddReason = (typeof ARR_ADD_REASONS)[number];
```
Extend `PERMISSION_AUDIT_ACTIONS` (`enums.ts:10`) with **`update_section_permission`** (the
`permission_audit.action` CHECK is rebuilt in the migration — the enum array drives it).

### New table `role_section_permissions` (`packages/db/src/schema/role-section-permissions.ts`)
Columns: `role_id` (FK `roles.id`, cascade), `section_id` (enum CHECK), `level` (enum CHECK),
`created_at`/`updated_at`. Composite PK `(role_id, section_id)`. CHECK constraints built from
the SQL-list pattern in `media-items.ts:17` / `roles.ts`. Export from `packages/db/src/schema/index.ts`.

### `restore_runs` (`packages/db/src/schema/restore-runs.ts`) — add `reason` column
`reason text NOT NULL DEFAULT 'restore'` + CHECK from `ARR_ADD_REASONS` (ADR-017 C-02). Existing
rows backfill to `'restore'`. `RestoreRunRow`/report surface carry it.

### Fileless import target (`media_items`)
Insert imported rows as **radarr, tombstoned** (`deleted_from_arr_at = now()`), `monitored=false`,
`tmdb_id` from the `[tmdb NNNNN]` token, `title`/`year` parsed, external-id CHECK
(`media-items.ts:78`) satisfied. `media_items` requires NOT-NULL `arr_item_id` (unique per
`(arr_kind, arr_instance_id, arr_item_id)` — `media-items.ts:85`) + NOT-NULL
`quality_profile_id`/`quality_profile_name`/`root_folder` — imported rows need synthetic values;
**Q-02 decides** the synthetic `arr_item_id` scheme + `arr_instance_id` marker (candidate:
`arr_instance_id='fileless-import'`, `arr_item_id = -rowIndex`, `quality_profile_name='(imported)'`)
so a later real Radarr sync re-matches by `(arr_kind, tmdb_id)` and adopts the row.

### Migrations (`packages/db/migrations/` — next is `0009_*`)
- `0009_role_section_permissions.sql` — new table + CHECKs + rebuild `permission_audit.action` CHECK.
- `0010_arr_add_reason.sql` — `restore_runs.reason` column + CHECK + backfill.
- Fileless import is **data, not schema** (see Ops) — no migration.

### Guard-list updates (CI)
- `packages/domain/__tests__/no-direct-state-writes.test.ts` — add **`role_section_permissions`**
  to every FORBIDDEN_PATTERNS branch (INSERT/UPDATE/DELETE SQL + `.insert/.update/.delete`
  Drizzle forms, `roleSectionPermissions`) exactly as the Phase-2 tables were added (`:41-66`).
  `media_items` is already guarded, so the fileless import must run through a `@hnet/domain`
  single-writer.
- `packages/domain/__tests__/arr-write-import-guard.test.ts` — **no change**: `executeArrAdd`
  stays in `packages/domain`, so `@hnet/arr/write` is still domain-confined. Do NOT import
  `@hnet/arr/write` from the new router/UI.

---

## Domain (`packages/domain`)

- **`executeArrAdd`** (generalize `restore-flow.ts:273` `executeRestore`) — add `searchOnAdd:
  boolean` + `reason: ArrAddReason`; after a successful `addItemToArr` (`restore-flow.ts:209`),
  when `searchOnAdd`, trigger the owning `*arr`'s search command (reuse the search-command plumbing
  behind `search-flow.ts` / `action-scope.ts`; MoviesSearch/SeriesSearch/ArtistSearch) and record a
  `search_requested` ledger event. Keep the fresh-diff TOCTOU re-validation (`:278-317`) and the
  per-item report. `executeRestore` becomes a thin `executeArrAdd({searchOnAdd:false,
  reason:'restore'})` wrapper so `restore.ts` router + tests are untouched.
- **`recordRestoreResult`** (`restore-runs.ts:66`) — already clears the tombstone + writes the
  `restored` event in one tx; extend to also thread `reason` into the run and emit the
  `search_requested` event when searched (both in the same tx — hard rule 6).
- **`setSectionPermission`** (new single-writer) — upsert `role_section_permissions` + co-write a
  `permission_audit` (`action:'update_section_permission'`, before/after level in `detail`) in one
  `inTransaction`. Reject setting a level on the Admin role (implicit Edit — ADR-016 C-03) with a
  coded error (mirror `SystemRoleImmutableError`, `roles.ts:145`).
- **`importFilelessBacklog`** (new single-writer) — parse the markdown, insert tombstoned radarr
  rows via `.insert(mediaItems)` inside `inTransaction`, `onConflictDoNothing` on
  `(arr_kind, tmdb_id)` dedup (Q-02), and write one aggregate `permission_audit`/ledger marker
  row. Idempotent (re-runnable). Parser handles the D-05 line format:
  `Title (Year) — R/10, V votes [tmdb NNNNN]`.
- **`sectionLevelForRole`** helper (read; used by session build + `sectionProcedure`) — returns
  the role's level for a section, applying the Admin=Edit and no-row=default fallbacks (ADR-016 C-01/C-03).

Invariants: bulk add re-derives fresh `*arr` state (no TOCTOU — mirrors `restore-flow.ts:278`);
every guarded-table write (`media_items`, `restore_runs`, `role_section_permissions`,
`ledger_events`, `permission_audit`) is a `@hnet/domain` single-writer with its audit row in-tx.

---

## Client / integration

No new external system or write client. Bulk add reuses the existing `@hnet/arr` read + confined
`@hnet/arr/write` clients through `executeArrAdd` (import-confined — arr-write guard unchanged).
Search-command triggering reuses existing `@hnet/arr` command endpoints already used by
`search-flow.ts`. No new env/secret — `*arr` base URLs/keys come from the existing ExternalSecret
contract (reference names only; server-side base URLs are hard-rule-3 exempt).

`@hnet/auth` session: extend the `ctx.user.role` shape (built alongside `role.isAdmin`) to include
`sectionPermissions: Record<SectionId, SectionPermissionLevel>` so nav + `sectionProcedure` gate
without a per-request query (mirrors the `role.isAdmin` pattern, `middleware/role.ts:6`).

---

## API (`packages/api`)

- **`sectionProcedure(sectionId, minLevel)`** — new middleware factory in
  `packages/api/src/middleware/role.ts` (composes `authedProcedure` like `adminProcedure:6`):
  `FORBIDDEN` when the caller's level for `sectionId` is below `minLevel` (Disabled < Read-Only <
  Edit). Admin passes implicitly.
- **`ledgerAdmin` (or extend `ledger.ts`) router** — new procedures, all `sectionProcedure('ledger', …)`:
  - `browse` — `sectionProcedure('ledger','read_only')` query: the PLAN-004 filter DSL over
    `media_items` (one `arrKind`), `includeTombstoned` always true, keyset pagination
    (reuse `cursor.ts` + the `ledger.ts:37-110` where/keyset shape).
  - `export` — `sectionProcedure('ledger','read_only')` query/mutation returning the deterministic
    list payload for the current filter (AC-12; format per ADR-017 C-03). Streams/returns the file body.
  - `bulkAddAndSearch` — `sectionProcedure('ledger','edit')` mutation → `mapDomainErrors(() =>
    executeArrAdd({ …, searchOnAdd: true, reason: 'ledger_add', mediaItemIds }))`; returns
    `{ runId, status }` (mirror `restore.ts:38-58`). Cap the id list (`.max(10_000)` like `restore.ts:43`).
  - `run` — `sectionProcedure('ledger','read_only')` — the `restore_runs` report row filtered to
    `reason='ledger_add'` (reuse `restore.ts:61` projection).
- **`roles` router** (`roles.ts`) — add `setSectionPermission` (`adminProcedure` → domain
  `setSectionPermission`) and include each role's section levels in `roles.list` for the
  `/admin/roles` editor. `RoleInput`/`RolePatchInput` schemas gain the section-permission field.

---

## UI (`apps/web`)

- **Top-level nav:** add **Ledger** to `.topbar__nav` (DESIGN-004 D-11 primary nav, shown on
  phones). Entry rendered only when `sectionPermissions.ledger !== 'disabled'` (server-gated route
  + client-hidden nav).
- **`apps/web/app/(app)/ledger/page.tsx`** (`'use client'`) — Movie/TV/Music sub-tabs via `?tab=`
  (mirror `library/page.tsx` tablist); each tab renders the **`@hnet/ui` filter table** (PLAN-004)
  bound to `ledgerAdmin.browse` for that `arrKind`. Column set = harvested/enriched metadata
  (PLAN-004), no posters (TODO #5).
- **Selection actions bar:** **"Add & search in {Radarr/Sonarr/Lidarr}"** → **Modal**
  (`components/modal.tsx`) — multi-field/explanatory confirm (ADR-014 / hard rule 8; NOT
  `ConfirmButton`, NOT `window.confirm`), summarizing count + target + "monitored, will search",
  then the per-item report (AC-11). **"Export list"** → file download (AC-12).
- **Permission behavior:** Read-Only hides the Add-&-search control (export stays); Disabled → no
  nav, route redirects. Server is authoritative (AC-13).
- **`/admin/roles`** — add a per-role **Section access** editor (Ledger: Edit/Read-Only/Disabled
  `<select>`; 006 adds Trash rows) wired to `roles.setSectionPermission`.
- **No layout reorientation (ADR-015):** row selection + Modal arming change color/emphasis only;
  the actions bar reserves space; drag-drop is not used here. Toolbar/table use the ported engine's
  in-place expansion semantics (excepted by hard rule 9).

---

## Ops

- **No new 1Password / ExternalSecret / env.** `*arr` credentials come from the existing contract.
- **Fileless import execution:** a one-shot invocation of `importFilelessBacklog` (data load, not a
  migration). Fable 5 decides the mechanism (Q-02): a `pnpm --filter @hnet/db` seed-style script or
  a one-off `@hnet/domain` script run against staging post-deploy. Idempotent, so re-runnable.
- **e2e stub:** extend the existing `apps/web/e2e/support` `*arr` stub so `bulkAddAndSearch` (add +
  search command) is hermetic — assert the add POST and the search command hit the stub. LIVE
  validation hits the real `*arr`. Ledger browse/export need no external system (DB-only).

---

## Open decisions Fable 5 must make (authorized to decide + record as ADR C-NN / Q-NN)

- **Q-01 (export format)** — CSV vs newline-JSON vs a native Radarr/Sonarr "custom list"/import JSON.
  Prefer a format that round-trips into the target `*arr`'s import. Record in ADR-017 C-03 + DESIGN-007 D-04.
- **Q-02 (fileless mapping + dedup + synthetic keys)** — the synthetic `arr_item_id`/`arr_instance_id`/
  profile values for imported rows (so real sync later adopts them), and dedup vs existing radarr rows
  by `(arr_kind, tmdb_id)`. Record in DESIGN-007 D-05.
- **Q-03 (default section level)** — the no-row fallback per section (proposed Ledger = Read-Only for
  authed non-admins; or Disabled-by-default and admin opt-in). Record in ADR-016 C-01.
- **Q-04 (music add/export)** — does bulk Add-&-search + export include Lidarr/music, or Movie/TV only
  first? (TODO #1 keeps music out of subtitle Fix; music restore already exists in `executeRestore`.)
  Record in DESIGN-007.
- **Q-05 (restore_runs rename vs reuse)** — keep the `restore_runs` table name for both reasons
  (ADR-017 C-02, no rename migration) vs a new `arr_add_runs` table. Recommended: reuse + `reason`.
- **Own jointly with PLAN-006:** the shared Section-Permission model (ADR-016) — 005 ships the base
  table/enum/writer/session/`sectionProcedure`; 006 layers Trash's finer per-action model on top.

---

## Verification

**Unit / integration (Vitest, embedded PG16 — `@hnet/test-utils`):**
- `executeArrAdd` generalization: `searchOnAdd:false,reason:'restore'` reproduces `executeRestore`
  behavior (existing `restore-writers.test.ts` stays green); `searchOnAdd:true` adds monitored +
  triggers the search command + writes `restored` **and** `search_requested` events in one tx;
  fresh-diff re-validation still skips now-present/vanished ids (mirror `restore-flow.ts:278`).
- Export builder: deterministic output for a fixed filtered set incl. external ids (AC-12).
- `importFilelessBacklog`: parses the markdown line format, inserts tombstoned radarr rows with
  the right `tmdb_id`, satisfies the external-id CHECK, dedups on re-run (idempotent), audited.
- `setSectionPermission` / `sectionLevelForRole`: upsert + audit in-tx; Admin implicit Edit;
  no-row fallback; rejects setting Admin.
- Role gating: `sectionProcedure` returns FORBIDDEN below `minLevel`; Disabled/Read-Only/Edit matrix.
- CI guards: `no-direct-state-writes.test.ts` includes `role_section_permissions`;
  `arr-write-import-guard.test.ts` still passes (no new `@hnet/arr/write` importers).

**e2e (Playwright, stub `*arr` under `apps/web/e2e`):**
- Ledger nav appears/absent per section level; Movie/TV/Music tabs; filter → select → Add-&-search
  Modal → per-item report; export downloads a file; Read-Only hides the Add control.

**LIVE Playwright (real staging `https://haynesnetwork.haynesops.com` + real `*arr`; FULL access approved):**
1. Ledger → Movies, filter to **recently-removed / tombstoned** items, select **one**, **Add &
   search in the real Radarr**, then confirm in Radarr it is **added + monitored + searching**.
2. Repeat for **one TV** item into the real Sonarr (added + searching).
3. **Export** the filtered set to disk and verify the file lists exactly the filtered items with
   external ids (AC-12).
4. Confirm a Read-Only role sees browse+export but no Add control; a Disabled role has no nav entry.

---

## Definition of Done

- Docs authored + ADR-016/017 ratified (Accepted); glossary T-50..T-52 + BC notes landed **in the
  same PR** as code.
- Local merge gate green: `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build`.
- Branch `feat/ledger-section` → PR → required checks (lint-and-typecheck, test, build) green →
  squash-merge (conventional commit `feat:`).
- Image tag bumped in `haynes-ops` `kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml`
  + `flux reconcile` (per `docs/ops/004-deploy-runbook.md`); fileless import run once against staging.
- LIVE Playwright journeys 1–4 pass against real staging + real `*arr`.
- Plan marked **Completed** + `git mv .agents/plans/005-ledger-section.md .agents/plans/completed/`.

---

## Out of scope
- Posters / poster storage in the Ledger (TODO #5 says no posters here; that's PLAN-004 for Library).
- The Trash section, Maintainerr integration, and Trash's finer per-action permission model (PLAN-006).
- Removing the `/admin/restore` nav (PLAN-006 owns that removal; 005 leaves Restore intact).
- New metadata harvesting/enrichment (PLAN-004) — 005 only consumes those columns + the lookup path.
- Cosign signing (PLAN-007), public cutover (PLAN-008).

## Rollback
- Revert the squash-merge PR (code + migrations `0009`/`0010` are additive: a new table + a
  defaulted `restore_runs.reason` column — dropping them restores prior schema).
- The fileless import is additive tombstoned rows keyed by a distinct `arr_instance_id`
  (Q-02) — deletable by that marker without touching real synced rows.
- Roll back staging by pinning the previous image tag in `haynes-ops` + `flux reconcile`.
- `executeRestore` remains a wrapper, so Restore is unaffected by a Ledger-only revert.
