// ADR-045 / DESIGN-023 (PLAN-026) — the Authentik role-portal single-writer orchestrators. This is the
// ONLY place @hnet/authentik/write + @hnet/openwebui/write are driven (import-confined). Two concerns:
//
//   • provisionSyncedTier — when a role becomes a synced tier, PRE-CREATE its Authentik group (name =
//     role name lowercased) + the same-named Open WebUI group, and add the group to the owned-groups
//     allowlist + role→group map. Idempotent (ensure-exists). External creates append authentik_group_audit
//     rows AFTER the apply; the allowlist/map changes are same-tx audited via setAppSetting.
//
//   • assignRolePortal — assign a Role to an identity: flip its OWNED-group membership in Authentik
//     (exclusive across owned tier groups — join the role's group, leave every other owned group), and
//     write the LOCAL role state (assignRole for an app user; a parked pending_role_assignments row for an
//     Authentik-only identity, consumed on first login). THE GUARDRAIL: a membership write is attempted
//     ONLY for a group in the owned-groups allowlist (assertGroupOwned throws before any external call),
//     so the app can never touch authentik-admin-managed groups (authentik Admins, mfa-exempt, …).
import {
  authentikGroupAudit,
  pendingRoleAssignments,
  permissionAudit,
  roles,
  type DbClient,
} from '@hnet/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import {
  AuthentikGroupNotOwnedError,
  AuthentikUnavailableError,
  NotFoundError,
  OwuiUnavailableError,
  SyncedTierInvalidError,
} from './errors';
import { getAuthentikGroupMap, getAuthentikOwnedGroups, setAppSetting } from './app-settings';
import { assignRole, type RoleInitiator } from './roles';
import { upsertAuthentikUser } from './authentik-users';
import type { AuthentikPortalBundle } from './authentik-clients';
import type { AuthentikGroupAuditAction } from '@hnet/db';

/** The Authentik group name a role projects to: an explicit map entry, else name.toLowerCase(). */
export function groupNameForRole(roleId: string, roleName: string, map: Record<string, string>): string {
  return map[roleId] ?? roleName.toLowerCase();
}

/** THE GUARDRAIL. Throw unless `groupName` is in the owned-groups allowlist (case-insensitive). */
export function assertGroupOwned(groupName: string, ownedGroups: readonly string[]): void {
  if (!ownedGroups.map((g) => g.toLowerCase()).includes(groupName.toLowerCase())) {
    throw new AuthentikGroupNotOwnedError(groupName);
  }
}

/** Append one external-write audit row (the plex_share_audit-class ledger). Its own tx (append-only). */
async function auditGroupWrite(
  db: DbClient | undefined,
  row: {
    action: AuthentikGroupAuditAction;
    groupName: string;
    authentikUserPk?: number | null;
    roleId?: string | null;
    subjectEmail?: string | null;
    actorId: string | null;
    detail?: unknown;
  },
): Promise<void> {
  await resolveDb(db)
    .insert(authentikGroupAudit)
    .values({
      action: row.action,
      groupName: row.groupName,
      authentikUserPk: row.authentikUserPk ?? null,
      roleId: row.roleId ?? null,
      subjectEmail: row.subjectEmail ?? null,
      actorId: row.actorId,
      detail: (row.detail as object | null) ?? null,
    });
}

export interface ProvisionSyncedTierInput {
  db?: DbClient;
  bundle: AuthentikPortalBundle;
  roleId: string;
  actorId: string | null;
}

export interface ProvisionSyncedTierResult {
  groupName: string;
  authentikCreated: boolean;
  owuiCreated: boolean;
}

/**
 * Make a role a managed synced tier: set the flag, add its group to the owned-groups allowlist + map,
 * and ensure the Authentik group AND the same-named Open WebUI group exist. Idempotent — safe to re-run
 * (ensure-exists everywhere). The tier's EXISTENCE propagates automatically; its per-app ENTITLEMENTS
 * (OWUI model access, Kavita libraries) remain per-app config — the UX states this on creation.
 */
