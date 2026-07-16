// DESIGN-005 D-14 — the sync orchestrator. One sync_runs row brackets each source
// (startSyncRun/finishSyncRun); failures are isolated per source (one *arr down never
// fails the whole run); the mass-tombstone guard surfaces as status 'aborted' with the
// tombstones unwritten. After the per-source flows, backfillEventAttribution re-links
// Seerr events whose item/user has since appeared, and completeFixRequests closes
// fixes whose replacement import was just ingested (ADR-007 C-06).
import {
  ARR_KINDS,
  SYNC_SOURCES,
  db as defaultDb,
  type ArrKind,
  type DbClient,
  type SyncRunKind,
  type SyncSource,
} from '@hnet/db';
import {
  MassTombstoneAbortedError,
  backfillEventAttribution,
  completeFixRequests,
  drainDuePoolRefreshes,
  expireStaleFixRequests,
  deliverOutbox,
  runFailureDigest,
  evaluateActivityFailures,
  evaluateMamGovernor,
  evaluateSmartAlerts,
  evaluateSpacePolicy,
  finishSyncRun,
  refreshTrashCandidates,
  runPelotonPosterGuard,
  startSyncRun,
  sweepExpiredBatches,
  syncAiUsage,
  syncAuthentikUsers,
  syncBooks,
  syncPlexMatches,
  syncPlexCollections,
  type DrainPoolRefreshResult,
  type KapowarrClientBundle,
  type LazyLibrarianClientBundle,
  type SyncBooksReport,
  type SyncPlexMatchesReport,
  type SyncPlexCollectionsReport,
  type MaintainerrClientBundle,
  type MamGovernorBundle,
  type MamGovernorReport,
  type MamGovernorTuning,
  type BooksActivityBundle,
  type ActivityFailuresReport,
  type ActivityFailureInput,
  type ActivitySourceAdapter,
  toFailureInputs,
  BOOKS_ACTIVITY_SOURCE,
  ARR_ACTIVITY_SOURCE,
  KAPOWARR_ACTIVITY_SOURCE,
  type OutboxDeliveryReport,
  type PlexClientBundle,
  type PosterGuardReport,
  type SmartAlertsReport,
  type SpacePolicyReport,
  type SweepReport,
  type SyncAiUsageReport,
  type SyncAuthentikUsersResult,
  type TrashCandidatesRefreshReport,
  type UtilizationArrBundle,
} from '@hnet/domain';
// ADR-044 / DESIGN-022 (PLAN-021) — the read-only Open WebUI admin-API client the `ai-usage-sync` mode
// polls; the fetched snapshot is handed to the @hnet/domain syncAiUsage single-writer (never a live
// cross-DB read — the *arr-ledger precedent).
import { fetchOwuiUsage, type OpenWebUiClient } from './openwebui';
// ADR-046 / DESIGN-024 (PLAN-023) — the read-only Kavita + Audiobookshelf snapshot fetcher the
// `books-sync` mode hands to the @hnet/domain syncBooks single-writer (books_items mirror upsert).
import { fetchBooksSnapshot, type BooksSyncBundle } from './books';
// ADR-055 / DESIGN-028 (PLAN-044) — the `goodreads-sync` mode's read side: pages each linked user's PUBLIC
// shelf RSS + GB enrichment and hands the enriched snapshot to the domain syncGoodreadsIntegration
// orchestrator (which does the DB writes + the confined LazyLibrarian pushes — the bundle arrives here as
// an opaque type, never constructed in sync — the poster-guard precedent).
import { runGoodreadsSync, type GoodreadsSourceBundle, type GoodreadsSyncReport } from './goodreads';
// ADR-053 / DESIGN-026 D-07 (PLAN-029) — the ABS per-user listening-progress read, folded into books-sync
// as an isolated post-step (per-user Audiobooks read-state; Kavita DEFERRED).
import { syncAbsUserProgress, type SyncAbsUserProgressReport } from './abs-progress';
// ADR-047 / DESIGN-025 (PLAN-028) — the read-only *arr→Plex GUID matcher the `plex-match` mode hands to the
// @hnet/domain syncPlexMatches single-writer (media_plex_matches derived-cache upsert + reconcile).
import { fetchPlexMatchSnapshot, type PlexMatchStats } from './plex-match';
// ADR-064 / DESIGN-035 (PLAN-037) — the read-only HOps collections fetcher the `collections-sync`
// mode hands to the @hnet/domain syncPlexCollections single-writer (mirror upsert + scoped reconcile).
import { fetchPlexCollectionsSnapshot, type PlexCollectionsStats } from './plex-collections';
// ADR-045 / DESIGN-023 (PLAN-026) — the read-only Authentik directory client the `authentik-users` mode
// pages; the snapshot is handed to the @hnet/domain syncAuthentikUsers single-writer (mirror upsert).
import type { AuthentikReadClient } from '@hnet/authentik';
// ADR-043 / DESIGN-021 (PLAN-024) — the durable Peloton poster mapping + the image-backed asset source
// the `poster-guard` mode hands to the domain guard (the confined Plex write upload stays in
// packages/domain — the bundle arrives here as an opaque PlexClientBundle, never constructed in sync).
import { PELOTON_POSTER_MAPPING, createFilePosterAssetSource } from './peloton-poster-map';
// ADR-040 / DESIGN-020 (PLAN-019) — the `smart-alerts` mode reads the smartctl series through the
// read-only @hnet/metrics client (no write surface ⇒ no import-confinement) and hands the readings to
// the domain evaluator, which does the transition detection + the same-tx outbox enqueue.
import { getDriveSmartReadings, type PrometheusReader } from '@hnet/metrics';
import { runArrFullSync } from './arr-full';
import { runArrIncrementalSync } from './arr-incremental';
import type { MetadataSourceClients, SyncClients } from './clients';
import {
  buildMetadataContext,
  runMetadataRefreshForKind,
  type MetadataContext,
} from './metadata-refresh';
import { noopLogger, type SyncLogger } from './logger';
import { runSeerrSync } from './seerr';

export type SyncMode = SyncRunKind; // 'full' | 'incremental' | 'metadata-refresh'

