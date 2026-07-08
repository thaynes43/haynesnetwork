// DESIGN-003 D-06 / ADR-012 — users router (admin roster + role assignment). A user's
// access is entirely their single role; the setRole write delegates to @hnet/domain's
// assignRole single-writer (user_role_transitions audit in the same tx).
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { roles, users } from '@hnet/db';
import { assignRole, setUserPlexIdentity } from '@hnet/domain';
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
        // fix/plex-identity-mapping — the admin-set Plex identity override (My Plex matching).
        plexEmail: users.plexEmail,
        plexUsername: users.plexUsername,
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
      plexEmail: row.plexEmail,
      plexUsername: row.plexUsername,
    }));
  }),

  /**
   * fix/plex-identity-mapping — set (or clear) a user's Plex identity OVERRIDE. This is the
   * fallback the My Plex matcher uses when the OIDC id_token carries no plex_email/plex_username
   * claim: the owner's Authentik email (admin@haynesnetwork.com) differs from their plex.tv email
   * (manofoz@gmail.com), so email-matching missed them. Values are normalized (trim + lowercase);
   * a blank field clears it (→ NULL). Not a role/permission mutation (no audit row) — it is an
   * identity hint for display, never an access grant.
   */
  setPlexIdentity: adminProcedure
    .input(
      z.object({
        userId: z.uuid(),
        // Accept a loose email-ish string; the matcher is case-insensitive and the value is a hint.
        // Normalization (trim + lowercase, blank → null) is owned by the domain single-writer.
        plexEmail: z.string().max(320).nullable(),
        plexUsername: z.string().max(320).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // The single-writer guard requires the users write to live in @hnet/domain (unknown user
      // → NotFoundError → NOT_FOUND via mapDomainErrors).
      return mapDomainErrors(() =>
        setUserPlexIdentity({
          db: ctx.db,
          userId: input.userId,
          plexEmail: input.plexEmail,
          plexUsername: input.plexUsername,
        }),
      );
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
