// ADR-012 — roles router (admin-only). A role is a named app set; a user has exactly one.
// All writes delegate to @hnet/domain single-writers (create_role/update_role/delete_role
// audits in the same tx). Role ASSIGNMENT to a user lives on the users router (setRole).
import { z } from 'zod';
import { asc, count } from 'drizzle-orm';
import { roleAppGrants, roles, users } from '@hnet/db';
import { createRole, deleteRole, updateRole } from '@hnet/domain';
import { mapDomainErrors, router } from '../trpc';
import { adminProcedure } from '../middleware/role';
import { RoleInput, RolePatchInput } from '../schemas';

export const rolesRouter = router({
  /** Every role with its app set + member count (feeds /admin/roles + the user role picker). */
  list: adminProcedure.query(async ({ ctx }) => {
    const roleRows = await ctx.db
      .select({
        id: roles.id,
        name: roles.name,
        description: roles.description,
        isAdmin: roles.isAdmin,
        isDefault: roles.isDefault,
        grantsAll: roles.grantsAll,
        sortOrder: roles.sortOrder,
      })
      .from(roles)
      .orderBy(asc(roles.sortOrder), asc(roles.name));
    const grantRows = await ctx.db
      .select({ roleId: roleAppGrants.roleId, appId: roleAppGrants.appId })
      .from(roleAppGrants);
    const memberRows = await ctx.db
      .select({ roleId: users.roleId, members: count(users.id) })
      .from(users)
      .groupBy(users.roleId);

    const appIdsByRole = new Map<string, string[]>();
    for (const row of grantRows) {
      const list = appIdsByRole.get(row.roleId) ?? [];
      list.push(row.appId);
      appIdsByRole.set(row.roleId, list);
    }
    const membersByRole = new Map(memberRows.map((row) => [row.roleId, Number(row.members)]));

    // The Admin role has no explicit grants — it's an implicit all-apps superuser.
    return roleRows.map((row) => ({
      ...row,
      appIds: appIdsByRole.get(row.id) ?? [],
      memberCount: membersByRole.get(row.id) ?? 0,
    }));
  }),

  create: adminProcedure.input(RoleInput).mutation(async ({ ctx, input }) => {
    // Audits 'create_role'; duplicate name → ROLE_NAME_CONFLICT (D-13).
    return mapDomainErrors(() => createRole({ db: ctx.db, ...input, actorId: ctx.user.id }));
  }),

  update: adminProcedure.input(RolePatchInput).mutation(async ({ ctx, input }) => {
    const { id, ...patch } = input;
    // Admin role → ROLE_IMMUTABLE; Default role rename → ROLE_IMMUTABLE; audits 'update_role'.
    return mapDomainErrors(() => updateRole({ db: ctx.db, roleId: id, ...patch, actorId: ctx.user.id }));
  }),

  delete: adminProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    // Reassigns members to Default, then deletes; system roles → ROLE_IMMUTABLE. Audits 'delete_role'.
    return mapDomainErrors(() => deleteRole({ db: ctx.db, roleId: input.id, actorId: ctx.user.id }));
  }),
});
