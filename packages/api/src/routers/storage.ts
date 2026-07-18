// ADR-030 / DESIGN-013 (PLAN-013 disk + reclaim metrics) — the Storage tRPC surface. Three reads plus
// one write, all ADMIN-gated for v1 (operational data; DESIGN-013 notes a future section-permission if
// this ever goes member-facing):
//   storage.utilization       — current disk utilization per media array (*arr /diskspace, resilient).
//   storage.trend({window})   — the native free-space trend (Prometheus exportarr history + targets;
//                               ADR-030 amendment 2026-07-09 — replaces the Grafana deep-link).
//   storage.reclaim({window}) — reclaim attribution over a window (PG deletion snapshots + expedite).
//   storage.targets.get       — the per-server space_targets map (drives the reference line).
//   storage.targets.set       — set the targets (audited via the app_settings single-writer).
import { z } from 'zod';
import {
  getReclaim,
  getUtilization,
  getAppSetting,
  getNotifyWindow,
  getSpacePolicy,
  getSpacePolicyStatus,
  setAppSetting,
  RECLAIM_WINDOWS,
  SPACE_POLICY_MODES,
} from '@hnet/domain';
import { mapDomainErrors, resolveArrBundle, resolvePrometheusReader, router } from '../trpc';
import { adminProcedure } from '../middleware/role';
import { getStorageTrend, TREND_WINDOWS } from '../storage-trend';

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
    minCandidates: z.number().int().min(0).max(100000).optional(),
  })
  .strict();
// DESIGN-014 amendment (2026-07-09, build A) — a per-kind composition cap and the movie/tv cap map.
// `value` is an item count (maxItems) or bytes (targetBytes); the domain applies only ENABLED caps and
// re-guards each field, so bounds here are just sanity rails. Both kinds are required (getSpacePolicy
// always emits a fully-populated perKind, so the UI round-trips the whole object like perArray).
const spacePolicyCap = z
  .object({ enabled: z.boolean(), value: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER) })
  .strict();
const spacePolicyKindCaps = z
  .object({ maxItems: spacePolicyCap, targetBytes: spacePolicyCap })
  .strict();
export const SpacePolicyInput = z
  .object({
    enabled: z.boolean(),
    // DESIGN-014 amendment (2026-07-09, build A) — the proposal mode.
    mode: z.enum(SPACE_POLICY_MODES),
    minCandidates: z.number().int().min(0).max(100000),
    perArray: z.record(z.string(), spacePolicyArrayCfg),
    // DESIGN-014 amendment (2026-07-09, build A) — per-kind caps (replaces the retired flat
    // targetBytesPerBatch, which getSpacePolicy still migrates when reading an old stored row).
    perKind: z.object({ movie: spacePolicyKindCaps, tv: spacePolicyKindCaps }).strict(),
  })
  .strict();

/**
 * ADR-034 / DESIGN-015 — the Pushover delivery window the Notifications card writes. `[startHour,
 * endHour)` in `tz`; `startHour < endHour` is enforced (overnight windows are out of scope, DESIGN-015
 * Q-03). `tz` is a non-empty IANA name (the domain re-validates via Intl before use). The inferred
 * shape is exactly @hnet/domain's NotifyWindow — no cast needed.
 */
export const NotifyWindowInput = z
  .object({
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(1).max(24),
    tz: z.string().min(1).max(64),
  })
  .strict()
  .refine((w) => w.startHour < w.endHour, {
    message: 'startHour must be before endHour (overnight windows are not supported)',
    path: ['endHour'],
  });

export const storageRouter = router({
  /** Current disk utilization per media array — the utilization card. Resilient to a downed *arr. */
  utilization: adminProcedure.query(({ ctx }) =>
    mapDomainErrors(() => getUtilization({ db: ctx.db, arr: resolveArrBundle(ctx) })),
  ),

  /**
   * The native free-space trend (ADR-030 amendment 2026-07-09 / DESIGN-013 D-07): exportarr
   * history from Prometheus grouped to the SAME arrays as `utilization`, plus the space-target
   * drawn as a free-bytes floor. Prometheus down ⇒ `unavailable: true`, never a crashed tab.
   */
  trend: adminProcedure
    .input(z.object({ window: z.enum(TREND_WINDOWS).default('30d') }))
    .query(({ ctx, input }) =>
      mapDomainErrors(() =>
        getStorageTrend({
          db: ctx.db,
          arr: resolveArrBundle(ctx),
          prometheus: resolvePrometheusReader(ctx),
          window: input.window,
        }),
      ),
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

    /** Ledger-derived status: last proposal (global + per kind) + each kind's open-batch state. */
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

  // ADR-034 / DESIGN-015 (PLAN-016) — the Pushover delivery window (the owner's quiet-hours control).
  // adminProcedure (operator setting); audited through the app_settings single-writer.
  notify: router({
    window: router({
      /** The effective delivery window (default merged + fail-safe validated). */
      get: adminProcedure.query(({ ctx }) => getNotifyWindow(ctx.db)),

      /** Replace the delivery window — audited via setAppSetting (update_app_setting). */
      set: adminProcedure.input(NotifyWindowInput).mutation(({ ctx, input }) =>
        mapDomainErrors(() =>
          setAppSetting({
            db: ctx.db,
            key: 'notify_window',
            value: input,
            actorId: ctx.user.id,
          }),
        ),
      ),
    }),
  }),
});
