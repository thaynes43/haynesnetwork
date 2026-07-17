// DESIGN-003 D-01/D-02/D-13 — tRPC context, procedure ladder, and the domain-error
// seam (ADR-004). Donor: todos-for-dues packages/api/src/trpc.ts. No wire transformer
// (D-03): procedures return plain-JSON-safe shapes; timestamps are emitted as ISO-8601
// strings explicitly, never raw Date fields.
import { initTRPC, TRPCError } from '@trpc/server';
import { getServerSession, type SessionUser } from '@hnet/auth';
import { db, type Database } from '@hnet/db';
import {
  arrClientBundleFromEnv,
  ArrUpstreamError,
  AuthentikGroupNotOwnedError,
  AuthentikUnavailableError,
  authentikPortalBundleFromEnv,
  ConcurrentTransitionError,
  FixAlreadyOpenError,
  FixRateLimitError,
  FixTargetRequiredError,
  InvalidCatalogUrlError,
  InvalidGoodreadsProfileError,
  KapowarrUpstreamError,
  kapowarrBundleFromEnv,
  type KapowarrClientBundle,
  booksActivityBundleFromEnv,
  buildArrActivityAdapter,
  buildKapowarrActivityAdapter,
  resolveArrBaseUrls,
  resolveKapowarrBaseUrl,
  type ActivitySourceAdapter,
  type BooksActivityBundle,
  LastAdminError,
  LazyLibrarianUpstreamError,
  lazyLibrarianBundleFromEnv,
  type LazyLibrarianClientBundle,
  librettoBundleFromEnv,
  type LibrettoClientBundle,
  CollectionAcquireForbiddenError,
  CollectionSuggestionNotOpenError,
  LedgerItemTombstonedError,
  LibraryNotAllowedError,
  maintainerrClientBundleFromEnv,
  MaintainerrUnsafeError,
  MaintainerrUpstreamError,
  BookFixAlreadyOpenError,
  BookFixRateLimitError,
  BookFixUnroutableError,
  InvalidTicketTargetError,
  InvalidTicketTransitionError,
  NotFoundError,
  OwuiUnavailableError,
  PlexAccountUnmatchedError,
  PlexAllStateError,
  PlexServerUnavailableError,
  plexClientBundleFromEnv,
  ReorderMismatchError,
  RestoreProfileUnmappedError,
  RoleNameConflictError,
  SearchCapExceededError,
  SubtitleFixUnsupportedError,
  SyncedTierInvalidError,
  SystemRoleImmutableError,
  TrashBatchEmptyError,
  TrashBatchOpenError,
  TrashBatchStateError,
  TrashMusicUnsupportedError,
  TrashSaveNotOwnedError,
  type ArrClientBundle,
  type AuthentikPortalBundle,
  type MaintainerrClientBundle,
  type PlexClientBundle,
} from '@hnet/domain';
import { prometheusClientFromEnv, type PrometheusRangeReader } from './prometheus';
// ADR-037 / DESIGN-016 (PLAN-017 Metrics) — the read-only Prometheus reader for the Metrics section.
// A DISTINCT reader from `./prometheus` (which is range-only, storage-trend): @hnet/metrics adds the
// instant `query` the Overview needs. Kept separate so the shipped storage vertical stays untouched.
import {
  prometheusClientFromEnv as metricsReaderFromEnv,
  type PrometheusReader as MetricsPrometheusReader,
} from '@hnet/metrics';
// ADR-068 / DESIGN-040 (PLAN-057) — the estate play scoreboard: the TTL-memoized read-only
// Tautulli aggregation source. `@hnet/arr`'s TautulliClient satisfies ScoreboardReader
// structurally; clients are built with a 3s timeout so a slow instance loses the D-02
// deadline race instead of riding ArrHttp's GET retries into a slow dashboard.
import {
  createPlayScoreboard,
  SCOREBOARD_DEADLINE_MS,
  type PlayScoreboardSource,
} from '@hnet/metrics';
import { resolveTautulliInstances } from '@hnet/arr';
import { TautulliClient } from '@hnet/arr/read';
// ADR-055 / DESIGN-028 (PLAN-044) — the read-only Goodreads RSS + Google Books clients the integrations.link
// mutation uses to resolve a vanity URL → user id, probe the public shelf is reachable (no secret), and run
// the first shelf sync inline so the coverage card isn't a "0 of 0" dead-end. Read-only.
import { GoodreadsRssClient, GoogleBooksClient, goodreadsConfigFromEnv } from '@hnet/goodreads';
// ADR-070 / DESIGN-043 (PLAN-052 — collection manager) — the confined Libretto client's error taxonomy,
// mapped honestly: an unreachable host (network/timeout/5xx) → BAD_GATEWAY (the manager degrades), a 4xx
// (a bad recipe save — 400 with per-path issues) → BAD_REQUEST carrying the issues.
import { LibrettoHttpError, LibrettoUnreachableError } from '@hnet/libretto';

