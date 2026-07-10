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
  drainDuePoolRefreshes,
  expireStaleFixRequests,
  deliverOutbox,
  evaluateSmartAlerts,
  evaluateSpacePolicy,
  finishSyncRun,
  refreshTrashCandidates,
  runPelotonPosterGuard,
  startSyncRun,
  sweepExpiredBatches,
  syncAiUsage,
  type DrainPoolRefreshResult,
  type MaintainerrClientBundle,
  type OutboxDeliveryReport,
  type PlexClientBundle,
  type PosterGuardReport,
  type SmartAlertsReport,
  type SpacePolicyReport,
  type SweepReport,
  type SyncAiUsageReport,
  type TrashCandidatesRefreshReport,
  type UtilizationArrBundle,
} from '@hnet/domain';
// ADR-044 / DESIGN-022 (PLAN-021) — the read-only Open WebUI admin-API client the `ai-usage-sync` mode
// polls; the fetched snapshot is handed to the @hnet/domain syncAiUsage single-writer (never a live
// cross-DB read — the *arr-ledger precedent).
import { fetchOwuiUsage, type OpenWebUiClient } from './openwebui';
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
  /** ADR-043 / DESIGN-021 — the Plex client bundle (read + confined write) the `poster-guard` mode uses to
   *  read the k8plex Peloton library and re-apply drifted override posters. Required only for that mode. */
  plex?: PlexClientBundle;
  /** ADR-044 / DESIGN-022 — the read-only Open WebUI admin-API client the `ai-usage-sync` mode polls for
   *  chats + users. Required only for that mode; tests inject a fetch-stubbed client. */
  openWebUi?: OpenWebUiClient;
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
  /** The notify-outbox run's error — sets totalFailure for the CLI exit. */
  outboxError?: string;
  /** ADR-040 — the `smart-alerts` detector result (null for every other mode / when it errored). */
  smartAlerts?: SmartAlertsReport | null;
  /** The smart-alerts run's error — sets totalFailure for the CLI exit. */
  smartAlertsError?: string;
  /** ADR-043 — the `poster-guard` result (null for every other mode / when it errored). */
  posterGuard?: PosterGuardReport | null;
  /** The poster-guard run's error — sets totalFailure for the CLI exit. */
  posterGuardError?: string;
  /** ADR-044 — the `ai-usage-sync` result (null for every other mode / when it errored). */
  aiUsage?: SyncAiUsageReport | null;
  /** The ai-usage-sync run's error — sets totalFailure for the CLI exit. */
  aiUsageError?: string;
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
