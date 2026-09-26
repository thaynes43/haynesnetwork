// ADR-093 C-13 / DESIGN-052 D-15 (PLAN-072 S8) — the one-off Release Block SEED (not a sync mode):
//
//   tsx release-block-seed.ts --dry-run|--apply [--legacy-sab=<file>] [--manual=<file>]
//   tsx release-block-seed.ts --pool
//
// Seeds a "must not contain" term for every past Trash deletion the ledger (or a legacy HaynesTower SABnzbd history)
// can identify, plus the remediation titles, then reconciles and reads back the Radarr/Sonarr release profiles.
// `--dry-run` writes nothing (it still GETs each *arr item to confirm what is gone) and prints the counts per source,
// the rows skipped because their *arr record still exists, the named titles and what stays unblockable.
//
// `--pool` (PLAN-072 S6(e), before the sweep resumes) is a separate, READ-ONLY report: it runs the D-11 / D-12
// derivation over the pending Trash pool (movies and TV) and prints the records by shape, confidence and identity
// source, the records with no release group (Q-12), and the items D-11 would keep `release_unrecorded` with their
// reasons and share (Q-13). It writes nothing; it needs MAINTAINERR_URL / MAINTAINERR_API_KEY besides the *arr keys.
//
// Files (never committed; they hold no URL):
//   --legacy-sab  one completed job per line: JSON {"name","bytes","completed"} or `name<TAB>bytes<TAB>completed`
//   --manual      a JSON array of {"tmdbId","title","year","releaseNames":[…]}
//
// Env: DATABASE_URL, RADARR_URL/RADARR_API_KEY, SONARR_URL/SONARR_API_KEY (URLs default in-cluster).
import { readFileSync } from 'node:fs';
import { getPool } from '@hnet/db';
import {
  maintainerrClientBundleFromEnv,
  parseLegacySabFile,
  parseManualSeedFile,
  releaseBlockArrClientsFromEnv,
  reportPoolReleaseIdentity,
  seedReleaseBlock,
} from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage: release-block-seed.ts --dry-run|--apply [--legacy-sab=<file>] [--manual=<file>]
       release-block-seed.ts --pool

  --dry-run            count what would be seeded, per source (writes nothing)
  --apply              write the records (active, 365 days from each deletion) and reconcile the profiles
  --legacy-sab=<file>  legacy SABnzbd completed jobs (JSON lines or name<TAB>bytes<TAB>completed)
  --manual=<file>      remediation titles: JSON [{tmdbId, title, year, releaseNames}]
  --pool               PLAN-072 S6(e): what the Release Block would record for the pending pool (writes nothing)

Env: DATABASE_URL, RADARR_API_KEY, SONARR_API_KEY (RADARR_URL / SONARR_URL default in-cluster);
     --pool also MAINTAINERR_URL, MAINTAINERR_API_KEY.`;

export interface SeedArgs {
  apply: boolean;
  /** PLAN-072 S6(e) — the read-only pool report instead of a seed. */
  pool: boolean;
  legacySab: string | null;
  manual: string | null;
}

export function parseSeedArgs(argv: readonly string[]): SeedArgs | 'help' {
  let mode: 'dry' | 'apply' | 'pool' | null = null;
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
    if (arg === '--dry-run') mode = mode !== null && mode !== 'dry' ? badMode() : 'dry';
    else if (arg === '--apply') mode = mode !== null && mode !== 'apply' ? badMode() : 'apply';
    else if (arg === '--pool') mode = mode !== null && mode !== 'pool' ? badMode() : 'pool';
    else if (arg === '--legacy-sab' || arg.startsWith('--legacy-sab='))
      legacySab = valueOf('--legacy-sab');
    else if (arg === '--manual' || arg.startsWith('--manual=')) manual = valueOf('--manual');
    else throw new Error(`unknown argument "${arg}"`);
  }
  if (mode === null) throw new Error('one of --dry-run, --apply or --pool is required');
  if (mode === 'pool' && (legacySab || manual)) {
    throw new Error('--pool is a read-only report: it takes no --legacy-sab or --manual file');
  }
  return {
    apply: mode === 'apply',
    pool: mode === 'pool',
    legacySab: legacySab || null,
    manual: manual || null,
  };
}

function badMode(): never {
  throw new Error('--dry-run, --apply and --pool are exclusive');
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
  if (args.pool) {
    // PLAN-072 S6(e) — read-only: Maintainerr's pool, the ledger and the *arr identity reads; nothing is written.
    const report = await reportPoolReleaseIdentity({
      maintainerr: maintainerrClientBundleFromEnv(),
      arr: releaseBlockArrClientsFromEnv().read,
      logger,
    });
    console.log(JSON.stringify(report, null, 2));
    return 0;
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
