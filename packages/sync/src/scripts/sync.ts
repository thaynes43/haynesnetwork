// DESIGN-005 D-14 — the CronJob CLI entry:
//
//   tsx sync.ts --mode=full|incremental [--source=sonarr|radarr|lidarr|seerr] [--force-tombstones]
//
// Env (D-18): DATABASE_URL plus SONARR_URL/SONARR_API_KEY (+ RADARR_/LIDARR_/SEERR_);
// URLs default to the in-cluster service DNS. Exit 0 with a per-source report unless
// EVERY requested source failed (or the run could not start at all) — one *arr being
// down must not mask the sources that synced (D-14 failure isolation).
import {
  ARR_KINDS,
  SYNC_RUN_KINDS,
  SYNC_SOURCES,
  getPool,
  type SyncRunKind,
  type SyncSource,
} from '@hnet/db';
import {
  maintainerrClientBundleFromEnv,
  plexClientBundleFromEnv,
  type UtilizationArrBundle,
} from '@hnet/domain';
import { prometheusClientFromEnv } from '@hnet/metrics';
import { buildMetadataSourceClients, buildOptionalMaintainerrRead, buildSyncClients, requireClient } from '../clients';
import { createConsoleLogger } from '../logger';
import { runSync } from '../orchestrator';

const USAGE = `Usage: sync.ts --mode=full|incremental|metadata-refresh|trash-batch-sweep|space-policy|notify-outbox|smart-alerts [--source=${SYNC_SOURCES.join('|')}] [--force-tombstones]

  --mode=full              item-list upsert + tombstone pass per *arr (+ Seerr requests)
  --mode=incremental       history/since cursor polling per *arr (+ Seerr requests)
  --mode=metadata-refresh  harvest ratings/genres/runtime/posters (+ Tautulli watch-stats,
                           Maintainerr, direct TMDB/TVDB fallback) into media_metadata (ADR-018)
  --mode=trash-batch-sweep delete the survivors of every EXPIRED Leaving-Soon batch, one guarded
                           item at a time (ADR-025 — SAFE audit + live exclusions + guardian re-run).
                           Drives Maintainerr; needs MAINTAINERR_URL/MAINTAINERR_API_KEY. No --source.
  --mode=space-policy      PROPOSE (never delete) a draft batch for each media array over its space
                           target (ADR-031 — reads *arr /diskspace + createBatchFromPending; admin gate
                           stays the human check). Needs SONARR/RADARR/LIDARR_URL/_API_KEY +
                           MAINTAINERR_URL/MAINTAINERR_API_KEY. No --source. No-op unless space_policy
                           is enabled in app_settings.
  --mode=notify-outbox     drain DUE notification_outbox rows to Pushover (ADR-034 — batch-lifecycle
                           pushes; sent_at null + attempts<5 + earliest_send_at<=now). Needs
                           PUSHOVER_APP_TOKEN + PUSHOVER_USER_KEY; disabled-safe — a clean no-op that
                           leaves rows queued when either is absent. No --source. Writes no sync_runs row.
  --mode=smart-alerts      detect CRITICAL SMART transitions since the last check (ADR-040 — pass→FAIL,
                           media_errors 0→n, spare crossing threshold margin, a NEW critical_warning bit,
                           or the critical appdata pool wear crossing 80/90%) and enqueue ONE
                           notification_outbox row per transition, same-tx with the smart_drive_state
                           update. First sight of a drive records a BASELINE and pages nothing. Reads the
                           in-cluster Prometheus (PROMETHEUS_URL, in-cluster default; no secret). No
                           --source. Writes no sync_runs row.
  --mode=poster-guard      re-apply drifted Peloton override posters on k8plex (ADR-043 — read HOps
                           Peloton, resolve each show→series art + season→duration art from the durable
                           assets baked into the image, and re-push ONLY the targets whose Plex thumb
                           drifted since the last apply). Appends one poster_guard_applications ledger row
                           per re-apply (drift baseline + audit). Needs PLEX_HAYNESKUBE_TOKEN. No --source.
                           Writes no sync_runs row.
  --source=NAME            limit the run to one source (repeatable; default: all sources; for
                           metadata-refresh the default is the three *arr kinds)
  --force-tombstones       override the mass-tombstone guard (DESIGN-005 D-14/Q-03)
  --help                   print this usage

Env (DESIGN-005 D-18): DATABASE_URL, SONARR_URL/SONARR_API_KEY, RADARR_URL/RADARR_API_KEY,
LIDARR_URL/LIDARR_API_KEY, SEERR_URL/SEERR_API_KEY (URLs default to in-cluster DNS).
Metadata sources (ADR-018 / DESIGN-008 — all OPTIONAL, skip-if-absent): TAUTULLI_API_KEY,
TAUTULLI_K8PLEX_API_KEY, TAUTULLI_HAYNESTOWER_API_KEY (+ _URL for haynestower), TMDB_API_KEY /
TMDB_API_READ_ACCESS_TOKEN, TVDB_API_KEY, MAINTAINERR_URL/MAINTAINERR_API_KEY.`;