export interface RunSyncOptions {
  mode: SyncMode;
  /** Sources to sync this run; defaults to all four (D-11 SYNC_SOURCES). */
  sources?: readonly SyncSource[];
  /** --force-tombstones (Q-03): override the mass-tombstone guard. */
  forceTombstones?: boolean;
  /** *arr instance slug (D-05 decision 1); single-instance 'main' today. */
  arrInstanceId?: string;
  clients: SyncClients;
  /** ADR-018 / DESIGN-008 — the OPTIONAL metadata-harvest source clients (Tautulli/TMDB/
   *  TVDB/Maintainerr). Required only for mode 'metadata-refresh'; every tier is degradable. */
  metadataSources?: MetadataSourceClients;
  /** metadata-refresh: rows older than now-threshold (or missing) refresh. Default 6h. */
  metadataStaleThresholdMs?: number;
  /** metadata-refresh: cap the rows harvested this run. */
  metadataLimit?: number;
  /** ADR-025 / DESIGN-011 — the Maintainerr client bundle the `trash-batch-sweep` mode drives
   *  (read + confined write). Required only for that mode; tests inject a fetch-stubbed bundle.
   *  ADR-031 — the `space-policy` mode ALSO drives it (createBatchFromPending). */
  maintainerr?: MaintainerrClientBundle;
  /** ADR-031 / DESIGN-014 — the diskspace-only *arr read bundle the `space-policy` mode reads
   *  utilization from (getUtilization). Required only for that mode; tests inject a stubbed bundle. */
  arr?: UtilizationArrBundle;
  /** ADR-035 — the OPTIONAL Maintainerr READ handle: when present, the full/incremental modes end
   *  by rebuilding the Trash candidate snapshot (the walls' read-model) so it stays ≤ one sync tick
   *  stale. Absent (a Maintainerr-less env) ⇒ the step is skipped cleanly. */
  maintainerrRead?: Pick<MaintainerrClientBundle, 'read'>;
  /** ADR-040 / DESIGN-020 — the read-only @hnet/metrics Prometheus reader the `smart-alerts` mode reads
   *  the smartctl series through. Required only for that mode; tests inject a stubbed reader. */
  smartReader?: PrometheusReader;
  /** ADR-054 / DESIGN-027 — the MAM-governor client bundle (qB count read + the confined Prowlarr indexer
   *  toggle) the `mam-governor` mode drives. Required only for that mode; tests inject fetch-stubbed clients. */
  mamGovernor?: MamGovernorBundle;
  /** ADR-054 / DESIGN-027 — the governor's tuning (limit/buffer/stuck-hours). Resolved once per run via
   *  the resolveGovernorConfig SEAM (env in v1; PLAN-040 adds a DB override). Required only for that mode. */
  mamTuning?: MamGovernorTuning;
  /** ADR-059 / DESIGN-030 — the books activity bundle (the LL+SAB adapter) the `activity-scan` mode scans
   *  for import failures. Required only for that mode; tests inject a stubbed adapter. */
  activityBundle?: BooksActivityBundle;
  /** ADR-059 / DESIGN-030 D-08 — the UNIVERSAL *arr activity adapter (Radarr/Sonarr/Lidarr queue + import
   *  state) the `activity-scan` mode ALSO scans for import failures (import_blocked / download_failed).
   *  Optional; when present it is reconciled independently of the books source. Tests inject a stub. */
  arrActivityAdapter?: ActivitySourceAdapter;
  /** ADR-059 / DESIGN-030 D-08 — the KAPOWARR (comics) activity adapter (queue + tasks + history) the
   *  `activity-scan` mode ALSO scans for comic download failures (download_failed). Optional; reconciled
   *  independently of the other sources. Tests inject a stub. */
  kapowarrActivityAdapter?: ActivitySourceAdapter;
  /** ADR-043 / DESIGN-021 — the Plex client bundle (read + confined write) the `poster-guard` mode uses to
   *  read the k8plex Peloton library and re-apply drifted override posters. Required only for that mode. */
  plex?: PlexClientBundle;
  /** ADR-044 / DESIGN-022 — the read-only Open WebUI admin-API client the `ai-usage-sync` mode polls for
   *  chats + users. Required only for that mode; tests inject a fetch-stubbed client. */
  openWebUi?: OpenWebUiClient;
  /** ADR-045 / DESIGN-023 — the read-only Authentik directory client the `authentik-users` mode pages.
   *  Required only for that mode; tests inject a stubbed client. */
  authentik?: Pick<AuthentikReadClient, 'listUsers'>;
  /** ADR-046 / DESIGN-024 — the read-only Kavita + Audiobookshelf clients + public deep-link bases the
   *  `books-sync` mode pages. Required only for that mode; tests inject fetch-stubbed clients. */
  books?: BooksSyncBundle;
  /** ADR-055 / DESIGN-028 — the read-only Goodreads RSS + Google Books clients the `goodreads-sync` mode
   *  pages. Required only for that mode; tests inject fetch-stubbed clients. */
  goodreads?: GoodreadsSourceBundle;
  /** ADR-055 / DESIGN-028 — the confined LazyLibrarian bundle the `goodreads-sync` mode pushes requests
   *  through (built in packages/domain from env; opaque here). Optional — absent ⇒ mirror + mint only. */
  lazyLibrarian?: LazyLibrarianClientBundle;
  /** ADR-056 (PLAN-046) — the confined Kapowarr bundle the `goodreads-sync` mode routes COMICS through (built
   *  in packages/domain from env; opaque here). Optional — absent ⇒ comics stay parked. */
  kapowarr?: KapowarrClientBundle;
  /** Clock injection for deterministic `ai-usage-sync` tests (synced_at / created_at fallbacks). */
  now?: Date;
  /** Injected DB (tests); defaults to the lazy @hnet/db client. */
  db?: DbClient;
  logger?: SyncLogger;
  /** Incremental bootstrap page walk tuning (tests). */
  historyPageSize?: number;
  maxHistoryPages?: number;
}

export interface SourceRunReport {
  source: SyncSource;
  /** sync_runs.id — null only if even startSyncRun failed (DB unreachable). */
  runId: string | null;
  status: 'succeeded' | 'failed' | 'aborted';
  stats: Record<string, unknown>;
  error?: string;
}

