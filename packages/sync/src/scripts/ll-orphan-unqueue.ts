// Issue #735 / DESIGN-028 amendment 2026-10-06 — the one-off ORPHAN LAZYLIBRARIAN WANT repair (not a sync mode):
//
//   tsx ll-orphan-unqueue.ts --dry-run|--apply [--keep=<id>:<format>[,...]]
//
// Before the LazyLibrarian Release existed, a want the app abandoned, parked or re-pointed left its LazyLibrarian book
// `Wanted`, and LazyLibrarian searched it every day (22 such books on 2026-10-06). This finds every LazyLibrarian format
// that reads `Wanted`, is not held, and that no live request asks for (the Orphan LazyLibrarian Want census, T-284), and
// sends it back to `Skipped` through the domain's confined `unqueueBook` (`unqueueOrphanLlWants`). Nothing is written to
// the app database and nothing to LazyLibrarian's own database: LazyLibrarian's API only.
//
// The keep list names books a person queued by hand on purpose (default: the English records re-wanted by the
// 2026-10-05 F10 sweep to replace foreign copies, see `F10_HAND_REWANTS`); they are listed, never unqueued.
// `--dry-run` reads only (the database and one `getAllBooks`) and prints every format it would unqueue. Idempotent: a
// second `--apply` finds only the kept ones.
//
// Env: DATABASE_URL, LAZYLIBRARIAN_API_KEY (LAZYLIBRARIAN_URL defaults in-cluster).
import { getPool } from '@hnet/db';
import { lazyLibrarianBundleFromEnv, llSnapshotUsable, unqueueOrphanLlWants } from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage: ll-orphan-unqueue.ts --dry-run|--apply [--keep=<id>:<format>[,...]]

  --dry-run   list every orphan LazyLibrarian format it would send back to Skipped (reads only)
  --apply     send them back to Skipped (LazyLibrarian unqueueBook); a second run changes nothing
  --keep      leave these <LazyLibrarian id>:<ebook|audiobook> alone (default: the 2026-10-05 F10 hand re-wants)

Env: DATABASE_URL, LAZYLIBRARIAN_API_KEY (LAZYLIBRARIAN_URL defaults in-cluster).`;

/**
 * The English LazyLibrarian records the 2026-10-05 F10 sweep re-wanted by hand to replace foreign copies it removed from
 * the library (HANDOFF, "final F10 sweep" and "the leftovers are closed"). No request names some of them, so they read
 * as orphans; they are deliberate, and stay wanted until LazyLibrarian grabs them.
 */
export const F10_HAND_REWANTS = [
  '-2R-EAAAQBAJ:ebook', // Solitaire
  'mPGNzQEACAAJ:ebook', // Israel Potter
  'BL6LDQAAQBAJ:ebook', // Dead or Alive
  'FOqzEAAAQBAJ:audiobook', // Murtagh
  'GGcbzgEACAAJ:audiobook', // The Other Emily
  'K0UczgEACAAJ:audiobook', // Divergent
  'Tm-rzwEACAAJ:audiobook', // Queen Charlotte
  '2TEPAAAAQBAJ:audiobook', // Roverandom
  'PyRvEAAAQBAJ:audiobook', // These Infinite Threads
  'd-DrEAAAQBAJ:audiobook', // Chain of Thorns
  'Nlf8EAAAQBAJ:audiobook', // Katabasis
] as const;

export interface LlOrphanUnqueueArgs {
  apply: boolean;
  keep: string[];
}

export function parseLlOrphanUnqueueArgs(argv: readonly string[]): LlOrphanUnqueueArgs | 'help' {
  let mode: 'dry' | 'apply' | null = null;
  let keep: string[] = [...F10_HAND_REWANTS];
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg.startsWith('--keep=')) {
      keep = arg
        .slice('--keep='.length)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const k of keep) {
        if (!/^[^:\s]+:(ebook|audiobook)$/.test(k)) throw new Error(`--keep entry "${k}" is not <id>:<ebook|audiobook>`);
      }
      continue;
    }
    if (arg !== '--dry-run' && arg !== '--apply') throw new Error(`unknown argument "${arg}"`);
    const next = arg === '--apply' ? 'apply' : 'dry';
    if (mode !== null && mode !== next) throw new Error('--dry-run and --apply are exclusive');
    mode = next;
  }
  if (mode === null) throw new Error('one of --dry-run or --apply is required');
  return { apply: mode === 'apply', keep };
}

async function main(): Promise<number> {
  const logger = createConsoleLogger();
  let args: LlOrphanUnqueueArgs | 'help';
  try {
    args = parseLlOrphanUnqueueArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`ll-orphan-unqueue: ${(error as Error).message}\n\n${USAGE}`);
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
  const ll = lazyLibrarianBundleFromEnv();
  const snapshot = await ll.read.getAllBookStatuses();
  // An LL error answer parses to an empty map: decide nothing on it.
  if (!llSnapshotUsable(snapshot)) {
    logger.error('LazyLibrarian getAllBooks came back empty; nothing decided');
    return 1;
  }
  const report = await unqueueOrphanLlWants({
    ll,
    snapshot,
    keep: new Set(args.keep),
    dryRun: !args.apply,
    log: logger,
  });
  const { rows, ...counts } = report;
  console.log(JSON.stringify({ ...counts, llBooks: snapshot.size }, null, 2));
  for (const row of rows) console.log(JSON.stringify(row));
  return report.failed > 0 ? 1 : 0;
}

// Run only as a script (tests import parseLlOrphanUnqueueArgs).
if (process.argv[1]?.endsWith('ll-orphan-unqueue.ts')) {
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
