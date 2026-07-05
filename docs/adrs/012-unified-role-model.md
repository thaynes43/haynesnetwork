# ADR-012: Unified Role model — one admin-managed Role per user

- **Status:** Accepted
- **Date:** 2026-07-05
- **Deciders:** Tom Haynes

## Context and problem statement

Phase 1 shipped **four overlapping authorization mechanisms**, and administering them
together was confusing:

1. A `'Member' | 'Admin'` text enum on `users.role` (ADR-002 C-04; DESIGN-001 D-02).
2. **Tags** — admin-created permission bundles (`tags` + `tag_app_grants` + `user_tags`,
   DESIGN-001 D-07..D-09) carrying app grants and a family flag.
3. A **family designation** — both direct (`users.is_family`) and tag-derived
   (`tags.is_family`), gating Phase-3 family-only Plex libraries.
4. Per-app **default visibility** (`app_catalog.default_visible`, DESIGN-001 D-05) plus
   per-user **direct grants** (`user_app_grants`, DESIGN-001 D-06).

Effective apps were the union of default-visible entries, direct grants, and tag grants,
computed through the `effective_app_grants` SQL view (DESIGN-001 D-11) with per-source
provenance. To answer "what can this user see?" an admin had to reason across a role enum,
a set of tags, a per-user grant list, and a per-app default flag simultaneously.

Two of these were also dead weight pre-1.0: **"Family" was functionally inert** — a
Phase-3 placeholder with no library-gating built yet (glossary T-05, T-17..T-21) — and the
default-visible/direct-grant split existed only because there was no role to hang an app
set on. The owner wanted one mental model for authorization before Phase 3.

## Decision drivers

1. **One mental model for the admin surface.** "What can this user see?" should have a
   single answer: their role. Household-scale administration, not RBAC-for-enterprise.
2. **Preserve the single-writer / audit-in-transaction invariant** (ADR-003, R-04): every
   role/permission mutation still co-writes its audit row in the same transaction.
3. **Keep the tRPC role gate cheap** — the session should carry enough to gate
   `adminProcedure` without an extra query (the property ADR-002 C-04 bought).
4. **Drop inert surface** — no "Family" flag, no default-visible column, no per-user grant
   table if a role can express the same thing more simply.
5. **Pre-1.0, staging-only data.** No production users depend on the old shape, so a
   destructive migration is on the table if it is materially simpler.

## Considered options

- **Single role per user** (chosen) vs **multi-role / additive** (a user carries a set of
  roles whose app sets union, tag-style). Multi-role is strictly more expressive but
  reintroduces the "which of my several grant sources produced this?" provenance problem
  the tag model already had — the exact complexity being removed. The owner chose
  **single-role** for simplicity: one row, one answer, no union at read time.
- **Roles-only** (chosen) vs **roles + retained per-user grants**. Keeping `user_app_grants`
  as an override layer on top of roles would preserve fine-grained control but keeps two
  provenances (role + direct) and the dedupe/removal semantics of AC-06. Chosen
  **roles-only**: to give one user a different app set, an admin makes (or reuses) a role.
- **Clean-cut migration** (chosen) vs **preserve/backfill** the tag/grant/family history.
  A preserving migration would map each user's effective app set into a synthesized
  per-user role and keep the old audit trail. Chosen **clean cut** (migration 0007): the
  data is staging-only and disposable pre-1.0, and a backfill that fabricates one role per
  distinct app set would leave a mess of near-duplicate roles for an admin to reconcile.

## Decision outcome

Chosen option: **one unified, admin-managed Role per user.**

> **Amended (2026-07-05, shipped after this ADR):** three refinements landed with the code.
> (1) **`roles.grants_all`** — a boolean that grants a **non-admin** role EVERY catalog app
> (including ones added later) with **no** `role_app_grants` rows, i.e. Admin's all-apps reach
> **without** admin-console access; effective apps = all apps when `is_admin OR grants_all`
> (C-11). (2) **Migration 0007 seeds THREE roles**, not two: the Admin and Default **system**
> roles **plus a normal `Family` role** (`is_admin`/`is_default`/`grants_all` all false) —
> "Extended family — access to every app except Tautulli" — the concrete example this outcome
> names, fully editable and deletable like any admin-created role (C-12). (3) **Default's
> seeded app set is seerr/plex/k8plex/plexops** (PlexOps added — basic users get it too), not
> the old three.

