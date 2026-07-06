import {
  permissionAudit,
  roleTrashActionGrants,
  roles,
  TRASH_ACTIONS,
  type DbClient,
  type TrashAction,
} from '@hnet/db';
import { asc, eq } from 'drizzle-orm';
import { NotFoundError, SystemRoleImmutableError } from './errors';
import { inTransaction, resolveDb } from './db-client';

/**
 * ADR-023 / DESIGN-010 D-03 — the single writer for a Role's fine-grained Trash action grants
 * (role_trash_action_grants), mirroring setRoleLibraries: replace-whole-set + a same-tx
 * `update_trash_actions` permission_audit row carrying the before/after action lists (CLAUDE.md
 * hard rule 6). A row = the action is GRANTED (presence is the grant; there is no boolean). The
 * coarse `role_section_permissions.trash` level still gates VIEW; these unlock the individual
 * write actions. The Admin role is immutable here — it implies EVERY action with NO rows (ADR-023
 * C-03) — so setting actions on it is rejected with SystemRoleImmutableError (ROLE_IMMUTABLE),
 * exactly like setSectionPermission / setRoleLibraries reject editing the Admin role.
 */
export interface SetRoleTrashActionsInput {
  db?: DbClient;
  roleId: string;
  /** The WHOLE granted set — replace-in-place (unknown values rejected up front). */
  actions: TrashAction[];
  actorId: string | null;
}

function normalizeActions(actions: TrashAction[]): TrashAction[] {
  // De-dupe + a stable order for the audit snapshot; unknown values are impossible past the
  // zod edge but re-validated defensively (defence in depth beneath the API schema).
  const set = new Set(actions);
  for (const a of set) {
    if (!TRASH_ACTIONS.includes(a)) throw new NotFoundError(`Unknown trash action '${a}'`);
  }
  return TRASH_ACTIONS.filter((a) => set.has(a));
}

export async function setRoleTrashActions(
  input: SetRoleTrashActionsInput,
): Promise<{ changed: boolean; before: TrashAction[]; after: TrashAction[] }> {
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
        'The Admin role has every Trash action and has no editable action grants.',
      );
    }

    const beforeRows = await tx
      .select({ action: roleTrashActionGrants.action })
      .from(roleTrashActionGrants)
      .where(eq(roleTrashActionGrants.roleId, input.roleId))
      .orderBy(asc(roleTrashActionGrants.action));
    const beforeSet = new Set(beforeRows.map((r) => r.action));
    const before = TRASH_ACTIONS.filter((a) => beforeSet.has(a));

    await tx.delete(roleTrashActionGrants).where(eq(roleTrashActionGrants.roleId, input.roleId));
    if (after.length > 0) {
      await tx
        .insert(roleTrashActionGrants)
        .values(after.map((action) => ({ roleId: input.roleId, action })));
    }

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_trash_actions',
      roleId: input.roleId,
      detail: { role_name: role.name, before, after },
    });

    const changed =
      before.length !== after.length || before.some((a, i) => a !== after[i]);
    return { changed, before, after };
  });
}

/**
 * ADR-023 C-03 — resolve a role's effective Trash action set, applying the Admin=all fallback.
 * A read; used by session hydration and any server-side re-check. `isAdmin` short-circuits to the
 * full set with no query. Non-admins get exactly their granted rows (absence ⇒ not granted).
 */
export async function trashActionsForRole(input: {
  db?: DbClient;
  roleId: string;
  isAdmin?: boolean;
}): Promise<TrashAction[]> {
  if (input.isAdmin) return [...TRASH_ACTIONS];
  const db = resolveDb(input.db);
  const rows = await db
    .select({ action: roleTrashActionGrants.action })
    .from(roleTrashActionGrants)
    .where(eq(roleTrashActionGrants.roleId, input.roleId));
  const set = new Set(rows.map((r) => r.action));
  return TRASH_ACTIONS.filter((a) => set.has(a));
}
