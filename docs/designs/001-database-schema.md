# DESIGN-001: Database schema — Phase 1 (identity, catalog, tags, audit)

- **Status:** Accepted
- **Last updated:** 2026-07-03
- **Satisfies:** PRD-001 R-02, R-03, R-04 (persistence layer), R-10..R-15, R-20..R-22, R-62;
  groundwork for R-25..R-28 (Appendix A sketch only); governed by ADR-002 (Authentik OIDC via
  Better Auth) and ADR-003 (Postgres 16 + Drizzle) — both being written in parallel, referenced
  by number + title.

## Overview

Defines the complete Postgres 16 schema for **Phase 1**: Better Auth identity tables, the
role-transition audit log, the DB-backed app catalog, per-user app grants, tags (permission
bundles), tag/user join tables, and the generic permission audit log. It also fixes the
cross-cutting rules every later design inherits: naming/type conventions, the
effective-permissions derivation (R-22), the audit-in-same-transaction rule (R-04), migration
numbering, and the catalog seed strategy (R-12/R-13).

Phase 2 ledger tables are **named as reserved** here and designed in DESIGN-005. Phase 3 Plex
tables are **sketched, non-normative**, in Appendix A.

The schema shape deliberately mirrors `todos-for-dues` (the architecture donor —
`../todos-for-dues/packages/db/src/schema/` and `migrations/0005_better_auth_tables.sql`),
including two hard-won reconciliations from that repo: Better Auth's `drizzleAdapter` does
**not** auto-create its tables, and Better Auth 1.6.x writes the OIDC `picture` claim to
`users.image` unconditionally (a missing column silently breaks the OAuth callback).

**Definition of success:** an implementation agent can transcribe §Detailed design into
`packages/db/src/schema/`, run `drizzle-kit generate`, apply the migrations to a fresh
Postgres 16, and every cited PRD requirement is satisfied at the persistence layer.

## Detailed design

### D-01 Conventions (normative for all tables, all phases)

1. **Postgres 16 only** (R-62, CLAUDE.md rule 1). Tests run against an embedded Postgres 16
   binary — no SQLite/MySQL substitution, no Docker.
