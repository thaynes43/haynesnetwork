# PLAN-006: Trash section — Maintainerr-backed deletion UI + fine-grained role permissions

- **Status:** Completed (2026-07-07) — shipped v0.11.0 + fixes v0.11.1/v0.11.2; live-validated on
  staging: Maintainerr audited SAFE and configured with the owner-required non-deleting test rule
  (18 junk candidates, 60-day countdown, dnd tag-exclusions enabled); Trash UI validated
  end-to-end (pending tables + reclaim footer, shield save/unsave with real dnd tagging, expedite
  modals cancel-only + filter refusal, role gating audited, webhook → Activity feed live); rules
  arm/disarm round-trip verified wipe-free against the real API. Three review passes closed every
  destructive-surface finding (estate-wide handle never used; live exclusions consulted; pinned
  snapshots; in-band failures fail closed).
- **Satisfies:** PRD-001 new R-80..R-88 (Trash); new ADR-019 (Trash lifecycle + Maintainerr
  integration + Section/Action permission model + Restore-nav retirement); new DESIGN-009
  (Trash UI + `@hnet/maintainerr` + permission matrix). Relates ADR-008 (ledger/write-backs),
  ADR-011 (write-back surface), ADR-012 (roles), ADR-014 (ConfirmButton/Modal), ADR-015
  (no-reorient).
