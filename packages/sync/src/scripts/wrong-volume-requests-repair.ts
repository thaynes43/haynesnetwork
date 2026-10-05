// Issue #693 / DESIGN-028 amendment 2026-10-05 — the one-off WRONG-VOLUME REQUESTS REPAIR (not a sync mode):
//
//   tsx wrong-volume-requests-repair.ts --dry-run|--apply
//
// Repairs the requests pinned to another volume's or work's LazyLibrarian book, through the domain's single writers
// (`repairWrongVolumeRequests`): pairing wants on a live anchor get the identity check the hourly mint now runs;
// collection wants on another work's book are parked `wrong_volume` (the two BBC Radio Drama Collection rows that
// could re-queue "Terry Pratchett's Discworld"); goodreads wants on another work's book are re-pointed to the shelf's
// current volume or settled; the two Mistborn sequel wants on removed anchors are settled; the four Chroniken wants
// another repair parked by hand are brought to the state the single writers leave a park in. `--dry-run` reads only (the
// database and one `getAllBooks`) and prints every row it would change; `--apply` writes them. Nothing is written to
// LazyLibrarian. Rows pointing at a `--skip-ll` id are left alone (default: ik6xzgEACAAJ, the record the 2026-10-05
// cross-volume repair owns). Idempotent: a second `--apply` changes nothing.
//
// Env: DATABASE_URL, LAZYLIBRARIAN_API_KEY (LAZYLIBRARIAN_URL defaults in-cluster).
import { getPool } from '@hnet/db';
import {
  lazyLibrarianBundleFromEnv,
  llSnapshotUsable,
  repairWrongVolumeRequests,
} from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage: wrong-volume-requests-repair.ts --dry-run|--apply [--skip-ll=<id>[,<id>...]]

  --dry-run   list every request the repair would change (reads only)
  --apply     change them through the single writers; a second run changes nothing
  --skip-ll   leave rows pointing at these LazyLibrarian ids alone (default: ik6xzgEACAAJ)

Env: DATABASE_URL, LAZYLIBRARIAN_API_KEY (LAZYLIBRARIAN_URL defaults in-cluster).`;

/** The 2026-10-05 cross-volume repair owns this record (the German Chroniken der Unterwelt omnibus). */
const DEFAULT_SKIP_LL = ['ik6xzgEACAAJ'];

/**
 * Issue #693's two pairing wants on removed Kavita anchors ("Mistborn: Wax & Wayne", "Mistborn: Secret History"),
 * each with the id it must still hold ("Mistborn: The Final Empire", reused through the old subtitle-cutting key).
 */
export const REMOVED_ANCHOR_WANTS = [
  { requestId: '3d1c1aca-f4e8-4fe8-b624-ce3f324f5a72', llBookId: 't_ZYYXZq4RgC' },
  { requestId: 'f35dc888-d282-4d0b-8728-3e42e286106f', llBookId: 't_ZYYXZq4RgC' },
] as const;

/**
 * The four Chroniken der Unterwelt pairing wants the 2026-10-05 cross-volume repair parked `wrong_volume` with a direct
 * write (their German omnibus `ik6xzgEACAAJ`, F10 English-only). Conformed through the domain writer: still parked, no
 * id, and a missing format that no longer reads `landed`/`wanted` from the omnibus.
 */
export const HAND_PARKED_WANTS = [
  'c0afcc7e-bcdb-4cd4-af18-2a3bd7296b4a',
  '525913ff-7199-406c-8806-3a3785d659e5',
  'ca08224a-b1ac-4781-ae36-cfe522cea3e8',
  'aec71b5a-3609-4470-b4e4-e728a9fa0502',
] as const;

export interface WrongVolumeRepairArgs {
  apply: boolean;
  skipLl: string[];
}

export function parseWrongVolumeRepairArgs(
  argv: readonly string[],
): WrongVolumeRepairArgs | 'help' {
  let mode: 'dry' | 'apply' | null = null;
  let skipLl = [...DEFAULT_SKIP_LL];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg.startsWith('--skip-ll=')) {
      skipLl = arg
        .slice('--skip-ll='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      continue;
    }
    if (arg !== '--dry-run' && arg !== '--apply') throw new Error(`unknown argument "${arg}"`);
    const next = arg === '--apply' ? 'apply' : 'dry';
    if (mode !== null && mode !== next) throw new Error('--dry-run and --apply are exclusive');
    mode = next;
  }
  if (mode === null) throw new Error('one of --dry-run or --apply is required');
  return { apply: mode === 'apply', skipLl };
}

async function main(): Promise<number> {
  const logger = createConsoleLogger();
  let args: WrongVolumeRepairArgs | 'help';
  try {
    args = parseWrongVolumeRepairArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`wrong-volume-requests-repair: ${(error as Error).message}\n\n${USAGE}`);
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
  const snapshot = await lazyLibrarianBundleFromEnv().read.getAllBookStatuses();
  // An LL error answer parses to an empty map, which would read every book as absent: decide nothing on it.
  if (!llSnapshotUsable(snapshot)) {
    logger.error('LazyLibrarian getAllBooks came back empty; nothing decided');
    return 1;
  }
  const report = await repairWrongVolumeRequests({
    snapshot,
    dryRun: !args.apply,
    skipLlBookIds: new Set(args.skipLl),
    removedAnchorWants: REMOVED_ANCHOR_WANTS,
    parkedPairingWants: HAND_PARKED_WANTS,
    log: logger,
  });
  const counts: Record<string, number> = {};
  for (const row of report.rows) {
    const key = `${row.origin}.${row.action}${row.applied ? '' : report.dryRun ? '' : '.not_applied'}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  console.log(JSON.stringify({ dryRun: report.dryRun, llBooks: snapshot.size, counts }, null, 2));
  for (const row of report.rows) console.log(JSON.stringify(row));
  return 0;
}

// Run only as a script (tests import parseWrongVolumeRepairArgs).
if (process.argv[1]?.endsWith('wrong-volume-requests-repair.ts')) {
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
