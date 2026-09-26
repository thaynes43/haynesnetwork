// ADR-093 C-13 / DESIGN-052 D-15 (PLAN-072 S8) — the one-off Release Block SEED (not a sync mode):
//
//   tsx release-block-seed.ts --dry-run|--apply [--legacy-sab=<file>] [--manual=<file>]
//
// Seeds a "must not contain" term for every past Trash deletion the ledger (or a legacy HaynesTower SABnzbd history)
// can identify, plus the remediation titles, then reconciles and reads back the Radarr/Sonarr release profiles.
// `--dry-run` writes nothing (it still GETs each *arr item to confirm what is gone) and prints the counts per source,
// the rows skipped because their *arr record still exists, the named titles and what stays unblockable.
//
// Files (never committed; they hold no URL):
//   --legacy-sab  one completed job per line: JSON {"name","bytes","completed"} or `name<TAB>bytes<TAB>completed`
//   --manual      a JSON array of {"tmdbId","title","year","releaseNames":[…]}
//
// Env: DATABASE_URL, RADARR_URL/RADARR_API_KEY, SONARR_URL/SONARR_API_KEY (URLs default in-cluster).
import { readFileSync } from 'node:fs';
import { getPool } from '@hnet/db';
import {
  parseLegacySabFile,
  parseManualSeedFile,
  releaseBlockArrClientsFromEnv,
  seedReleaseBlock,
} from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage: release-block-seed.ts --dry-run|--apply [--legacy-sab=<file>] [--manual=<file>]

  --dry-run            count what would be seeded, per source (writes nothing)
  --apply              write the records (active, 365 days from each deletion) and reconcile the profiles
  --legacy-sab=<file>  legacy SABnzbd completed jobs (JSON lines or name<TAB>bytes<TAB>completed)
  --manual=<file>      remediation titles: JSON [{tmdbId, title, year, releaseNames}]

Env: DATABASE_URL, RADARR_API_KEY, SONARR_API_KEY (RADARR_URL / SONARR_URL default in-cluster).`;

export interface SeedArgs {
  apply: boolean;
  legacySab: string | null;
  manual: string | null;
}

export function parseSeedArgs(argv: readonly string[]): SeedArgs | 'help' {
  let mode: 'dry' | 'apply' | null = null;
  let legacySab: string | null = null;
  let manual: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    // `--legacy-sab <file>` (DESIGN-052 D-15's spelling) and `--legacy-sab=<file>` are both accepted.
    const valueOf = (flag: string): string => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a file`);
      i += 1;
      return next;
    };
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--dry-run') mode = mode === 'apply' ? badMode() : 'dry';
    else if (arg === '--apply') mode = mode === 'dry' ? badMode() : 'apply';
    else if (arg === '--legacy-sab' || arg.startsWith('--legacy-sab='))
      legacySab = valueOf('--legacy-sab');
    else if (arg === '--manual' || arg.startsWith('--manual=')) manual = valueOf('--manual');
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (mode === null) throw new Error('one of --dry-run or --apply is required');
  return { apply: mode === 'apply', legacySab: legacySab || null, manual: manual || null };
}

function badMode(): never {
  throw new Error('--dry-run and --apply are exclusive');
}

async function main(): Promise<number> {
  const logger = createConsoleLogger();
  let args: SeedArgs | 'help';
  try {
    args = parseSeedArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`release-block-seed: ${(error as Error).message}\n\n${USAGE}`);
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
  const legacySab = args.legacySab
    ? parseLegacySabFile(readFileSync(args.legacySab, 'utf8'))
    : undefined;
  const manual = args.manual ? parseManualSeedFile(readFileSync(args.manual, 'utf8')) : undefined;
  const report = await seedReleaseBlock({
    arr: releaseBlockArrClientsFromEnv(),
    apply: args.apply,
    ...(legacySab ? { legacySab } : {}),
    ...(manual ? { manual } : {}),
    logger,
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

// Run only as a script (tests import parseSeedArgs).
if (process.argv[1]?.endsWith('release-block-seed.ts')) {
  main()
    .then(async (code) => {
      await getPool()
        .end()
        .catch(() => {});
      process.exit(code);
    })
    .catch(async (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      await getPool()
        .end()
        .catch(() => {});
      process.exit(1);
    });
}
