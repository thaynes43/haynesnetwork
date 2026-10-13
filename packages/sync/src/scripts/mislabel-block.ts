// ADR-110 C-04, C-05 / DESIGN-055 D-05 (PLAN-077 P4) — the Mislabel Block's in-cluster tool (not a sync mode):
//
//   tsx mislabel-block.ts list [--state active|expired|removed|all]
//   tsx mislabel-block.ts adopt --series <sonarr series id> --group <release group> [--dry-run]
//   tsx mislabel-block.ts reconcile [--dry-run]
//
// `list` prints the terms (default: active). `adopt` is ADR-110 C-05: Case A's hand-made per-series profile becomes one
// Mislabel Block term (origin `adoption`), written and read back by the domain's single writer; `--dry-run` prints the
// term it would write and writes nothing. The hand-made profile and its tag are then removed by hand with a read-back
// (PLAN-077 P4). `reconcile` expires terms past their 365 days and repairs the profile's drift, as the hourly
// `title-check` upkeep does; `--dry-run` reports the drift and writes nothing.
//
// Env: DATABASE_URL, SONARR_API_KEY (SONARR_URL defaults in-cluster). `list` needs only DATABASE_URL.
import { MISLABEL_TERM_STATES, db, getPool, type MislabelTermState } from '@hnet/db';
import {
  adoptMislabelTerm,
  listMislabelTerms,
  mislabelBlockSonarrFromEnv,
  reconcileMislabelBlock,
} from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage:
  mislabel-block.ts list [--state active|expired|removed|all]
  mislabel-block.ts adopt --series <sonarr series id> --group <release group> [--dry-run]
  mislabel-block.ts reconcile [--dry-run]

list only reads. adopt and reconcile write Sonarr's "mislabelled releases" profile (read back) unless --dry-run.`;

export type MislabelBlockArgs =
  | { command: 'list'; state: MislabelTermState | 'all' }
  | { command: 'adopt'; seriesId: number; group: string; dryRun: boolean }
  | { command: 'reconcile'; dryRun: boolean };

/** Parse the command line (exported for a unit test). */
export function parseMislabelBlockArgs(argv: readonly string[]): MislabelBlockArgs | 'help' {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') return 'help';
  if (command !== 'list' && command !== 'adopt' && command !== 'reconcile') {
    throw new Error(`unknown command "${command}"`);
  }
  let state: MislabelTermState | 'all' = 'active';
  let seriesId: number | undefined;
  let group: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i]!;
    const value = rest[i + 1];
    switch (flag) {
      case '--state':
        if (value !== 'all' && !(MISLABEL_TERM_STATES as readonly string[]).includes(value ?? '')) {
          throw new Error('--state needs active, expired, removed or all');
        }
        state = value as MislabelTermState | 'all';
        i += 1;
        break;
      case '--series':
        if (value === undefined || !/^\d+$/.test(value)) throw new Error('--series needs the Sonarr series id');
        seriesId = Number(value);
        i += 1;
        break;
      case '--group':
        if (!value || value.trim().length === 0) throw new Error('--group needs the release group');
        group = value.trim();
        i += 1;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      default:
        throw new Error(`unknown argument "${flag}"`);
    }
  }
  if (command === 'list') {
    if (seriesId !== undefined || group !== undefined || dryRun) throw new Error('list takes only --state');
    return { command, state };
  }
  if (command === 'adopt') {
    if (seriesId === undefined || group === undefined) throw new Error('adopt needs --series and --group');
    return { command, seriesId, group, dryRun };
  }
  if (seriesId !== undefined || group !== undefined) throw new Error('reconcile takes only --dry-run');
  return { command, dryRun };
}

async function main(): Promise<number> {
  let args: MislabelBlockArgs | 'help';
  try {
    args = parseMislabelBlockArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`mislabel-block: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (!process.env.DATABASE_URL) {
    console.error('mislabel-block: DATABASE_URL is required');
    return 2;
  }
  const logger = createConsoleLogger();

  if (args.command === 'list') {
    const terms = await listMislabelTerms({ db, state: args.state });
    console.log(JSON.stringify(terms, null, 2));
    return 0;
  }

  const sonarr = mislabelBlockSonarrFromEnv();
  if (args.command === 'adopt') {
    const result = await adoptMislabelTerm({
      db,
      sonarr,
      seriesId: args.seriesId,
      releaseGroup: args.group,
      dryRun: args.dryRun,
      logger,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.saved || 'dryRun' in result ? 0 : 1;
  }

  const report = await reconcileMislabelBlock({ db, sonarr, dryRun: args.dryRun, logger });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

// Run only as a script (a test may import parseMislabelBlockArgs).
if (process.argv[1]?.endsWith('mislabel-block.ts')) {
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