export interface SyncReport {
  mode: SyncMode;
  startedAt: Date;
  finishedAt: Date;
  sources: SourceRunReport[];
  /** Post-step results (null when the step itself errored — see backfillError). */
  backfill: { itemsLinked: number; usersLinked: number } | null;
  fixesCompleted: number | null;
  /** Count of OPEN fixes auto-closed to 'timed_out' this run (null for modes that skip the sweep). */
  fixesTimedOut?: number | null;
  backfillError?: string;
  fixCompletionError?: string;
  /** The timeout sweep's error, if it threw (the completion step is independent). */
  fixTimeoutError?: string;
  /** ADR-025 — the `trash-batch-sweep` result (null for every other mode / when the sweep errored). */
  sweep?: SweepReport | null;
  /** The sweep's error (e.g. an unsafe-Maintainerr refusal) — sets totalFailure for the CLI exit. */
  sweepError?: string;
  /** ADR-031 — the `space-policy` proposal result (null for every other mode / when it errored). */
  spacePolicy?: SpacePolicyReport | null;
  /** The space-policy run's error — sets totalFailure for the CLI exit. */
  spacePolicyError?: string;
  /** ADR-034 — the `notify-outbox` drainer result (null for every other mode / when it errored). */
  outbox?: OutboxDeliveryReport | null;
  /** ADR-060 follow-up — the failure-digest mode report (openCount + enqueued). */
  failureDigest?: { openCount: number; enqueued: number } | null;
  /** The notify-outbox run's error — sets totalFailure for the CLI exit. */
  outboxError?: string;
  /** ADR-040 — the `smart-alerts` detector result (null for every other mode / when it errored). */
  smartAlerts?: SmartAlertsReport | null;
  /** The smart-alerts run's error — sets totalFailure for the CLI exit. */
  smartAlertsError?: string;
  /** ADR-054 — the `mam-governor` result (null for every other mode / when it errored). */
  mamGovernor?: MamGovernorReport | null;
  /** The mam-governor run's error — sets totalFailure for the CLI exit. */
  mamGovernorError?: string;
  /** ADR-059 — the `activity-scan` failure-ledger result (null for every other mode / when it errored). */
  activity?: ActivityFailuresReport | null;
  /** The activity-scan run's error — sets totalFailure for the CLI exit. */
  activityError?: string;
  /** ADR-043 — the `poster-guard` result (null for every other mode / when it errored). */
  posterGuard?: PosterGuardReport | null;
  /** The poster-guard run's error — sets totalFailure for the CLI exit. */
  posterGuardError?: string;
  /** ADR-044 — the `ai-usage-sync` result (null for every other mode / when it errored). */
  aiUsage?: SyncAiUsageReport | null;
  /** The ai-usage-sync run's error — sets totalFailure for the CLI exit. */
  aiUsageError?: string;
  /** ADR-045 — the `authentik-users` directory-mirror result (null for every other mode / on error). */
  authentikUsers?: SyncAuthentikUsersResult | null;
  /** The authentik-users run's error — sets totalFailure for the CLI exit. */
  authentikUsersError?: string;
  /** ADR-046 — the `books-sync` result (null for every other mode / when it errored). ADR-053 folds the
   *  per-user ABS listening-progress read (absProgress) in as an isolated sub-step. */
  booksSync?:
    | (SyncBooksReport & {
        syncedSources: string[];
        absProgress?: SyncAbsUserProgressReport | null;
      })
    | null;
  /** The books-sync run's error — sets totalFailure for the CLI exit. */
  booksSyncError?: string;
  /** ADR-055 — the `goodreads-sync` result (null for every other mode / when it errored). */
  goodreadsSync?: GoodreadsSyncReport | null;
  /** The goodreads-sync run's error — sets totalFailure for the CLI exit. */
  goodreadsSyncError?: string;
  /** ADR-047 — the `plex-match` result (null for every other mode / when it errored). */
  plexMatch?: (SyncPlexMatchesReport & { stats: PlexMatchStats }) | null;
  /** The plex-match run's error — sets totalFailure for the CLI exit. */
  plexMatchError?: string;
  /** ADR-064 — the `collections-sync` result (null for every other mode / when it errored). */
  collectionsSync?: (SyncPlexCollectionsReport & { stats: PlexCollectionsStats }) | null;
  /** The collections-sync run's error — sets totalFailure for the CLI exit. */
  collectionsSyncError?: string;
  /** ADR-035 — the candidate-snapshot refresh post-step (full/incremental with a Maintainerr
   *  handle; null when skipped or failed). */
  candidateRefresh?: TrashCandidatesRefreshReport | null;
  /** The candidate-refresh step's error. NEVER sets totalFailure — a Maintainerr outage must not
   *  fail the *arr sync run; the walls keep serving the previous snapshot ("as of N min ago"). */
  candidateRefreshError?: string;
  /** DESIGN-010/014 amendment (build D) — the debounced pool-refresh BACKSTOP: full/incremental with a
   *  write-capable Maintainerr bundle drain any overdue `pending_pool_refresh` marker (a save whose
   *  in-process timer was lost to a pod restart). Null when skipped or errored. Never sets totalFailure. */
  poolRefresh?: DrainPoolRefreshResult | null;
  /** The pool-refresh backstop's error (isolated — a Maintainerr outage never fails the sync run). */
  poolRefreshError?: string;
  /** True when EVERY requested source failed/aborted — the CLI's nonzero-exit signal. */
  totalFailure: boolean;
}

function isArrKind(source: SyncSource): source is ArrKind {
  return (ARR_KINDS as readonly string[]).includes(source);
}

async function runSource(
  options: RunSyncOptions,
  db: DbClient,
  logger: SyncLogger,
  source: SyncSource,
  metadataContext: MetadataContext | undefined,
): Promise<Record<string, unknown>> {
  const arrInstanceId = options.arrInstanceId ?? 'main';
  // ADR-018 / DESIGN-008 D-03 — the metadata harvest is per *arr kind (Seerr has no metadata);
  // the cross-kind Tautulli/Maintainerr context is built once and shared across kinds.
  if (options.mode === 'metadata-refresh') {
    if (!isArrKind(source)) return { skipped: 'metadata-refresh harvests *arr kinds only' };
    if (!metadataContext) throw new Error('metadata-refresh requires metadataSources');
    return runMetadataRefreshForKind({
      db,
      clients: options.clients,
      sources: options.metadataSources!,
      context: metadataContext,
      arrKind: source,
      arrInstanceId,
      logger,
      staleThresholdMs: options.metadataStaleThresholdMs,
      limit: options.metadataLimit,
    });
  }
  if (!isArrKind(source)) {
    // Seerr has no item list; its request scan is cursor-driven in both modes (D-14).
    return runSeerrSync({ db, clients: options.clients, logger });
  }
  if (options.mode === 'full') {
    return runArrFullSync({
      db,
      clients: options.clients,
      arrKind: source,
      arrInstanceId,
      forceTombstones: options.forceTombstones ?? false,
      logger,
    });
  }
  return runArrIncrementalSync({
    db,
    clients: options.clients,
    arrKind: source,
    arrInstanceId,
    logger,
    pageSize: options.historyPageSize,
    maxPages: options.maxHistoryPages,
  });
}

/**
 * Run one sync pass over the requested sources. Never throws for a per-source
 * failure — inspect the report; throws only if the report itself cannot be produced
 * (e.g. the database is unreachable for every bookkeeping write).
 */
