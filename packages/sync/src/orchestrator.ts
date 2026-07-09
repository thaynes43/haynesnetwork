// DESIGN-005 D-14 — the sync orchestrator. One sync_runs row brackets each source
// (startSyncRun/finishSyncRun); failures are isolated per source (one *arr down never
// fails the whole run); the mass-tombstone guard surfaces as status 'aborted' with the
// tombstones unwritten. After the per-source flows, backfillEventAttribution re-links
// Seerr events whose item/user has since appeared, and completeFixRequests closes
// fixes whose replacement import was just ingested (ADR-007 C-06).
import { ARR_KINDS, SYNC_SOURCES, db as defaultDb, type ArrKind, type DbClient, type SyncRunKind, type SyncSource } from '@hnet/db';
import {
  MassTombstoneAbortedError,
  backfillEventAttribution,
  completeFixRequests,
  deliverOutbox,
  evaluateSpacePolicy,
  finishSyncRun,
  startSyncRun,
  sweepExpiredBatches,
  type MaintainerrClientBundle,
  type OutboxDeliveryReport,
  type SpacePolicyReport,
  type SweepReport,
  type UtilizationArrBundle,
} from '@hnet/domain';
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
  backfillError?: string;
  fixCompletionError?: string;
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
  /** The notify-outbox run's error — sets totalFailure for the CLI exit. */
  outboxError?: string;
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

  const totalFailure = reports.length > 0 && reports.every((r) => r.status !== 'succeeded');
  return {
    mode: options.mode,
    startedAt,
    finishedAt: new Date(),
    sources: reports,
    backfill,
    fixesCompleted,
    ...(backfillError !== undefined ? { backfillError } : {}),
    ...(fixCompletionError !== undefined ? { fixCompletionError } : {}),
    totalFailure,
  };
}
