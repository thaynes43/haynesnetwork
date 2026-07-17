// ADR-070 / DESIGN-043 D-01 (PLAN-052 — collection manager) — the fine-grained collection action grants,
// the exact setRoleBookActions / setRoleActivityActions idiom (ADR-023/059/062): a ROW is the grant;
// `setRoleCollectionActions` is the SOLE writer and co-writes an `update_collection_actions`
// permission_audit row in the SAME transaction (hard rule 6). `acquire` (the content-pull knob) is a
// DISTINCT grant a `manage` role does not automatically hold and is re-checked server-side at the call.
import {
  permissionAudit,
  roleCollectionActionGrants,
  roles,
  COLLECTION_ACTIONS,
  type CollectionAction,
  type DbClient,
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { NotFoundError } from './errors';

/** The collection actions granted to a role (empty for admin roles — admin implies all; the gate handles it). */
export async function collectionActionsForRole(input: {
  db?: DbClient;
  roleId: string;
  /** When the caller already knows admin, short-circuit to every action (parity with activityActionsForRole). */
  isAdmin?: boolean;
}): Promise<CollectionAction[]> {
  if (input.isAdmin) return [...COLLECTION_ACTIONS];
  const rows = await resolveDb(input.db)
    .select({ action: roleCollectionActionGrants.action })
    .from(roleCollectionActionGrants)
    .where(eq(roleCollectionActionGrants.roleId, input.roleId));
  return rows.map((r) => r.action);
}

/**
 * Replace-set a role's collection action grants (Admin is immutable — it implies all actions and stores
 * none). Co-writes an `update_collection_actions` permission_audit row in the SAME tx (hard rule 6). This
 * is the call that opens `suggest` / `manage` / `acquire` to a role after the owner's review (the books-Fix
 * Q-01 precedent — ships Admin-only, opened per role as a data change, not code).
 */
export async function setRoleCollectionActions(input: {
  db?: DbClient;
  roleId: string;
  actions: CollectionAction[];
  actorId: string;
}): Promise<CollectionAction[]> {
  const unique = [...new Set(input.actions)];
  for (const a of unique) {
    if (!COLLECTION_ACTIONS.includes(a)) throw new Error(`Unknown collection action: ${a}`);
  }
  return inTransaction(input.db, async (tx) => {
    const [role] = await tx
      .select({ id: roles.id, isAdmin: roles.isAdmin, name: roles.name })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .for('update');
    if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);
    if (role.isAdmin) throw new Error('ROLE_IMMUTABLE: the Admin role implies all collection actions');

    await tx.delete(roleCollectionActionGrants).where(eq(roleCollectionActionGrants.roleId, role.id));
    if (unique.length > 0) {
      await tx
        .insert(roleCollectionActionGrants)
        .values(unique.map((action) => ({ roleId: role.id, action })));
    }
    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_collection_actions',
      detail: { role_id: role.id, role_name: role.name, actions: unique },
    });
    return unique;
  });
}
