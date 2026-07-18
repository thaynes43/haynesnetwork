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
// ADR-047 / DESIGN-025 (PLAN-028) — THE INVARIANT surface: the access gate resolver (used by the poster
// route + the Ledger export route), the per-item poster-proxy check, and the /library page's server-side
// Movies/TV/Music tab-visibility resolver.
export {
  resolveLibraryAccessGate,
  isMediaItemAccessibleToUser,
  resolveMediaTabVisibility,
  resolveArtMatchForItem,
  type LibraryAccessGate,
  type PlexPlayTarget,
  type PlexArtMatch,
} from './library-access';
// ADR-048 / DESIGN-005 D-22 (PLAN-030) — the TV season/episode art proxy seam: the signed item-scoped
// thumb reference (mint + verify), the transcode-upstream resolver on the matched server, and the LRU key
// (used by the /api/library/plex-art app route). THE INVARIANT: art is served only bound to an item the
// caller can access.
export {
  signPlexArtRef,
  verifyPlexArtRef,
  buildPlexArtUrl,
  resolvePlexArtUpstream,
  plexArtEtag,
  plexArtCacheKey,
  isPlexServerSlug,
  type PlexArtSize,
  type PlexArtUpstream,
} from './library-plex-art';
// ADR-037 — the metrics-level resolver the /metrics page passes down (admin ⇒ 'full').
export { effectiveMetricsLevel, metricsProcedure } from './middleware/role';
// ADR-037 / DESIGN-016 — the Metrics Overview wire type (the /metrics client imports it TYPE-ONLY).
export type { MetricsOverview } from './routers/metrics';
// ADR-038 / DESIGN-017 (PLAN-022) — the ytdl-sub Library: the `ytdlsub` section rung (the /library route
// gate reuses `effectiveSectionLevel`), the Plex-thumb proxy upstream resolver (used by the app poster
// route), and the wire types the ytdl-sub browser imports TYPE-ONLY.
export { ytdlsubProcedure } from './middleware/role';
// ADR-047 / DESIGN-025 (PLAN-028) — the per-library k8plex access gate for the Peloton/YouTube sub-tabs
// (the /library page splices only the libraries the caller's role can access; admin ⇒ both).
export { accessibleYtdlsubLibraries } from './routers/ytdlsub';
// ADR-041 / DESIGN-017 D-07 — thumb VARIANTS (closed size allow-list), the strong (size, thumb) ETag,
// and the in-process LRU the poster route memoizes transcoded variants in (NOT a store).
export {
  resolveYtdlsubThumbUpstream,
  isValidPlexThumbPath,
  isYtdlsubThumbSize,
  ytdlsubThumbEtag,
  ytdlsubThumbCache,
  ThumbLruCache,
  YTDLSUB_THUMB_SIZES,
} from './ytdlsub-poster';
export type { YtdlsubThumbSize, YtdlsubThumbUpstream, CachedThumb } from './ytdlsub-poster';
// ADR-046 / DESIGN-024 (PLAN-023) — the Books Library surface: the `books` section rung (the app cover
// route reuses `effectiveSectionLevel`), the book-cover proxy helper (used by the app /api/books/cover
// route), and the wire types the Books browser imports TYPE-ONLY.
export { booksProcedure } from './middleware/role';
// ADR-055 / DESIGN-028 (PLAN-044) — the Integrations section gate for the Integrations tab surface.
export { integrationsProcedure } from './middleware/role';
export {
  getBooksCover,
  booksCoverCache,
  booksCoverEtag,
  isBooksSource,
  isValidBooksExternalId,
  ABS_COVER_VARIANT,
} from './books-cover';
export type { BooksCoverResult } from './books-cover';
// DESIGN-026 D-04 amendment (group-card art) — the ABS author-portrait surface: the directory the
// books.groups enrichment reads, and the sized-image read the /api/books/author-image route serves.
export {
  ABS_AUTHOR_IMAGE_VARIANT,
  absAuthorDirectory,
  absAuthorImageEtag,
  absAuthorImageUrlFor,
  getAbsAuthorImage,
  isValidAbsAuthorId,
  isValidAbsAuthorVersion,
} from './books-author-art';
export type { AbsAuthorArtRef, AbsAuthorImageResult } from './books-author-art';
export { booksCoverUrlFor, toBooksListItem, BOOKS_SORTS } from './books-query';
export type { BooksListItem, BooksSort, BooksSearchInput, BookReadState } from './books-query';
export { BOOK_READ_STATES } from './books-query';
// PLAN-056 / DESIGN-029 amendment 3 — the three-state composed-Wanted filter + the entry union.
export { BOOKS_WANTED_STATES } from './books-query';
export type { BooksWantedState } from './books-query';
export type {
  BooksSearchResult,
  BooksSearchEntry,
  BooksWantedItem,
  BooksDetailResult,
  BooksCollectionGroup,
  BooksCollectionCategoryCounts,
} from './routers/books';
// ADR-051 / DESIGN-026 (PLAN-029 step 2) — the engine key/facet types the client-side registry
// type-checks its declarations against (TYPE-ONLY — erased at compile; the registry is authoritative
// on which (wall, view-level) offers which key, these unions are the per-engine supersets).
export type { LibrarySortField, WatchState } from './ledger-query';
export type { BooksGroup, BookLengthBucket, BookFormatKey } from './books-query';
// ADR-052 / DESIGN-026 D-06 (PLAN-029) — the per-user Library preferences wire type (the /library route
// + the UX agent's client import it TYPE-ONLY). Re-exported so the inferred caller type stays portable.
export type { WallPreference } from './routers/library';
export type {
  YtdlsubShow,
  YtdlsubListResult,
  YtdlsubLibraryId,
  YtdlsubLibrarySummary,
  YtdlsubShowDetail,
  YtdlsubSeason,
  YtdlsubDetailResult,
  YtdlsubEpisode,
  YtdlsubEpisodesResult,
} from './routers/ytdlsub';
// ADR-048 / DESIGN-005 D-22 (PLAN-030) — the TV season-poster + episode-thumb wire shapes (client-typed).
export type {
  LedgerPlexSeason,
  LedgerPlexSeasonsResult,
  LedgerPlexEpisodeArt,
  LedgerPlexEpisodeArtResult,
} from './routers/ledger';
// ADR-064 / DESIGN-035 D-03 (PLAN-037) — the Movies/TV Collections group-card wire shape (client-typed).
export type { LedgerCollectionGroup } from './routers/ledger';
// DESIGN-035 D-10'/D-11' — the chip row's gated per-category counts (OPEN vocabulary: the client
// orders whatever categories are present hint-list-then-alphabetical; no fixed enum to pull).
export type { LedgerCollectionCategoryCounts } from './routers/ledger';
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