- **Depends on:** PLAN-004 (media metadata + the ported `@hnet/ui` filter/table engine —
  Trash's Movies/TV tables reuse it) **and** the Maintainerr instance — **already deployed**
  (haynes-ops PR #1973, `kubernetes/main/apps/media/maintainerr`, image
  `ghcr.io/maintainerr/maintainerr:3.17.0`, `media` ns): live at
  `https://maintainerr.haynesops.com`, in-cluster `http://maintainerr.media.svc.cluster.local:6246`,
  health `/api/health` (+ `/api/health/live`, `/api/health/ready`). It boots with a **fresh empty
  DB — no rules, no integrations, so it deletes nothing.** The owner retrieves the first-run API
  key into 1Password (`HaynesKube`) as `MAINTAINERR_API_KEY` and wires integrations via the UI:
  **Plex** (plexops), **Tautulli** (backed by haynestower — most watch history),
  **Radarr/Sonarr/Lidarr**, **Seerr**. Your preflight `auditMaintainerr` MUST confirm those
  integrations are connected and no destructive rule is armed before enabling any expedite/delete.
  Soft-coordinates with PLAN-005 on the
  **section-permission base model** (see Cross-plan coordination).
- **TODO source:** `.agents/plans/TODO.md` #4.

> **ID reconciliation (Fable 5, do first):** the concrete numbers below (ADR-019, DESIGN-009,
> R-80.., migration 0009, glossary T-50.., D-01..) are _tentative_. Plans 002–005 execute
> before this one and may consume some IDs. Before authoring, grep the live ceilings
> (`grep -oE 'R-[0-9]+' docs/prds/001-haynesnetwork.md | sort -t- -k2 -n | tail`; same for
> ADR/DESIGN filenames, `T-` in the glossary, `packages/db/migrations/`) and take the next
> free block. IDs are stable once chosen (CLAUDE.md).

---

## Goal

A new **top-level `/trash` section** that **replaces the Admin → Restore nav item**
(`apps/web/app/(app)/admin/layout.tsx:23`) and wraps the tonight-hosted **Maintainerr**
instance behind a friendly UI. Maintainerr owns the rule engine, the "collections" of items
pending deletion, exclusions/whitelist, and deletion execution; our Trash is the readable
front-end the owner wants (raw Maintainerr is too complex). Five parts:

1. **Rules editor** — create/edit the Maintainerr rules that decide what gets deleted; role
   access is coarse **Edit / Read-Only / Disabled**.
2. **Movies tab + TV tab** (never combined) of items marked for deletion, each row showing
   _when_ it deletes and _how much space_ it frees, plus the **total space** the whole pending
   set frees. Filtered by our `media_metadata` (PLAN-004) via the ported filter engine.
3. **Save** an item → add it to Maintainerr's **exclusion/whitelist** so it is never deleted;
   also available as **perma-save** from the Library page via a shield 🛡️ affordance, **Movies +
   TV only, never music**.
4. **Expedite** deletion — the whole pending list, or a single item.
5. **Recently Deleted** sub-section with **Restore**.

Permissions are **fine-grained per role**: a toggle per user-action plus fully-Disabled; the
whole Trash tab is disablable (then hidden from nav), and individual portions are disablable
(e.g. a role limited to only saving/whitelisting Movies).

> **CRITICAL (owner instruction) — audit before arming anything destructive.** Fable 5's FIRST
> executable step, before wiring or enabling _any_ expedite/rule/delete path, is to **audit the
> live Maintainerr install**: verify its integrations are connected (Plex, Tautulli
> [`haynestower`], Sonarr, Radarr, Lidarr, Seerr) and verify **nothing is poised to delete**
> (no active destructive rule firing / a confirmed safe-hold). Only after a recorded SAFE
> verdict may the destructive surfaces (expedite, rule-save that could schedule deletions) be
> enabled. See Verification → _Preflight audit gate_.

---

## Docs-first artifacts to author (same PR as behavior)

### PRD-001 edits (`docs/prds/001-haynesnetwork.md`)

- New subsection **### Trash & retention (Phase 2.5)** under Requirements with:
  - **R-80** Top-level Trash section integrates Maintainerr; replaces the Admin Restore nav
    item. _(Must)_
  - **R-81** Rules editor mapped to Maintainerr rules; role access Edit / Read-Only / Disabled.
    _(Must)_
  - **R-82** Movies and TV pending-deletion tables (separate tabs), each row: title +
    scheduled-delete date + space freed; a total-space figure for the whole set; filterable by
    our metadata via the shared filter engine. _(Must)_
  - **R-83** Save/whitelist an item so Maintainerr never deletes it; perma-save from Library
    (Movies + TV only, not music). _(Must)_
  - **R-84** Expedite deletion for the whole list or one item — destructive, confirmed. _(Must)_
  - **R-85** Recently Deleted list with Restore. _(Must)_
  - **R-86** Fine-grained per-role permissions: per-action toggle + Disabled; whole tab
    disablable (hidden) and per-portion disablable. _(Must)_
  - **R-87** Music is never deletable via Trash (no Lidarr deletion surface). _(Must)_
  - **R-88** Before any destructive action is available, the Maintainerr integration health and
    a no-pending-delete safe state are verified and surfaced. _(Must)_
- Amend the **Failsafe restore** block (`R-50..R-52`, lines 117–123): note the Restore capability
  is **retired as an Admin nav item** here; its diff/re-add power is **re-homed into the
  PLAN-005 Ledger section**. The underlying `restoreRouter` + `executeRestore` stay callable
  (Recently-Deleted Restore reuses them); `/admin/restore` redirects to `/trash`.

### New ADR-019 (`docs/adrs/019-trash-and-maintainerr.md`, MADR 3.0 — Fable 5 authors AND ratifies to Accepted)

Decides, in one ADR:

- **Maintainerr is the system of record** for rules, pending-deletion collections, exclusions,
  and deletion execution — Trash is read-through + a confined write surface, _not_ a
  reimplementation. (Resolves DDD-002 BC-03's open `Q-04` "Maintainerr is a follow-on".)
- **`@hnet/maintainerr` write surface is import-confined to `packages/domain`** — same rule as
  `@hnet/arr/write` (ADR-008/011), enforced by a new guard test.
- **The Section/Action permission model**: coarse `role_section_grants` (section ∈ {trash,
  ledger,…} × level ∈ {edit, read_only, disabled}) plus fine-grained `role_trash_action_grants`
  (per-action enable) layered on top. Extends ADR-012's unified Role. (Coordinated with PLAN-005
  — see Cross-plan coordination; whichever of 005/006 lands first _creates_ `role_section_grants`
  and the other extends it.)
- **Restore nav retirement** and its re-home into Ledger (relates R-50..R-52).
- **No music deletion** — Trash exposes Movies (Radarr) + TV (Sonarr) only.
- Consequences C-01.. (good: one deletion brain, audited saves/expedites; bad: hard dependency
  on Maintainerr uptime + its API stability; safe-hold audit is a manual gate).

### DDD (`docs/domain-driven-design/001-ubiquitous-language.md` — glossary is normative)

New terms (tentative T-50..): **Trash** (T-50), **Deletion Candidate** (T-51, an item in a
Maintainerr collection pending deletion), **Exclusion / Whitelist / Save** (T-52), **Recently
Deleted** (T-53), **Section Permission** (T-54, coarse Edit/Read-Only/Disabled), **Action
Permission** (T-55, per-action enable), **Collection** (T-56, Maintainerr's grouping),
**Expedite** (T-57). Update `docs/domain-driven-design/002-bounded-contexts.md`: extend **BC-03
Media Ledger** external-systems to add **Maintainerr (rules + deletion execution; read
collections/exclusions, write exclusions/rules/expedite)** and note Section/Action permissions
are decided by **BC-02 Entitlements** (the permission mutation, audited) while the Trash actions
themselves are BC-03.

### New DESIGN-009 (`docs/designs/009-trash-and-maintainerr.md`)

- **D-01** `@hnet/maintainerr` client shape (read + confined write), config/env contract
  (mirrors `packages/arr/src/config.ts:22-48`).
- **D-02** Maintainerr REST mapping table (endpoints → our operations) — _filled from the live
  Swagger_, see Client below.
- **D-03** Permission matrix: sections × levels, Trash actions × enable, and how the nav/route
  gate + each tRPC procedure read it.
- **D-04** Trash UI layout: `/trash` sub-nav (Rules · Movies · TV · Recently Deleted), the
  pending tables (per-item + total space footer), Save shield, Expedite (ConfirmButton vs
  Modal), no-reorient reservations (ADR-015).
- **D-05** Preflight audit / safe-hold surface (`trash.status`) contract.
- **D-06** Recently-Deleted source-of-truth resolution (read-through vs thin mirror).

---

## Data model (`packages/db`)

**No secret in git.** Maintainerr `base_url` is server-side backend config (in-cluster service
DNS default — **EXEMPT** from the arbitrary-URL rule, like the *arrs, CLAUDE.md hard rule 3 /
`config.ts:11-20`); `api_key` is a secret env `MAINTAINERR_API_KEY` (1Password → ExternalSecret;
owner adds tonight). Config lives in a `@hnet/maintainerr` module à la `assertArrEnv`, **not** a
table.

### Enums — single source of truth (`packages/db/src/schema/enums.ts`)

- `SECTION_PERMISSION_LEVELS = ['edit','read_only','disabled'] as const` (coordinate: PLAN-005
  may already add this — reuse, don't duplicate).
- `PERMISSION_SECTIONS = ['trash','ledger', …] as const` (coordinate with 005; add only 'trash'
  if 005 seeded the array).
- `TRASH_ACTIONS = ['view_pending','save_exclude','remove_exclude','expedite_item',
'expedite_all','edit_rules','restore_deleted'] as const` — _the exact set is an Open Decision_.
- Extend `LEDGER_EVENT_TYPES` (`enums.ts:29-42`) with `'trash_excluded'`, `'trash_expedited'`,
  `'trash_restored'`.
- Extend `LEDGER_EVENT_SOURCES` (`enums.ts:44`) with `'maintainerr'`.
- Extend `PERMISSION_AUDIT_ACTIONS` (`enums.ts:10-18`) with `'update_role_permissions'` (the
  Section/Action permission mutation is a BC-02 audited change).
- Each new enum gets its CHECK constraint in the migration exactly like
  `media-items.ts:73-84` / `restore-runs.ts` build `ANY(ARRAY[...])` from the const list.

### Tables

- **`role_section_grants`** (`role_id` FK→roles cascade, `section` text+CHECK, `level`
  text+CHECK, PK `(role_id, section)`). Coarse access. _Created by whichever of PLAN-005/006
  lands first; the other extends its section set._
- **`role_trash_action_grants`** (`role_id` FK→roles cascade, `action` text+CHECK, `enabled`
  boolean, PK `(role_id, action)`). Fine-grained. Absent row ⇒ derived from the section level
  (edit ⇒ all enabled, read_only ⇒ only view_* / no writes, disabled ⇒ none).
- **Recently-Deleted source** — _Open Decision (D-06)_: default **read-through** from
  Maintainerr history + existing `ledger_events` `'deleted'` rows (`enums.ts:33`), **no new
  table**. If Maintainerr history proves thin/non-durable, add a thin mirror
  `trash_deletions(id, media_item_id?, maintainerr_media_id, arr_kind, title, size_freed,
deleted_at, restored_at)` — decide during the audit step.

### Guard-list + import-confinement updates (mandatory)

- **`packages/domain/__tests__/no-direct-state-writes.test.ts`** — add the new guarded tables to
  every relevant pattern (`roleSectionGrants`, `roleTrashActionGrants`, and `trash_deletions` if
  created) in `FORBIDDEN_PATTERNS` (`no-direct-state-writes.test.ts:33-68`): the `.insert()`,
  `.update()`, `.delete()` Drizzle forms and the raw-SQL `INSERT/UPDATE/DELETE` forms, plus the
  `role_section_grants|role_trash_action_grants` SQL identifiers. These may be written **only**
  by `@hnet/domain`.
- **New `packages/domain/__tests__/maintainerr-write-import-guard.test.ts`** — clone
  `arr-write-import-guard.test.ts` (`:17` `ALLOWED_DIR_PREFIXES`, `:19` `IMPORT_PATTERN`) with
  `IMPORT_PATTERN = /@hnet\/maintainerr\/write/`, allowed only under `packages/domain` and
  `packages/maintainerr`. Confines any Maintainerr mutation (exclusion/rule/expedite) to the
  domain orchestrators.

---

## Domain (`packages/domain`) — single-writers, invariants

Mirror the Restore/Fix vertical (`fix-flow.ts`, `restore-flow.ts`): each guarded-state mutation
wrapped in `inTransaction`, its audit/ledger row written in the **same tx**; the external
Maintainerr call follows the fix-flow discipline (write the pending/audit intent, call external,
record outcome) and the orchestrator **re-derives fresh state** to avoid TOCTOU (as
`executeRestore` re-validates against a fresh diff).

- **Permission writers** (extend `packages/domain/src/roles.ts`):
  - `updateRoleSectionGrant({ roleId, section, level, actorId })` — upsert `role_section_grants`
    - a `'update_role_permissions'` `permission_audit` row in one tx (pattern:
      `roles.ts:130-224 updateRole`). Refuse to disable a section for the Admin role (Admin is
      superuser, `roles.ts:144-146`).
  - `updateRoleTrashActions({ roleId, actions[], actorId })` — replace the fine-grained set +
    audit in one tx.
  - **Read helper** `trashPermissionsForRole(roleId)` (à la `effective-apps.ts:37`) resolving the
    effective `{ sectionLevel, actions:Set }` for gating.
- **`@hnet/maintainerr` client bundle injection** — a `MaintainerrClientBundle` (read + write)
  passed into orchestrators, resolved in `packages/api` from env (parallels
  `arr-clients.ts` / `resolveArrBundle`).
- **Trash orchestrators** (new `packages/domain/src/trash-flow.ts`):
  - `saveExclusion({ db, maintainerr, mediaItem, actorId })` — POST Maintainerr exclusion, then
    a `ledger_events` `'trash_excluded'` row (source `'maintainerr'`) in-tx. Idempotent (already
    excluded ⇒ no-op, no event — cf. `assignRole` idempotency `roles.ts:334-336`).
  - `removeExclusion(...)` — symmetric.
  - `upsertTrashRule` / `deleteTrashRule` — Maintainerr rule writes + a `permission_audit`-style
    or `ledger_events` audit; **only reachable when the caller has `edit_rules`**.
  - `expediteDeletion({ scope:'item'|'all', … })` — **destructive**; re-derives the fresh
    pending set, requires the Preflight-audit SAFE flag to be set, triggers Maintainerr's
    collection handler / sets the item's delete date, records `'trash_expedited'` events. Gated
    behind `expedite_item` / `expedite_all`.
  - `restoreDeleted(...)` — **reuses `executeRestore`** (`restore-flow.ts`) to re-add the item to
    the matching *arr, then a `'trash_restored'` event. (Confirm reuse — Open Decision.)
  - `auditMaintainerr({ maintainerr })` — read-only: fetch Maintainerr settings/status, assert
    each integration (Plex, Tautulli haynestower, sonarr/radarr/lidarr, seerr) is connected, and
    assert no collection is imminently deleting / a safe-hold holds. Returns a structured
    verdict; **writes no state**.
- **Invariants:** music/Lidarr is never a valid Trash target (reject at the orchestrator, not
  just UI); expedite refuses unless `auditMaintainerr` last returned SAFE; every write path
  checks the caller's Action Permission (defence in depth beneath the API gate).

---

## Client / integration — new `@hnet/maintainerr` package

New workspace package `packages/maintainerr` (scoped `@hnet/maintainerr`, raw TS, no build step —
like every `@hnet/*`). Split entrypoints as the arr package does (`packages/arr/src/read.ts` vs
`write.ts`, `index.ts`), with a `@hnet/maintainerr/write` subpath that is import-confined:

- **`config.ts`** — `MAINTAINERR_URL` (default `http://maintainerr.media.svc.cluster.local:6246`,
  EXEMPT server-side base URL) + `MAINTAINERR_API_KEY` (required secret, never echoed) — clone
  `packages/arr/src/config.ts:34-48` `assertArrEnv`.
- **`read.ts`** — list collections + collection media (pending items, per-item size, delete date),
  list rules/rule groups, list exclusions, get settings/status/history. Zod schemas under
  `schemas/` (clone `packages/arr/src/schemas/*`).
- **`write.ts`** (confined) — add/remove exclusion, create/update/delete rule (group), trigger the
  collection handler / expedite.
- **`http.ts`/`errors.ts`** — clone `packages/arr/src/http.ts`,`errors.ts` (api-key header,
  typed `MaintainerrHttpError`).

> **Research task (Fable 5, live) — fill DESIGN-009 D-02 from the real instance.** Direct
> WebFetch of Maintainerr's public docs 403/404'd from this environment; the authoritative
> source is the **running instance's Swagger** once it boots tonight:
> `https://maintainerr.haynesops.com/api/swagger` (and `/api-json`). Enumerate the exact paths —
> expected shapes to confirm: `GET /api/collections` (+ collection media/content, each item's
> `plexId`/`tmdbId` + size + `deleteAfterDays`/scheduled date), `GET/POST /api/rules` +
> rule-groups, `GET/POST/DELETE` exclusion endpoint(s), `GET /api/settings` + `/api/app/status`
> (integration health), the collection **handle/execute** trigger, and any deletion **history**
> endpoint. Map each to a `read.ts`/`write.ts` method and record the table in D-02.

---

## API (`packages/api`) — `trashRouter`, per-action gated

- **New `packages/api/src/routers/trash.ts`**, registered in `packages/api/src/routers/index.ts`.
- **New `trashProcedure` middleware** (extend `packages/api/src/middleware/role.ts` alongside
  `adminProcedure`) — a factory `trashAction('save_exclude')` that loads the caller role's
  effective Trash permission (`trashPermissionsForRole`) and throws `FORBIDDEN` if the action
  isn't enabled / the section is disabled. All Maintainerr calls go through domain orchestrators
  wrapped in `mapDomainErrors` (pattern: `restore.ts:27`, `:47`).
- Procedures:
  - `trash.status` — `adminProcedure`; runs `auditMaintainerr` (integration health + safe-hold).
  - `trash.pending` (`{ media: 'movie'|'tv', filter }`) — `trashAction('view_pending')`; reads
    collections, joins `media_metadata` (PLAN-004) for filter fields + poster, returns rows +
    aggregate total space.
  - `trash.rules.list` — `trashAction('view_pending')`/section read; `trash.rules.upsert` /
    `trash.rules.delete` — `trashAction('edit_rules')`.
  - `trash.save` / `trash.unsave` — `trashAction('save_exclude')` / `'remove_exclude'`.
  - `trash.expedite` (`{ scope, mediaItemId? }`) — `trashAction('expedite_item'|'expedite_all')`;
    refuses unless `trash.status` last verdict is SAFE.
  - `trash.recentlyDeleted` / `trash.restore` — `trashAction('restore_deleted')`.
  - `roles.setSectionGrant` / `roles.setTrashActions` — `adminProcedure` (extend the existing
    `roles` router `packages/api/src/routers/roles.ts`) → the domain permission writers.

---

## UI (`apps/web`)

- **Top-level nav** — add `<Link href="/trash">Trash</Link>` to `components/top-bar.tsx:195-198`
  (Primary nav, after Library). **Visible only** when the session/role's Trash section ≠
  `disabled`; thread the section level through the session or a lightweight `trash.access` query.
- **`app/(app)/trash/layout.tsx`** — server-side gate: redirect to `/` if section disabled
  (pattern: `admin/layout.tsx:11-14` `protectedRouteRedirect`). Sub-nav landmark: **Rules ·
  Movies · TV · Recently Deleted**, each link shown only if its portion is enabled for the role.
- **Rules page** — editor mapped to Maintainerr rules; renders read-only when level =
  `read_only`, editable when `edit`. Rule-schema→editor mapping is an Open Decision (expose the
  Maintainerr properties PLAN-004 already harvests as metadata).
- **Movies + TV pages** (separate routes/tabs, never combined) — the **ported `@hnet/ui` filter/
  table engine** (built in PLAN-004) over `trash.pending`; columns include scheduled-delete date
  and per-item space freed; a **total-space footer** for the whole pending set. Each row has a
  **Save 🛡️** control and an **Expedite** control (per-item).
- **Save (perma-save) shield 🛡️** — on the Trash rows _and_ on the **Library page**
  (`app/(app)/library/page.tsx` + `library/[id]/item-detail.tsx`), **Movies + TV only, never
  music** (hide the shield for Lidarr items). Save is non-destructive → a light **ConfirmButton**
  inline two-step (ADR-014) or a plain toggle; toggling fills color, never layout (ADR-015). Icon
  is an Open Decision (🛡️ shield vs 📌 pin vs 💾) — owner memory: distinct visual identity, pick
  in-theme, screenshot for approval.
- **Expedite** — **destructive**: single-item uses the `@hnet/ui` **ConfirmButton** inline
  two-step (never `window.confirm`; ADR-014). **Expedite-all** is explanatory/multi-consequence →
  a **Modal** (like `admin/restore/page.tsx:273` confirm Modal / the failsafe pattern). Armed
  state deepens color and reserves the widest label width so the row can't shift (ADR-015 /
  CLAUDE.md hard rule 9).
- **Recently Deleted page** — list + per-row **Restore** (ConfirmButton; reuses `executeRestore`).
- **Retire Admin Restore nav** — remove the `<Link href="/admin/restore">Restore</Link>` from
  `admin/layout.tsx:23`; **redirect `/admin/restore` → `/trash`** (keep `restoreRouter` +
  `admin/restore/page.tsx` callable until PLAN-005 re-homes the diff/re-add into Ledger).
- **No-reorient audit** — filter/sort interactions, save toggles, and expedite arming must not
  reflow neighbours; tab switches and any deliberate row expansion are the allowed exceptions
  (ADR-015).

---

## Ops

- **Env / secret** — add `MAINTAINERR_URL` (non-secret, cluster-DNS default) and
  `MAINTAINERR_API_KEY` (secret) to `.env.example`, the app's ExternalSecret + Helm env in
  `haynes-ops kubernetes/main/apps/frontend/haynesnetwork/app/helmrelease.yaml` (reference the
  1Password item **by name only** — `HaynesKube` vault; owner places `MAINTAINERR_API_KEY`
  tonight after the instance boots; pattern:
  `haynes-ops .../media/sonarr/app/helmrelease.yaml:93` `secretKeyRef`). **Never commit the
  value.** If Maintainerr uses Tautulli, it consumes `TAUTULLI_HAYNESTOWER_API_KEY` on the
  Maintainerr side (haynes-ops), not here.
- **e2e stub** — new `apps/web/e2e/support/stub-maintainerr.ts` (clone `stub-arr.ts`) serving
  collections (movies + tv fixtures with sizes/dates), rules, exclusions, settings/status
  (all-integrations-connected + safe-hold), and history; wire it into
  `e2e/support/global-setup.ts` / `harness.ts` / `env.ts` so e2e stays hermetic.
- **Deploy** — bump the image tag in
  `haynes-ops .../frontend/haynesnetwork/app/helmrelease.yaml` + `flux reconcile`
  (docs/ops/004-deploy-runbook.md).

---

## Open decisions Fable 5 must make (authorized to decide + record as ADR-019 / Q-NN)

1. **Read-through vs thin mirror** for pending collections and Recently-Deleted (default:
   read-through; add `trash_deletions` only if Maintainerr history is non-durable — decide during
   the audit).
2. **Exact `TRASH_ACTIONS` set** and whether Rules alone uses the 3-level Edit/Read-Only/Disabled
   while other actions are binary enable — vs a uniform matrix.
3. **Recently-Deleted source of truth** (Maintainerr history vs `ledger_events` `'deleted'` vs
   both merged) — D-06.
4. **Maintainerr rule-schema → our editor mapping** (which properties are exposed/editable).
5. **Perma-save icon** final choice (🛡️ / 📌 / 💾) — screenshot for owner approval.
6. **Safe-delete verification procedure** — the precise checks `auditMaintainerr` runs and what
   counts as SAFE (e.g. delete action paused, or zero items scheduled within N hours).
7. **Restore reuse** — confirm Recently-Deleted Restore calls `executeRestore` unchanged.
8. **Section-permission ownership** with PLAN-005 (who creates `role_section_grants`).

---

## Cross-plan coordination

- **PLAN-004** — Trash's Movies/TV tables and Rules-editor metadata reuse the **ported
  `@hnet/ui` filter/table engine** and the `media_metadata` table (posters, ratings, sizes).
  Hard dependency; do not reimplement filtering.
- **PLAN-005 (Ledger)** — shares the **`role_section_grants`** base table and
  `SECTION_PERMISSION_LEVELS` enum, and **inherits the retired Restore diff/re-add power**.
  Whichever plan executes first creates `role_section_grants` + the enum; the second adds its
  section value and extends the permission UI. The `restoreRouter`/`executeRestore` stay live
  through this plan; PLAN-005 re-homes the diff/execute UI into Ledger.
- **Shared building block** — the filter engine is DESIGN-006 visual identity: port the mechanism,
  never demo-console's look.

---

## Verification

### Preflight audit gate (run FIRST, before enabling destructive surfaces)

- Point `@hnet/maintainerr` at the live instance; run `auditMaintainerr` (or `trash.status`) and
  **confirm**: Plex, Tautulli (haynestower), Sonarr, Radarr, Lidarr, Seerr all connected, and a
  **SAFE** no-imminent-deletion verdict. Record the verdict. **Do not** wire/enable expedite or
  any rule-save that could schedule deletions until SAFE is confirmed. If not SAFE, halt and
  surface for the owner (PushNotification) rather than proceeding.

### Unit / integration (Vitest, embedded PG16)

- **Permission matrix** — `trashPermissionsForRole` across section levels × action grants
  (edit ⇒ all, read_only ⇒ view-only, disabled ⇒ none; Admin ⇒ all, cannot be disabled).
- **Single-writers** — `updateRoleSectionGrant`/`updateRoleTrashActions` write the
  `permission_audit` row in the same tx (extend `permission-writers.test.ts`); `saveExclusion`
  idempotency + `'trash_excluded'` ledger event; `expediteDeletion` refuses when not SAFE and
  rejects Lidarr/music targets.
- **Guard tests must stay green** — the extended `no-direct-state-writes.test.ts` and the new
  `maintainerr-write-import-guard.test.ts`.
- **Merge gate:** `pnpm lint && pnpm lint:css && pnpm typecheck && pnpm test && pnpm build` all
  green.

### e2e (Playwright, stub Maintainerr — hermetic)

- New `apps/web/e2e/trash.spec.ts`: nav visibility per role (disabled ⇒ no Trash link);
  Movies/TV tables render + filter + total-space footer; Save shield adds an exclusion (stub
  asserts the POST); Expedite shows ConfirmButton (item) / Modal (all); Recently-Deleted +
  Restore; `/admin/restore` redirects to `/trash`; Library shield present for Movies/TV, absent
  for music.

### LIVE Playwright against real staging (`https://haynesnetwork.haynesops.com`) + real Maintainerr — **NON-DESTRUCTIVE**

- Read the **real** pending collections into the Movies and TV tabs; verify per-item + total
  space render.
- **Save one item** and confirm it lands in Maintainerr's real **exclusion list** (verify via
  `@hnet/maintainerr` read / Maintainerr UI).
- Exercise **role gating** live (a Disabled role sees no Trash tab; a save-only role can save but
  not expedite/edit rules).
- **CONFIRM nothing was actually deleted** — re-read collections/history and assert the pending
  set and on-disk media are unchanged; **do not** trigger a real expedite/delete during
  validation.

---

## Definition of Done

- Docs-first artifacts authored in the same PR (PRD edits; ADR-019 authored **and ratified to
  Accepted**; glossary + BC-03 terms; DESIGN-009 with D-02 filled from the live Swagger).
- Merge gate green; branch `feat/trash-section` → PR → required checks (`lint-and-typecheck`,
  `test`, `build`) green → squash-merge.
- Deployed to staging (image tag bumped in haynes-ops + `flux reconcile`).
- Preflight audit recorded SAFE; the four LIVE non-destructive journeys pass against real staging
  - real Maintainerr, with an explicit "nothing deleted" confirmation.
- Plan marked **Completed** and `git mv .agents/plans/006-trash-section.md
.agents/plans/completed/`.

---

## Out of scope

- **Music deletion** — never (R-87); Lidarr has no Trash surface.
- Reimplementing Maintainerr's rule engine or deletion scheduler — Maintainerr owns it.
- Posters/metadata harvest and the filter engine themselves — delivered by PLAN-004.
- Re-homing the Restore diff/re-add UI into Ledger — that is PLAN-005 (this plan only retires the
  nav item and redirects).
- Public `haynesnetwork.com` cutover — PLAN-008.

---

## Rollback

- **Feature-flag / nav:** setting every role's Trash section to `disabled` hides the tab and
  gates every `trash.*` procedure — an instant kill switch without a deploy.
- **Deploy:** revert the haynes-ops image tag to the prior release + `flux reconcile`.
- **Data:** the migration is additive (new tables/enums/`ledger_events` values); a down-migration
  drops `role_section_grants`/`role_trash_action_grants` (+ `trash_deletions` if created) — no
  existing table altered destructively. Maintainerr state (exclusions/rules) is Maintainerr's own
  system of record; a rollback of _this app_ leaves Maintainerr untouched and safe.
- **Safety:** because expedite is the only destructive path and it is gated behind the recorded
  SAFE verdict + per-action permission + confirm, a rollback never leaves a half-armed deletion.

---

## Addendum (2026-07-05, owner) — never delete what people are watching (cross-server guarantee)

**Requirement (owner, load-bearing):** watch history must protect media from deletion across ALL
THREE Plex servers — _"I don't want to delete things people are watching."_

**Why not a one-time Tautulli migration:** Maintainerr pairs to ONE Plex+Tautulli (HaynesOps), so
its native rules only see HaynesOps watch history. Importing HaynesTower's Tautulli history into
HaynesOps once is a frozen snapshot — HaynesTower stays live and keeps accruing views from users
who don't migrate, which would then be invisible to Maintainerr. A migration is a seed, not a
safeguard.

**The safeguard THIS app owns (build it):** using PLAN-004's unified cross-server watch signal
(`last_watched_at` = MAX across the three Tautullis), the Trash flow **auto-excludes any item
watched on ANY server within a configurable recency window** (default e.g. 90 days) by adding it
to **Maintainerr's exclusion/whitelist** before it can be actioned, and surfaces "last watched
(any server)" in the Movies/TV pending tables so a recently-watched title is never a deletion
candidate. This runs as a safety net OVER Maintainerr's own HaynesOps-only rules: anything watched
anywhere recently is whitelisted, not deleted. The exclusion sync must run **before** Maintainerr's
scheduled deletion cron.

**Optional supplementary step (owner-driven, not a substitute):** a one-time Tautulli "Import
Database" of HaynesTower's history into the HaynesOps Tautulli, to give Maintainerr's _native_
rules more depth. Largely a manual Tautulli UI operation — document it, but do not rely on it for
the guarantee above.

**Note — Maintainerr config is UI-only:** Maintainerr's dependency tokens (Plex, Tautulli, the
three *arrs, Seerr) are configured in its own UI and stored in its SQLite DB — they are NOT
env-injectable (only `TZ` / `UI_PORT` / `BASE_PATH` / `GITHUB_TOKEN` are supported). Do **not**
create an ExternalSecret for them. The only Maintainerr secret this app wires is
`MAINTAINERR_API_KEY` (Maintainerr's own key, which THIS app consumes).

Open decisions for Fable 5: the default recency window + whether it's admin/per-role configurable;
protection via auto-whitelist in Maintainerr vs filtering our pending view vs both (recommend
auto-whitelist so Maintainerr itself never deletes it).

**Add to Definition of Done:** a LIVE check that an item watched on HaynesTower _only_ is excluded
from deletion on the HaynesOps-paired Maintainerr.

---

## Addendum (2026-07-05, owner) — exclusion tag → *arr tag → our ledger

Enable Maintainerr's **"Tag excluded content"**: whenever Maintainerr excludes/whitelists an item
it stamps a protective tag (canonical label TBD — `dnd` or `do-not-delete`) on the matching
**Radarr movie / Sonarr series** (NOT Lidarr — no music deletion). Our *arr sync ALREADY ingests
*arr tags into `media_items.arrTags`, so "protected" is readable straight from the ledger — no
extra Maintainerr call. Fable: enable it via the Maintainerr API on Radarr + Sonarr with **"Remove
tag on un-exclude" = ON** (so the tag mirrors live state — safe because the label is
Maintainerr-managed, not hand-applied); treat the tag on `arrTags` as a first-class "protected"
signal in Library + the Trash pending tables; make **perma-save (shield) ⇄ Maintainerr exclusion**
bidirectional; standardize ONE canonical label across Maintainerr + our copy (add it to the glossary).

