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
import { maintainerrClientBundleFromEnv } from '@hnet/domain';
import { buildMetadataSourceClients, buildSyncClients } from '../clients';
import { createConsoleLogger } from '../logger';
import { runSync } from '../orchestrator';

const USAGE = `Usage: sync.ts --mode=full|incremental|metadata-refresh|trash-batch-sweep [--source=${SYNC_SOURCES.join('|')}] [--force-tombstones]

  --mode=full              item-list upsert + tombstone pass per *arr (+ Seerr requests)
  --mode=incremental       history/since cursor polling per *arr (+ Seerr requests)
  --mode=metadata-refresh  harvest ratings/genres/runtime/posters (+ Tautulli watch-stats,
                           Maintainerr, direct TMDB/TVDB fallback) into media_metadata (ADR-018)
  --mode=trash-batch-sweep delete the survivors of every EXPIRED Leaving-Soon batch, one guarded
                           item at a time (ADR-025 — SAFE audit + live exclusions + guardian re-run).
                           Drives Maintainerr; needs MAINTAINERR_URL/MAINTAINERR_API_KEY. No --source.
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
        throw new CliUsageError(`invalid --mode "${value}" (expected full|incremental)`);
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
    throw new CliUsageError('--mode=full|incremental|metadata-refresh|trash-batch-sweep is required');
  }
  if (mode === 'trash-batch-sweep' && sources.length > 0) {
    throw new CliUsageError('--source is not valid for --mode=trash-batch-sweep (it drives Maintainerr)');
  }
  // metadata-refresh defaults to the *arr kinds (Seerr has no metadata); trash-batch-sweep uses no
  // *arr source at all (it drives Maintainerr); other modes default to all four sources.
  const defaultSources =
    mode === 'trash-batch-sweep'
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
  // ADR-025 — the confined Maintainerr bundle for the batch-expiry sweep (throws one ArrConfigError
  // naming MAINTAINERR_API_KEY if absent). The write client is constructed inside @hnet/domain so
  // the @hnet/arr/write import stays confined there (ADR-008 guard).
  const maintainerr =
    args.mode === 'trash-batch-sweep' ? maintainerrClientBundleFromEnv() : undefined;

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
    logger,
  });

  logger.info('sync finished', {
    mode: report.mode,
    durationMs: report.finishedAt.getTime() - report.startedAt.getTime(),
    totalFailure: report.totalFailure,
    backfill: report.backfill,
    fixesCompleted: report.fixesCompleted,
    ...(report.sweep ? { sweep: { batchesSwept: report.sweep.batchesSwept, batches: report.sweep.batches } } : {}),
    ...(report.sweepError !== undefined ? { sweepError: report.sweepError } : {}),
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