export type { SessionUser };

export interface TRPCContext {
  db: Database;
  /** null ⇢ no/invalid session (D-01). */
  user: SessionUser | null;
  /**
   * DESIGN-005 D-17/D-18 — the *arr client bundle the ledger/fix/restore procedures
   * run against. Absent in production contexts (built lazily from env on first use);
   * tests inject fetch-stubbed bundles here (ADR-010 — no live-API tests in CI).
   */
  arr?: ArrClientBundle;
  /**
   * ADR-017 / DESIGN-007 D-05 — the Plex client bundle the plex procedures (registry
   * refresh, share/unshare, myLibraries live-state) run against. Same injection model as
   * `arr`: env-built singleton in production, stubbed bundle in tests.
   */
  plex?: PlexClientBundle;
  /**
   * ADR-023 / DESIGN-010 D-01 — the Maintainerr client bundle the Trash procedures run against.
   * Same injection model: env-built singleton in production (built lazily on first Trash call —
   * requires MAINTAINERR_API_KEY), stubbed bundle in tests.
   */
  maintainerr?: MaintainerrClientBundle;
  /**
   * ADR-030 amendment (2026-07-09) / DESIGN-013 D-07 — the Prometheus range reader the
   * `storage.trend` read runs against. Same injection model: env-built singleton in production
   * (PROMETHEUS_URL, in-cluster default), stubbed reader in tests.
   */
  prometheus?: PrometheusRangeReader;
  /**
   * ADR-037 / DESIGN-016 (PLAN-017) — the @hnet/metrics Prometheus reader the `metrics.overview` read
   * runs against (instant + range). Same injection model: env-built singleton in production
   * (PROMETHEUS_URL, in-cluster default), stubbed reader in tests.
   */
  metrics?: MetricsPrometheusReader;
  /**
   * ADR-045 / DESIGN-023 (PLAN-026) — the Authentik + Open WebUI portal bundle the /admin/users +
   * synced-tier procedures run against (directory read, group create, membership write). Same injection
   * model: env-built singleton in production (AUTHENTIK_API_TOKEN + OPENWEBUI_API_KEY), stubbed bundle in
   * tests.
   */
  authentikPortal?: AuthentikPortalBundle;
  /**
   * ADR-055 / DESIGN-028 (PLAN-044) — the confined LazyLibrarian bundle the `integrations.search` (manual
   * re-search) runs against. Env-built singleton in production (LAZYLIBRARIAN_API_KEY); stubbed in tests.
   */
  lazylibrarian?: LazyLibrarianClientBundle;
  /**
   * ADR-056 (PLAN-046) — the confined Kapowarr bundle the comic leg of `integrations.search` (comic
   * force-search) runs against. Env-built singleton in production (KAPOWARR_API_KEY); stubbed in tests.
   */
  kapowarr?: KapowarrClientBundle;
  /**
   * ADR-055 / DESIGN-028 (PLAN-044) — the read-only Goodreads RSS client `integrations.link` resolves a
   * vanity URL + probes shelf reachability with. Env-built singleton in production; stubbed in tests.
   */
  goodreads?: GoodreadsRssClient;
  /**
   * ADR-055 / DESIGN-028 (PLAN-044) — the read-only Google Books enrichment client the first-sync-on-link
   * fast path uses to resolve shelf items to LazyLibrarian volume ids. Env-built singleton in production;
   * absent/stubbed in tests (a fresh-link background sync is best-effort — the hourly CronJob is the SoT).
   */
  googleBooks?: GoogleBooksClient;
  /**
   * ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the BOOKS activity bundle the `activity.*`
   * procedures read/act through (the LL wanted-table + SAB queue/history adapter + the confined LL write).
   * Env-built singleton in production (LAZYLIBRARIAN_* + SABNZBD_*); stubbed bundle in tests.
   */
  activity?: BooksActivityBundle;
  /**
   * ADR-070 / DESIGN-043 (PLAN-052 — collection manager) — the confined Libretto bundle the
   * `collections.*` manager procedures read/write through (list recipes/collections/runs, validate,
   * upsert/delete/apply — the content-pulling writes). Env-built singleton in production
   * (LIBRETTO_API_KEY); stubbed bundle in tests. NEVER constructed in the browser.
   */
  libretto?: LibrettoClientBundle;
  /**
   * ADR-068 / DESIGN-040 (PLAN-057) — the estate play scoreboard source `metrics.playScoreboard`
   * reads (the ~10-min TTL memo over the three Tautullis). Env-built singleton in production
   * (resolveTautulliInstances — absent env ⇒ zero readers ⇒ `unavailable`, never an error);
   * injected fake in tests.
   */
  playScoreboard?: PlayScoreboardSource;
}

