import { permissionAudit, roles, type DbClient, type MetricsLevel } from '@hnet/db';
import { eq } from 'drizzle-orm';
import { NotFoundError, SystemRoleImmutableError } from './errors';
import { inTransaction } from './db-client';

/**
 * ADR-037 C-01 / DESIGN-016 D-03 — the single writer for a Role's metrics access level
 * (roles.metrics_level), mirroring setSectionPermission: lock the role FOR UPDATE, reject the Admin
 * role (it implies `full` via the session short-circuit and has no editable level), read the before
 * value, write in place, and co-write an `update_role_metrics_level` permission_audit row in the SAME
 * transaction (CLAUDE.md hard rule 6). Admin immutability raises SystemRoleImmutableError (the
 * ROLE_IMMUTABLE coded error), exactly like setSectionPermission rejects editing the Admin section set.
 */
export interface SetRoleMetricsLevelInput {
  db?: DbClient;
  roleId: string;
  level: MetricsLevel;
  actorId: string | null;
}

export async function setRoleMetricsLevel(
  input: SetRoleMetricsLevelInput,
): Promise<{ changed: boolean; before: MetricsLevel; after: MetricsLevel }> {
  return inTransaction(input.db, async (tx) => {
    const [role] = await tx
      .select({
        id: roles.id,
        name: roles.name,
        isAdmin: roles.isAdmin,
        metricsLevel: roles.metricsLevel,
      })
      .from(roles)
      .where(eq(roles.id, input.roleId))
      .for('update');
    if (!role) throw new NotFoundError(`Role ${input.roleId} not found`);
    if (role.isAdmin) {
      throw new SystemRoleImmutableError(
        'The Admin role has full metrics access and no editable metrics level.',
      );
    }

    const before = role.metricsLevel;

    await tx
      .update(roles)
      .set({ metricsLevel: input.level, updatedAt: new Date() })
      .where(eq(roles.id, input.roleId));

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'update_role_metrics_level',
      roleId: input.roleId,
      detail: { role_name: role.name, before, after: input.level },
    });

    return { changed: before !== input.level, before, after: input.level };
  });
}