interface CliArgs {
  mode: SyncRunKind;
  sources: SyncSource[];
  forceTombstones: boolean;
}

class CliUsageError extends Error {}

function parseArgs(argv: string[]): CliArgs | 'help' {
  let mode: SyncRunKind | undefined;
  const sources: SyncSource[] = [];
  let forceTombstones = false;

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--force-tombstones') {
      forceTombstones = true;
    } else if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length);
      if (!(SYNC_RUN_KINDS as readonly string[]).includes(value)) {
        throw new CliUsageError(`invalid --mode "${value}" (expected ${SYNC_RUN_KINDS.join('|')})`);
      }
      mode = value as SyncRunKind;
    } else if (arg.startsWith('--source=')) {
      const value = arg.slice('--source='.length);
      if (!(SYNC_SOURCES as readonly string[]).includes(value)) {
        throw new CliUsageError(`invalid --source "${value}" (expected ${SYNC_SOURCES.join('|')})`);
      }
      sources.push(value as SyncSource);
    } else {
      throw new CliUsageError(`unknown argument "${arg}"`);
    }
  }
  if (mode === undefined) {
    throw new CliUsageError(
      '--mode=full|incremental|metadata-refresh|trash-batch-sweep|space-policy|notify-outbox|smart-alerts is required',
    );
  }
  if (
    (mode === 'trash-batch-sweep' ||
      mode === 'space-policy' ||
      mode === 'notify-outbox' ||
      mode === 'smart-alerts' ||
      mode === 'poster-guard') &&
    sources.length > 0
  ) {
    throw new CliUsageError(`--source is not valid for --mode=${mode}`);
  }
  // metadata-refresh defaults to the *arr kinds (Seerr has no metadata); trash-batch-sweep +
  // space-policy + notify-outbox + smart-alerts use no *arr SOURCE loop at all (they drive Maintainerr /
  // read diskspace / drain the outbox / read Prometheus directly); other modes default to all sources.
  const defaultSources =
    mode === 'trash-batch-sweep' ||
    mode === 'space-policy' ||
    mode === 'notify-outbox' ||
    mode === 'smart-alerts' ||
    mode === 'poster-guard'
      ? []
      : mode === 'metadata-refresh'
        ? [...ARR_KINDS]
        : [...SYNC_SOURCES];
  return {
    mode,
    sources: sources.length > 0 ? [...new Set(sources)] : defaultSources,
    forceTombstones,
  };
}

