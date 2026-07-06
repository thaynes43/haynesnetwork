import { pgTable, uuid, primaryKey } from 'drizzle-orm/pg-core';
import { roles } from './roles';
import { plexServers } from './plex-servers';

/**
 * ADR-024 — role-scoped "all libraries on server X" grants. Presence of a row means the role
 * grants its members ALL libraries (including future ones) on that Plex server: a member of such
 * a role may self-toggle their own account between the plex.tv all-libraries state and an explicit
 * per-section list (seeded with their current full set — no access loss). This sits ALONGSIDE the
 * per-library `role_library_grants` allow-list (a role may have both explicit library grants and
 * an all-grant on the same or different servers); the effective allowed set is their union.
 *
 * An `is_admin` role stores NO rows here and implies all-libraries on every server (mirrors the
 * role_library_grants admin short-circuit). Composite PK dedupes; both FKs cascade so deleting a
 * role or a server removes its all-grants. Written only by the @hnet/domain setRoleLibraries
 * single-writer, which co-writes an `update_role_libraries` permission_audit row in the SAME
 * transaction (hard rule 6).
 */
export const rolePlexServerAllGrants = pgTable(
  'role_plex_server_all_grants',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    plexServerId: uuid('plex_server_id')
      .notNull()
      .references(() => plexServers.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.plexServerId] })],
);

export type RolePlexServerAllGrantRow = typeof rolePlexServerAllGrants.$inferSelect;
export type RolePlexServerAllGrantInsert = typeof rolePlexServerAllGrants.$inferInsert;
