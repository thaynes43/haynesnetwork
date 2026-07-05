// DESIGN-003 D-06 / ADR-012 — users router (admin roster + role assignment). A user's
// access is entirely their single role; the setRole write delegates to @hnet/domain's
// assignRole single-writer (user_role_transitions audit in the same tx).
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { roles, users } from '@hnet/db';
import { assignRole } from '@hnet/domain';
import { mapDomainErrors, router } from '../trpc';
import { adminProcedure } from '../middleware/role';

export const usersRouter = router({
  /**
   * Admin roster: id, displayName, email, createdAt, and the user's role
   * { id, name, isAdmin } (users ⋈ roles). Feeds /admin and /admin/users/[id]. What each
   * role grants is fetched separately from roles.list, so there is no getById.
   */
  list: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({
        id: users.id,
        displayName: users.displayName,
        email: users.email,
        createdAt: users.createdAt,
        roleId: users.roleId,
        roleName: roles.name,
        roleIsAdmin: roles.isAdmin,
      })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .orderBy(asc(users.displayName), asc(users.email));

    return rows.map((row) => ({
      id: row.id,
      displayName: row.displayName,
      email: row.email,
      createdAt: row.createdAt.toISOString(), // D-03: ISO-8601 strings on the wire
      role: { id: row.roleId, name: row.roleName, isAdmin: row.roleIsAdmin },
    }));
  }),

  /**
   * Assign a user to a role (ADR-012). Idempotent (already in the role → no-op, no audit).
   * Refuses to demote the last Admin → LAST_ADMIN (D-13). Audits via user_role_transitions.
   */
  setRole: adminProcedure
    .input(z.object({ userId: z.uuid(), roleId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(() =>
        assignRole({
          db: ctx.db,
          userId: input.userId,
          toRoleId: input.roleId,
          initiator: { id: ctx.user.id, kind: 'admin' },
        }),
      );
    }),
});