let envArrBundle: ArrClientBundle | undefined;

/** The bundle for this request: injected (tests) or the env-built singleton (D-18). */
export function resolveArrBundle(ctx: TRPCContext): ArrClientBundle {
  if (ctx.arr) return ctx.arr;
  envArrBundle ??= arrClientBundleFromEnv();
  return envArrBundle;
}

let envMaintainerrBundle: MaintainerrClientBundle | undefined;

/** The Maintainerr bundle for this request: injected (tests) or the env-built singleton (D-01). */
export function resolveMaintainerrBundle(ctx: TRPCContext): MaintainerrClientBundle {
  if (ctx.maintainerr) return ctx.maintainerr;
  envMaintainerrBundle ??= maintainerrClientBundleFromEnv();
  return envMaintainerrBundle;
}

let envPlexBundle: PlexClientBundle | undefined;

/** The Plex bundle for this request: injected (tests) or the env-built singleton (D-05). */
export function resolvePlexBundle(ctx: TRPCContext): PlexClientBundle {
  if (ctx.plex) return ctx.plex;
  envPlexBundle ??= plexClientBundleFromEnv();
  return envPlexBundle;
}

let envPrometheus: PrometheusRangeReader | undefined;

/** The Prometheus reader for this request: injected (tests) or the env-built singleton (D-07). */
export function resolvePrometheusReader(ctx: TRPCContext): PrometheusRangeReader {
  if (ctx.prometheus) return ctx.prometheus;
  envPrometheus ??= prometheusClientFromEnv();
  return envPrometheus;
}

let envMetricsReader: MetricsPrometheusReader | undefined;

/** The @hnet/metrics reader for this request: injected (tests) or the env-built singleton (ADR-037). */
export function resolveMetricsReader(ctx: TRPCContext): MetricsPrometheusReader {
  if (ctx.metrics) return ctx.metrics;
  envMetricsReader ??= metricsReaderFromEnv();
  return envMetricsReader;
}

let envPlayScoreboard: PlayScoreboardSource | undefined;

