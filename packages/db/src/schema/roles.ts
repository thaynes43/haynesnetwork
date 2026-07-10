import { pgTable, uuid, text, timestamp, integer, boolean, check, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { METRICS_LEVELS, type MetricsLevel } from './enums';

// ADR-037 C-01 — SQL list for the roles.metrics_level CHECK (single source of truth = METRICS_LEVELS).
const METRICS_LEVELS_SQL_LIST = METRICS_LEVELS.map((l) => `'${l}'`).join(',');

/**
 * Fixed ids for the two seeded system roles (migration 0007). Fixed (not random) so
 * `users.role_id` can carry a DEFAULT — a Postgres column default can't be a subquery —
 * which is what lands every Better-Auth-created user in the Default role.
 */
export const SEEDED_ROLE_IDS = {
  admin: '22222222-2222-4222-8222-222222222222',
  default: '11111111-1111-4111-8111-111111111111',
} as const;

/**
 * ADR-012 — a Role is an admin-managed named group with an editable app set; every user
 * has exactly one (`users.role_id`). Two roles are seeded and system-locked:
 *   - Admin (`is_admin`): superuser — all catalog apps implicitly (no role_app_grants
 *     rows), grants admin access, immutable (no rename/edit/delete). Bootstrap emails
 *     land here.
 *   - Default (`is_default`): the role assigned to every new user; its app set replaces
 *     the old per-app `default_visible` flag and is editable, but the role can't be
 *     renamed or deleted.
 * Partial unique indexes guarantee at most one Admin and one Default role; the CHECK
 * forbids a single role being both.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull().unique(),
    description: text('description'),
    isAdmin: boolean('is_admin').notNull().default(false),
    isDefault: boolean('is_default').notNull().default(false),
    // ADR-012: grant EVERY catalog app (incl. ones added later) without admin console
    // access. Admin implies this via is_admin; a non-admin role sets grants_all directly
    // ("All apps" in the UI). When true, the role stores NO role_app_grants rows.
    grantsAll: boolean('grants_all').notNull().default(false),
    // ADR-037 C-01 (PLAN-017 Metrics) — the role's metrics access level (T-107). Single value per role
    // (like grants_all); default 'limited'. Admin implies 'full' via the session short-circuit. Written
    // ONLY by the @hnet/domain setRoleMetricsLevel single-writer (co-writes permission_audit in-tx).
    metricsLevel: text('metrics_level').$type<MetricsLevel>().notNull().default('limited'),
    // ADR-045 C-01 (PLAN-026 Authentik role portal) — opt-in: when true this role PROJECTS to an
    // Authentik group (the cross-app role primitive). Creating/flipping-on a synced tier auto-creates
    // the Authentik group (name = role name lowercased) + the same-named Open WebUI group and adds it to
    // the owned-groups allowlist; assigning the role then writes that owned-group membership. Internal /
    // experimental roles keep this false and stay app-local. Admin/Default are NOT synced tiers; the
    // seeded Family role IS (migration 0036 backfills it — it projects to the pre-existing `family` group).
    syncedTier: boolean('synced_tier').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('roles_not_admin_and_default', sql`NOT (${table.isAdmin} AND ${table.isDefault})`),
    check(
      'roles_metrics_level_enum',
      sql`${table.metricsLevel} = ANY (ARRAY[${sql.raw(METRICS_LEVELS_SQL_LIST)}])`,
    ),
    uniqueIndex('roles_single_admin_idx').on(table.isAdmin).where(sql`${table.isAdmin}`),
    uniqueIndex('roles_single_default_idx').on(table.isDefault).where(sql`${table.isDefault}`),
  ],
);

export type RoleRow = typeof roles.$inferSelect;
export type RoleInsert = typeof roles.$inferInsert;
