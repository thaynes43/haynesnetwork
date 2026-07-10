import {
  appCatalog,
  permissionAudit,
  roleAppGrants,
  roles,
  userRoleTransitions,
  users,
  type DbClient,
  type Transaction,
} from '@hnet/db';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  ConcurrentTransitionError,
  LastAdminError,
  NotFoundError,
  RoleNameConflictError,
  SystemRoleImmutableError,
  isPostgresUniqueViolation,
} from './errors';
import { inTransaction, resolveDb } from './db-client';

/**
 * ADR-012 — @hnet/domain single-writers for the Role model. A Role is an admin-managed
 * named group with an app set (role_app_grants); every user has exactly one (users.role_id).
 * Two seeded roles are system-locked: Admin (superuser, implicit all-apps, immutable) and
 * Default (new-user role; app set editable, name/existence locked). Each writer co-writes
 * its permission_audit / user_role_transitions row in the same transaction (D-12).
 */

/** Who assigned a role (there is no 'user' kind — users never change their own role). */
export type RoleInitiator = { id: string; kind: 'admin' } | { id: null; kind: 'system' };

/** The seeded Admin role's id (superuser). Throws on an unseeded DB. */
export async function getAdminRoleId(dbc?: DbClient): Promise<string> {
  const [row] = await resolveDb(dbc).select({ id: roles.id }).from(roles).where(eq(roles.isAdmin, true));
  if (!row) throw new NotFoundError('Admin role not found (unseeded database)');
  return row.id;
}

/** The seeded Default role's id (assigned to every new user). Throws on an unseeded DB. */
export async function getDefaultRoleId(dbc?: DbClient): Promise<string> {
  const [row] = await resolveDb(dbc)
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.isDefault, true));
  if (!row) throw new NotFoundError('Default role not found (unseeded database)');
  return row.id;
}

async function appRefs(
  tx: Transaction,
  appIds: string[],
): Promise<Array<{ id: string; slug: string }>> {
  if (appIds.length === 0) return [];
  const rows = await tx
    .select({ id: appCatalog.id, slug: appCatalog.slug })
    .from(appCatalog)
    .where(inArray(appCatalog.id, appIds));
  if (rows.length !== new Set(appIds).size) {
    const found = new Set(rows.map((r) => r.id));
    const missing = appIds.filter((id) => !found.has(id));
    throw new NotFoundError(`Catalog app(s) not found: ${missing.join(', ')}`);
  }
  return rows;
}

export interface CreateRoleInput {
  db?: DbClient;
  name: string;
  description?: string | null;
  /** When grantsAll is true these are ignored — a grants_all role stores no app rows. */
  appIds?: string[];
  /** Grant EVERY app, incl. ones added later ("All apps" in the UI). */
  grantsAll?: boolean;
  /** ADR-045 — opt-in: this role PROJECTS to an Authentik group. The LOCAL flag is set here; the
   *  external group create + OWUI pre-create + owned-allowlist append run in provisionSyncedTier
   *  (authentik-portal.ts), called by the API after this returns. */
  syncedTier?: boolean;
  actorId: string | null;
}

/** Create a (non-system) role + its app grants + a 'create_role' audit row in ONE tx. */
export async function createRole(input: CreateRoleInput): Promise<{ roleId: string }> {
  return inTransaction(input.db, async (tx) => {
    const grantsAll = input.grantsAll ?? false;
    const syncedTier = input.syncedTier ?? false;
    const apps = grantsAll ? [] : await appRefs(tx, input.appIds ?? []);

    let roleRow: { id: string } | undefined;
    try {
      [roleRow] = await tx
        .insert(roles)
        .values({ name: input.name, description: input.description ?? null, grantsAll, syncedTier })
        .returning({ id: roles.id });
    } catch (err) {
      if (isPostgresUniqueViolation(err)) {
        throw new RoleNameConflictError(`A role named '${input.name}' already exists`);
      }
      throw err;
    }
    if (!roleRow) throw new Error('role insert returned no row');

    if (apps.length > 0) {
      await tx.insert(roleAppGrants).values(apps.map((app) => ({ roleId: roleRow.id, appId: app.id })));
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'create_role',
      roleId: roleRow.id,
      detail: { role_name: input.name, grants_all: grantsAll, synced_tier: syncedTier, apps },
    });

    return { roleId: roleRow.id };
  });
}

export interface UpdateRoleInput {
  db?: DbClient;
  roleId: string;
  name?: string;
  description?: string | null;
  /** When provided (and grantsAll isn't true), replaces the whole app set. */
  appIds?: string[];
  /** When provided, toggles the all-apps grant; true clears the explicit app set. */
  grantsAll?: boolean;
  /** ADR-045 — when provided, sets the synced-tier flag column (the external group create /
   *  allowlist changes are orchestrated separately in authentik-portal.ts). */
  syncedTier?: boolean;
  actorId: string | null;
}

