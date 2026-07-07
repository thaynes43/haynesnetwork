// ADR-030 / DESIGN-013 (PLAN-013 disk + reclaim metrics) — the Storage tRPC surface. Three reads plus
// one write, all ADMIN-gated for v1 (operational data; DESIGN-013 notes a future section-permission if
// this ever goes member-facing):
//   storage.utilization       — current disk utilization per media array (*arr /diskspace, resilient).
//   storage.reclaim({window}) — reclaim attribution over a window (PG deletion snapshots + expedite).
//   storage.targets.get       — the per-server space_targets map (drives the reference line).
//   storage.targets.set       — set the targets (audited via the app_settings single-writer).
import { z } from 'zod';
import {
  getReclaim,
  getUtilization,
  getAppSetting,
  getSpacePolicy,
  getSpacePolicyStatus,
  setAppSetting,
  RECLAIM_WINDOWS,
} from '@hnet/domain';
import { mapDomainErrors, resolveArrBundle, router } from '../trpc';
import { adminProcedure } from '../middleware/role';

/**
 * Per-server space targets: a SPARSE map of Plex-server slug → percent-used ceiling (0..100). The keys
 * mirror PLEX_SERVER_SLUGS (`haynestower|haynesops|hayneskube`); every value is optional so a caller can
 * set just one server, and `.strict()` rejects any non-slug key. The inferred shape is a Partial map,
 * which is exactly @hnet/domain's SpaceTargets — no cast needed.
 */
const percentCeiling = z.number().int().min(0).max(100).optional();
export const SpaceTargetsInput = z.object({
  targets: z
    .object({
      haynestower: percentCeiling,
      haynesops: percentCeiling,
      hayneskube: percentCeiling,
    })
    .strict(),
});

/**
 * ADR-031 / DESIGN-014 — the space-policy config the admin card writes. The whole object is replaced
 * (the UI sends the merged value, like the targets editor). `perArray` is keyed by STORAGE_ARRAYS key
 * (`haynestower`|`cephfs`); an entry OPTS AN ARRAY IN (`enabled` true). Bounds keep the knobs sane;
 * the inferred shape is exactly @hnet/domain's SpacePolicy — no cast needed.
 */
const spacePolicyArrayCfg = z
  .object({
    enabled: z.boolean(),
    cooldownDays: z.number().int().min(0).max(365).optional(),
    minCandidates: z.number().int().min(0).max(100000).optional(),
  })
  .strict();
export const SpacePolicyInput = z
  .object({
    enabled: z.boolean(),
    cooldownDays: z.number().int().min(0).max(365),
    minCandidates: z.number().int().min(0).max(100000),
    perArray: z.record(z.string(), spacePolicyArrayCfg),
  })
  .strict();

export const storageRouter = router({
  /** Current disk utilization per media array — the utilization card. Resilient to a downed *arr. */
  utilization: adminProcedure.query(({ ctx }) =>
    mapDomainErrors(() => getUtilization({ db: ctx.db, arr: resolveArrBundle(ctx) })),
  ),

  /** Reclaim attribution over a window (30d/90d/365d/all) — category × resolution, curve, per batch. */
  reclaim: adminProcedure
    .input(z.object({ window: z.enum(RECLAIM_WINDOWS).default('90d') }))
    .query(({ ctx, input }) => getReclaim({ db: ctx.db, window: input.window })),

  targets: router({
    /** The stored space_targets map (defaults to `{}` — no targets set). */
    get: adminProcedure.query(({ ctx }) => getAppSetting(ctx.db, 'space_targets')),

    /** Set the space_targets map — audited via the app_settings single-writer (update_app_setting). */
    set: adminProcedure.input(SpaceTargetsInput).mutation(({ ctx, input }) =>
      mapDomainErrors(() =>
        setAppSetting({
          db: ctx.db,
          key: 'space_targets',
          value: input.targets,
          actorId: ctx.user.id,
        }),
      ),
    ),
  }),

  // ADR-031 / DESIGN-014 (PLAN-014) — the space-driven POLICY: propose-only config + status. All
  // adminProcedure (operational + destructive-adjacent). The tuning/graduation READ lives on
  // trash.tuning; this card composes both.
  policy: router({
    /** The effective space-policy config (defaults merged — always fully populated, DEFAULT OFF). */
    get: adminProcedure.query(({ ctx }) => getSpacePolicy(ctx.db)),

    /** Ledger-derived status: last proposal (global + per kind), open-batch + cooldown/next-eligible. */
    status: adminProcedure.query(({ ctx }) => getSpacePolicyStatus({ db: ctx.db })),

    /**
     * Replace the space-policy config — audited via the app_settings single-writer (update_app_setting).
     * The whole object is replaced (like targets.set); the UI sends the merged object. Enabling is a
     * config change only: the propose-only sync job (which never deletes) acts on it out-of-band.
     */
    set: adminProcedure.input(SpacePolicyInput).mutation(({ ctx, input }) =>
      mapDomainErrors(() =>
        setAppSetting({
          db: ctx.db,
          key: 'space_policy',
          value: input,
          actorId: ctx.user.id,
        }),
      ),
    ),
  }),
});
