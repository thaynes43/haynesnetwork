// DESIGN-005 D-14 — the CronJob CLI entry:
//
//   tsx sync.ts --mode=full|incremental [--source=sonarr|radarr|lidarr|seerr] [--force-tombstones]
//
// Env (D-18): DATABASE_URL plus SONARR_URL/SONARR_API_KEY (+ RADARR_/LIDARR_/SEERR_);
// URLs default to the in-cluster service DNS. Exit 0 with a per-source report unless
// EVERY requested source failed (or the run could not start at all) — one *arr being
// down must not mask the sources that synced (D-14 failure isolation).
import { SYNC_RUN_KINDS, SYNC_SOURCES, getPool, type SyncRunKind, type SyncSource } from '@hnet/db';
import { buildSyncClients } from '../clients';
import { createConsoleLogger } from '../logger';
import { runSync } from '../orchestrator';

const USAGE = `Usage: sync.ts --mode=full|incremental [--source=${SYNC_SOURCES.join('|')}] [--force-tombstones]

  --mode=full           item-list upsert + tombstone pass per *arr (+ Seerr requests)
  --mode=incremental    history/since cursor polling per *arr (+ Seerr requests)
  --source=NAME         limit the run to one source (repeatable; default: all four)
  --force-tombstones    override the mass-tombstone guard (DESIGN-005 D-14/Q-03)
  --help                print this usage

Env (DESIGN-005 D-18): DATABASE_URL, SONARR_URL/SONARR_API_KEY, RADARR_URL/RADARR_API_KEY,
LIDARR_URL/LIDARR_API_KEY, SEERR_URL/SEERR_API_KEY (URLs default to in-cluster DNS).`;

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
    throw new CliUsageError('--mode=full|incremental is required');
  }
  return { mode, sources: sources.length > 0 ? [...new Set(sources)] : [...SYNC_SOURCES], forceTombstones };
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
  // one ArrConfigError naming every absent variable (never their values).
  const clients = buildSyncClients(args.sources);

  logger.info('sync starting', {
    mode: args.mode,
    sources: args.sources,
    forceTombstones: args.forceTombstones,
  });
  const report = await runSync({
    mode: args.mode,
    sources: args.sources,
    forceTombstones: args.forceTombstones,
    clients,
    logger,
  });

  logger.info('sync finished', {
    mode: report.mode,
    durationMs: report.finishedAt.getTime() - report.startedAt.getTime(),
    totalFailure: report.totalFailure,
    backfill: report.backfill,
    fixesCompleted: report.fixesCompleted,
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