export async function runSync(options: RunSyncOptions): Promise<SyncReport> {
  const logger = options.logger ?? noopLogger;
  const db = options.db ?? (defaultDb as DbClient);

  // ADR-025 / DESIGN-011 — the batch-expiry sweep is NOT a per-source loop; it drives Maintainerr
  // to delete the survivors of every expired `leaving_soon` batch (each item re-checked fresh:
  // SAFE audit + live exclusions + guardian). Its audit trail is the ledger + batch rows (never a
  // sync_runs row, exactly like expedite), so it returns early with a `sweep` report.
  if (options.mode === 'trash-batch-sweep') {
    const startedAt = new Date();
    if (!options.maintainerr) {
      throw new Error('trash-batch-sweep requires a maintainerr client bundle');
    }
    let sweep: SweepReport | null = null;
    let sweepError: string | undefined;
    try {
      sweep = await sweepExpiredBatches({ db, maintainerr: options.maintainerr, actorId: null });
      logger.info('trash batch sweep complete', {
        batchesSwept: sweep.batchesSwept,
        deleted: sweep.batches.reduce((n, b) => n + b.deletedCount, 0),
        skipped: sweep.batches.reduce((n, b) => n + b.skippedCount, 0),
      });
    } catch (error) {
      sweepError = error instanceof Error ? error.message : String(error);
      logger.error('trash batch sweep failed', { error: sweepError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      sweep,
      ...(sweepError !== undefined ? { sweepError } : {}),
      totalFailure: sweepError !== undefined,
    };
  }

  // ADR-031 / DESIGN-014 — the space-driven policy is also NOT a per-source loop: it reads *arr
  // /diskspace utilization + drives Maintainerr through createBatchFromPending to PROPOSE (never
  // delete) draft batches for arrays over target. Like the sweep it writes no sync_runs row — its
  // audit trail is the trash_space_policy ledger event + the space_policy notification + the proposed
  // batch's transition events. Returns early with a `spacePolicy` report.
  if (options.mode === 'space-policy') {
    const startedAt = new Date();
    if (!options.maintainerr) {
      throw new Error('space-policy requires a maintainerr client bundle');
    }
    if (!options.arr) {
      throw new Error('space-policy requires an *arr diskspace read bundle');
    }
    let spacePolicy: SpacePolicyReport | null = null;
    let spacePolicyError: string | undefined;
    try {
      spacePolicy = await evaluateSpacePolicy({
        db,
        maintainerr: options.maintainerr,
        arr: options.arr,
        actorId: null,
      });
      logger.info('space policy evaluated', {
        enabled: spacePolicy.enabled,
        proposedCount: spacePolicy.proposedCount,
        arrays: spacePolicy.arrays.map((a) => ({
          key: a.key,
          usedPct: a.usedPct,
          target: a.target,
          overTarget: a.overTarget,
          proposals: a.proposals.map((p) => ({ mediaKind: p.mediaKind, outcome: p.outcome })),
        })),
      });
    } catch (error) {
      spacePolicyError = error instanceof Error ? error.message : String(error);
      logger.error('space policy evaluation failed', { error: spacePolicyError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      spacePolicy,
      ...(spacePolicyError !== undefined ? { spacePolicyError } : {}),
      totalFailure: spacePolicyError !== undefined,
    };
  }

  // ADR-034 / DESIGN-015 — the `notify-outbox` drainer is also NOT a per-source loop: it reads DUE
  // notification_outbox rows and delivers them to Pushover (disabled-safe — a clean no-op when the
  // PUSHOVER_* env is absent). No *arr source, no sync_runs row — its trail is the outbox rows.
  // Returns early with an `outbox` report. A delivery failure of an individual row is recorded on that
  // row (attempts/backoff) — only a wholesale failure (e.g. the DB read) sets outboxError/totalFailure.
  if (options.mode === 'notify-outbox') {
    const startedAt = new Date();
    let outbox: OutboxDeliveryReport | null = null;
    let outboxError: string | undefined;
    try {
      outbox = await deliverOutbox({ db, logger });
      logger.info('notify-outbox drained', {
        dueCount: outbox.dueCount,
        sent: outbox.sent,
        failed: outbox.failed,
        parked: outbox.parked,
        skipped: outbox.skipped,
        ...(outbox.reason !== undefined ? { reason: outbox.reason } : {}),
      });
    } catch (error) {
      outboxError = error instanceof Error ? error.message : String(error);
      logger.error('notify-outbox drain failed', { error: outboxError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      outbox,
      ...(outboxError !== undefined ? { outboxError } : {}),
      totalFailure: outboxError !== undefined,
    };
  }

  // ADR-060 follow-up (PLAN-048 tail) — the nightly `failure-digest` mode: reads OPEN
  // activity_import_failures and enqueues ONE admin email-channel outbox row (none when clean).
  // No *arr source, no sync_runs row — its trail is the outbox row; the notify-outbox drainer
  // delivers it (disabled-safe without SMTP creds per R-197).
  if (options.mode === 'failure-digest') {
    const startedAt = new Date();
    let failureDigest: { openCount: number; enqueued: number } | null = null;
    let digestError: string | undefined;
    try {
      failureDigest = await runFailureDigest({ db });
      logger.info('failure-digest evaluated', { ...failureDigest });
    } catch (error) {
      digestError = error instanceof Error ? error.message : String(error);
      logger.error('failure-digest failed', { error: digestError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      failureDigest,
      totalFailure: digestError !== undefined,
    };
  }

  // ADR-040 / DESIGN-020 — the `smart-alerts` detector is also NOT a per-source loop: it reads the
  // smartctl series through @hnet/metrics and, per drive, diffs the reading against the persisted
  // smart_drive_state, enqueuing ONE notification_outbox row on a CRITICAL transition (same-tx with the
  // state update). First sight of a drive records a BASELINE and pages nothing — so the known
  // staging-pool bad state never pages. No *arr source, no sync_runs row — its trail is the outbox rows
  // + smart_drive_state. Returns early with a `smartAlerts` report. Disabled-safe: the enqueue always
  // records the transition; the notify-outbox drainer no-ops without PUSHOVER_* creds.
  if (options.mode === 'smart-alerts') {
    const startedAt = new Date();
    if (!options.smartReader) {
      throw new Error('smart-alerts requires a Prometheus reader (smartReader)');
    }
    let smartAlerts: SmartAlertsReport | null = null;
    let smartAlertsError: string | undefined;
    try {
      const drives = await getDriveSmartReadings({ prometheus: options.smartReader });
      smartAlerts = await evaluateSmartAlerts({ db, drives });
      logger.info('smart-alerts evaluated', {
        evaluated: smartAlerts.evaluated,
        baselined: smartAlerts.baselined,
        degraded: smartAlerts.degraded,
        recovered: smartAlerts.recovered,
        enqueued: smartAlerts.enqueued,
      });
    } catch (error) {
      smartAlertsError = error instanceof Error ? error.message : String(error);
      logger.error('smart-alerts evaluation failed', { error: smartAlertsError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      smartAlerts,
      ...(smartAlertsError !== undefined ? { smartAlertsError } : {}),
      totalFailure: smartAlertsError !== undefined,
    };
  }

  // ADR-054 / DESIGN-027 — the `mam-governor` mode is NOT a per-source loop: it counts UNSATISFIED torrents
  // locally in qBittorrent (`books-mam`, seeding_time < 72h + still-downloading — ZERO MAM API surface) and,
  // near the rank cap (unsatisfied ≥ limit − buffer), toggles the MyAnonaMouse Prowlarr indexer's `enable`
  // flag (which Prowlarr's fullSync propagates to LazyLibrarian). It upserts the single-row mam_gate_state
  // and enqueues a gate-transition (or >48h zero-headroom) notification_outbox row same-tx. Fail-closed: a
  // failed count ⇒ gate closed. No *arr source, no sync_runs row — its trail is the outbox rows +
  // mam_gate_state. Returns early with a `mamGovernor` report. Disabled-safe: the enqueue always records the
  // transition; the notify-outbox drainer no-ops without PUSHOVER_* creds.
  if (options.mode === 'mam-governor') {
    const startedAt = new Date();
    if (!options.mamGovernor) {
      throw new Error('mam-governor requires a client bundle (mamGovernor)');
    }
    if (!options.mamTuning) {
      throw new Error('mam-governor requires resolved tuning (mamTuning)');
    }
    let mamGovernor: MamGovernorReport | null = null;
    let mamGovernorError: string | undefined;
    try {
      mamGovernor = await evaluateMamGovernor({
        db,
        clients: options.mamGovernor.clients,
        targets: options.mamGovernor.targets,
        tuning: options.mamTuning,
      });
      logger.info('mam-governor evaluated', {
        countOk: mamGovernor.countOk,
        unsatisfied: mamGovernor.unsatisfied,
        downloading: mamGovernor.downloading,
        seedingUnder72: mamGovernor.seedingUnder72,
        limit: mamGovernor.limit,
        buffer: mamGovernor.buffer,
        threshold: mamGovernor.threshold,
        headroom: mamGovernor.headroom,
        gateOpen: mamGovernor.gateOpen,
        desiredOpen: mamGovernor.desiredOpen,
        indexerEnabled: mamGovernor.indexerEnabled,
        actuated: mamGovernor.actuated,
        event: mamGovernor.event,
        stuckAlerted: mamGovernor.stuckAlerted,
        enqueued: mamGovernor.enqueued,
        ...(mamGovernor.countError !== undefined ? { countError: mamGovernor.countError } : {}),
        ...(mamGovernor.readError !== undefined ? { readError: mamGovernor.readError } : {}),
        ...(mamGovernor.actuationError !== undefined
          ? { actuationError: mamGovernor.actuationError }
          : {}),
      });
    } catch (error) {
      mamGovernorError = error instanceof Error ? error.message : String(error);
      logger.error('mam-governor evaluation failed', { error: mamGovernorError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      mamGovernor,
      ...(mamGovernorError !== undefined ? { mamGovernorError } : {}),
      totalFailure: mamGovernorError !== undefined,
    };
  }

  // ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the `activity-scan` mode polls each source
  // family's queue/import state (SLICE 1: the books LL+SAB adapter), extracts the current OPEN import
  // failures, and via evaluateActivityFailures UPSERTS the durable activity_import_failures ledger AND
  // enqueues one `activity_import_failed` notification_outbox row per NEW failure in the SAME transaction.
  // No *arr source, no sync_runs row — its trail is the ledger + the outbox rows. Disabled-safe: the
  // enqueue always records; the notify-outbox drainer no-ops without PUSHOVER_* creds. A source read
  // failure is logged and treated as "no failures for that source" (never resolves a strand on a wire
  // hiccup — evaluateActivityFailures only closes failures for the sources actually scanned).
  if (options.mode === 'activity-scan') {
    const startedAt = new Date();
    if (!options.activityBundle && !options.arrActivityAdapter && !options.kapowarrActivityAdapter) {
      throw new Error(
        'activity-scan requires at least one source (activityBundle and/or arrActivityAdapter and/or kapowarrActivityAdapter)',
      );
    }
    let activity: ActivityFailuresReport | null = null;
    let activityError: string | undefined;
    try {
      const scannedSources: string[] = [];
      const failures: ActivityFailureInput[] = [];
      // Each source is scanned + reconciled INDEPENDENTLY: a source unreachable this run is NOT added to
      // scannedSources, so evaluateActivityFailures never closes its prior strands on a wire hiccup.
      if (options.activityBundle) {
        try {
          const items = await options.activityBundle.adapter.list();
          scannedSources.push(BOOKS_ACTIVITY_SOURCE);
          failures.push(...toFailureInputs(BOOKS_ACTIVITY_SOURCE, items));
        } catch (error) {
          logger.warn('activity-scan: books source degraded', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (options.arrActivityAdapter) {
        try {
          const items = await options.arrActivityAdapter.list();
          scannedSources.push(ARR_ACTIVITY_SOURCE);
          failures.push(...toFailureInputs(ARR_ACTIVITY_SOURCE, items));
        } catch (error) {
          logger.warn('activity-scan: *arr source degraded', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (options.kapowarrActivityAdapter) {
        try {
          const items = await options.kapowarrActivityAdapter.list();
          scannedSources.push(KAPOWARR_ACTIVITY_SOURCE);
          failures.push(...toFailureInputs(KAPOWARR_ACTIVITY_SOURCE, items));
        } catch (error) {
          logger.warn('activity-scan: Kapowarr source degraded', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      activity = await evaluateActivityFailures({ db, failures, scannedSources });
      logger.info('activity-scan evaluated', {
        seen: activity.seen,
        opened: activity.opened,
        resolved: activity.resolved,
        enqueued: activity.enqueued,
        scannedSources,
      });
    } catch (error) {
      activityError = error instanceof Error ? error.message : String(error);
      logger.error('activity-scan failed', { error: activityError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      activity,
      ...(activityError !== undefined ? { activityError } : {}),
      totalFailure: activityError !== undefined,
    };
  }

  // ADR-043 / DESIGN-021 — the `poster-guard` detector is NOT a per-source loop: it reads the k8plex
  // Peloton library, resolves each show/season to its durable override poster (baked into the image), and
  // re-applies ONLY the targets that drifted since the last apply — appending one poster_guard_applications
  // ledger row per re-apply (the drift baseline + audit; no sync_runs row, like smart-alerts). Bounded to
  // ~14 reads/run + drift-gated writes. Returns early with a `posterGuard` report.
  if (options.mode === 'poster-guard') {
    const startedAt = new Date();
    if (!options.plex) {
      throw new Error('poster-guard requires a Plex client bundle (plex)');
    }
    let posterGuard: PosterGuardReport | null = null;
    let posterGuardError: string | undefined;
    try {
      posterGuard = await runPelotonPosterGuard({
        db,
        read: options.plex.read.hayneskube,
        write: options.plex.write.hayneskube,
        assets: createFilePosterAssetSource(),
        mapping: PELOTON_POSTER_MAPPING,
      });
      logger.info('poster-guard evaluated', {
        found: posterGuard.found,
        checked: posterGuard.checked,
        inSync: posterGuard.inSync,
        reapplied: posterGuard.reapplied.length,
        unmapped: posterGuard.unmapped.length,
        missingAssets: posterGuard.missingAssets,
      });
    } catch (error) {
      posterGuardError = error instanceof Error ? error.message : String(error);
      logger.error('poster-guard evaluation failed', { error: posterGuardError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      posterGuard,
      ...(posterGuardError !== undefined ? { posterGuardError } : {}),
      totalFailure: posterGuardError !== undefined,
    };
  }

  // ADR-044 / DESIGN-022 — the `ai-usage-sync` ingestion is NOT a per-source loop: it polls the Open WebUI
  // admin API (read-only — never mutates OWUI), normalizes each chat to the mirror aggregates (image-gen
  // heuristic + duration/token sums), and UPSERTS them via the domain syncAiUsage single-writer. Like the
  // alert/outbox modes it touches NO *arr source and writes NO sync_runs row — its trail is ai_usage_chats.
  // Returns early with an `aiUsage` report. A poll/parse failure sets aiUsageError → totalFailure (nonzero
  // exit), so a persistently unreachable OWUI is visible in the CronJob history.
  if (options.mode === 'ai-usage-sync') {
    const startedAt = new Date();
    if (!options.openWebUi) {
      throw new Error('ai-usage-sync requires an Open WebUI client (openWebUi)');
    }
    let aiUsage: SyncAiUsageReport | null = null;
    let aiUsageError: string | undefined;
    try {
      const snapshot = await fetchOwuiUsage(options.openWebUi, options.now);
      aiUsage = await syncAiUsage({
        db,
        chats: snapshot.chats,
        users: snapshot.users,
        now: options.now,
      });
      logger.info('ai-usage-sync complete', {
        chats: aiUsage.chats,
        upserted: aiUsage.upserted,
        imageGenerations: aiUsage.imageGenerations,
        usersResolved: aiUsage.usersResolved,
      });
    } catch (error) {
      aiUsageError = error instanceof Error ? error.message : String(error);
      logger.error('ai-usage-sync failed', { error: aiUsageError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      aiUsage,
      ...(aiUsageError !== undefined ? { aiUsageError } : {}),
      totalFailure: aiUsageError !== undefined,
    };
  }

  // ADR-045 / DESIGN-023 — the `authentik-users` directory sync is NOT a per-source loop: it pages the
  // Authentik users API (read-only — never mutates Authentik), normalizes each identity, and UPSERTS them
  // via the domain syncAuthentikUsers single-writer into the authentik_users mirror. Like ai-usage-sync it
  // touches no *arr source and writes NO sync_runs row — its trail is the mirror. A page/parse failure sets
  // authentikUsersError → totalFailure (nonzero exit) so a persistently unreachable Authentik is visible in
  // the CronJob history.
  if (options.mode === 'authentik-users') {
    const startedAt = new Date();
    if (!options.authentik) {
      throw new Error('authentik-users requires an Authentik read client (authentik)');
    }
    let authentikUsersResult: SyncAuthentikUsersResult | null = null;
    let authentikUsersError: string | undefined;
    try {
      authentikUsersResult = await syncAuthentikUsers({ db, authentik: options.authentik });
      logger.info('authentik-users sync complete', {
        fetched: authentikUsersResult.fetched,
        upserted: authentikUsersResult.upserted,
      });
    } catch (error) {
      authentikUsersError = error instanceof Error ? error.message : String(error);
      logger.error('authentik-users sync failed', { error: authentikUsersError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      authentikUsers: authentikUsersResult,
      ...(authentikUsersError !== undefined ? { authentikUsersError } : {}),
      totalFailure: authentikUsersError !== undefined,
    };
  }

  // ADR-046 / DESIGN-024 — the `books-sync` mode pages Kavita (Books + Comics) + Audiobookshelf (Audio
  // Books) READ-ONLY, normalizes each series/item, and UPSERTS the snapshot via the domain syncBooks
  // single-writer into books_items (tombstoning vanished rows). Standalone mode: no *arr source, writes
  // NO sync_runs row — its trail is books_items. A run where NEITHER source could be fully read is a
  // totalFailure (nonzero exit) so a persistently unreachable server is visible in the CronJob history.
  if (options.mode === 'books-sync') {
    const startedAt = new Date();
    if (!options.books) {
      throw new Error('books-sync requires Kavita + Audiobookshelf clients (books)');
    }
    let booksSync:
      | (SyncBooksReport & {
          syncedSources: string[];
          absProgress?: SyncAbsUserProgressReport | null;
        })
      | null = null;
    let booksSyncError: string | undefined;
    try {
      const snapshot = await fetchBooksSnapshot(options.books, logger);
      const report = await syncBooks({
        db,
        rows: snapshot.rows,
        syncedSources: snapshot.syncedSources,
        now: options.now,
      });
      booksSync = { ...report, syncedSources: snapshot.syncedSources };
      // ADR-053 / DESIGN-026 D-07 — per-user ABS listening-progress read (ISOLATED: a failure here never
      // fails books-sync; a no-op when no user has an ABS handle). Runs after the books mirror upsert so
      // the external_id → books_items join sees the fresh rows.
      try {
        const absProgress = await syncAbsUserProgress({
          db,
          abs: options.books.audiobookshelf,
          logger,
        });
        booksSync = { ...booksSync, absProgress };
      } catch (error) {
        logger.error('books-sync: abs per-user progress step failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        booksSync = { ...booksSync, absProgress: null };
      }
      logger.info('books-sync complete', {
        kavitaSeries: snapshot.counts.kavitaSeries,
        absItems: snapshot.counts.absItems,
        upserted: report.upserted,
        tombstoned: report.tombstoned,
        byKind: report.byKind,
        syncedSources: snapshot.syncedSources,
      });
      if (snapshot.syncedSources.length === 0) {
        booksSyncError = 'books-sync: neither Kavita nor Audiobookshelf could be fully read';
      }
    } catch (error) {
      booksSyncError = error instanceof Error ? error.message : String(error);
      logger.error('books-sync failed', { error: booksSyncError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      booksSync,
      ...(booksSyncError !== undefined ? { booksSyncError } : {}),
      totalFailure: booksSyncError !== undefined,
    };
  }

  // ADR-055 / DESIGN-028 — the `goodreads-sync` mode pages each LINKED Goodreads integration's PUBLIC shelf
  // RSS + GB enrichment (read-only) and hands the enriched snapshot to the domain syncGoodreadsIntegration
  // orchestrator (mirror shelf → match library → mint requests → push BOTH formats to LazyLibrarian, paced →
  // reconcile → coverage). Standalone mode: no --source, writes NO sync_runs row — its trail is the
  // integration tables. Per-integration isolation; a run with zero linked integrations is a clean no-op.
  // Returns early with a `goodreadsSync` report. Only a wholesale failure (e.g. the DB read) sets
  // goodreadsSyncError → totalFailure (nonzero exit).
  if (options.mode === 'goodreads-sync') {
    const startedAt = new Date();
    if (!options.goodreads) {
      throw new Error('goodreads-sync requires Goodreads RSS + Google Books clients (goodreads)');
    }
    let goodreadsSync: GoodreadsSyncReport | null = null;
    let goodreadsSyncError: string | undefined;
    try {
      goodreadsSync = await runGoodreadsSync({
        db,
        goodreads: options.goodreads,
        ...(options.lazyLibrarian ? { ll: options.lazyLibrarian } : {}),
        ...(options.kapowarr ? { kapowarr: options.kapowarr } : {}),
        ...(options.now ? { now: options.now } : {}),
        logger,
      });
      logger.info('goodreads-sync complete', {
        integrations: goodreadsSync.integrations,
        synced: goodreadsSync.synced,
        failed: goodreadsSync.failed,
      });
    } catch (error) {
      goodreadsSyncError = error instanceof Error ? error.message : String(error);
      logger.error('goodreads-sync failed', { error: goodreadsSyncError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      goodreadsSync,
      ...(goodreadsSyncError !== undefined ? { goodreadsSyncError } : {}),
      totalFailure: goodreadsSyncError !== undefined,
    };
  }

  // ADR-047 / DESIGN-025 — the `plex-match` mode reads the ledger's live media_items + the Plex libraries
  // READ-ONLY, resolves each item to its exact Plex {library, ratingKey} by shared-GUID match, and UPSERTS
  // the media_plex_matches cache via the domain syncPlexMatches single-writer (reconciling titles a fully-
  // read library no longer serves). Standalone mode: no *arr source, writes NO sync_runs row — its trail is
  // media_plex_matches. A run that could read NO Plex server at all is a totalFailure (nonzero exit).
  if (options.mode === 'plex-match') {
    const startedAt = new Date();
    if (!options.plex) throw new Error('plex-match requires a Plex client bundle (plex)');
    let plexMatch: (SyncPlexMatchesReport & { stats: PlexMatchStats }) | null = null;
    let plexMatchError: string | undefined;
    try {
      const snapshot = await fetchPlexMatchSnapshot({ db, plex: options.plex, logger });
      const report = await syncPlexMatches({
        db,
        matches: snapshot.matches,
        scopedLibraryIds: snapshot.scopedLibraryIds,
        now: options.now,
      });
      plexMatch = { ...report, stats: snapshot.stats };
      logger.info('plex-match complete', {
        upserted: report.upserted,
        removed: report.removed,
        byKind: snapshot.stats.byKind,
        scopedLibraries: snapshot.scopedLibraryIds.length,
        unmappedSections: snapshot.stats.unmappedSections,
        plexTitlesIndexed: snapshot.stats.plexTitlesIndexed,
      });
      if (snapshot.scopedLibraryIds.length === 0) {
        plexMatchError =
          'plex-match: no Plex library could be read (registry empty or all servers down)';
      }
    } catch (error) {
      plexMatchError = error instanceof Error ? error.message : String(error);
      logger.error('plex-match failed', { error: plexMatchError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      plexMatch,
      ...(plexMatchError !== undefined ? { plexMatchError } : {}),
      totalFailure: plexMatchError !== undefined,
    };
  }

  // ADR-064 / DESIGN-035 — the `collections-sync` mode reads the HOps server's registered movie/show
  // sections' collections + members READ-ONLY (external software is ALWAYS the collections source of
  // truth — owner doctrine R1; slug haynesops only — R4) and UPSERTS the plex_collections /
  // plex_collection_members mirror via the domain syncPlexCollections single-writer, reconciling
  // collections/members a fully-read section/collection no longer serves. Standalone mode: no *arr
  // source, writes NO sync_runs row — its trail is the mirror tables. A run that could read NO
  // section at all is a totalFailure (nonzero exit).
  if (options.mode === 'collections-sync') {
    const startedAt = new Date();
    if (!options.plex) throw new Error('collections-sync requires a Plex client bundle (plex)');
    let collectionsSync: (SyncPlexCollectionsReport & { stats: PlexCollectionsStats }) | null = null;
    let collectionsSyncError: string | undefined;
    try {
      const snapshot = await fetchPlexCollectionsSnapshot({ db, plex: options.plex, logger });
      const report = await syncPlexCollections({
        db,
        collections: snapshot.collections,
        scopedLibraryIds: snapshot.scopedLibraryIds,
        ...(options.now ? { now: options.now } : {}),
      });
      collectionsSync = { ...report, stats: snapshot.stats };
      logger.info('collections-sync complete', {
        collectionsUpserted: report.collectionsUpserted,
        membersUpserted: report.membersUpserted,
        collectionsRemoved: report.collectionsRemoved,
        membersRemoved: report.membersRemoved,
        scopedLibraries: snapshot.scopedLibraryIds.length,
        truncatedCollections: snapshot.stats.truncatedCollections,
        truncatedSections: snapshot.stats.truncatedSections,
        unmappedSections: snapshot.stats.unmappedSections,
      });
      // A run that READ nothing is a failure; a truncated-but-read run is a degraded success
      // (upserts landed, reconcile skipped — the stats carry the truncation).
      if (snapshot.stats.sectionsRead === 0) {
        collectionsSyncError =
          'collections-sync: no HOps section could be read (registry empty or server down)';
      }
    } catch (error) {
      collectionsSyncError = error instanceof Error ? error.message : String(error);
      logger.error('collections-sync failed', { error: collectionsSyncError });
    }
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: [],
      backfill: null,
      fixesCompleted: null,
      collectionsSync,
      ...(collectionsSyncError !== undefined ? { collectionsSyncError } : {}),
      totalFailure: collectionsSyncError !== undefined,
    };
  }

  // metadata-refresh harvests *arr kinds only (Seerr has no metadata) — default to ARR_KINDS.
  const sources =
    options.sources ?? (options.mode === 'metadata-refresh' ? ARR_KINDS : SYNC_SOURCES);
  const startedAt = new Date();
  const reports: SourceRunReport[] = [];

  // Build the shared Tautulli/Maintainerr context ONCE (D-03) so a 3-kind harvest doesn't
  // re-scan Tautulli three times. Degrades internally — never throws for a tier failure.
  const metadataContext =
    options.mode === 'metadata-refresh' && options.metadataSources
      ? await buildMetadataContext({ sources: options.metadataSources, logger })
      : undefined;

  for (const source of sources) {
    let runId: string | null = null;
    try {
      ({ runId } = await startSyncRun({ db, source, runKind: options.mode }));
      logger.info('sync run started', { source, mode: options.mode, runId });
      const stats = await runSource(options, db, logger, source, metadataContext);
      await finishSyncRun({ db, runId, status: 'succeeded', stats });
      logger.info('sync run succeeded', { source, runId, ...stats });
      reports.push({ source, runId, status: 'succeeded', stats });
    } catch (error) {
      // Per-source isolation (D-14): record, log, continue with the next source.
      const aborted = error instanceof MassTombstoneAbortedError;
      const message = error instanceof Error ? error.message : String(error);
      const status = aborted ? ('aborted' as const) : ('failed' as const);
      if (runId !== null) {
        try {
          await finishSyncRun({ db, runId, status, error: message });
        } catch (finishError) {
          logger.error('failed to record sync run failure', {
            source,
            runId,
            error: finishError instanceof Error ? finishError.message : String(finishError),
          });
        }
      }
      logger.error(aborted ? 'sync run aborted (mass-tombstone guard)' : 'sync run failed', {
        source,
        runId,
        error: message,
      });
      reports.push({ source, runId, status, stats: {}, error: message });
    }
  }

  // Post-steps — idempotent, cheap, and independent of which sources ran (D-12). Skipped for
  // metadata-refresh: attribution backfill + fix completion are ledger concerns, not metadata.
  let backfill: SyncReport['backfill'] = null;
  let backfillError: string | undefined;
  let fixesCompleted: number | null = null;
  let fixCompletionError: string | undefined;
  let fixesTimedOut: number | null = null;
  let fixTimeoutError: string | undefined;
  if (options.mode === 'metadata-refresh') {
    const totalFailure = reports.length > 0 && reports.every((r) => r.status !== 'succeeded');
    return {
      mode: options.mode,
      startedAt,
      finishedAt: new Date(),
      sources: reports,
      backfill,
      fixesCompleted,
      totalFailure,
    };
  }
  try {
    backfill = await backfillEventAttribution({ db });
    if (backfill.itemsLinked > 0 || backfill.usersLinked > 0) {
      logger.info('seerr attribution backfilled', { ...backfill });
    }
  } catch (error) {
    backfillError = error instanceof Error ? error.message : String(error);
    logger.error('attribution backfill failed', { error: backfillError });
  }

  try {
    const { completed } = await completeFixRequests({ db });
    fixesCompleted = completed.length;
    if (completed.length > 0) {
      logger.info('fix requests completed by ingested imports', { count: completed.length });
    }
  } catch (error) {
    fixCompletionError = error instanceof Error ? error.message : String(error);
    logger.error('fix completion matching failed', { error: fixCompletionError });
  }

  // Never-stuck safety net: close OPEN fixes older than the horizon (48h) to 'timed_out' so a
  // fire-and-forget subtitle fix (never closed by completeFixRequests) or a search that never
  // landed stops blocking the one-open-fix-per-target rule. Isolated from the completion step.
  try {
    const { timedOut } = await expireStaleFixRequests({ db });
    fixesTimedOut = timedOut.length;
    if (timedOut.length > 0) {
      logger.info('stale fix requests timed out', { count: timedOut.length });
    }
  } catch (error) {
    fixTimeoutError = error instanceof Error ? error.message : String(error);
    logger.error('fix timeout sweep failed', { error: fixTimeoutError });
  }

  // ADR-035 — refresh the Trash candidate read-model (skip-if-absent, isolated like every other
  // post-step: a Maintainerr outage never fails the sync run).
  let candidateRefresh: TrashCandidatesRefreshReport | null = null;
  let candidateRefreshError: string | undefined;
  if (options.maintainerrRead !== undefined) {
    try {
      candidateRefresh = await refreshTrashCandidates({ db, maintainerr: options.maintainerrRead });
      logger.info('trash candidate snapshot refreshed', {
        durationMs: candidateRefresh.durationMs,
        kinds: candidateRefresh.kinds,
      });
    } catch (error) {
      candidateRefreshError = error instanceof Error ? error.message : String(error);
      logger.error('trash candidate snapshot refresh failed', { error: candidateRefreshError });
    }
  }

  // DESIGN-010/014 amendment (build D) — the debounced pool-refresh BACKSTOP. Isolated + skip-if-absent
  // exactly like the candidate refresh: with a write-capable Maintainerr bundle, drain any overdue
  // pending_pool_refresh marker (a save whose in-process web timer was lost to a restart) so the rule
  // re-execution still fires. Cheap no-op when nothing is due; a Maintainerr outage keeps the marker for
  // the next tick and never fails the sync.
  let poolRefresh: DrainPoolRefreshResult | null = null;
  let poolRefreshError: string | undefined;
  if (options.maintainerr !== undefined) {
    try {
      poolRefresh = await drainDuePoolRefreshes({ db, maintainerr: options.maintainerr });
      if (poolRefresh.dueKinds.length > 0) {
        logger.info('pool-refresh backstop drained', {
          dueKinds: poolRefresh.dueKinds,
          executed: poolRefresh.executed,
          disabled: poolRefresh.disabled,
        });
      }
    } catch (error) {
      poolRefreshError = error instanceof Error ? error.message : String(error);
      logger.error('pool-refresh backstop failed', { error: poolRefreshError });
    }
  }

  const totalFailure = reports.length > 0 && reports.every((r) => r.status !== 'succeeded');
  return {
    mode: options.mode,
    startedAt,
    finishedAt: new Date(),
    sources: reports,
    backfill,
    fixesCompleted,
    fixesTimedOut,
    candidateRefresh,
    poolRefresh,
    ...(backfillError !== undefined ? { backfillError } : {}),
    ...(fixCompletionError !== undefined ? { fixCompletionError } : {}),
    ...(fixTimeoutError !== undefined ? { fixTimeoutError } : {}),
    ...(candidateRefreshError !== undefined ? { candidateRefreshError } : {}),
    ...(poolRefreshError !== undefined ? { poolRefreshError } : {}),
    totalFailure,
  };
}