/**
 * Update a role's name/description and/or whole app set + one 'update_role' audit row with
 * the before/after delta. The Admin role is fully immutable; the Default role's app set and
 * description are editable but it cannot be renamed.
 */
export async function updateRole(input: UpdateRoleInput): Promise<{ changed: boolean }> {
  return inTransaction(input.db, async (tx) => {
    const [before] = await tx
      .select({
        name: roles.name,
        description: roles.description,
        isAdmin: roles.isAdmin,
        isDefault: roles.isDefault,
        grantsAll: roles.grantsAll,
        syncedTier: roles.syncedTier,
      })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .for('update');
    if (!before) throw new NotFoundError(`Role ${input.roleId} not found`);
    if (before.isAdmin) {
      throw new SystemRoleImmutableError('The Admin role is a superuser and cannot be edited.');
    }
    if (before.isDefault && input.name !== undefined && input.name !== before.name) {
      throw new SystemRoleImmutableError('The Default role cannot be renamed.');
    }

    if (input.name !== undefined && input.name !== before.name) {
      const [conflict] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.name, input.name), ne(roles.id, input.roleId)));
      if (conflict) throw new RoleNameConflictError(`A role named '${input.name}' already exists`);
    }

    const beforeApps = await tx
      .select({ id: roleAppGrants.appId, slug: appCatalog.slug })
      .from(roleAppGrants)
      .innerJoin(appCatalog, eq(appCatalog.id, roleAppGrants.appId))
      .where(eq(roleAppGrants.roleId, input.roleId))
      .orderBy(asc(appCatalog.slug));

    const afterName = input.name ?? before.name;
    const afterDescription =
      input.description === undefined ? before.description : input.description;
    const afterGrantsAll = input.grantsAll ?? before.grantsAll;
    const afterSyncedTier = input.syncedTier ?? before.syncedTier;
    // A grants_all role holds NO explicit app rows; otherwise a provided appIds replaces them.
    const afterApps = afterGrantsAll ? [] : input.appIds ? await appRefs(tx, input.appIds) : beforeApps;

    try {
      await tx
        .update(roles)
        .set({
          name: afterName,
          description: afterDescription,
          grantsAll: afterGrantsAll,
          syncedTier: afterSyncedTier,
          updatedAt: sql`now()`,
        })
        .where(eq(roles.id, input.roleId));
    } catch (err) {
      // The pre-check above is best-effort; a concurrent rename can still hit the unique
      // index here — surface it as the coded conflict, not a raw 500.
      if (isPostgresUniqueViolation(err)) {
        throw new RoleNameConflictError(`A role named '${afterName}' already exists`);
      }
      throw err;
    }

    // Rewrite the app set when the caller sent one, or when flipping the all-apps flag.
    if (input.appIds || input.grantsAll !== undefined) {
      await tx.delete(roleAppGrants).where(eq(roleAppGrants.roleId, input.roleId));
      if (afterApps.length > 0) {
        await tx
          .insert(roleAppGrants)
          .values(afterApps.map((app) => ({ roleId: input.roleId, appId: app.id })));
      }
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_role',
      roleId: input.roleId,
      detail: {
        before: {
          role_name: before.name,
          description: before.description,
          grants_all: before.grantsAll,
          synced_tier: before.syncedTier,
          apps: beforeApps,
        },
        after: {
          role_name: afterName,
          description: afterDescription,
          grants_all: afterGrantsAll,
          synced_tier: afterSyncedTier,
          apps: afterApps,
        },
      },
    });

    return { changed: true };
  });
}

export interface DeleteRoleInput {
  db?: DbClient;
  roleId: string;
  actorId: string | null;
}

/**
 * Delete a (non-system) role. Its members are reassigned to the Default role in the same
 * transaction so no user is ever orphaned (users.role_id is NOT NULL). The 'delete_role'
 * audit row is written BEFORE the delete so its role_id FK is SET NULL by the cascade while
 * the jsonb detail keeps the snapshot. Admin/Default cannot be deleted.
 */
