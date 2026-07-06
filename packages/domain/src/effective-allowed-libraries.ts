import {
  plexLibraries,
  plexServers,
  roleLibraryGrants,
  roles,
  users,
  type DbClient,
  type PlexMediaType,
  type PlexServerSlug,
} from '@hnet/db';
import { and, asc, eq } from 'drizzle-orm';
import { resolveDb } from './db-client';

/**
 * A Plex library a user's Role permits them to self-add, annotated with the server it lives
 * on. ADR-012: one role per user ⇒ a single provenance (the user's role), so no per-source
 * fields.
 */
export interface EffectiveLibrary {
  libraryId: string;
  serverId: string;
  serverSlug: PlexServerSlug;
  serverName: string;
  machineIdentifier: string;
  sectionKey: string;
  name: string;
  mediaType: PlexMediaType;
}

const LIBRARY_COLUMNS = {
  libraryId: plexLibraries.id,
  serverId: plexServers.id,
  serverSlug: plexServers.slug,
  serverName: plexServers.name,
  machineIdentifier: plexServers.machineIdentifier,
  sectionKey: plexLibraries.sectionKey,
  name: plexLibraries.name,
  mediaType: plexLibraries.mediaType,
} as const;

/**
 * ADR-017 D-04 — the complete set of Plex libraries a user may self-share, ordered by server
 * slug then library name. An Admin-role user sees EVERY available library (implicit all —
 * mirrors effectiveAppsForUser's is_admin short-circuit); every other user sees exactly the
 * libraries their role grants (role_library_grants). Unlike effectiveAppsForUser there is NO
 * grants_all short-circuit: a grants_all (non-admin) role still needs explicit library grants
 * (ADR-017 D-08). Only `available` libraries are offered — a library that vanished from a
 * refresh is withheld but its grants/audit survive (D-04). This is the authoritative allowed
 * set the share single-writers re-derive INSIDE their transaction (TOCTOU guard).
 */
export async function effectiveAllowedLibrariesForUser(
  userId: string,
  dbc?: DbClient,
): Promise<EffectiveLibrary[]> {
  const q = resolveDb(dbc);

  const [u] = await q
    .select({ roleId: users.roleId, isAdmin: roles.isAdmin })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId));
  if (!u) return [];

  const order = [asc(plexServers.slug), asc(plexLibraries.name)] as const;

  if (u.isAdmin) {
    return q
      .select(LIBRARY_COLUMNS)
      .from(plexLibraries)
      .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
      .where(eq(plexLibraries.available, true))
      .orderBy(...order);
  }

  return q
    .select(LIBRARY_COLUMNS)
    .from(roleLibraryGrants)
    .innerJoin(plexLibraries, eq(plexLibraries.id, roleLibraryGrants.plexLibraryId))
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(and(eq(roleLibraryGrants.roleId, u.roleId), eq(plexLibraries.available, true)))
    .orderBy(...order);
}