export async function provisionSyncedTier(
  input: ProvisionSyncedTierInput,
): Promise<ProvisionSyncedTierResult> {
  const executor = resolveDb(input.db);
  const [role] = await executor
    .select({ name: roles.name, syncedTier: roles.syncedTier })
    .from(roles)
    .where(eq(roles.id, input.roleId));
  if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);

  const map = await getAuthentikGroupMap(input.db);
  const groupName = groupNameForRole(input.roleId, role.name, map);

  // Flag on (idempotent) + owned-allowlist append + map entry — the LOCAL, audited config changes first,
  // so the group is recognized as owned before any membership write can target it.
  if (!role.syncedTier) {
    await executor.update(roles).set({ syncedTier: true, updatedAt: sql`now()` }).where(eq(roles.id, input.roleId));
  }
  const owned = await getAuthentikOwnedGroups(input.db);
  if (!owned.includes(groupName)) {
    await setAppSetting({
      db: input.db,
      key: 'authentik_owned_groups',
      value: [...owned, groupName],
      actorId: input.actorId,
    });
  }
  if (map[input.roleId] !== groupName) {
    await setAppSetting({
      db: input.db,
      key: 'authentik_group_map',
      value: { ...map, [input.roleId]: groupName },
      actorId: input.actorId,
    });
  }

  // Ensure the Authentik group (create if missing) — the target for the groups-claim sync.
  let authentikCreated = false;
  const akGroups = await callAuthentik(() => input.bundle.authentik.read.listGroups());
  if (!akGroups.some((g) => g.name === groupName)) {
    await callAuthentik(() => input.bundle.authentik.write.createGroup(groupName));
    authentikCreated = true;
    await auditGroupWrite(input.db, {
      action: 'create_group',
      groupName,
      roleId: input.roleId,
      actorId: input.actorId,
      detail: { role_name: role.name },
    });
  }

  // Ensure the same-named Open WebUI group (OWUI does NOT auto-create from claims — the portal pre-creates).
  let owuiCreated = false;
  const owuiGroups = await callOwui(() => input.bundle.owui.read.listGroups());
  if (!owuiGroups.some((g) => g.name === groupName)) {
    await callOwui(() =>
      input.bundle.owui.write.createGroup(groupName, `haynesnetwork ${role.name} tier`),
    );
    owuiCreated = true;
    await auditGroupWrite(input.db, {
      action: 'ensure_owui_group',
      groupName,
      roleId: input.roleId,
      actorId: input.actorId,
      detail: { role_name: role.name },
    });
  }

  return { groupName, authentikCreated, owuiCreated };
}

export interface DeactivateSyncedTierInput {
  db?: DbClient;
  roleId: string;
  actorId: string | null;
}

/**
 * Stop managing a synced tier: flip the flag off and REMOVE its group from the owned-groups allowlist
 * (so future membership writes for it are refused). NON-destructive — the Authentik + OWUI groups and
 * all existing memberships are left intact (group deletion is out of scope, ADR-045 boundary). The
 * role→group map entry is kept so a later re-activation resolves the same group.
 */
export async function deactivateSyncedTier(
  input: DeactivateSyncedTierInput,
): Promise<{ groupName: string | null }> {
  const executor = resolveDb(input.db);
  const [role] = await executor
    .select({ name: roles.name, syncedTier: roles.syncedTier })
    .from(roles)
    .where(eq(roles.id, input.roleId));
  if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);

  const map = await getAuthentikGroupMap(input.db);
  const groupName = groupNameForRole(input.roleId, role.name, map);

  if (role.syncedTier) {
    await executor.update(roles).set({ syncedTier: false, updatedAt: sql`now()` }).where(eq(roles.id, input.roleId));
  }
  const owned = await getAuthentikOwnedGroups(input.db);
  if (owned.includes(groupName)) {
    await setAppSetting({
      db: input.db,
      key: 'authentik_owned_groups',
      value: owned.filter((g) => g !== groupName),
      actorId: input.actorId,
    });
  }
  return { groupName };
}

/** How to reach the identity being assigned: an app user (has a users row) or an Authentik-only pk. */
export interface AssignRolePortalInput {
  db?: DbClient;
  bundle: AuthentikPortalBundle;
  /** The Authentik user pk (the membership-write subject; always required). */
  authentikUserPk: number;
  username: string;
  email: string;
  uid?: string | null;
  /** The role to assign. */
  roleId: string;
  /** The app user row matching this identity by email — null ⇒ Authentik-only (park a pending intent). */
  appUserId: string | null;
  /** Who initiated (admin id, or system). */
  actor: RoleInitiator;
}