/**
 * The play-scoreboard source for this request: injected (tests) or the env-built singleton
 * (ADR-068). The memo lives inside the source, so the singleton IS the cache.
 */
export function resolvePlayScoreboardSource(ctx: TRPCContext): PlayScoreboardSource {
  if (ctx.playScoreboard) return ctx.playScoreboard;
  envPlayScoreboard ??= createPlayScoreboard({
    readers: resolveTautulliInstances().map((inst) => {
      const client = new TautulliClient({
        baseUrl: inst.baseUrl,
        apiKey: inst.apiKey,
        timeoutMs: SCOREBOARD_DEADLINE_MS,
      });
      return { slug: inst.slug, getLibrariesTable: () => client.getLibrariesTable() };
    }),
  });
  return envPlayScoreboard;
}

let envAuthentikPortalBundle: AuthentikPortalBundle | undefined;

/** The Authentik/OWUI portal bundle: injected (tests) or the env-built singleton (ADR-045). */
export function resolveAuthentikPortalBundle(ctx: TRPCContext): AuthentikPortalBundle {
  if (ctx.authentikPortal) return ctx.authentikPortal;
  envAuthentikPortalBundle ??= authentikPortalBundleFromEnv();
  return envAuthentikPortalBundle;
}

let envLazyLibrarianBundle: LazyLibrarianClientBundle | undefined;

/** The LazyLibrarian bundle for this request: injected (tests) or the env-built singleton (ADR-055). */
export function resolveLazyLibrarianBundle(ctx: TRPCContext): LazyLibrarianClientBundle {
  if (ctx.lazylibrarian) return ctx.lazylibrarian;
  envLazyLibrarianBundle ??= lazyLibrarianBundleFromEnv();
  return envLazyLibrarianBundle;
}

let envKapowarrBundle: KapowarrClientBundle | undefined;

/** The Kapowarr bundle for this request: injected (tests) or the env-built singleton (ADR-056). */
export function resolveKapowarrBundle(ctx: TRPCContext): KapowarrClientBundle {
  if (ctx.kapowarr) return ctx.kapowarr;
  envKapowarrBundle ??= kapowarrBundleFromEnv();
  return envKapowarrBundle;
}

let envLibrettoBundle: LibrettoClientBundle | undefined;

/** The Libretto bundle for this request: injected (tests) or the env-built singleton (ADR-070). */
export function resolveLibrettoBundle(ctx: TRPCContext): LibrettoClientBundle {
  if (ctx.libretto) return ctx.libretto;
  envLibrettoBundle ??= librettoBundleFromEnv();
  return envLibrettoBundle;
}

let envGoodreadsClient: GoodreadsRssClient | undefined;

/** The Goodreads RSS client for this request: injected (tests) or the env-built singleton (ADR-055). */
export function resolveGoodreadsRssClient(ctx: TRPCContext): GoodreadsRssClient {
  if (ctx.goodreads) return ctx.goodreads;
  if (!envGoodreadsClient) {
    const cfg = goodreadsConfigFromEnv();
    envGoodreadsClient = new GoodreadsRssClient({ baseUrl: cfg.goodreadsBaseUrl });
  }
  return envGoodreadsClient;
}

let envActivityBundle: BooksActivityBundle | undefined;

/** The books activity bundle for this request: injected (tests) or the env-built singleton (ADR-059). */
export function resolveActivityBundle(ctx: TRPCContext): BooksActivityBundle {
  if (ctx.activity) return ctx.activity;
  envActivityBundle ??= booksActivityBundleFromEnv();
  return envActivityBundle;
}

/**
 * ADR-059 / DESIGN-030 D-08 (PLAN-048) — the UNIVERSAL *arr activity adapter for this request: the
 * Radarr/Sonarr/Lidarr queue + recent-import read, built off the same *arr read-client bundle the
 * fix/restore procedures use (injected in tests, env-built singleton in prod). Read-only — the failure
 * ACTIONS fire the confined write clients on `resolveArrBundle(ctx).write` after commit. Base URLs (the
 * Admin-only downstream link) come from env; a missing one falls back to the in-cluster service DNS.
 */
