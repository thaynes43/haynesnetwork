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
  getAppsMetrics,
  getHardwareMetrics,
  getHardwareOverview,
  getNetworkMetrics,
  getNetworkOverview,
  overviewGrafanaLinks,
  type AppsMetrics,
  type HardwareMetrics,
  type HardwareOverview,
  type NetworkMetrics,
  type NetworkOverview,
  type OverviewGrafanaLinks,
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
  /**
   * ADMIN-ONLY (DESIGN-016 D-07). The LAN-only Grafana footnote link. Present ONLY when the caller is
   * an admin; OMITTED for every non-admin caller at BOTH levels — a member/family response never carries
   * a Grafana URL. Gated on ADMIN status (LAN reachability), not the metrics level.
   */
  grafana?: OverviewGrafanaLinks;
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
    const payload: MetricsOverview = { level, network, hardware, storage };
    // Admin-only: the LAN-only Grafana footnote link is attached ONLY for an admin caller (D-07).
    if (ctx.user.role.isAdmin) payload.grafana = overviewGrafanaLinks();
    return payload;
  }),

  /**
   * DESIGN-018 (PLAN-018) — the Apps sub-tab payload: the media-automation apps (*arr + downloaders +
   * indexers) in four curated groups, read from the same in-cluster Prometheus. Gated by section
   * visibility (metricsProcedure). No *arr/downloader series names a user, so the payload is the same
   * at both levels — but the full-only seam is kept plumbed via `includeUserAware` (ADR-037 C-03): at
   * `full` a present-but-empty `requesterActivity` key is included; at `limited` it is omitted, so a
   * future requester panel slots into the full-only branch without a refactor.
   */
  apps: metricsProcedure.query(async ({ ctx }): Promise<AppsMetrics> => {
    const level = effectiveMetricsLevel(ctx.user.role);
    return getAppsMetrics({
      prometheus: resolveMetricsReader(ctx),
      includeUserAware: level === 'full',
      // Admin-only: the LAN-only Grafana deep-links (D-07) — gated on admin, not level.
      includeGrafanaLinks: ctx.user.role.isAdmin,
    });
  }),

  /**
   * ADR-040 / DESIGN-020 (PLAN-019) — the Hardware sub-tab payload: SMART drive health + NVMe
   * endurance, per-node load/temperature, and the Proxmox host→VM showcase. Gated by section
   * visibility (metricsProcedure) only. **UNGATED beyond that (owner ruling R-129): the payload is
   * identical at `full` and `limited`** — hardware is not user-aware, so there is no level shaping
   * here (unlike apps/network). Every field degrades independently in the read model — never a throw.
   */
  hardware: metricsProcedure.query(({ ctx }): Promise<HardwareMetrics> =>
    getHardwareMetrics({
      prometheus: resolveMetricsReader(ctx),
      // Admin-only: the LAN-only Grafana deep-links (D-07) — hardware is ungated by level, but the
      // Grafana links are still admin-gated (LAN reachability, not detail).
      includeGrafanaLinks: ctx.user.role.isAdmin,
    }),
  ),

  /**
   * ADR-039 / DESIGN-019 (PLAN-020) — the Network sub-tab payload. Gated by section visibility
   * (metricsProcedure) and SHAPED by the caller's level (ADR-039 C-03): `limited` gets ONLY the WAN
   * usage-vs-capacity meters (reusing the Overview's capacity denominators — not duplicated) + the WAN
   * throughput history; `full` ADDS the infrastructure grain (per-AP/switch/gateway performance, WAN
   * health, site rollup counts, per-uplink caps). The infra queries are ONLY issued when the caller is
   * `full` (includeInfra) — never fetched, never serialized for `limited`. The allow-listed `network.ts`
   * query module structurally never names a client series, so NO shape can leak a client identity.
   */
  network: metricsProcedure.query(async ({ ctx }): Promise<NetworkMetrics> => {
    const level = effectiveMetricsLevel(ctx.user.role);
    const [uploadCapacityMbps, downloadCapacityMbps] = await Promise.all([
      getAppSetting(ctx.db, 'upload_capacity_mbps'),
      getAppSetting(ctx.db, 'download_capacity_mbps'),
    ]);
    return getNetworkMetrics({
      prometheus: resolveMetricsReader(ctx),
      uploadCapacityMbps,
      downloadCapacityMbps,
      includeInfra: level === 'full',
      // Admin-only: the LAN-only Grafana deep-links (D-07) — gated on admin, not level.
      includeGrafanaLinks: ctx.user.role.isAdmin,
    });
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