export interface AssignRolePortalResult {
  groupName: string | null;
  added: string[];
  removed: string[];
  /** True when the app-role intent was PARKED (Authentik-only identity) vs applied immediately. */
  pending: boolean;
}

/**
 * Assign a Role to an Authentik identity and propagate it to the owned Authentik groups (exclusive
 * across tier groups). Order: (1) read the subject + groups live from Authentik (abort cleanly if
 * unreachable — nothing mutated); (2) apply the LOCAL role state (assignRole / pending upsert) in one
 * audited tx; (3) flip the external owned-group membership (guardrail-checked; each flip audited after);
 * (4) refresh the mirror row. A step-3 failure leaves the local role set + partial group change — a
 * re-run reconciles (add/remove are idempotent against the live set).
 */
export async function assignRolePortal(
  input: AssignRolePortalInput,
): Promise<AssignRolePortalResult> {
  const executor = resolveDb(input.db);
  const email = input.email.trim().toLowerCase();

  // (0) Resolve the role + its owned group.
  const [role] = await executor
    .select({ name: roles.name, syncedTier: roles.syncedTier, isAdmin: roles.isAdmin })
    .from(roles)
    .where(eq(roles.id, input.roleId));
  if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);

  const ownedGroups = await getAuthentikOwnedGroups(input.db);
  const map = await getAuthentikGroupMap(input.db);
  const desiredGroup = role.syncedTier ? groupNameForRole(input.roleId, role.name, map) : null;
  if (desiredGroup !== null && !ownedGroups.map((g) => g.toLowerCase()).includes(desiredGroup)) {
    // The tier isn't provisioned into the allowlist — creating the group is provisionSyncedTier's job.
    throw new SyncedTierInvalidError(
      `Role '${role.name}' is a synced tier but its group '${desiredGroup}' is not provisioned — ` +
        `create the tier's group first (re-run tier provisioning).`,
    );
  }

  // (1) Live read of the subject + the group name→pk map (abort if Authentik is unreachable).
  const [subject, akGroups] = await Promise.all([
    callAuthentik(() => input.bundle.authentik.read.getUser(input.authentikUserPk)),
    callAuthentik(() => input.bundle.authentik.read.listGroups()),
  ]);
  const groupPkByName = new Map(akGroups.map((g) => [g.name, g.pk]));
  const currentGroups = subject.groups_obj.map((g) => g.name);
  const currentOwned = currentGroups.filter((g) =>
    ownedGroups.map((o) => o.toLowerCase()).includes(g.toLowerCase()),
  );
  const toRemove = currentOwned.filter((g) => g !== desiredGroup);
  const toAdd = desiredGroup && !currentGroups.includes(desiredGroup) ? [desiredGroup] : [];

  // (2) LOCAL role state, in one audited transaction.
  let pending = false;
  if (input.appUserId) {
    await assignRole({
      db: input.db,
      userId: input.appUserId,
      toRoleId: input.roleId,
      initiator: input.actor,
      note: `Assigned via the Authentik user portal (${role.name})`,
    });
  } else {
    pending = true;
    await inTransaction(input.db, async (tx) => {
      // One live pending row per identity — supersede any prior unconsumed intent.
      await tx
        .delete(pendingRoleAssignments)
        .where(
          and(
            eq(pendingRoleAssignments.authentikUserPk, input.authentikUserPk),
            isNull(pendingRoleAssignments.consumedAt),
          ),
        );
      await tx.insert(pendingRoleAssignments).values({
        authentikUserPk: input.authentikUserPk,
        authentikUsername: input.username,
        email,
        authentikUid: input.uid ?? null,
        roleId: input.roleId,
        assignedBy: input.actor.id,
      });
      await tx.insert(permissionAudit).values({
        actorId: input.actor.id,
        action: 'assign_pending_role',
        roleId: input.roleId,
        detail: {
          authentik_user_pk: input.authentikUserPk,
          username: input.username,
          email,
          role_name: role.name,
        },
      });
    });
  }

  // (3) External owned-group membership flips — guardrail-checked, audited after each apply.
  const added: string[] = [];
  const removed: string[] = [];
  for (const g of toAdd) {
    assertGroupOwned(g, ownedGroups);
    const pk = groupPkByName.get(g);
    if (!pk) throw new SyncedTierInvalidError(`Owned group '${g}' has no Authentik group (provision it).`);
    await callAuthentik(() => input.bundle.authentik.write.addUserToGroup(pk, input.authentikUserPk));
    added.push(g);
    await auditGroupWrite(input.db, {
      action: 'add_member',
      groupName: g,
      authentikUserPk: input.authentikUserPk,
      roleId: input.roleId,
      subjectEmail: email,
      actorId: input.actor.id,
      detail: { role_name: role.name, previous_owned_groups: currentOwned, app_user: !!input.appUserId },
    });
  }
  for (const g of toRemove) {
    assertGroupOwned(g, ownedGroups);
    const pk = groupPkByName.get(g);
    if (!pk) continue; // not in Authentik anymore — nothing to remove
    await callAuthentik(() =>
      input.bundle.authentik.write.removeUserFromGroup(pk, input.authentikUserPk),
    );
    removed.push(g);
    await auditGroupWrite(input.db, {
      action: 'remove_member',
      groupName: g,
      authentikUserPk: input.authentikUserPk,
      roleId: input.roleId,
      subjectEmail: email,
      actorId: input.actor.id,
      detail: { role_name: role.name, reason: 'exclusive-owned-tier', app_user: !!input.appUserId },
    });
  }

  // (4) Refresh the mirror row so /admin/users reflects the new membership immediately (non-fatal).
  try {
    const fresh = await input.bundle.authentik.read.getUser(input.authentikUserPk);
    await upsertAuthentikUser({ db: input.db, user: fresh });
  } catch {
    // A transient read failure just means the roster is one sync-tick stale — never fail the assign.
  }

  return { groupName: desiredGroup, added, removed, pending };
}

