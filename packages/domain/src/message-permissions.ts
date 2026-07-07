import {
  permissionAudit,
  roleMessageActionGrants,
  roles,
  MESSAGE_ACTIONS,
  type DbClient,
  type MessageAction,
} from '@hnet/db';
import { asc, eq } from 'drizzle-orm';
import { NotFoundError, SystemRoleImmutableError } from './errors';
import { inTransaction, resolveDb } from './db-client';

/**
 * ADR-026 / DESIGN-012 D-04 — the single writer for a Role's fine-grained Bulletin message action
 * grants (role_message_action_grants), a clone of setRoleTrashActions: replace-whole-set + a
 * same-tx `update_message_actions` permission_audit row carrying the before/after action lists
 * (CLAUDE.md hard rule 6). A row = the action is GRANTED (presence is the grant; no boolean). The
 * coarse `role_section_permissions.bulletin` level still gates READ (the Feed + Messages browse);
 * these unlock POST (own messages) and MODERATE (any message). The Admin role is immutable here —
 * it implies BOTH actions with NO rows — so setting actions on it is rejected with
 * SystemRoleImmutableError (ROLE_IMMUTABLE), exactly like setRoleTrashActions / setSectionPermission.
 */
export interface SetRoleMessageActionsInput {
  db?: DbClient;
  roleId: string;
  /** The WHOLE granted set — replace-in-place (unknown values rejected up front). */
  actions: MessageAction[];
  actorId: string | null;
}

function normalizeActions(actions: MessageAction[]): MessageAction[] {
  const set = new Set(actions);
  for (const a of set) {
    if (!MESSAGE_ACTIONS.includes(a)) throw new NotFoundError(`Unknown message action '${a}'`);
  }
  return MESSAGE_ACTIONS.filter((a) => set.has(a));
}

export async function setRoleMessageActions(
  input: SetRoleMessageActionsInput,
): Promise<{ changed: boolean; before: MessageAction[]; after: MessageAction[] }> {
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
        'The Admin role has every Bulletin message action and has no editable action grants.',
      );
    }

    const beforeRows = await tx
      .select({ action: roleMessageActionGrants.action })
      .from(roleMessageActionGrants)
      .where(eq(roleMessageActionGrants.roleId, input.roleId))
      .orderBy(asc(roleMessageActionGrants.action));
    const beforeSet = new Set(beforeRows.map((r) => r.action));
    const before = MESSAGE_ACTIONS.filter((a) => beforeSet.has(a));

    await tx.delete(roleMessageActionGrants).where(eq(roleMessageActionGrants.roleId, input.roleId));
    if (after.length > 0) {
      await tx
        .insert(roleMessageActionGrants)
        .values(after.map((action) => ({ roleId: input.roleId, action })));
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_message_actions',
      roleId: input.roleId,
      detail: { role_name: role.name, before, after },
    });

    const changed = before.length !== after.length || before.some((a, i) => a !== after[i]);
    return { changed, before, after };
  });
}

/**
 * ADR-026 C-04 — resolve a role's effective Bulletin message action set, applying the Admin=all
 * fallback. A read; used by session hydration and any server-side re-check. `isAdmin`
 * short-circuits to the full set with no query. Non-admins get exactly their granted rows.
 */
export async function messageActionsForRole(input: {
  db?: DbClient;
  roleId: string;
  isAdmin?: boolean;
}): Promise<MessageAction[]> {
  if (input.isAdmin) return [...MESSAGE_ACTIONS];
  const db = resolveDb(input.db);
  const rows = await db
    .select({ action: roleMessageActionGrants.action })
    .from(roleMessageActionGrants)
    .where(eq(roleMessageActionGrants.roleId, input.roleId));
  const set = new Set(rows.map((r) => r.action));
  return MESSAGE_ACTIONS.filter((a) => set.has(a));
}
