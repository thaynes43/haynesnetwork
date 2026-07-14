// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the Activity ACTION grant seam (R2), the exact
// setRoleTrashActions idiom: a role's fine-grained Activity actions are a replace-whole-set with a same-tx
// `update_activity_actions` permission_audit row (hard rule 6). A ROW = the action is granted (presence is
// the grant; no boolean — ADR-023 C-03). Import-failure actions ship Admin-only; this seam OPENS one to a
// role later. The Admin role is immutable here (implies every action with no rows).
import {
  permissionAudit,
  roleActivityActionGrants,
  roles,
  ACTIVITY_ACTIONS,
  type ActivityAction,
  type DbClient,
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import { NotFoundError, SystemRoleImmutableError } from './errors';
import { inTransaction, resolveDb } from './db-client';

export interface SetRoleActivityActionsInput {
  db?: DbClient;
  roleId: string;
  /** The WHOLE granted set — replace-in-place (unknown values rejected up front). */
  actions: ActivityAction[];
  actorId: string | null;
}

function normalizeActions(actions: ActivityAction[]): ActivityAction[] {
  const set = new Set(actions);
  for (const a of set) {
    if (!ACTIVITY_ACTIONS.includes(a)) throw new NotFoundError(`Unknown activity action '${a}'`);
  }
  return ACTIVITY_ACTIONS.filter((a) => set.has(a));
}

/**
 * The single writer for a role's Activity action grants: replace-whole-set + a same-tx
 * `update_activity_actions` audit row carrying before/after. The Admin role is rejected
 * (SystemRoleImmutableError) — it implies every action with no rows, exactly like setRoleTrashActions.
 */
export async function setRoleActivityActions(
  input: SetRoleActivityActionsInput,
): Promise<{ changed: boolean; before: ActivityAction[]; after: ActivityAction[] }> {
  const after = normalizeActions(input.actions);
  return inTransaction(input.db, async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, name: roles.name, isAdmin: roles.isAdmin })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .for('update');
    if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);
    if (role.isAdmin) {
      throw new SystemRoleImmutableError(
        'The Admin role has every Activity action and has no editable action grants.',
      );
    }

    const beforeRows = await tx
      .select({ action: roleActivityActionGrants.action })
      .from(roleActivityActionGrants)
      .where(eq(roleActivityActionGrants.roleId, input.roleId));
    const beforeSet = new Set(beforeRows.map((r) => r.action));
    const before = ACTIVITY_ACTIONS.filter((a) => beforeSet.has(a));

    await tx.delete(roleActivityActionGrants).where(eq(roleActivityActionGrants.roleId, input.roleId));
    if (after.length > 0) {
      await tx
        .insert(roleActivityActionGrants)
        .values(after.map((action) => ({ roleId: input.roleId, action })));
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_activity_actions',
      roleId: input.roleId,
      detail: { role_name: role.name, before, after },
    });

    const changed = before.length !== after.length || before.some((a, i) => a !== after[i]);
    return { changed, before, after };
  });
}

/**
 * Resolve a role's effective Activity action set (Admin ⇒ all with no query). Used by the
 * `activityActionProcedure` server gate (a mutation path, so a per-call read is fine — the seam does not
 * yet ride the session, matching R2's "openable to roles later"). Absence ⇒ not granted.
 */
export async function activityActionsForRole(input: {
  db?: DbClient;
  roleId: string;
  isAdmin?: boolean;
}): Promise<ActivityAction[]> {
  if (input.isAdmin) return [...ACTIVITY_ACTIONS];
  const rows = await resolveDb(input.db)
    .select({ action: roleActivityActionGrants.action })
    .from(roleActivityActionGrants)
    .where(eq(roleActivityActionGrants.roleId, input.roleId));
  const set = new Set(rows.map((r) => r.action));
  return ACTIVITY_ACTIONS.filter((a) => set.has(a));
}
