import { pgTable, uuid, primaryKey } from 'drizzle-orm/pg-core';
import { roles } from './roles';
import { appCatalog } from './app-catalog';

/**
 * ADR-012 — the apps a role grants (replaces tag_app_grants + the per-app default_visible
 * flag). A user's visible tiles = the apps their role grants (or ALL apps if their role
 * is_admin, in which case there are NO rows here for that role — access is implicit).
 * Composite PK dedupes (role, app); both FKs cascade so deleting a role or an app removes
 * its grants.
 */
export const roleAppGrants = pgTable(
  'role_app_grants',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    appId: uuid('app_id')
      .notNull()
      .references(() => appCatalog.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.appId] })],
);

export type RoleAppGrantRow = typeof roleAppGrants.$inferSelect;
export type RoleAppGrantInsert = typeof roleAppGrants.$inferInsert;