2. **uuid primary keys** via `uuid('id').primaryKey().defaultRandom()` → `DEFAULT
   gen_random_uuid()`. `gen_random_uuid()` is built into Postgres ≥ 13, so **no `pgcrypto`
   extension migration is needed** (unlike todos-for-dues' `0001_extensions.sql`).
3. **snake_case column names** in SQL; camelCase property names in Drizzle declarations.
4. **`timestamptz`** everywhere: `created_at`/`updated_at` with `defaultNow()`; `updated_at`
   maintained by app code on every UPDATE (Drizzle `set()` with a SQL `now()` expression,
   as in the donor's `transitionRole`), not by triggers.
5. **Enums are `text` + CHECK constraint**, not Postgres enum types — same trade as
   todos-for-dues DESIGN-001 (easier to migrate; typed via `$type<...>()` from `enums.ts`).
6. Join tables get a surrogate `id` uuid PK plus a `UNIQUE` constraint on the natural key
   (uniform PK convention; simplifies audit references and Drizzle relations).
7. Schema files live in `packages/db/src/schema/` (one file per table + `enums.ts` +
   `index.ts` barrel); migrations in `packages/db/migrations/`.

```
packages/db/src/schema/
  enums.ts                    (ROLES, ROLE_INITIATOR_KINDS, PERMISSION_AUDIT_ACTIONS)
  users.ts                    (D-02)
  session.ts account.ts verification.ts   (D-03 — Better Auth)
  user-role-transitions.ts    (D-04)
  app-catalog.ts              (D-05)
  user-app-grants.ts          (D-06)
  tags.ts                     (D-07)
  tag-app-grants.ts           (D-08)
  user-tags.ts                (D-09)
  permission-audit.ts         (D-10)
  effective-app-grants.ts     (D-11 — pgView)
  index.ts                    (barrel)
```

### D-02 `enums.ts` + `users` (Better Auth user model)

```ts
// enums.ts
export const ROLES = ['Member', 'Admin'] as const;               // PRD-001 Actors & roles
export type Role = (typeof ROLES)[number];

export const ROLE_INITIATOR_KINDS = ['system', 'admin'] as const; // R-02 system, R-04 admin
export type RoleInitiatorKind = (typeof ROLE_INITIATOR_KINDS)[number];

export const PERMISSION_AUDIT_ACTIONS = [
  'grant_app', 'revoke_app',                        // R-15
  'create_tag', 'update_tag', 'delete_tag',         // R-20
  'apply_tag', 'remove_tag',                        // R-21
  'set_family', 'unset_family',                     // family designation (direct)
  'create_app', 'update_app', 'delete_app',         // R-11 catalog edits
] as const;
export type PermissionAuditAction = (typeof PERMISSION_AUDIT_ACTIONS)[number];
```

`users` mirrors todos-for-dues' shape with haynesnetwork's role set plus the **direct family
designation** column:

```ts
// users.ts
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    displayName: text('display_name').notNull(),          // Better Auth `name` field → mapped in ADR-002 wiring (DESIGN-002 D-02)
    role: text('role').$type<Role>().notNull().default('Member'),
    isFamily: boolean('is_family').notNull().default(false), // DIRECT family designation (see D-11 for effective-family)
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),                                  // nullable; Better Auth 1.6.x writes the OIDC `picture` claim here unconditionally — omitting it breaks the OAuth callback (todos-for-dues DESIGN-001 reconciliation 2026-05-17)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('users_role_enum', sql`${table.role} = ANY (ARRAY['Member','Admin'])`),
  ],
);
```

Key behaviours:

1. `role` defaults to `'Member'` — every successful Authentik login auto-creates a Member
   (R-03/AC-02); Admin is reached only via the bootstrap hook (R-02, DESIGN-002 D-05) or a
   future admin action, both routed through `transitionRole` (D-12).
2. `is_family` here is the **direct** designation; a user is *effectively* Family when
   `is_family` is true **or** any applied tag has `tags.is_family` (D-11). Both mutation paths
   are audited (`set_family`/`unset_family` direct; `apply_tag`/`remove_tag` for the tag path).
3. Better Auth is configured with `user.modelName: 'users'` and `fields: { name:
   'displayName' }` so its `name` field lands in `display_name` (DESIGN-002 D-02) — same
   mapping as the donor repo.
4. No credential columns: auth is OIDC-only (R-01); provider linkage lives in `account` (D-03).

### D-03 Better Auth managed tables: `session`, `account`, `verification`

Byte-for-byte the shapes from todos-for-dues (`packages/db/src/schema/{session,account,verification}.ts`,
proven against Better Auth 1.6.x by `migrations/0005_better_auth_tables.sql`). Declared in our
Drizzle schema because **`drizzleAdapter` does not auto-create tables**.

| Table | Columns (all snake_case, uuid ids `gen_random_uuid()`) | Constraints/indexes |
|-------|--------------------------------------------------------|---------------------|
| `session` | `id`, `user_id` → users ON DELETE CASCADE, `expires_at` timestamptz NOT NULL, `token` text NOT NULL UNIQUE, `ip_address`, `user_agent`, `created_at`, `updated_at` | `session_user_id_idx` |
| `account` | `id`, `user_id` → users ON DELETE CASCADE, `provider_id` text NOT NULL (always `'authentik'` in Phase 1), `account_id` text NOT NULL (OIDC `sub`), `access_token`, `refresh_token`, `id_token`, `access_token_expires_at`, `refresh_token_expires_at`, `scope`, `password` (always NULL — kept because Better Auth's base account model includes it), `created_at`, `updated_at` | `UNIQUE(provider_id, account_id)`, `account_user_id_idx` |
| `verification` | `id`, `identifier` text NOT NULL, `value` text NOT NULL, `expires_at` timestamptz NOT NULL, `created_at`, `updated_at` | `verification_identifier_idx` |

`verification` is unused by the OIDC-only flow but Better Auth's core expects the model to
exist; declaring it costs one empty table and avoids fighting the library.

### D-04 `user_role_transitions` — role-change audit (R-02, R-04)

```ts
export const userRoleTransitions = pgTable(
  'user_role_transitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    fromRole: text('from_role').$type<Role>(),             // nullable: reserved for inception rows; bootstrap promotion writes 'Member'
    toRole: text('to_role').$type<Role>().notNull(),
    initiatorId: uuid('initiator_id').references(() => users.id), // null when initiator_kind = 'system'
    initiatorKind: text('initiator_kind').$type<RoleInitiatorKind>().notNull(),
    note: text('note'),                                    // e.g. 'BOOTSTRAP_ADMIN_EMAILS promotion'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('user_role_transitions_initiator_kind_enum',
      sql`${table.initiatorKind} = ANY (ARRAY['system','admin'])`),
    index('user_role_transitions_user_created_idx').on(table.userId, table.createdAt.desc()),
  ],
);
```

Append-only by convention (no UPDATE/DELETE in app code). `initiator_kind` has no `'user'`
value — users never change their own role. Rows are written exclusively by
`transitionRole` in `packages/domain` (D-12), satisfying AC-03's "audit row with system
initiator".

### D-05 `app_catalog` — DB-backed, admin-editable catalog (R-11, R-14)

```ts
export const appCatalog = pgTable(
  'app_catalog',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),                 // stable machine key, e.g. 'seerr'
    name: text('name').notNull(),                          // tile title
    description: text('description'),                      // tile subtitle
    url: text('url').notNull(),                            // R-14 CHECK below
    icon: text('icon'),                                    // key into the inline-SVG ICON_KEYS registry in packages/ui (no external fetches; themable via CSS tokens; see DESIGN-003 D-10)
    defaultVisible: boolean('default_visible').notNull().default(false), // R-12 vs R-13
    sortOrder: integer('sort_order').notNull().default(0), // R-11 display order
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('app_catalog_url_haynesnetwork_only',
      sql`${table.url} ~ '^https://[a-z0-9.-]+\\.haynesnetwork\\.com(/.*)?$'`),
  ],
);
```

**The URL CHECK is the DB-level enforcement of R-14** (never link users to
`*.haynesops.com` — CLAUDE.md rule 3). Note the regex is end-anchored with `(/.*)?$`: the
sketch form `^https://[a-z0-9.-]+\.haynesnetwork\.com` (prefix-only) would accept
`https://evil.haynesnetwork.com.attacker.io` because nothing constrains what follows `.com`.
The anchored form requires the hostname to *end* in `.haynesnetwork.com`, optionally followed
by a path. The app layer (Zod on the catalog tRPC mutations) validates first with a friendly
error; the CHECK is the backstop that survives any future code path. Every catalog write is
also audited (`create_app`/`update_app`/`delete_app` in D-10) per R-04's spirit — a URL edit
is a permission-relevant change.

Dashboard query (AC-04): visible tiles = `default_visible` entries ∪ effective grants (D-11),
ordered by `sort_order, name`.

### D-06 `user_app_grants` — direct per-user grants (R-15)

```ts
export const userAppGrants = pgTable(
  'user_app_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    appId: uuid('app_id').notNull().references(() => appCatalog.id, { onDelete: 'cascade' }),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }), // null = grantor since deleted
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('user_app_grants_user_app_unique').on(table.userId, table.appId),
    index('user_app_grants_user_id_idx').on(table.userId),
  ],
);
```

`ON DELETE CASCADE` from both `users` and `app_catalog`: deleting a catalog entry removes the
grants pointing at it (the durable history lives in `permission_audit`, whose FK is SET NULL +
jsonb snapshot — D-10). Grant/revoke goes through domain helpers that write the
`grant_app`/`revoke_app` audit row in the same transaction (D-12).

### D-07 `tags` — permission bundles (R-20)

```ts
export const tags = pgTable('tags', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  description: text('description'),
  isFamily: boolean('is_family').notNull().default(false), // tag-derived family designation (R-20 bundle includes family)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

`updated_at` is included beyond the sketch because tags are admin-*editable* (R-20) and D-01
convention pairs the timestamps. A tag's bundle = its `tag_app_grants` rows (D-08), its
`is_family` flag, and (Phase 3) its library grants (Appendix A). US-05's "family" tag is
simply `is_family = true` + family-library grants once Phase 3 lands.

### D-08 `tag_app_grants` — apps bundled into a tag (R-20)

```ts
export const tagAppGrants = pgTable(
  'tag_app_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
    appId: uuid('app_id').notNull().references(() => appCatalog.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('tag_app_grants_tag_app_unique').on(table.tagId, table.appId)],
);
```

Editing a tag's bundle audits as `update_tag` with the delta in `permission_audit.detail`.

### D-09 `user_tags` — tag applications (R-21)

```ts
export const userTags = pgTable(
  'user_tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
    appliedBy: uuid('applied_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('user_tags_user_tag_unique').on(table.userId, table.tagId),
    index('user_tags_user_id_idx').on(table.userId),
  ],
);
```

Applying/removing a tag never copies rows into `user_app_grants` — tag permissions are
**derived at read time** (D-11), so removing a tag removes exactly the tag-derived
permissions and nothing else (AC-06).

### D-10 `permission_audit` — generic audit log (R-04)

```ts
export const permissionAudit = pgTable(
  'permission_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }), // null = system
    action: text('action').$type<PermissionAuditAction>().notNull(),
    subjectUserId: uuid('subject_user_id').references(() => users.id, { onDelete: 'set null' }),
    appId: uuid('app_id').references(() => appCatalog.id, { onDelete: 'set null' }),
    tagId: uuid('tag_id').references(() => tags.id, { onDelete: 'set null' }),
    detail: jsonb('detail'),                              // denormalized snapshot: slugs/names/before-after — keeps history readable after SET NULL
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('permission_audit_action_enum', sql`${table.action} = ANY (ARRAY[
      'grant_app','revoke_app',
      'create_tag','update_tag','delete_tag',
      'apply_tag','remove_tag',
      'set_family','unset_family',
      'create_app','update_app','delete_app'
    ])`),
    index('permission_audit_created_idx').on(table.createdAt.desc()),
    index('permission_audit_subject_created_idx').on(table.subjectUserId, table.createdAt.desc()),
  ],
);
```

Rules:

1. **Append-only.** No UPDATE/DELETE in app code, ever.
2. Referential columns use `ON DELETE SET NULL` (not CASCADE) so audit history outlives the
   subject; `detail` jsonb always carries the human-readable snapshot (`{"app_slug":"immich",
   "app_name":"Immich"}`, tag names, before/after values) so a row is meaningful even after
   its FKs null out.
3. Extending the action list = new migration dropping and re-adding the CHECK, plus the
   `enums.ts` array, in the same change. Phase 2/3 designs (fix actions, library grants) will
   extend it this way or define sibling audit tables — decided in DESIGN-005.
4. Role changes are **not** in this table — they have the dedicated shape in D-04. Both tables
   observe the same-transaction rule (D-12).

### D-11 Effective permissions derivation (R-22, AC-06)

**Decision: a SQL view + a typed wrapper in `packages/domain`** (not domain-query-only). The
view gives one canonical definition queryable from `psql` during ops/debugging; the domain
wrapper gives the app typed access. Declared as a Drizzle `pgView` in
`schema/effective-app-grants.ts` so `drizzle-kit generate` emits it into `0001` (if the
installed drizzle-kit version doesn't emit views, the statement is appended to `0001` by
hand — reviewer verifies).

```sql
CREATE VIEW effective_app_grants AS
  SELECT uag.user_id,
         uag.app_id,
         'direct'::text AS source,     -- provenance (R-22: "UI shows where each permission comes from")
         NULL::uuid     AS tag_id
    FROM user_app_grants uag
  UNION ALL
  SELECT ut.user_id,
         tag_grant.app_id,
         'tag'::text    AS source,
         ut.tag_id
    FROM user_tags ut
    JOIN tag_app_grants tag_grant ON tag_grant.tag_id = ut.tag_id;
```

- `UNION ALL` deliberately preserves one row per provenance: a user granted Immich directly
  *and* via two tags yields three rows. The dashboard dedupes on `app_id`; the admin
  permissions UI renders every row's provenance (R-22). Removing a tag removes exactly its
  rows (AC-06).
- **Dashboard visibility** (AC-04/AC-05): `default_visible` catalog entries ∪
  `effective_app_grants` rows for the user — evaluated per request, so an admin grant appears
  on the user's next dashboard query without re-login (AC-05).
- **Effective family** (consumed by Phase 3): `users.is_family OR EXISTS (SELECT 1 FROM
  user_tags ut JOIN tags t ON t.id = ut.tag_id WHERE ut.user_id = $1 AND t.is_family)` —
  exposed as `isEffectivelyFamily(userId)` in `packages/domain`. Kept as a domain query (no
  second view) until Phase 3 gives it a real read surface.
- No materialization: the whole dataset is household-scale; derive-on-read is O(rows-you-can-
  count-on-fingers) and can never go stale.

### D-12 The audit-in-same-transaction rule (R-04)

Every mutation of `users.role`, `users.is_family`, `user_app_grants`, `tags`,
`tag_app_grants`, `user_tags`, or `app_catalog` **must** write its audit row
(`user_role_transitions` or `permission_audit`) inside the same `db.transaction(...)` as the
mutation. Enforced by convention: the only code allowed to write these tables lives in
`packages/domain` single-writer helpers —

| Helper | Mutates | Audits |
|--------|---------|--------|
| `transitionRole` | `users.role` | `user_role_transitions` |
| `setFamilyDesignation` | `users.is_family` | `permission_audit` (`set_family`/`unset_family`) |
| `grantApp` / `revokeApp` | `user_app_grants` | `permission_audit` |
| `createTag` / `updateTag` / `deleteTag` | `tags`, `tag_app_grants` | `permission_audit` |
| `applyTag` / `removeTag` | `user_tags` | `permission_audit` |
| `createApp` / `updateApp` / `deleteApp` | `app_catalog` | `permission_audit` |

`transitionRole` is ported from todos-for-dues `packages/domain/src/user-role-transitions.ts`,
including its optimistic-concurrency guard (`UPDATE ... WHERE role = expectedFromRole
RETURNING`; zero rows → `ConcurrentTransitionError`), minus the min-Admin trigger handling
(haynesnetwork has no such trigger — the bootstrap allowlist R-02 is the Admin-recovery
mechanism, so a zero-Admin state is always recoverable by the owner logging in).

### D-13 Migration numbering

Drizzle convention, `packages/db/migrations/`, 4-digit sequence:

| Migration | Contents | How produced |
|-----------|----------|--------------|
| `0001_init.sql` | All D-02..D-10 tables, CHECKs, indexes, FKs, and the D-11 view | `drizzle-kit generate` (reviewer diffs against this doc) |
| `0002_seed_app_catalog.sql` | Catalog seed (D-14) | hand-written |

No extensions migration (D-01 item 2). Migrations run as an init container in-cluster (R-62)
and via `pnpm --filter @app/db migrate` locally/tests.

### D-14 Seed data — `0002_seed_app_catalog.sql` (R-12, R-13)

**Decision: seed only when `app_catalog` is empty** (guard: `WHERE NOT EXISTS (SELECT 1 FROM
app_catalog)`), not per-row UPSERT. Rationale: the catalog is admin-owned data after first
boot (R-11). A per-row `ON CONFLICT (slug) DO NOTHING` would *resurrect rows an admin
deliberately deleted* on the next deploy, and `DO UPDATE` would overwrite admin edits (e.g.
the Seerr cutover URL flip, PRD Q-02). Empty-table-only means the seed runs exactly once per
environment and every subsequent catalog change flows through the audited admin UI. Trade-off
accepted: new *seeded* defaults for existing environments must ship as a new migration or be
entered via the UI.

```sql
-- Seed the app catalog on first deploy only. Admin edits/deletions win forever after
-- (R-11); later catalog changes go through the admin UI, audited via permission_audit.
INSERT INTO app_catalog (slug, name, description, url, icon, default_visible, sort_order)
SELECT * FROM (VALUES
  -- R-12: default-visible tiles
  ('seerr',      'Seerr',      'Request movies & TV shows',            'https://overseerr.haynesnetwork.com', 'seerr',      true,  10),
  ('plex',       'Plex',       'Watch — legacy haynestower server',    'https://plex.haynesnetwork.com',      'plex',       true,  20),
  ('k8plex',     'K8Plex',     'Watch — k8s Plex server',              'https://k8plex.haynesnetwork.com',    'plex',       true,  30),
  -- R-13: admin-grantable tiles, seeded hidden
  ('plexops',    'PlexOps',    'Watch — ops Plex server',              'https://plexops.haynesnetwork.com',   'plex',       false, 40),
  ('immich',     'Immich',     'Photo & video library',                'https://immich.haynesnetwork.com',    'immich',     false, 50),
  ('open-webui', 'Open WebUI', 'Self-hosted AI chat',                  'https://ai.haynesnetwork.com',        'open-webui', false, 60),
  ('paperless',  'Paperless',  'Document management',                  'https://paperless.haynesnetwork.com', 'paperless',  false, 70),
  ('tautulli',   'Tautulli',   'Plex activity & stats',                'https://tautulli.haynesnetwork.com',  'tautulli',   false, 80)
) AS seed(slug, name, description, url, icon, default_visible, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM app_catalog);
```

URL verification (2026-07-03, DNS + content probe from the dev machine): `overseerr`, `plex`,
`k8plex`, `plexops`, `immich`, `paperless`, `tautulli` subdomains all resolve
(individual records — no wildcard; `openwebui`/`webui`/`chat` are NXDOMAIN). Open WebUI is
served at **`ai.haynesnetwork.com`** (page title "Open WebUI" confirmed). `sort_order` is
seeded in gaps of 10 so admins can interleave without renumbering. Seerr's URL flips to the
k8s instance via a one-field admin edit at cutover (PRD Q-02).

### D-15 Phase 2 & Phase 3 reservations

**Phase 2 (media ledger — designed in DESIGN-005):** the table names `media_items`,
`ledger_events`, `wanted_items`, and `fix_requests` are **reserved** for R-40..R-52. No DDL in
Phase 1; nothing else may claim these names. DESIGN-005 will also decide how Fix/restore
actions are audited (extend D-10's action CHECK vs. sibling audit tables).

**Phase 3 (Plex library self-service):** sketched in Appendix A, non-normative.

## Alternatives considered

- **Postgres enum types instead of text + CHECK** — rejected for Phase 1 (migration friction
  when values evolve; donor repo's experience). Revisit post-stabilization.
- **Composite PKs on join tables** (`(user_id, app_id)` etc.) — rejected in favor of surrogate
  uuid + UNIQUE (D-01.6): uniform convention, simpler audit/detail references.
- **Copying tag permissions into `user_app_grants` on apply** — rejected: breaks AC-06
  (removal couldn't distinguish tag-derived from direct) and loses R-22 provenance. Derivation
  at read time (D-11) is trivially cheap at this scale.
- **Materialized view / cached effective permissions** — rejected: household-scale data,
  staleness risk for zero measurable win.
- **Per-row UPSERT seed (`ON CONFLICT DO NOTHING`)** — rejected (D-14): resurrects
  admin-deleted rows on redeploy. Empty-table-only guard chosen; documented trade-off.
- **Folding role changes into `permission_audit`** — rejected: role transitions have a
  from/to shape and a proven donor implementation (`transitionRole`); keeping them separate
  preserves that port (D-04, D-12).
- **Prefix-only URL regex** (as sketched) — tightened with `(/.*)?$` end-anchor; see D-05 for
  the bypass it closes.

## Test strategy

Integration tests in `packages/db/__tests__/` against **embedded Postgres 16** (R-62; no
Docker in this WSL distro — CLAUDE.md rule 1):

- **Migrations:** fresh DB → apply all → no errors; re-apply `0002` → no-op.
- **Seed semantics (D-14):** seeded catalog matches R-12/R-13 exactly (3 visible, 5 hidden);
  after deleting a seeded row and re-running `0002`, the row stays deleted; after editing a
  URL and re-running, the edit survives.
- **Constraints:** `users_role_enum`, `permission_audit_action_enum`,
  `user_role_transitions_initiator_kind_enum` reject bad values (SQLSTATE 23514); UNIQUE
  pairs reject duplicates (23505); FK cascades/SET NULLs behave as declared.
- **R-14 CHECK (D-05):** rejects `https://sonarr.haynesops.com/...`, `http://...`,
  `https://evil.haynesnetwork.com.attacker.io/`; accepts `https://plex.haynesnetwork.com` and
  `https://plex.haynesnetwork.com/web/index.html`.
- **View (D-11):** direct-only, tag-only, direct+tag (distinct provenance rows), two tags
  granting the same app (two rows); removing a tag removes only its rows (AC-06); dashboard
  query returns default-visible ∪ granted (AC-04/AC-05).
- **Domain helpers (D-12):** each helper writes mutation + audit atomically; a forced audit
  failure rolls back the mutation; `transitionRole` concurrency guard errors on stale
  `expectedFromRole`.

## Appendix A — Phase 3 sketch: Plex servers & libraries (NON-NORMATIVE)

Columns **proposed, not final** — Phase 3 design (post-DESIGN-005) finalizes after inspecting
the three servers' library naming via the Plex API (PRD Q-03). Recorded now only so Phase 1
naming doesn't collide.

| Table | Proposed columns |
|-------|------------------|
| `plex_servers` | `id` uuid PK; `slug` text UNIQUE (`'k8plex'`, `'plexops'`, `'haynestower'`); `name` text; `base_url` text (server-side URL — may be `*.svc.cluster.local` or LAN; never user-facing, so R-14's CHECK does **not** apply here); `token_ref` text (1Password item/field *reference*, never the token itself — CLAUDE.md rule 7); `machine_identifier` text; `created_at`/`updated_at` |
| `plex_libraries` | `id` uuid PK; `server_id` → plex_servers CASCADE; `section_key` text (Plex section id); `name` text; `media_type` text; `is_family_only` boolean default false (true for `HNet Home Videos`, `HNet Photos` — R-26); `synced_at` timestamptz; UNIQUE(`server_id`, `section_key`) |
| `user_library_grants` | `id`; `user_id`; `library_id`; `granted_by`; `created_at`; UNIQUE(`user_id`, `library_id`) — per-user allowed set (R-25/R-27) |
| `tag_library_grants` | `id`; `tag_id`; `library_id`; `created_at`; UNIQUE(`tag_id`, `library_id`) — tag-bundled allowed set (R-20/R-27) |

Open modeling question deferred to Phase 3: R-26's default is *allow-all-except-family-only*,
which inverts the grant model above (grants may become exceptions/deny rows, or an
allowed-set snapshot). Effective-family (D-11) gates `is_family_only` rows either way.
Library-change audit actions will extend D-10 per its extension rule.

## Open questions

| ID | Question | Resolution |
|----|----------|------------|
| Q-01 | Icon registry contract: exact `icon` key set (registry lives in `packages/ui` per DESIGN-003 D-10 so `packages/api` can validate keys). Owner of the SVG assets? | (open — UI design doc) |
| Q-02 | `open-webui` tile: is `ai.haynesnetwork.com` the URL the owner wants on the tile long-term (verified serving Open WebUI today), or is a rename planned? | (open — verified working 2026-07-03; admin can edit later either way) |
| Q-03 | Should deleting a catalog app be a soft delete (`archived_at`) instead of hard DELETE, given grants cascade away? Phase 1 assumes hard delete + audit snapshot (D-10). | (open — lean: hard delete is fine at this scale) |
| Q-04 | Does drizzle-kit at the version we pin emit `CREATE VIEW` from `pgView` definitions (D-11), or does `0001` need a hand-written append? | (open — resolve at scaffold time; either lands in 0001) |
