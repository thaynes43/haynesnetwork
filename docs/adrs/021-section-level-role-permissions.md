# ADR-021: Section-level Role Permissions (Edit / Read-Only / Disabled)

- **Status:** Accepted
- **Date:** 2026-07-06
- **Deciders:** Tom Haynes (owner) · ratified by Fable 5 (autonomous run, KICKOFF mandate)

## Context and problem statement

PLAN-005 adds a top-level **Ledger** section (spreadsheet browse over the whole media ledger
+ bulk Add-&-search + emergency export). Not every role should see it, and of those that do,
not every role should be able to run the mutating Add-&-search. The existing entitlement model
(ADR-012) is per **app** (`role_app_grants`) and per **Plex library** (ADR-017
`role_library_grants`); neither models access to an in-app **section** with a graded level.
PLAN-006 (Trash) needs the same shape — and the two plans were drafted in parallel and both
sketched a base "section grant" table, so the base must be defined **once, here** (PLAN-005 is
lower-numbered and executes first), with PLAN-006 layering its finer per-action model on top.

We need: a role's access **level** per top-level section — **Edit** (full), **Read-Only**
(browse/export, no mutation), **Disabled** (section hidden) — carried on the session so nav +
API gating need no per-request query, and written through the single-writer + same-tx-audit
discipline every other permission mutation already follows (CLAUDE.md hard rule 6).

## Decision drivers

1. One canonical base model shared by PLAN-005 and PLAN-006 — no second base table (the
   cross-plan reconciliation in `.agents/plans/README.md` names it `role_section_permissions`).
2. Consistency with the existing grant tables: const-array enums (TS + SQL CHECK, single source
   of truth), Admin implicit, single-writer + same-tx `permission_audit`, session-carried.
3. Server-authoritative gating (never client-hidden only) — a Read-Only role must be *unable* to
   call the mutation, not merely not shown the button.

## Decision

- **C-01 — A role carries one access `level` per `section_id`** in a new
  `role_section_permissions` table (`role_id` FK cascade, `section_id`, `level`, composite PK
  `(role_id, section_id)`, timestamps). `SECTION_IDS = ['ledger','trash']` and
  `SECTION_PERMISSION_LEVELS = ['edit','read_only','disabled']` are const-array enums in
  `enums.ts` (the single source of truth for the TS types AND the SQL CHECK constraints — the
  CLAUDE.md convention). **The absence of a row means a documented per-section default**
  (`SECTION_DEFAULT_LEVELS`): **Ledger = `read_only`** (Q-03 resolved — an authenticated member
  browses/exports the whole ledger without an admin touching their role, while the mutating
  Add-&-search stays Edit-gated), **Trash = `disabled`** (reserved for PLAN-006; the section
  stays hidden until that plan builds it). The total order for gating is
  `disabled < read_only < edit` (`SECTION_LEVEL_RANK`).

- **C-02 — Written by a `@hnet/domain` single-writer** (`setSectionPermission`) that upserts the
  row and co-writes a `permission_audit` row (`action:'update_section_permission'`, before/after
  level + section in `detail`) in the **same transaction** (hard rule 6). `PERMISSION_AUDIT_ACTIONS`
  gains `update_section_permission`; migration 0013 rebuilds the `permission_audit.action` CHECK
  from the enum array (the same DROP+ADD pattern ADR-017 used at 0010). The caller's section
  levels are **hydrated onto the session** (`SessionRole.sectionPermissions: Record<SectionId,
  Level>`, resolved in `getSessionExtension`) so nav rendering and the new `sectionProcedure`
  gate switch on it with no extra query — exactly as `role.isAdmin` is carried today
  (`middleware/role.ts`). A new `sectionProcedure(sectionId, minLevel)` composes `authedProcedure`
  and returns `FORBIDDEN` below `minLevel`.

- **C-03 — Admin (`roles.is_admin`) implies `edit` on every section** with **no rows** — the same
  implicit-superuser rule as the all-apps (ADR-012 / T-49) and all-libraries (ADR-017) grants.
  `setSectionPermission` refuses to set a level on the Admin role with the `ROLE_IMMUTABLE`
  coded error (`SystemRoleImmutableError`), mirroring how `setRoleLibraries` refuses the Admin
  library set.

**Shared with PLAN-006:** Trash adds its own `section_id` value(s) already reserved in
`SECTION_IDS` and (per its own plan) a finer per-action grant model **on top** of this base;
006 does NOT create a second base table.

## Consequences

- **Positive:** one small additive table + one enum + one writer + one middleware factory gives
  graded, audited, server-authoritative section access reused verbatim by Trash. No change to the
  existing app/library grant paths. Rollback is dropping an additive table (no role loses access —
  every role falls back to its documented default).
- **Negative / trade-offs:** section access is a *separate* dimension from app grants, so an admin
  edits it in a distinct control (DESIGN-009 D-08). The no-row default means "grant nothing" for a
  role is expressed by an explicit `disabled` row, not by absence — deliberate, so new members are
  not locked out of read-only browse.
- **Neutral:** `role_section_permissions` joins the `no-direct-state-writes` guard list (all six
  patterns) so only the domain writer can touch it.

## Alternatives considered

- **A boolean `can_access_section` per (role, section).** Rejected — cannot express Read-Only,
  which is the whole point (browse/export without mutation).
- **Reuse `role_app_grants` with synthetic "app" rows for sections.** Rejected — sections are not
  catalog apps (no URL/icon/order), and it would overload the app-grant audit semantics.
- **A per-section boolean pair (visible, editable).** Rejected — a single ordered `level` enum is
  simpler to gate on and extends cleanly (PLAN-006 layers finer per-action grants, not more
  booleans).
