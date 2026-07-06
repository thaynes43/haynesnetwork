import {
  permissionAudit,
  plexLibraries,
  plexServers,
  roleLibraryGrants,
  roles,
  type DbClient,
  type Transaction,
} from '@hnet/db';
import { asc, eq, inArray } from 'drizzle-orm';
import { NotFoundError, SystemRoleImmutableError } from './errors';
import { inTransaction } from './db-client';

/**
 * ADR-017 / DESIGN-007 D-04 — the single writer for a Role's Plex library grants
 * (role_library_grants), mirroring updateRole's replace-whole-set + same-tx audit. The Admin
 * role is immutable here: it sees every library implicitly (is_admin short-circuit) and stores
 * NO grant rows (ADR-017 D-08/D-10). Every edit co-writes one 'update_role_libraries'
 * permission_audit row with the before/after delta.
 */

interface LibraryRef {
  id: string;
  name: string;
  serverSlug: string;
}

async function libraryRefs(tx: Transaction, libraryIds: string[]): Promise<LibraryRef[]> {
  if (libraryIds.length === 0) return [];
  const rows = await tx
    .select({ id: plexLibraries.id, name: plexLibraries.name, serverSlug: plexServers.slug })
    .from(plexLibraries)
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(inArray(plexLibraries.id, libraryIds))
    .orderBy(asc(plexServers.slug), asc(plexLibraries.name));
  if (rows.length !== new Set(libraryIds).size) {
    const found = new Set(rows.map((r) => r.id));
    const missing = libraryIds.filter((id) => !found.has(id));
    throw new NotFoundError(`Plex library(s) not found: ${missing.join(', ')}`);
  }
  return rows;
}

export interface SetRoleLibrariesInput {
  db?: DbClient;
  roleId: string;
  /** The whole grant set — replace-whole-bundle semantics (mirrors updateRole appIds). */
  libraryIds: string[];
  actorId: string | null;
}

export async function setRoleLibraries(input: SetRoleLibrariesInput): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, name: roles.name, isAdmin: roles.isAdmin })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .for('update');
    if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);
    if (role.isAdmin) {
      throw new SystemRoleImmutableError(
        'The Admin role can access every Plex library and has no editable library set.',
      );
    }

    const after = await libraryRefs(tx, input.libraryIds);

    const before = await tx
      .select({ id: roleLibraryGrants.plexLibraryId, name: plexLibraries.name, serverSlug: plexServers.slug })
      .from(roleLibraryGrants)
      .innerJoin(plexLibraries, eq(plexLibraries.id, roleLibraryGrants.plexLibraryId))
      .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
      .where(eq(roleLibraryGrants.roleId, input.roleId))
      .orderBy(asc(plexServers.slug), asc(plexLibraries.name));

    await tx.delete(roleLibraryGrants).where(eq(roleLibraryGrants.roleId, input.roleId));
    if (after.length > 0) {
      await tx
        .insert(roleLibraryGrants)
        .values(after.map((lib) => ({ roleId: input.roleId, plexLibraryId: lib.id })));
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_role_libraries',
      roleId: input.roleId,
      detail: { role_name: role.name, before, after },
    });

    return { changed: true };
  });
}
