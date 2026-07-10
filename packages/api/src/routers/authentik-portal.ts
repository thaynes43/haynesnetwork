// ADR-045 / DESIGN-023 (PLAN-026) — the Authentik user/role PORTAL router (admin-only). It reads the
// whole Authentik directory (the synced mirror), refreshes it on demand, and assigns a role to any
// identity — flipping owned-group membership in Authentik and, for an Authentik-only identity, parking a
// pending intent consumed on first login. Every write delegates to a @hnet/domain single-writer/
// orchestrator (the group-write ledger + audit); the router only resolves the identity + injects the
// portal bundle.
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { authentikUsers, users } from '@hnet/db';
import { assignRolePortal, listAuthentikDirectory, syncAuthentikUsers, NotFoundError } from '@hnet/domain';
import { mapDomainErrors, resolveAuthentikPortalBundle, router } from '../trpc';
import { adminProcedure } from '../middleware/role';

export const authentikPortalRouter = router({
  /** The /admin/users roster: every mirrored Authentik identity + its app linkage + pending assignment. */
  listIdentities: adminProcedure.query(async ({ ctx }) => {
    return listAuthentikDirectory(ctx.db);
  }),

  /** Re-read the live Authentik directory and upsert the mirror (the on-demand "Refresh" button). */
  refresh: adminProcedure.mutation(async ({ ctx }) => {
    return mapDomainErrors(() =>
      syncAuthentikUsers({ db: ctx.db, authentik: resolveAuthentikPortalBundle(ctx).authentik.read }),
    );
  }),

  /**
   * Assign a Role to an Authentik identity. Resolves the identity from the mirror (username/email/uid)
   * and its app user row (email match), then delegates to assignRolePortal: flip owned-group membership
   * in Authentik (exclusive across tier groups) and set the LOCAL role (assignRole for an app user, or a
   * parked pending row for an Authentik-only identity). A non-owned group write is refused by the domain
   * guardrail (→ FORBIDDEN). Service accounts / e-mail-less identities cannot be assigned.
   */
  assignRole: adminProcedure
    .input(z.object({ authentikUserPk: z.number().int(), roleId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      return mapDomainErrors(async () => {
        const [row] = await ctx.db
          .select({
            username: authentikUsers.username,
            email: authentikUsers.email,
            uid: authentikUsers.uid,
            userType: authentikUsers.userType,
            appUserId: users.id,
          })
          .from(authentikUsers)
          .leftJoin(users, sql`lower(${users.email}) = lower(${authentikUsers.email})`)
          .where(eq(authentikUsers.pk, input.authentikUserPk));
        if (!row) {
          throw new NotFoundError(
            `Authentik identity pk ${input.authentikUserPk} not in the mirror — refresh the directory first.`,
          );
        }
        if (row.userType === 'internal_service_account') {
          throw new NotFoundError('Service-account identities cannot be assigned a role.');
        }
        if (!row.email) {
          throw new NotFoundError(
            'This identity has no email — a role cannot be parked for it (email is the first-login join key).',
          );
        }
        return assignRolePortal({
          db: ctx.db,
          bundle: resolveAuthentikPortalBundle(ctx),
          authentikUserPk: input.authentikUserPk,
          username: row.username,
          email: row.email,
          uid: row.uid,
          roleId: input.roleId,
          appUserId: row.appUserId,
          actor: { id: ctx.user.id, kind: 'admin' },
        });
      });
    }),
});