export function resolveArrActivityAdapter(ctx: TRPCContext): ActivitySourceAdapter {
  return buildArrActivityAdapter(resolveArrBundle(ctx).read, { baseUrls: resolveArrBaseUrls() });
}

/**
 * ADR-059 / DESIGN-030 D-08 (PLAN-048) — the KAPOWARR (comics) activity adapter for this request: the live
 * download queue + running search tasks + recent history read, built off the same confined Kapowarr bundle's
 * READ client the comic force-search uses (injected in tests, env-built singleton in prod). Read-only — the
 * failure force-search ACTION reuses the confined `searchVolume` write on `resolveKapowarrBundle(ctx).write`
 * after commit. Comics ride the books section gate, so this adapter is only merged when books is visible.
 */
export function resolveKapowarrActivityAdapter(ctx: TRPCContext): ActivitySourceAdapter {
  return buildKapowarrActivityAdapter(resolveKapowarrBundle(ctx).read, { baseUrl: resolveKapowarrBaseUrl() });
}

let envGoogleBooksClient: GoogleBooksClient | undefined;

/** The Google Books client for this request: injected (tests) or the env-built singleton (ADR-055). */
export function resolveGoogleBooksClient(ctx: TRPCContext): GoogleBooksClient {
  if (ctx.googleBooks) return ctx.googleBooks;
  if (!envGoogleBooksClient) {
    const cfg = goodreadsConfigFromEnv();
    envGoogleBooksClient = new GoogleBooksClient({
      baseUrl: cfg.googleBooksUrl,
      ...(cfg.googleBooksApiKey ? { apiKey: cfg.googleBooksApiKey } : {}),
    });
  }
  return envGoogleBooksClient;
}

function hasKnownRole(user: SessionUser): boolean {
  // ADR-012: a valid session always carries a role object (users ⋈ roles). Fail closed if
  // the shape is somehow malformed.
  return typeof user.role?.isAdmin === 'boolean' && typeof user.role.id === 'string';
}

/**
 * D-01 — per-request context: getServerSession reads the Better Auth session from the
 * request headers and hydrates { role: { id, name, isAdmin }, displayName } (DESIGN-002
 * D-06, ADR-012). A missing/malformed role coerces to a null user — fail closed.
 */
export const createTRPCContext = async ({
  headers,
}: {
  headers: Headers;
}): Promise<TRPCContext> => {
  const session = await getServerSession(headers);
  const user = session && hasKnownRole(session.user) ? session.user : null;
  return { db, user };
};

/**
 * D-13 — the domain-error classes whose `code` field becomes the wire `appCode`
 * (DESIGN-003 table + the DESIGN-005 D-17 additions). ONLY the errorFormatter below
 * iterates this list; mapDomainErrors is a hand-written instanceof chain (and also
 * handles NotFoundError, which carries no appCode). The two are INDEPENDENT and CAN
 * drift — adding a coded domain error is a two-place edit here (this list AND the
 * mapDomainErrors chain), plus the DESIGN-003 D-13 and DESIGN-005 D-17 tables. See
 * packages/api/README.md.
 */
const APP_CODED_ERRORS = [
  InvalidCatalogUrlError,
  RoleNameConflictError,
  SystemRoleImmutableError,
  LastAdminError,
  ConcurrentTransitionError,
  ReorderMismatchError,
  FixRateLimitError,
  FixAlreadyOpenError,
  FixTargetRequiredError,
  SubtitleFixUnsupportedError,
  LedgerItemTombstonedError,
  ArrUpstreamError,
  RestoreProfileUnmappedError,
  LibraryNotAllowedError,
  PlexAccountUnmatchedError,
  PlexAllStateError,
  PlexServerUnavailableError,
  SearchCapExceededError,
  MaintainerrUnsafeError,
  MaintainerrUpstreamError,
  TrashMusicUnsupportedError,
  TrashBatchStateError,
  TrashBatchOpenError,
  TrashBatchEmptyError,
  TrashSaveNotOwnedError,
  AuthentikGroupNotOwnedError,
  AuthentikUnavailableError,
  OwuiUnavailableError,
  SyncedTierInvalidError,
  InvalidGoodreadsProfileError,
  LazyLibrarianUpstreamError,
  KapowarrUpstreamError,
] as const;