async function main(): Promise<number> {
  const logger = createConsoleLogger();

  let args: CliArgs | 'help';
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(`sync: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (args === 'help') {
    console.log(USAGE);
    return 0;
  }

  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    return 2;
  }

  // Build only the clients this run needs; missing keys for requested sources throw
  // one ArrConfigError naming every absent variable (never their values). trash-batch-sweep
  // has no *arr sources — it drives the Maintainerr bundle built below.
  const clients = buildSyncClients(args.sources);
  // ADR-018 / DESIGN-008 — the OPTIONAL metadata-harvest sources (Tautulli/TMDB/TVDB/
  // Maintainerr). Only built for metadata-refresh; each tier is skip-if-absent.
  const metadataSources =
    args.mode === 'metadata-refresh' ? buildMetadataSourceClients() : undefined;
  // ADR-025 / ADR-031 — the confined Maintainerr bundle for the batch-expiry sweep AND the
  // space-policy proposal mode (throws one ArrConfigError naming MAINTAINERR_API_KEY if absent). The
  // mutating client is constructed INSIDE @hnet/domain (maintainerrClientBundleFromEnv), so the
  // confined write surface stays domain-only (ADR-008 guard).
  // trash-batch-sweep / space-policy REQUIRE the bundle (throw if the key is absent). full/incremental
  // build it OPTIONALLY (DESIGN-014 build D — the pool-refresh backstop needs the WRITE surface); a
  // Maintainerr-less env just skips the backstop, like the candidate-refresh read handle below.
  let maintainerr: ReturnType<typeof maintainerrClientBundleFromEnv> | undefined;
  if (args.mode === 'trash-batch-sweep' || args.mode === 'space-policy') {
    maintainerr = maintainerrClientBundleFromEnv();
  } else if (args.mode === 'full' || args.mode === 'incremental') {
    try {
      maintainerr = maintainerrClientBundleFromEnv();
    } catch {
      maintainerr = undefined; // no MAINTAINERR_API_KEY — skip the backstop cleanly
    }
  }
  // ADR-035 — the OPTIONAL Maintainerr READ handle: full/incremental end by refreshing the Trash
  // candidate snapshot (skip-if-absent — a Maintainerr-less env just skips the step).
  const maintainerrRead =
    args.mode === 'full' || args.mode === 'incremental'
      ? buildOptionalMaintainerrRead()
      : undefined;
  // ADR-031 — the diskspace-only *arr read bundle for space-policy's getUtilization (needs the three
  // *arr keys; throws one ArrConfigError naming any absent). Wrapped as the minimal UtilizationArrBundle
  // shape — no bazarr, no confined write surface.
  let arr: UtilizationArrBundle | undefined;
  if (args.mode === 'space-policy') {
    const disk = buildSyncClients(['sonarr', 'radarr', 'lidarr']);
    arr = {
      read: {
        sonarr: requireClient(disk, 'sonarr'),
        radarr: requireClient(disk, 'radarr'),
        lidarr: requireClient(disk, 'lidarr'),
      },
    };
  }
  // ADR-040 / DESIGN-020 — the read-only @hnet/metrics Prometheus reader the `smart-alerts` mode reads
  // the smartctl series through (PROMETHEUS_URL, in-cluster default; no secret).
  const smartReader = args.mode === 'smart-alerts' ? prometheusClientFromEnv() : undefined;
  // ADR-043 / DESIGN-021 — the Plex client bundle (read + confined write) the `poster-guard` mode uses.
  // Built INSIDE @hnet/domain (plexClientBundleFromEnv), so the confined Plex write surface stays
  // domain-only (ADR-017 guard); throws one PlexConfigError if PLEX_HAYNESKUBE_TOKEN is absent.
  const plex = args.mode === 'poster-guard' ? plexClientBundleFromEnv() : undefined;

  logger.info('sync starting', {
    mode: args.mode,
    sources: args.sources,
    forceTombstones: args.forceTombstones,
    ...(metadataSources
      ? {
          tautulliInstances: metadataSources.tautulli.map((t) => t.slug),
          tmdb: Boolean(metadataSources.tmdb),
          tvdb: Boolean(metadataSources.tvdb),
          maintainerr: Boolean(metadataSources.maintainerr),
        }
      : {}),
  });
  const report = await runSync({
    mode: args.mode,
    sources: args.sources,
    forceTombstones: args.forceTombstones,
    clients,
    ...(metadataSources ? { metadataSources } : {}),
    ...(maintainerr ? { maintainerr } : {}),
    ...(arr ? { arr } : {}),
    ...(maintainerrRead ? { maintainerrRead } : {}),
    ...(smartReader ? { smartReader } : {}),
    ...(plex ? { plex } : {}),
    logger,
  });

  logger.info('sync finished', {
    mode: report.mode,
    durationMs: report.finishedAt.getTime() - report.startedAt.getTime(),
    totalFailure: report.totalFailure,
    backfill: report.backfill,
    fixesCompleted: report.fixesCompleted,
    ...(report.candidateRefresh
      ? {
          candidateRefresh: {
            durationMs: report.candidateRefresh.durationMs,
            kinds: report.candidateRefresh.kinds,
          },
        }
      : {}),
    ...(report.candidateRefreshError !== undefined
      ? { candidateRefreshError: report.candidateRefreshError }
      : {}),
    ...(report.poolRefresh && report.poolRefresh.dueKinds.length > 0
      ? { poolRefresh: report.poolRefresh }
      : {}),
    ...(report.poolRefreshError !== undefined ? { poolRefreshError: report.poolRefreshError } : {}),
    ...(report.sweep ? { sweep: { batchesSwept: report.sweep.batchesSwept, batches: report.sweep.batches } } : {}),
    ...(report.sweepError !== undefined ? { sweepError: report.sweepError } : {}),
    ...(report.spacePolicy
      ? {
          spacePolicy: {
            enabled: report.spacePolicy.enabled,
            proposedCount: report.spacePolicy.proposedCount,
            arrays: report.spacePolicy.arrays,
          },
        }
      : {}),
    ...(report.spacePolicyError !== undefined ? { spacePolicyError: report.spacePolicyError } : {}),
    ...(report.outbox
      ? {
          outbox: {
            dueCount: report.outbox.dueCount,
            sent: report.outbox.sent,
            failed: report.outbox.failed,
            parked: report.outbox.parked,
            skipped: report.outbox.skipped,
          },
        }
      : {}),
    ...(report.outboxError !== undefined ? { outboxError: report.outboxError } : {}),
    ...(report.smartAlerts ? { smartAlerts: report.smartAlerts } : {}),
    ...(report.smartAlertsError !== undefined ? { smartAlertsError: report.smartAlertsError } : {}),
    ...(report.posterGuard
      ? {
          posterGuard: {
            found: report.posterGuard.found,
            checked: report.posterGuard.checked,
            inSync: report.posterGuard.inSync,
            reapplied: report.posterGuard.reapplied.length,
            unmapped: report.posterGuard.unmapped.length,
            missingAssets: report.posterGuard.missingAssets,
          },
        }
      : {}),
    ...(report.posterGuardError !== undefined ? { posterGuardError: report.posterGuardError } : {}),
    sources: report.sources.map((s) => ({
      source: s.source,
      status: s.status,
      runId: s.runId,
      ...(s.error !== undefined ? { error: s.error } : {}),
      stats: s.stats,
    })),
  });
  return report.totalFailure ? 1 : 0;
}

main()
  .then(async (code) => {
    // Close the pg pool so the process can exit promptly on success paths too.
    try {
      await getPool().end();
    } catch {
      // pool never initialized (config error before any DB use) — nothing to close
    }
    process.exit(code);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