## Addendum (2026-07-05, owner) — Maintainerr notifications → in-app "Activity" feed (no phone spam)

Make THIS app the notification hub instead of Pushover-to-phone. Configure a Maintainerr **Webhook**
notification agent → a new secured endpoint on the app (`POST /api/webhooks/maintainerr`), gated by a
shared secret (`MAINTAINERR_WEBHOOK_SECRET`, 1Password → ExternalSecret; session-unauthenticated but
secret-required). **Target the in-cluster service** (`http://haynesnetwork.frontend.svc.cluster.local`),
NOT the public URL — both are in-cluster, so no public exposure and it works before the R-64 cutover.
Persist events (`ledger_events` `source:'maintainerr'`, or a `trash_notifications` table) and surface a
**"Activity" sub-tab under Trash**: a filterable deletion-lifecycle feed (flagged / leaving-soon /
excluded / deleted), role-gated read. **Notification router:** the in-app feed is the default sink;
let the owner opt specific event types (e.g. "items deleted", "large batch pending") to forward to
**Pushover** (existing creds, configured in our app) so only high-signal events reach the phone. Fable
configures the Maintainerr webhook agent via API once the endpoint ships (endpoint first, then wire the
agent). Open decisions: webhook payload → our event model; default Pushover-forward types; Trash-only
feed vs a general notification center later.

