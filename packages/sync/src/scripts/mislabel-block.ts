// ADR-110 C-04, C-05, ADR-113 / DESIGN-055 D-05, Q-10 ruling (PLAN-077 P4) — the Mislabel Block's in-cluster tool (not
// a sync mode):
//
//   tsx mislabel-block.ts list [--state active|expired|removed|all]
//   tsx mislabel-block.ts adopt --series <sonarr series id> (--group <g> | --pair "<SxxEyy title>" | --double <SxxEyyEzz>
//                               | --alias "<alternate title>") [--dry-run]
//   tsx mislabel-block.ts add-name --series <sonarr series id> (--pair ... | --double ... | --alias ...) [--dry-run]
//   tsx mislabel-block.ts reconcile [--dry-run]
//   tsx mislabel-block.ts offer --repair <repair request id> --group <release group>
//
// `list` prints the terms (default: active), each with its `kind` (`group`, `pair`, `double`, `alias`). `adopt` is
// ADR-110 C-05: a block of Case A's hand-made per-series profile becomes one Mislabel Block term (origin `adoption`),
// written and read back by the domain's single writer; a group with `--group`, a mislabelled name (ADR-113) with
// `--pair`, `--double` or `--alias`. `add-name` is ADR-113's staff path: one mislabelled-name term, origin `staff`.
// `--dry-run` prints the term either would write and writes nothing. The hand-made profile and its tag are then removed
// by hand with a read-back (PLAN-077 P4). `reconcile` expires terms past their 365 days and repairs the profile's drift,
// as the hourly `title-check` upkeep does; `--dry-run` reports the drift and writes nothing.
//
// Env: DATABASE_URL, SONARR_API_KEY (SONARR_URL defaults in-cluster). `list` needs only DATABASE_URL.
import { MISLABEL_TERM_STATES, db, getPool, type MislabelTermState } from '@hnet/db';
import {
  addMislabelNameTerm,
  addMislabelTermFromRemap,
  adoptMislabelTerm,
  listMislabelTerms,
  mislabelBlockSonarrFromEnv,
  reconcileMislabelBlock,
  type MislabelNameKind,
} from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage:
  mislabel-block.ts list [--state active|expired|removed|all]
  mislabel-block.ts adopt --series <sonarr series id> (--group <release group> | --pair "<SxxEyy title words>"
                          | --double <SxxEyyEzz> | --alias "<alternate title>") [--dry-run]
  mislabel-block.ts add-name --series <sonarr series id> (--pair "<SxxEyy title words>" | --double <SxxEyyEzz>
                             | --alias "<alternate title>") [--dry-run]
  mislabel-block.ts reconcile [--dry-run]
  mislabel-block.ts offer --repair <repair request id> --group <release group>

list only reads. adopt, add-name and reconcile write Sonarr's "mislabelled releases" profile (read back) unless
--dry-run. adopt moves one block of a hand-made profile in (origin adoption); add-name adds a mislabelled name as staff
(origin staff): --pair "S01E11 Secret Menu" (a number with another episode's title), --double S01E13E14, or --alias
with one of the show's alternate titles in Sonarr.
offer accepts the Mislabel offer of a completed shift re-map (a staff remap-run prints its mislabelGroups), as staff.`;

export type MislabelBlockArgs =
  | { command: 'list'; state: MislabelTermState | 'all' }
  | { command: 'adopt'; seriesId: number; group: string; dryRun: boolean }
  | {
      command: 'add-name';
      seriesId: number;
      kind: MislabelNameKind;
      name: string;
      /** `adoption` for `adopt` with a name flag, `staff` for `add-name`. */
      origin: 'staff' | 'adoption';
      dryRun: boolean;
    }
  | { command: 'reconcile'; dryRun: boolean }
  | { command: 'offer'; repairRequestId: string; group: string };

const NAME_FLAGS: Record<string, MislabelNameKind> = { '--pair': 'pair', '--double': 'double', '--alias': 'alias' };

/** Parse the command line (exported for a unit test). */
export function parseMislabelBlockArgs(argv: readonly string[]): MislabelBlockArgs | 'help' {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') return 'help';
  if (
    command !== 'list' &&
    command !== 'adopt' &&
    command !== 'add-name' &&
    command !== 'reconcile' &&
    command !== 'offer'
  ) {
    throw new Error(`unknown command "${command}"`);
  }
  let state: MislabelTermState | 'all' = 'active';
  let seriesId: number | undefined;
  let group: string | undefined;
  let name: { kind: MislabelNameKind; name: string } | undefined;
  let dryRun = false;
  let repairRequestId: string | undefined;
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
      case '--repair':
        if (!value || !/^[0-9a-f-]{36}$/i.test(value)) throw new Error('--repair needs the repair request id');
        repairRequestId = value.toLowerCase();
        i += 1;
        break;
      case '--pair':
      case '--double':
      case '--alias':
        if (!value || value.trim().length === 0 || value.startsWith('--')) {
          throw new Error(`${flag} needs the name, quoted`);
        }
        if (name !== undefined) throw new Error('give one of --pair, --double or --alias');
        name = { kind: NAME_FLAGS[flag]!, name: value.trim() };
        i += 1;
        break;
      default:
        throw new Error(`unknown argument "${flag}"`);
    }
  }
  if (command === 'list') {
    if (seriesId !== undefined || group !== undefined || name !== undefined || dryRun) {
      throw new Error('list takes only --state');
    }
    return { command, state };
  }
  if (command === 'adopt' || command === 'add-name') {
    if (repairRequestId !== undefined) throw new Error(`${command} takes no --repair`);
    if (seriesId === undefined) throw new Error(`${command} needs --series`);
    if (command === 'adopt' && group !== undefined && name === undefined) return { command, seriesId, group, dryRun };
    if (group !== undefined || name === undefined) {
      throw new Error(
        command === 'adopt'
          ? 'adopt needs one of --group, --pair, --double or --alias'
          : 'add-name needs one of --pair, --double or --alias',
      );
    }
    return {
      command: 'add-name',
      seriesId,
      kind: name.kind,
      name: name.name,
      origin: command === 'adopt' ? 'adoption' : 'staff',
      dryRun,
    };
  }
  if (name !== undefined) throw new Error(`${command} takes no --pair, --double or --alias`);
  if (command === 'offer') {
    if (repairRequestId === undefined || group === undefined || seriesId !== undefined || dryRun) {
      throw new Error('offer needs --repair and --group (and nothing else)');
    }
    return { command, repairRequestId, group };
  }
  if (seriesId !== undefined || group !== undefined || repairRequestId !== undefined) {
    throw new Error('reconcile takes only --dry-run');
  }
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

  if (args.command === 'add-name') {
    const result = await addMislabelNameTerm({
      db,
      sonarr,
      seriesId: args.seriesId,
      kind: args.kind,
      name: args.name,
      origin: args.origin,
      dryRun: args.dryRun,
      logger,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.saved || 'dryRun' in result ? 0 : 1;
  }

  if (args.command === 'offer') {
    const result = await addMislabelTermFromRemap({
      db,
      sonarr,
      repairRequestId: args.repairRequestId,
      releaseGroup: args.group,
      requesterId: null,
      requesterIsAdmin: true,
      logger,
    });
    console.log(JSON.stringify(result, null, 2));
    return result.saved ? 0 : 1;
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
      // Exit only once stdout has drained: a large JSON report piped through `kubectl exec` was cut at 64 KiB when
      // process.exit ran with the write still queued.
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