- A **Role** is an admin-managed row (`roles`) with a name, description, `sort_order`, and
  an **editable app set** (`role_app_grants`). Every user has **exactly one**
  (`users.role_id`, `ON DELETE RESTRICT`, DB-defaulted to the seeded Default role so
  Better-Auth-created rows land there without app involvement).
- **Three seeded, fixed-id roles** (migration 0007):
  - **Admin** (`is_admin`) — the superuser role: **implicit ALL apps** (holds no
    `role_app_grants` rows — new catalog apps are included automatically), grants admin
    console access, and is **fully immutable** (no rename, no app-set edit, no delete).
    `BOOTSTRAP_ADMIN_EMAILS` land here (R-02). The **last** Admin-role member cannot be
    moved off it (`LastAdminError`).
  - **Default** (`is_default`) — the role assigned to every new user. Seeded app set:
    seerr, plex, k8plex, **plexops**. Its app set and description are **editable**, but it
    **cannot be renamed or deleted**.
  - **Family** — a normal (editable, deletable) role seeded as the "extended family"
    example: every app **except Tautulli**. Existing `is_family` users migrate here.
- **Admins create more roles** with editable app sets and assign users to them. A role may
  instead **grant ALL apps** (`grants_all` — "All apps" in the UI, auto-includes apps added
  later) *without* admin-console access.
- **Effective apps = the user's role's app set** — or **ALL catalog apps** if the role is
  `is_admin` **or** `grants_all`. Computed by `effectiveAppsForUser`
  (`packages/domain/src/effective-apps.ts`);
  there is a single provenance (the role), so `EffectiveApp` no longer carries a source/tag
  field.
- **Deleting a custom role reassigns its members to Default** in the same transaction, then
  deletes (grants cascade), so `users.role_id` is never orphaned.
- **Session** carries `role = { id, name, isAdmin }` (hydrated `users ⋈ roles` in
  `session-extension`); `adminProcedure` gates on `ctx.user.role.isAdmin`.
- **Gone entirely:** the `'Member' | 'Admin'` text enum; `tags` / `tag_app_grants` /
  `user_tags`; per-user `user_app_grants`; `users.is_family` and `tags.is_family`;
  `app_catalog.default_visible`; the `effective_app_grants` view.

Shipped in `roles`, `role_app_grants`, `users.role_id`, the recreated
`user_role_transitions` (`from_role_id`/`to_role_id`), `permission_audit.role_id`, migration
`0007_unified_roles.sql` (a clean cut), `packages/domain/src/roles.ts` +
`effective-apps.ts`, the `roles` tRPC router + `users.setRole`, and the `/admin/roles` UI.
Branch `feat/unified-roles`, pending owner validation.

### Consequences

