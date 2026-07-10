// ADR-037 / DESIGN-016 (PLAN-017) — the Metrics tRPC surface. The Overview composes three sources and
// is SHAPED by the caller's metrics level (server-authoritative — a `limited` caller never receives the
// full-only `network.wanLinks` key):
//   metrics.access            — the caller's own level + whether the section is visible (any authed user).
//   metrics.overview          — the Overview payload, gated by `metricsProcedure` (metrics section
//                               ≥ read_only) and shaped by `effectiveMetricsLevel`.
//   metrics.capacity.get/set* — the admin-editable WAN capacity denominators (audited app_settings).
import { z } from 'zod';
import {
  getAppSetting,
  getUtilization,
  setAppSetting,
  type StorageArrayUtilization,
} from '@hnet/domain';
import {
  getHardwareOverview,
  getNetworkOverview,
  type HardwareOverview,
  type NetworkOverview,
} from '@hnet/metrics';
import type { MetricsLevel } from '@hnet/db';
import {
  mapDomainErrors,
  resolveArrBundle,
  resolveMetricsReader,
  router,
  authedProcedure,
  type TRPCContext,
} from '../trpc';
import {
  adminProcedure,
  effectiveMetricsLevel,
  effectiveSectionLevel,
  metricsProcedure,
} from '../middleware/role';

/** The Overview payload. `network.wanLinks` is present ONLY when the caller is `full` (ADR-037 C-03). */
export interface MetricsOverview {
  level: MetricsLevel;
  network: NetworkOverview;
  hardware: HardwareOverview;
  /** REUSES the 013 `getUtilization` snapshot (not user-aware) — shown at both levels. */
  storage: StorageArrayUtilization[];
}

/** The storage snapshot must never crash the Overview — a missing arr env / down *arr degrades to []. */
async function safeStorage(ctx: TRPCContext): Promise<StorageArrayUtilization[]> {
  try {
    return await getUtilization({ db: ctx.db, arr: resolveArrBundle(ctx) });
  } catch {
    return [];
  }
}

const capacityInput = z.object({ mbps: z.number().int().min(0).max(1_000_000) });

export const metricsRouter = router({
  /** Any authed user: their own resolved level + whether the Metrics section is visible to them. */
  access: authedProcedure.query(({ ctx }) => ({
    level: effectiveMetricsLevel(ctx.user.role),
    canSee: effectiveSectionLevel(ctx.user.role, 'metrics') !== 'disabled',
  })),

  /**
   * The Overview. Gated by section visibility (metricsProcedure); the payload GRANULARITY is decided
   * here by the caller's level — a `limited` caller passes `includeWanLinks: false`, so the full-only
   * per-uplink breakdown is never fetched and never serialized (ADR-037 C-03).
   */
  overview: metricsProcedure.query(async ({ ctx }): Promise<MetricsOverview> => {
    const level = effectiveMetricsLevel(ctx.user.role);
    const prometheus = resolveMetricsReader(ctx);
    const [uploadCapacityMbps, downloadCapacityMbps] = await Promise.all([
      getAppSetting(ctx.db, 'upload_capacity_mbps'),
      getAppSetting(ctx.db, 'download_capacity_mbps'),
    ]);
    const [network, hardware, storage] = await Promise.all([
      getNetworkOverview({
        prometheus,
        uploadCapacityMbps,
        downloadCapacityMbps,
        includeWanLinks: level === 'full',
      }),
      getHardwareOverview({ prometheus }),
      safeStorage(ctx),
    ]);
    return { level, network, hardware, storage };
  }),

  /** The admin-editable WAN capacity denominators (Mbps). Admin-gated + audited on write. */
  capacity: router({
    get: adminProcedure.query(async ({ ctx }) => ({
      uploadMbps: await getAppSetting(ctx.db, 'upload_capacity_mbps'),
      downloadMbps: await getAppSetting(ctx.db, 'download_capacity_mbps'),
    })),
    setUpload: adminProcedure.input(capacityInput).mutation(({ ctx, input }) =>
      mapDomainErrors(() =>
        setAppSetting({
          db: ctx.db,
          key: 'upload_capacity_mbps',
          value: input.mbps,
          actorId: ctx.user.id,
        }),
      ),
    ),
    setDownload: adminProcedure.input(capacityInput).mutation(({ ctx, input }) =>
      mapDomainErrors(() =>
        setAppSetting({
          db: ctx.db,
          key: 'download_capacity_mbps',
          value: input.mbps,
          actorId: ctx.user.id,
        }),
      ),
    ),
  }),
});
