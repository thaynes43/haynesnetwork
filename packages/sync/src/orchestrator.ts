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
  finishSyncRun,
  startSyncRun,
} from '@hnet/domain';
import { runArrFullSync } from './arr-full';
import { runArrIncrementalSync } from './arr-incremental';
import type { SyncClients } from './clients';
import { noopLogger, type SyncLogger } from './logger';
import { runSeerrSync } from './seerr';

export type SyncMode = SyncRunKind; // 'full' | 'incremental'

export interface RunSyncOptions {
  mode: SyncMode;
  /** Sources to sync this run; defaults to all four (D-11 SYNC_SOURCES). */
  sources?: readonly SyncSource[];
  /** --force-tombstones (Q-03): override the mass-tombstone guard. */
  forceTombstones?: boolean;
  /** *arr instance slug (D-05 decision 1); single-instance 'main' today. */
  arrInstanceId?: string;
  clients: SyncClients;
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
): Promise<Record<string, unknown>> {
  const arrInstanceId = options.arrInstanceId ?? 'main';
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
  const sources = options.sources ?? SYNC_SOURCES;
  const startedAt = new Date();
  const reports: SourceRunReport[] = [];

  for (const source of sources) {
    let runId: string | null = null;
    try {
      ({ runId } = await startSyncRun({ db, source, runKind: options.mode }));
      logger.info('sync run started', { source, mode: options.mode, runId });
      const stats = await runSource(options, db, logger, source);
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

  // Post-steps — idempotent, cheap, and independent of which sources ran (D-12).
  let backfill: SyncReport['backfill'] = null;
  let backfillError: string | undefined;
  try {
    backfill = await backfillEventAttribution({ db });
    if (backfill.itemsLinked > 0 || backfill.usersLinked > 0) {
      logger.info('seerr attribution backfilled', { ...backfill });
    }
  } catch (error) {
    backfillError = error instanceof Error ? error.message : String(error);
    logger.error('attribution backfill failed', { error: backfillError });
  }

  let fixesCompleted: number | null = null;
  let fixCompletionError: string | undefined;
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