const t = initTRPC.context<TRPCContext>().create({
  // D-13 — attach the stable appCode so clients switch on a machine-readable string,
  // never on the message (donor errorFormatter pattern).
  errorFormatter({ shape, error }) {
    const cause = error.cause;
    for (const ErrorClass of APP_CODED_ERRORS) {
      if (cause instanceof ErrorClass) {
        return { ...shape, data: { ...shape.data, appCode: cause.code } };
      }
    }
    return shape;
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const createCallerFactory = t.createCallerFactory;

// D-02 — exactly three rungs in Phase 1 (adminProcedure lives in middleware/role.ts).
export const publicProcedure = t.procedure;

export const authedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx: { ...ctx, user: ctx.user } }); // narrowed non-null
});

/**
 * D-13 — maps typed @hnet/domain errors to the right TRPCError code (donor pattern);
 * procedures wrap their domain calls in `mapDomainErrors(async () => { ... })`. The
 * original error rides along as `cause`, where the errorFormatter finds it to attach
 * the wire appCode.
 *
 * | Domain error                | appCode                     | TRPC code             |
 * |-----------------------------|-----------------------------|-----------------------|
 * | InvalidCatalogUrlError      | CATALOG_URL_INVALID         | UNPROCESSABLE_CONTENT |
 * | RoleNameConflictError       | ROLE_NAME_CONFLICT          | CONFLICT              |
 * | SystemRoleImmutableError    | ROLE_IMMUTABLE              | FORBIDDEN             |
 * | LastAdminError              | LAST_ADMIN                  | CONFLICT              |
 * | ReorderMismatchError        | REORDER_SET_MISMATCH        | CONFLICT              |
 * | FixRateLimitError           | FIX_RATE_LIMIT_EXCEEDED     | TOO_MANY_REQUESTS     |
 * | FixAlreadyOpenError         | FIX_ALREADY_OPEN            | CONFLICT              |
 * | FixTargetRequiredError      | FIX_TARGET_REQUIRED         | UNPROCESSABLE_CONTENT |
 * | SubtitleFixUnsupportedError | SUBTITLE_FIX_UNSUPPORTED    | UNPROCESSABLE_CONTENT |
 * | LedgerItemTombstonedError   | LEDGER_ITEM_TOMBSTONED      | PRECONDITION_FAILED   |
 * | ArrUpstreamError            | ARR_UPSTREAM_UNAVAILABLE    | BAD_GATEWAY           |
 * | RestoreProfileUnmappedError | RESTORE_PROFILE_UNMAPPED    | UNPROCESSABLE_CONTENT |
 * | SearchCapExceededError      | ARR_ADD_SEARCH_CAP_EXCEEDED | UNPROCESSABLE_CONTENT |
 * | LibraryNotAllowedError      | LIBRARY_NOT_ALLOWED         | FORBIDDEN             |
 * | PlexAccountUnmatchedError   | PLEX_ACCOUNT_UNMATCHED      | UNPROCESSABLE_CONTENT |
 * | PlexAllStateError           | PLEX_ALL_STATE              | UNPROCESSABLE_CONTENT |
 * | PlexServerUnavailableError  | PLEX_SERVER_UNAVAILABLE     | BAD_GATEWAY           |
 * | MaintainerrUnsafeError      | MAINTAINERR_UNSAFE          | PRECONDITION_FAILED   |
 * | MaintainerrUpstreamError    | MAINTAINERR_UNAVAILABLE     | BAD_GATEWAY           |
 * | TrashMusicUnsupportedError  | TRASH_MUSIC_UNSUPPORTED     | UNPROCESSABLE_CONTENT |
 * | TrashBatchStateError        | TRASH_BATCH_STATE           | CONFLICT              |
 * | TrashBatchOpenError         | TRASH_BATCH_ALREADY_OPEN    | CONFLICT              |
 * | TrashBatchEmptyError        | TRASH_BATCH_EMPTY           | UNPROCESSABLE_CONTENT |
 * | TrashSaveNotOwnedError      | TRASH_SAVE_NOT_OWNED        | FORBIDDEN             |
 * | InvalidTicketTransitionError| TICKET_INVALID_TRANSITION   | CONFLICT              |
 * | NotFoundError               | —                           | NOT_FOUND             |
 */