**Coordination with PLAN-009 (Bulletin):** build this receiver as the **generic** pattern 009
extends — a `notifications` table + `POST /api/webhooks/<source>` receiver with **Maintainerr as
source #1** (NOT a Maintainerr-specific endpoint/table). PLAN-009 then only adds Seerr/Tautulli
adapters + promotes the feed to a top-level "Bulletin" section, and this Trash "Activity" tab
becomes a `source='maintainerr'` filtered view of the same store. See `009-communication-hub.md`.

---

## Addendum (2026-07-06, owner) — minimal NON-DELETING test rules (deploy/live-validation step)

**Owner requirement:** as part of THIS plan's deploy + live-validation step, configure Maintainerr
with **1–2 deliberately conservative rules whose only job is to exercise the Trash UI** — real
collections, real pending rows, zero deletion risk:

- **Target only unambiguous junk**: very low rating **AND** very few votes **AND** zero plays
  across all servers (the PLAN-004 cross-server watch signal / Tautulli) **AND** never requested
  (no Seerr requester tag) **AND** added long ago. Every predicate must hold — the rule is an
  intersection, not a union.
- **LONG `deleteAfterDays` (≥ 60)** so nothing can reach its delete date during validation. The
  point is populated Movies/TV pending tables (sizes, scheduled dates, total-space footer), not
  deletions.
