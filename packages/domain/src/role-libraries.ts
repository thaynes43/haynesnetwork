import {
  permissionAudit,
  plexLibraries,
  plexServers,
  roleLibraryGrants,
  rolePlexServerAllGrants,
  roles,
  type DbClient,
  type Transaction,
} from '@hnet/db';
import { asc, eq, inArray } from 'drizzle-orm';
import { NotFoundError, SystemRoleImmutableError } from './errors';
import { inTransaction } from './db-client';

/**
 * ADR-017 / DESIGN-007 D-04 / ADR-024 — the single writer for a Role's Plex library grants: the
 * per-library allow-list (role_library_grants) AND, optionally, the per-server all-libraries grants
 * (role_plex_server_all_grants). Mirrors updateRole's replace-whole-set + same-tx audit. The Admin
 * role is immutable here: it sees every library implicitly (is_admin short-circuit) and stores NO
 * grant rows (ADR-017 D-08/D-10). Every edit co-writes one 'update_role_libraries' permission_audit
 * row with the before/after delta (libraries and, when touched, all-servers).
 */

interface LibraryRef {
  id: string;
  name: string;
  serverSlug: string;
}

interface ServerRef {
  id: string;
  slug: string;
  name: string;
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

async function serverRefs(tx: Transaction, serverIds: string[]): Promise<ServerRef[]> {
  if (serverIds.length === 0) return [];
  const rows = await tx
    .select({ id: plexServers.id, slug: plexServers.slug, name: plexServers.name })
    .from(plexServers)
    .where(inArray(plexServers.id, serverIds))
    .orderBy(asc(plexServers.slug));
  if (rows.length !== new Set(serverIds).size) {
    const found = new Set(rows.map((r) => r.id));
    const missing = serverIds.filter((id) => !found.has(id));
    throw new NotFoundError(`Plex server(s) not found: ${missing.join(', ')}`);
  }
  return rows;
}

export interface SetRoleLibrariesInput {
  db?: DbClient;
  roleId: string;
  /** The whole per-library grant set — replace-whole-bundle semantics (mirrors updateRole appIds). */
  libraryIds: string[];
  /**
   * ADR-024 — the whole set of server ids the role grants ALL libraries on (replace-whole-set).
   * OMITTED (undefined) leaves the role's existing all-grants untouched (back-compat for callers
   * that only manage the per-library set); an empty array clears them.
   */
  allServerIds?: string[];
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

    // ADR-024 — replace-whole-set the per-server all-grants only when the caller manages them.
    let allServersDetail: Record<string, unknown> = {};
    if (input.allServerIds !== undefined) {
      const allBefore = await tx
        .select({ id: rolePlexServerAllGrants.plexServerId, slug: plexServers.slug, name: plexServers.name })
        .from(rolePlexServerAllGrants)
        .innerJoin(plexServers, eq(plexServers.id, rolePlexServerAllGrants.plexServerId))
        .where(eq(rolePlexServerAllGrants.roleId, input.roleId))
        .orderBy(asc(plexServers.slug));
      const allAfter = await serverRefs(tx, input.allServerIds);

      await tx.delete(rolePlexServerAllGrants).where(eq(rolePlexServerAllGrants.roleId, input.roleId));
      if (allAfter.length > 0) {
        await tx
          .insert(rolePlexServerAllGrants)
          .values(allAfter.map((s) => ({ roleId: input.roleId, plexServerId: s.id })));
      }
      allServersDetail = {
        all_servers_before: allBefore.map((s) => ({ id: s.id, slug: s.slug, name: s.name })),
        all_servers_after: allAfter.map((s) => ({ id: s.id, slug: s.slug, name: s.name })),
      };
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_role_libraries',
      roleId: input.roleId,
      detail: { role_name: role.name, before, after, ...allServersDetail },
    });

    return { changed: true };
  });
}
