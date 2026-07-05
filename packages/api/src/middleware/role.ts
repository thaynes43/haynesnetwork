// DESIGN-003 D-02 / ADR-012 — the admin rung of the procedure ladder. Admin is the
// superuser role (roles.is_admin); the session carries role.isAdmin so this needs no
// extra query. Further attribute rungs (e.g. Phase-3 library gating) compose the same way.
import { TRPCError } from '@trpc/server';
import { authedProcedure } from '../trpc';

export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (!ctx.user.role.isAdmin) throw new TRPCError({ code: 'FORBIDDEN' });
  return next();
});
