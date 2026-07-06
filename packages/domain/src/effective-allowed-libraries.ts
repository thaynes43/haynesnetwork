import {
  plexLibraries,
  plexServers,
  roleLibraryGrants,
  rolePlexServerAllGrants,
  roles,
  users,
  type DbClient,
  type PlexMediaType,
  type PlexServerSlug,
} from '@hnet/db';
import { and, asc, eq, inArray, or } from 'drizzle-orm';
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
 * ADR-017 D-04 / ADR-024 — the complete set of Plex libraries a user may self-share, ordered by
 * server slug then library name. An Admin-role user sees EVERY available library (implicit all —
 * mirrors effectiveAppsForUser's is_admin short-circuit). Every other user sees the UNION of (a)
 * the libraries their role explicitly grants (role_library_grants) and (b) every available library
 * on any server their role holds an ALL-libraries grant on (role_plex_server_all_grants — ADR-024).
 * Unlike effectiveAppsForUser there is NO grants_all short-circuit: a grants_all (non-admin) role
 * still needs explicit or all-server library grants (ADR-017 D-08). Only `available` libraries are
 * offered — a library that vanished from a refresh is withheld but its grants/audit survive (D-04).
 * This is the authoritative allowed set the share single-writers re-derive INSIDE their transaction
 * (TOCTOU guard).
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

  const explicitRows = await q
    .select({ id: roleLibraryGrants.plexLibraryId })
    .from(roleLibraryGrants)
    .where(eq(roleLibraryGrants.roleId, u.roleId));
  const allServerRows = await q
    .select({ id: rolePlexServerAllGrants.plexServerId })
    .from(rolePlexServerAllGrants)
    .where(eq(rolePlexServerAllGrants.roleId, u.roleId));
  const explicitIds = explicitRows.map((r) => r.id);
  const allServerIds = allServerRows.map((r) => r.id);
  if (explicitIds.length === 0 && allServerIds.length === 0) return [];

  // OR of "this library is explicitly granted" and "this library is on an all-granted server".
  // Each library row matches at most once (1:1 join with its server), so no duplicates arise even
  // when a library is covered by both an explicit grant and its server's all-grant.
  const membership = [
    explicitIds.length > 0 ? inArray(plexLibraries.id, explicitIds) : undefined,
    allServerIds.length > 0 ? inArray(plexServers.id, allServerIds) : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  return q
    .select(LIBRARY_COLUMNS)
    .from(plexLibraries)
    .innerJoin(plexServers, eq(plexServers.id, plexLibraries.serverId))
    .where(and(eq(plexLibraries.available, true), or(...membership)))
    .orderBy(...order);
}

/**
 * ADR-024 — the set of Plex server ids the user's role grants ALL libraries on (the servers the
 * user may self-toggle their own account's all-libraries state for). An Admin-role user implicitly
 * all-grants every server (no rows — mirrors effectiveAllowedLibrariesForUser's admin short-circuit).
 * Re-derived inside setServerAllShare as the TOCTOU gate.
 */
export async function allGrantedServerIdsForUser(
  userId: string,
  dbc?: DbClient,
): Promise<Set<string>> {
  const q = resolveDb(dbc);

  const [u] = await q
    .select({ roleId: users.roleId, isAdmin: roles.isAdmin })
    .from(users)
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId));
  if (!u) return new Set();

  if (u.isAdmin) {
    const rows = await q.select({ id: plexServers.id }).from(plexServers);
    return new Set(rows.map((r) => r.id));
  }

  const rows = await q
    .select({ id: rolePlexServerAllGrants.plexServerId })
    .from(rolePlexServerAllGrants)
    .where(eq(rolePlexServerAllGrants.roleId, u.roleId));
  return new Set(rows.map((r) => r.id));
}