| ID | Consequence |
|----|-------------|
| C-01 | Good: one answer to "what can this user see?" — their role's app set (or all apps if Admin). No default-visible ∪ direct ∪ tag union, no provenance to render. `effectiveAppsForUser` is two simple queries (admin → all apps; else role_app_grants ⋈ app_catalog). |
| C-02 | Good: the single-writer / audit-in-transaction invariant (ADR-003, R-04) is preserved. `createRole`/`updateRole`/`deleteRole` co-write `permission_audit` (`create_role`/`update_role`/`delete_role`); `assignRole` co-writes `user_role_transitions` — each in one `db.transaction`. The no-direct-state-writes guard test now guards `roles`/`role_app_grants` alongside `users`/`permission_audit`/`app_catalog`. |
| C-03 | Good: `adminProcedure` stays a zero-extra-query gate — the session carries `role.isAdmin` (hydrated once in `session-extension`), preserving the property ADR-002 C-04 bought while replacing the enum with a FK. |
| C-04 | Good: a new user is a plain FK default. `users.role_id` DB-defaults to the fixed Default role id (a column default cannot be a subquery, hence fixed ids), so Better Auth inserts land in Default with no app-layer step; bootstrap then reassigns allowlisted emails to Admin via `assignRole` (idempotent — repeat logins no-op, AC-03). |
| C-05 | Good: the console can't lock itself out. `assignRole` refuses to move the last Admin-role member off Admin (`LastAdminError` → `LAST_ADMIN`, CONFLICT). Combined with the bootstrap allowlist (R-02), a zero-Admin state is unreachable. |
| C-06 | Good: system roles are tamper-proof. Partial unique indexes enforce at most one `is_admin` and one `is_default` role; a CHECK forbids a role being both; the domain writers reject editing Admin (`SystemRoleImmutableError` → `ROLE_IMMUTABLE`, FORBIDDEN), renaming/deleting Default, and deleting either. |
| C-07 | Bad (accepted): migration 0007 is a **clean cut** — it drops `tags`/`tag_app_grants`/`user_tags`/`user_app_grants` and the old `user_role_transitions` history. Existing Admin users map to the Admin role, everyone else to Default; all prior tag/grant/family assignments and role-transition audit rows are **lost**. Acceptable because the data is staging-only pre-1.0 (no production user base yet, R-64 cutover still pending). |
| C-08 | Bad (accepted): fine-grained per-user overrides are gone. To give one user a bespoke app set an admin must create (or reuse) a role. At household scale this is the intended trade — a handful of roles beats a per-user grant matrix. Revisit only if role sprawl appears. |
| C-09 | Note: **Phase 3 keeps its permission hook.** Family-only Plex library gating (R-26/R-27, glossary T-17..T-21, still unbuilt) will attach to a **role attribute** (e.g. a role-level allowed-library set / family flag on `roles`) rather than the removed `users.is_family` — the unbuilt Phase 3 design owns the concrete shape. "Family" is now just an example admin-created role, not a built-in flag. |
| C-10 | Note: new `appCode`s ship with this ADR — `ROLE_NAME_CONFLICT` (CONFLICT), `ROLE_IMMUTABLE` (FORBIDDEN), `LAST_ADMIN` (CONFLICT); `TAG_NAME_CONFLICT` is dropped. The two-place `appCode` edit in `trpc.ts` (the `APP_CODED_ERRORS` list and the `mapDomainErrors` chain) plus the DESIGN-003 D-13 table were updated together. |
| C-11 | Good (shipped after): a **non-admin role can grant all apps** without admin access. `roles.grants_all` (migration 0007) grants EVERY catalog app — including ones added later — and stores **no** `role_app_grants` rows; `effectiveAppsForUser` returns all apps when `is_admin OR grants_all`. `createRole`/`updateRole` accept `grantsAll` (true clears the explicit app set); `RoleInput`/`RolePatchInput` carry it; `/admin/roles` shows an **"All apps"** checkbox that greys out + disables the per-app checklist. Admin still implies all-apps via `is_admin`; `grants_all` is the same reach minus the console. |
| C-12 | Note (shipped after): **bootstrap seeds three roles**, not two — Admin + Default (system-locked) **plus `Family`** (a normal role: `is_admin`/`is_default`/`grants_all` all false), granting every catalog app **except Tautulli** (7 of 8). Family is the extended-family example the Decision outcome names; it is fully editable/deletable (unlike Admin/Default). Its Phase-3 Plex-library-gating meaning still attaches to a role attribute per C-09. |

## More information

- **Supersedes ADR-002 C-04** (role as a typed Better Auth `additionalField` enum): the
  role model is now a DB-backed `roles` table joined into the session, not a
  `'Member' | 'Admin'` string additionalField. ADR-002's *decision* (Authentik OIDC as the
  sole sign-in, bootstrap by email allowlist) stands unchanged — only its role-shape
  consequence is superseded; ADR-002 carries an "Amended by ADR-012" status link.
- **PRD-001:** amends the Actors & roles table and R-03, R-12, R-15 (superseded — no
  per-user grants), R-20/R-21/R-22 (tags → roles). Preserves R-26/R-27 (Phase-3 family
  libraries, now role-attached).
- **Designs:** DESIGN-001 (schema — `roles`/`role_app_grants`, `users.role_id`, recreated
  `user_role_transitions`, `permission_audit.role_id`, migration 0007, dropped
  tables/columns/view), DESIGN-002 (session role object; bootstrap via `assignRole`),
  DESIGN-003 (`roles` router + `users.setRole`; role-based `catalog.myApps`; appCode table),
  DESIGN-004 (`/admin/roles`, user Role selector, catalog drops the Default column).
- **Glossary:** DDD-001 T-02..T-05, T-10, T-13..T-16 amended; T-46..T-48 added (Role, Role
  App Grant, System Role).
- **Migration:** `packages/db/migrations/0007_unified_roles.sql`.
- **Sibling ADRs:** ADR-003 (audit-in-transaction), ADR-004 (role-gated procedure ladder).