/**
 * ADR-045 C-05 — the domain single-writer that CONSUMES a parked role intent on first login. Looks up
 * the newest live pending_role_assignments row for `email` (lowercased); if present, assignRole (its
 * user_role_transitions row) AND stamp the pending row consumed, in ONE transaction. Returns the applied
 * roleId (or null when there was nothing to consume). The Authentik group membership was already written
 * at admin-assign time — this only materializes the APP role now that the user row exists. Guard-friendly:
 * the pending_role_assignments write lives here in packages/domain, not in the auth hook that calls it.
 */
export async function consumePendingRoleForUser(input: {
  db?: DbClient;
  userId: string;
  email: string;
}): Promise<{ appliedRoleId: string | null }> {
  const email = input.email.trim().toLowerCase();
  const executor = resolveDb(input.db);
  const [pending] = await executor
    .select({ id: pendingRoleAssignments.id, roleId: pendingRoleAssignments.roleId })
    .from(pendingRoleAssignments)
    .where(and(eq(pendingRoleAssignments.email, email), isNull(pendingRoleAssignments.consumedAt)))
    .orderBy(sql`${pendingRoleAssignments.createdAt} DESC`)
    .limit(1);
  if (!pending) return { appliedRoleId: null };

  await inTransaction(input.db, async (tx) => {
    await assignRole({
      db: tx,
      userId: input.userId,
      toRoleId: pending.roleId,
      initiator: { id: null, kind: 'system' },
      note: 'Consumed pending Authentik-portal role assignment on first login',
    });
    await tx
      .update(pendingRoleAssignments)
      .set({ consumedAt: sql`now()`, consumedUserId: input.userId })
      .where(eq(pendingRoleAssignments.id, pending.id));
  });
  return { appliedRoleId: pending.roleId };
}

/** Wrap an Authentik client call, converting a typed client error into the coded domain error. */
async function callAuthentik<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new AuthentikUnavailableError(
      error instanceof Error ? error.message : 'Authentik request failed',
      { cause: error },
    );
  }
}

/** Wrap an Open WebUI client call, converting a typed client error into the coded domain error. */
async function callOwui<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new OwuiUnavailableError(
      error instanceof Error ? error.message : 'Open WebUI request failed',
      { cause: error },
    );
  }
}
