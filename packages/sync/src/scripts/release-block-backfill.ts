// ADR-117 / DESIGN-052 D-29 — one-off backfill of verified posted names for titles already deleted.
//
//   tsx release-block-backfill.ts --dry-run [--legacy-sab=<file>]
//   tsx release-block-backfill.ts --apply  [--legacy-sab=<file>]
//
// --dry-run writes nothing and does not call Radarr or Sonarr. --apply inserts active records (365 days
// from the original delete) and reconciles the profiles. Do not run --apply until the dry-run counts
// have been read. The legacy file is never committed.
//
// Env: DATABASE_URL. --apply also needs RADARR_URL/RADARR_API_KEY and SONARR_URL/SONARR_API_KEY
// (URLs default in-cluster). The script does not read the live download client; pass a history file.
import { readFileSync } from 'node:fs';
import { getPool } from '@hnet/db';
import {
  backfillPostedReleaseNames,
  parseLegacySabFile,
  releaseBlockArrClientsFromEnv,
} from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage: release-block-backfill.ts --dry-run|--apply [--legacy-sab=<file>]

  --dry-run            count verified terms that would be added (writes nothing, calls no *arr)
  --apply              write those records and reconcile the release profiles
  --legacy-sab=<file>  download history: JSON lines or name<TAB>bytes<TAB>completed

Env: DATABASE_URL. --apply also RADARR_API_KEY and SONARR_API_KEY.`;

export interface BackfillArgs {
  apply: boolean;
  legacySab: string | null;
}

export function parseBackfillArgs(argv: readonly string[]): BackfillArgs | 'help' {
  let mode: 'dry' | 'apply' | null = null;
  let legacySab: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const valueOf = (flag: string): string => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a file`);
      i += 1;
      return next;
    };
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--dry-run') mode = mode !== null && mode !== 'dry' ? badMode() : 'dry';
    else if (arg === '--apply') mode = mode !== null && mode !== 'apply' ? badMode() : 'apply';
    else if (arg === '--legacy-sab' || arg.startsWith('--legacy-sab=')) legacySab = valueOf('--legacy-sab');
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (mode === null) throw new Error('one of --dry-run or --apply is required');
  return { apply: mode === 'apply', legacySab: legacySab || null };
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
  const legacySab = args.legacySab ? parseLegacySabFile(readFileSync(args.legacySab, 'utf8')) : undefined;
  const report = await backfillPostedReleaseNames({
    ...(args.apply ? { arr: releaseBlockArrClientsFromEnv() } : {}),
    apply: args.apply,
    ...(legacySab ? { legacySab } : {}),
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
