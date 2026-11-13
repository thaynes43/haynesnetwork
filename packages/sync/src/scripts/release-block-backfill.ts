// ADR-117 / DESIGN-052 D-29 — one-off backfill of posted release names for titles Trash already deleted.
//
//   tsx release-block-backfill.ts --dry-run
//   tsx release-block-backfill.ts --apply
//
// One of the two is required: there is no default. --dry-run writes nothing and does not call Radarr or Sonarr.
// --apply inserts records (365 days from the original delete), writes and reads back the release profiles, and
// refuses a title whose terms would not fit under the cap (nothing older is pruned). Do not run --apply until the
// dry-run counts have been read. Names come from the app's own tables: the ledger and the legacy tables the
// loader fills (legacy-release-names-load.ts); the script reads no file and no download client.
//
// Env: DATABASE_URL. --apply also needs RADARR_URL/RADARR_API_KEY and SONARR_URL/SONARR_API_KEY
// (URLs default in-cluster).
import { getPool } from '@hnet/db';
import { backfillPostedReleaseNames, releaseBlockArrClientsFromEnv } from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage: release-block-backfill.ts --dry-run|--apply

  --dry-run  count the terms that would be added (writes nothing, calls no *arr)
  --apply    write those records and reconcile the release profiles

Env: DATABASE_URL. --apply also RADARR_API_KEY and SONARR_API_KEY.`;

export interface BackfillArgs {
  apply: boolean;
}

export function parseBackfillArgs(argv: readonly string[]): BackfillArgs | 'help' {
  let mode: 'dry' | 'apply' | null = null;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--dry-run') mode = mode !== null && mode !== 'dry' ? badMode() : 'dry';
    else if (arg === '--apply') mode = mode !== null && mode !== 'apply' ? badMode() : 'apply';
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (mode === null) throw new Error('one of --dry-run or --apply is required');
  return { apply: mode === 'apply' };
}

function badMode(): never {
  throw new Error('--dry-run and --apply are exclusive');
}

async function main(): Promise<number> {
  const logger = createConsoleLogger();
  let args: BackfillArgs | 'help';
  try {
    args = parseBackfillArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`release-block-backfill: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (!process.env.DATABASE_URL) {
    logger.error('DATABASE_URL is required');
    return 2;
  }
  const report = await backfillPostedReleaseNames({
    ...(args.apply ? { arr: releaseBlockArrClientsFromEnv() } : {}),
    apply: args.apply,
    logger,
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (process.argv[1]?.endsWith('release-block-backfill.ts')) {
  main()
    .then(async (code) => {
      await getPool()
        .end()
        .catch(() => {});
      process.stdout.write('', () => process.exit(code));
    })
    .catch(async (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      await getPool()
        .end()
        .catch(() => {});
      process.stdout.write('', () => process.exit(1));
    });
}
