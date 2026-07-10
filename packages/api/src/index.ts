// @hnet/api — the tRPC v11 surface (ADR-004, DESIGN-003). Context reads the Better
// Auth session; the procedure ladder is publicProcedure → authedProcedure →
// adminProcedure; every permission-touching mutation delegates to @hnet/domain
// helpers that co-write permission_audit rows in the same transaction.
export { appRouter, type AppRouter, createCallerFactory } from './routers/index';
export { createTRPCContext, mapDomainErrors, type SessionUser, type TRPCContext } from './trpc';
export {
  catalogUrlSchema,
  CatalogEntryInput,
  CatalogEntryPatchInput,
  RoleInput,
  RolePatchInput,
  PlexLibraryInput,
  RoleLibrariesInput,
  RefreshRegistryInput,
} from './schemas';
export { resolvePlexBundle } from './trpc';
export { SectionPermissionInput, TrashActionsInput } from './schemas';
// ADR-023 — the Trash section gates the UX/nav reads on (server-authoritative).
// ADR-025 errata — `effectiveTrashActions` expands stored grants with the computed implication
// (`save_exclude` ⇒ `save_leaving_soon`) so the /trash page hands the client the same effective set.
export { hasTrashAction, effectiveTrashActions, trashActionProcedure } from './middleware/role';
// ADR-019 / DESIGN-008 — the poster-proxy upstream resolver + the TMDB fallback for removed
// items (used by the app poster route).
export {
  resolvePosterUpstream,
  resolveTmdbPosterFallback,
  type PosterUpstream,
  type TmdbFallbackDeps,
} from './poster';
// ADR-021 — the section-level resolver the nav + the Ledger export route gate on (server-authoritative).
export { effectiveSectionLevel } from './middleware/role';
// ADR-037 — the metrics-level resolver the /metrics page passes down (admin ⇒ 'full').
export { effectiveMetricsLevel, metricsProcedure } from './middleware/role';
// ADR-037 / DESIGN-016 — the Metrics Overview wire type (the /metrics client imports it TYPE-ONLY).
export type { MetricsOverview } from './routers/metrics';
// ADR-022 / DESIGN-009 D-06 — the emergency Ledger JSONL export (used by the app export route).
export {
  buildExportFilterFromParams,
  streamLedgerExportRows,
  type LedgerExportRow,
} from './ledger-export';
export type { MyApp } from './routers/catalog';
export type { MyServer, MyLibrary } from './routers/plex';
// ADR-030 amendment (2026-07-09) / DESIGN-013 D-07 — the native free-space trend: wire types (the
// Storage tab imports these TYPE-ONLY, erased at compile) + the thin Prometheus read client.
export {
  TREND_WINDOWS,
  TREND_WINDOW_SPECS,
  FREESPACE_TREND_QUERY,
  mapTrendSeries,
  getStorageTrend,
  type TrendWindow,
  type TrendPoint,
  type StorageTrendSeries,
  type StorageTrendReport,
} from './storage-trend';
export {
  createPrometheusClient,
  prometheusClientFromEnv,
  PROMETHEUS_DEFAULT_URL,
  type PrometheusRangeReader,
  type PromMatrixSeries,
} from './prometheus';