- **Enable the `dnd` tag settings** while here: the Radarr + Sonarr tag-exclusion settings
  (`radarr_tag_exclusions`/`sonarr_*`, tag `dnd`, "remove tag on un-exclude" = ON) via the
  settings `PATCH` (DESIGN-010 D-02 / ops checklist #3) — so Save/exclusion round-trips are
  observable in `media_items.arrTags` during live validation.
- **Expedite is still NEVER exercised live** (the existing non-destructive validation rule
  stands unchanged; the ≥60-day window is belt-and-braces on top, not a substitute).
- **Seed data for PLAN-012:** the collections these test rules produce become the input the
  PLAN-012 curation pipeline (batches → admin poster review → Leaving Soon) builds its first
  draft batch from. Name them accordingly (e.g. `junk-movies-conservative`) and record the rule
  definitions in DESIGN-010 as-built notes.

---

## Addendum (2026-07-05, owner) — *arr tags in Trash (requester = keep, collection = source)

Use PLAN-004's parsed tag dimensions in both the pending Movies/TV tables (filter facets + columns)
and the deletion logic:

- **Requester (Seerr) tags = a KEEP signal** — a personally-requested title is strong
  do-not-delete: auto-protect/whitelist it (same mechanism as the watch-history guardian + the
  `dnd` exclusion tag), or at minimum surface the requester so a human never trashes it.
- **Source-collection (Kometa) tags = unwanted-media provenance** — surface which auto-collection
  added an item so rules/admins can target low-value sources (e.g. a "Trending" collection nobody
  watches); a rule could key on source-collection + low watch + low rating.
