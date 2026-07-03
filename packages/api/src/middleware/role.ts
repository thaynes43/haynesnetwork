// DESIGN-003 D-02 — the admin rung of the procedure ladder (donor: middleware/role.ts).
// haynesnetwork has two roles, so this is the only role middleware in Phase 1; further
// rungs (e.g. permission-attribute checks like Family, R-26) compose the same way.
import { TRPCError } from '@trpc/server';
import { authedProcedure } from '../trpc';

export const adminProcedure = authedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'Admin') throw new TRPCError({ code: 'FORBIDDEN' });
  return next();
});