export async function mapDomainErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InvalidCatalogUrlError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof RoleNameConflictError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof SystemRoleImmutableError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    }
    if (err instanceof LastAdminError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof ConcurrentTransitionError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof ReorderMismatchError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof FixRateLimitError) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: err.message, cause: err });
    }
    if (err instanceof FixAlreadyOpenError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof FixTargetRequiredError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof SubtitleFixUnsupportedError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof LedgerItemTombstonedError) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    }
    if (err instanceof ArrUpstreamError) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: err.message, cause: err });
    }
    if (err instanceof RestoreProfileUnmappedError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof SearchCapExceededError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof LibraryNotAllowedError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    }
    if (err instanceof PlexAccountUnmatchedError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof PlexAllStateError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof PlexServerUnavailableError) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: err.message, cause: err });
    }
    if (err instanceof MaintainerrUnsafeError) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: err.message, cause: err });
    }
    if (err instanceof MaintainerrUpstreamError) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: err.message, cause: err });
    }
    if (err instanceof TrashMusicUnsupportedError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof TrashBatchStateError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof TrashBatchOpenError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof TrashBatchEmptyError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof CollectionAcquireForbiddenError) {
      // ADR-070 C-04 — a manage-only caller tried to enable the content-pull knob.
      throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    }
    if (err instanceof CollectionSuggestionNotOpenError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof LibrettoUnreachableError) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Libretto is unreachable', cause: err });
    }
    if (err instanceof LibrettoHttpError) {
      // A 400 on a recipe save carries per-path validation issues — surface them plainly.
      const detail = err.issues && err.issues.length > 0 ? `: ${err.issues.slice(0, 5).join('; ')}` : '';
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Libretto rejected the request${detail}`, cause: err });
    }
    if (err instanceof TrashSaveNotOwnedError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    }
    if (err instanceof InvalidTicketTransitionError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof InvalidTicketTargetError) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
    }
    if (err instanceof BookFixRateLimitError) {
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: err.message, cause: err });
    }
    if (err instanceof BookFixAlreadyOpenError) {
      throw new TRPCError({ code: 'CONFLICT', message: err.message, cause: err });
    }
    if (err instanceof BookFixUnroutableError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof AuthentikGroupNotOwnedError) {
      throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
    }
    if (err instanceof SyncedTierInvalidError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof AuthentikUnavailableError) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: err.message, cause: err });
    }
    if (err instanceof OwuiUnavailableError) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: err.message, cause: err });
    }
    if (err instanceof InvalidGoodreadsProfileError) {
      throw new TRPCError({ code: 'UNPROCESSABLE_CONTENT', message: err.message, cause: err });
    }
    if (err instanceof LazyLibrarianUpstreamError) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: err.message, cause: err });
    }
    if (err instanceof KapowarrUpstreamError) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: err.message, cause: err });
    }
    if (err instanceof NotFoundError) {
      throw new TRPCError({ code: 'NOT_FOUND', message: err.message, cause: err });
    }
    throw err;
  }
}