export async function deleteRole(input: DeleteRoleInput): Promise<{ reassigned: number }> {
  return inTransaction(input.db, async (tx) => {
    const [role] = await tx
      .select({ name: roles.name, isAdmin: roles.isAdmin, isDefault: roles.isDefault })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .for('update');
    if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);
    if (role.isAdmin || role.isDefault) {
      throw new SystemRoleImmutableError('System roles (Admin, Default) cannot be deleted.');
    }

    const apps = await tx
      .select({ id: roleAppGrants.appId, slug: appCatalog.slug })
      .from(roleAppGrants)
      .innerJoin(appCatalog, eq(appCatalog.id, roleAppGrants.appId))
      .where(eq(roleAppGrants.roleId, input.roleId));

    const defaultRoleId = await getDefaultRoleId(tx);
    const reassigned = await tx
      .update(users)
      .set({ roleId: defaultRoleId, updatedAt: sql`now()` })
      .where(eq(users.roleId, input.roleId))
      .returning({ id: users.id });

    // Per-user transition rows so each reassigned member's role history stays complete
    // (the assignRole single-writer invariant — D-12). from_role_id SET-NULLs on the delete
    // below; the aggregate delete_role audit keeps the role name.
    if (reassigned.length > 0) {
      await tx.insert(userRoleTransitions).values(
        reassigned.map((u) => ({
          userId: u.id,
          fromRoleId: input.roleId,
          toRoleId: defaultRoleId,
          initiatorId: input.actorId,
          initiatorKind: (input.actorId ? 'admin' : 'system') as 'admin' | 'system',
          note: `Role '${role.name}' deleted — reassigned to Default`,
        })),
      );
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'delete_role',
      roleId: input.roleId,
      detail: { role_name: role.name, apps, reassigned_to_default: reassigned.length },
    });

    await tx.delete(roles).where(eq(roles.id, input.roleId));

    return { reassigned: reassigned.length };
  });
}

export interface AssignRoleInput {
  db?: DbClient;
  userId: string;
  toRoleId: string;
  initiator: RoleInitiator;
  note?: string;
  /** Optional optimistic-concurrency guard: when set and the user's current role differs,
   * ConcurrentTransitionError is thrown instead of proceeding. */
  expectedFromRoleId?: string;
}

export interface AssignRoleResult {
  changed: boolean;
  fromRoleId: string;
}

/**
 * The SINGLE writer for users.role_id (R-04, AC-03). Updates the role and inserts the
 * user_role_transitions audit row in one transaction. Idempotent: already in toRole → no-op,
 * no audit row (ADR-002 C-03: repeat bootstrap logins are no-ops). Refuses to move the last
 * Admin off the Admin role (LastAdminError) so the console can't lock itself out.
 */
export async function assignRole(input: AssignRoleInput): Promise<AssignRoleResult> {
  return inTransaction(input.db, async (tx) => {
    const [current] = await tx
      .select({ roleId: users.roleId })
      .from(users)
      .where(eq(users.id, input.userId))
      .for('update');
    if (!current) throw new NotFoundError(`User ${input.userId} not found`);

    const [target] = await tx
      .select({ id: roles.id, isAdmin: roles.isAdmin })
      .from(roles)
      .where(eq(roles.id, input.toRoleId));
    if (!target) throw new NotFoundError(`Role ${input.toRoleId} not found`);

    if (input.expectedFromRoleId !== undefined && current.roleId !== input.expectedFromRoleId) {
      throw new ConcurrentTransitionError(
        `User ${input.userId} is not in the expected role (changed concurrently)`,
      );
    }
    if (current.roleId === input.toRoleId) {
      return { changed: false, fromRoleId: current.roleId };
    }

    // Last-admin guard: moving OFF an admin role must leave at least one admin behind.
    const [currentRole] = await tx
      .select({ isAdmin: roles.isAdmin })
      .from(roles)
      .where(eq(roles.id, current.roleId));
    if (currentRole?.isAdmin && !target.isAdmin) {
      // Lock the admin-role member rows (FOR UPDATE), not just count them: a bare count takes
      // no lock, so two concurrent demotions of different admins would both read 2 under READ
      // COMMITTED and both pass. Locking serializes them — the second blocks, then re-reads 1
      // and is rejected. (The target row is already locked above; re-locking in-tx is fine.)
      const adminMembers = await tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(eq(roles.isAdmin, true))
        .for('update');
      if (adminMembers.length <= 1) {
        throw new LastAdminError(
          'Cannot remove the last Admin — assign another user to the Admin role first.',
        );
      }
    }

    const result = await tx
      .update(users)
      .set({ roleId: input.toRoleId, updatedAt: sql`now()` })
      .where(and(eq(users.id, input.userId), eq(users.roleId, current.roleId)))
      .returning({ id: users.id });
    if (result.length === 0) {
      throw new ConcurrentTransitionError(
        `User ${input.userId} changed role concurrently during assignment`,
      );
    }

    await tx.insert(userRoleTransitions).values({
      userId: input.userId,
      fromRoleId: current.roleId,
      toRoleId: input.toRoleId,
      initiatorId: input.initiator.id,
      initiatorKind: input.initiator.kind,
      note: input.note ?? null,
    });

    return { changed: true, fromRoleId: current.roleId };
  });
}
