// ADR-045 / DESIGN-023 (PLAN-026) — the Authentik DIRECTORY mirror single-writer + the /admin/users read
// model. `upsertAuthentikUsers` is the guarded single-writer for the authentik_users mirror (the ONLY
// path that writes it); `syncAuthentikUsers` reads the live directory and upserts it (the authentik-users
// sync mode + the on-demand admin refresh + the post-membership-write re-read all call it);
// `listAuthentikDirectory` joins the mirror to app users (by email) + roles + live pending assignments
// for the roster.
import {
  authentikUsers,
  pendingRoleAssignments,
  roles,
  users,
  AUTHENTIK_USER_TYPES,
  type AuthentikUserInsert,
  type AuthentikUserType,
  type DbClient,
} from '@hnet/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { sourcesOf, type AuthentikReadClient, type AuthentikUser } from '@hnet/authentik';
import { inTransaction, resolveDb } from './db-client';

function clampUserType(t: string): AuthentikUserType {
  return (AUTHENTIK_USER_TYPES as readonly string[]).includes(t)
    ? (t as AuthentikUserType)
    : 'internal';
}

/** Normalize a live Authentik user into a mirror row. */
export function toAuthentikUserRow(user: AuthentikUser): AuthentikUserInsert {
  return {
    pk: user.pk,
    username: user.username,
    name: user.name ?? '',
    email: user.email ?? null,
    userType: clampUserType(user.type),
    sources: sourcesOf(user),
    groups: user.groups_obj.map((g) => g.name),
    isActive: user.is_active,
    uid: user.uid ?? null,
    syncedAt: new Date(),
  };
}

export interface UpsertAuthentikUsersInput {
  db?: DbClient;
  users: AuthentikUserInsert[];
}

/**
 * The guarded single-writer for the authentik_users mirror. Upserts each row keyed by the Authentik pk
 * (INSERT … ON CONFLICT (pk) DO UPDATE). A synced READ-MODEL, so there is no audit row (the documented
 * no-ledger exemption, like ai_usage_chats / trash_candidates). Chunked to keep the parameter count sane.
 */
export async function upsertAuthentikUsers(
  input: UpsertAuthentikUsersInput,
): Promise<{ upserted: number }> {
  if (input.users.length === 0) return { upserted: 0 };
  return inTransaction(input.db, async (tx) => {
    const CHUNK = 200;
    for (let i = 0; i < input.users.length; i += CHUNK) {
      const chunk = input.users.slice(i, i + CHUNK);
      await tx
        .insert(authentikUsers)
        .values(chunk)
        .onConflictDoUpdate({
          target: authentikUsers.pk,
          set: {
            username: sql`excluded.username`,
            name: sql`excluded.name`,
            email: sql`excluded.email`,
            userType: sql`excluded.user_type`,
            sources: sql`excluded.sources`,
            groups: sql`excluded.groups`,
            isActive: sql`excluded.is_active`,
            uid: sql`excluded.uid`,
            syncedAt: sql`excluded.synced_at`,
          },
        });
    }
    return { upserted: input.users.length };
  });
}

/** Refresh a SINGLE mirror row from a freshly-read Authentik user (post-membership-write re-read). */
export async function upsertAuthentikUser(input: {
  db?: DbClient;
  user: AuthentikUser;
}): Promise<void> {
  await upsertAuthentikUsers({ db: input.db, users: [toAuthentikUserRow(input.user)] });
}

export interface SyncAuthentikUsersInput {
  db?: DbClient;
  authentik: Pick<AuthentikReadClient, 'listUsers'>;
}

export interface SyncAuthentikUsersResult {
  fetched: number;
  upserted: number;
}

/**
 * The `authentik-users` sync body (and the on-demand admin refresh): read the whole live Authentik
 * directory (incl. external / never-logged-in identities) and upsert the mirror. Read-only against
 * Authentik. Returns counts. Never deletes mirror rows for identities that vanished from Authentik —
 * deactivation there flips is_active, which the next sync captures (no hard delete, ADR-045 boundary).
 */
export async function syncAuthentikUsers(
  input: SyncAuthentikUsersInput,
): Promise<SyncAuthentikUsersResult> {
  const live = await input.authentik.listUsers();
  const rows = live.map(toAuthentikUserRow);
  const { upserted } = await upsertAuthentikUsers({ db: input.db, users: rows });
  return { fetched: live.length, upserted };
}

/** One roster row: the Authentik identity + its app linkage (by email) + any live pending assignment. */
export interface AuthentikDirectoryEntry {
  pk: number;
  username: string;
  name: string;
  email: string | null;
  userType: AuthentikUserType;
  sources: string[];
  groups: string[];
  isActive: boolean;
  syncedAt: string;
  /** The app user row that matches this identity by email (null ⇒ never logged into haynesnetwork). */
  appUserId: string | null;
  appRoleId: string | null;
  appRoleName: string | null;
  /** A parked (unconsumed) role assignment for this identity, if any (applied on their first login). */
  pendingRoleId: string | null;
  pendingRoleName: string | null;
}

/**
 * The /admin/users read model: every mirrored Authentik identity LEFT-joined to its app user (email,
 * case-insensitive), that user's role, and any live pending assignment. Ordered by username. A pure
 * read (no writes). Service-account identities are included but flagged by userType so the UI can badge
 * them and disable role assignment.
 */
export async function listAuthentikDirectory(db?: DbClient): Promise<AuthentikDirectoryEntry[]> {
  const executor = resolveDb(db);
  const rows = await executor
    .select({
      pk: authentikUsers.pk,
      username: authentikUsers.username,
      name: authentikUsers.name,
      email: authentikUsers.email,
      userType: authentikUsers.userType,
      sources: authentikUsers.sources,
      groups: authentikUsers.groups,
      isActive: authentikUsers.isActive,
      syncedAt: authentikUsers.syncedAt,
      appUserId: users.id,
      appRoleId: roles.id,
      appRoleName: roles.name,
      pendingRoleId: pendingRoleAssignments.roleId,
    })
    .from(authentikUsers)
    .leftJoin(users, sql`lower(${users.email}) = lower(${authentikUsers.email})`)
    .leftJoin(roles, eq(roles.id, users.roleId))
    .leftJoin(
      pendingRoleAssignments,
      and(
        eq(pendingRoleAssignments.authentikUserPk, authentikUsers.pk),
        isNull(pendingRoleAssignments.consumedAt),
      ),
    )
    .orderBy(authentikUsers.username);

  // Resolve pending role names in a second pass (the pending join carries the id only).
  const pendingRoleIds = [...new Set(rows.map((r) => r.pendingRoleId).filter((x): x is string => !!x))];
  const roleNameById = new Map<string, string>();
  if (pendingRoleIds.length > 0) {
    const roleRows = await executor
      .select({ id: roles.id, name: roles.name })
      .from(roles)
      .where(inArray(roles.id, pendingRoleIds));
    for (const r of roleRows) roleNameById.set(r.id, r.name);
  }

  return rows.map((r) => ({
    pk: r.pk,
    username: r.username,
    name: r.name,
    email: r.email,
    userType: r.userType,
    sources: r.sources,
    groups: r.groups,
    isActive: r.isActive,
    syncedAt: r.syncedAt.toISOString(),
    appUserId: r.appUserId,
    appRoleId: r.appRoleId,
    appRoleName: r.appRoleName,
    pendingRoleId: r.pendingRoleId,
    pendingRoleName: r.pendingRoleId ? (roleNameById.get(r.pendingRoleId) ?? null) : null,
  }));
}
