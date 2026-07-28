// ADR-082 / DESIGN-027 D-10 (PLAN-040) — the MAM governor admin surface. Admin-only (account-compliance
// config, not member-facing — PLAN-040 Q-01). One READ (status: gate state + resolved config with per-value
// provenance + recent transitions) and one WRITE (config.set) that delegates to the @hnet/domain
// setMamGovernorConfig single-writer — it validates the invariants (C-04) and co-writes an
// `update_app_setting` permission_audit row in the SAME transaction (hard rule 6; the audited app_settings
// store, no bespoke table). The env variables stay honored as the fallback tier (C-06); a DB row makes them
// dead. No destructive action here (there is nothing to confirm — ConfirmButton is not needed).
import { z } from 'zod';
import { getMamGovernorStatus, setMamGovernorConfig } from '@hnet/domain';
import { mapDomainErrors, router } from '../trpc';
import { adminProcedure } from '../middleware/role';

/**
 * ADR-082 C-04 — write-time validation at the API edge (the domain writer re-validates; defense in depth).
 * The two cross-field refines mirror `governorConfigError`: the edge (limit − buffer) must be positive and
 * the resume floor must sit strictly below it, so an unsatisfiable floor can never be submitted.
 */
export const GovernorConfigInput = z
  .object({
    limit: z.number().int().min(1).max(200),
    buffer: z.number().int().min(0),
    resumeFloor: z.number().int().min(0),
    trendPauseDelta: z.number().int().min(1),
  })
  .refine((c) => c.limit - c.buffer > 0, {
    message: 'The pause edge (limit minus buffer) must be greater than 0.',
    path: ['buffer'],
  })
  .refine((c) => c.resumeFloor < c.limit - c.buffer, {
    message: 'The resume floor must be below the pause edge (limit minus buffer).',
    path: ['resumeFloor'],
  });

export const mamGovernorRouter = router({
  /** The governor panel's read: gate state, resolved config + provenance, and recent transitions. */
  status: adminProcedure.query(({ ctx }) => getMamGovernorStatus({ db: ctx.db })),

  config: router({
    /** Save the DB-backed audited governor knobs (validated at the edge AND the domain writer). */
    set: adminProcedure.input(GovernorConfigInput).mutation(({ ctx, input }) =>
      mapDomainErrors(() =>
        setMamGovernorConfig({ db: ctx.db, config: input, actorId: ctx.user.id }),
      ),
    ),
  }),
});
