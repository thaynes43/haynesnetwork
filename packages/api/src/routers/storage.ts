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
});
