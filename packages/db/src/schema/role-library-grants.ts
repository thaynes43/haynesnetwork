import { pgTable, uuid, primaryKey } from 'drizzle-orm/pg-core';
import { roles } from './roles';
import { plexLibraries } from './plex-libraries';

/**
 * ADR-017 / DESIGN-007 D-01 — the Plex libraries a role allows its members to self-add
 * (a POSITIVE allow-list, exact mirror of role_app_grants). A user may self-share exactly
 * the libraries their role grants (union of nothing — one role per user, ADR-012); an
 * `is_admin` role short-circuits to ALL libraries with NO rows here. Unlike role_app_grants
 * there is no `grants_all` short-circuit — a `grants_all` (non-admin) role still needs
 * explicit library grants (ADR-017 D-08). Family libraries are simply the two rows granted
 * only to the Family role (ADR-017 D-10 — no family flag). Composite PK dedupes; both FKs
 * cascade so deleting a role or a library removes its grants.
 */
export const roleLibraryGrants = pgTable(
  'role_library_grants',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    plexLibraryId: uuid('plex_library_id')
      .notNull()
      .references(() => plexLibraries.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.plexLibraryId] })],
);

export type RoleLibraryGrantRow = typeof roleLibraryGrants.$inferSelect;
export type RoleLibraryGrantInsert = typeof roleLibraryGrants.$inferInsert;
