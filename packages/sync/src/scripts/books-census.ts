// DESIGN-028 amendment 2026-10-06 — the Books Census (glossary T-289; issues #744 and #781). Observe-only:
//
//   tsx books-census.ts [--holds=<path|url>] [--no-app-db]
//
// Reads LazyLibrarian's database read-only and the books share read-only, and the app's Postgres through a read-only
// session; finds held files that are another book (the Held File Check, T-290), stale file pointers, non-English
// files held, non-English books wanted and non-English library tags (F10); logs one `books_census_finding` line per
// finding and one `books_census` line per run, which haynes-ops alerts on. It never writes to any source and never
// repairs what it finds.
//
//   --holds      where the Census Holds are (default: $BOOKS_CENSUS_HOLDS_URL, else ./.agents/books-census-holds.yaml)
//   --no-app-db  LazyLibrarian's side only (no wants, no library tags)
//
// Env: LL_DB_PATH (required), BOOKS_CENSUS_DATABASE_URL (falls back to OWED_CHECKS_DATABASE_URL, then DATABASE_URL),
// BOOKS_ROOT (default /data/cephfs-hdd/data/media/books).
//
// Exit 0 when the pass completed, whatever it found (findings are alerts, not job failures); 1 when LazyLibrarian's
// database cannot be read; 2 on bad arguments.
import { createConsoleLogger } from '../logger';
import { runCensusPass } from '../books-census/run';

export interface BooksCensusArgs {
  holds: string;
  appDb: boolean;
}

export function parseBooksCensusArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): BooksCensusArgs {
  const args: BooksCensusArgs = {
    holds: env.BOOKS_CENSUS_HOLDS_URL || '.agents/books-census-holds.yaml',
    appDb: true,
  };
  for (const arg of argv) {
    const [flag, value] = arg.split(/=(.*)/s, 2) as [string, string | undefined];
    if (flag === '--no-app-db' && value === undefined) args.appDb = false;
    else if (flag === '--holds' && value) args.holds = value;
    else throw new Error(`unknown or malformed argument: ${arg}`);
  }
  return args;
}

export async function main(): Promise<number> {
  const log = createConsoleLogger();
  let args: BooksCensusArgs;
  try {
    args = parseBooksCensusArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const llDbPath = process.env.LL_DB_PATH;
  if (!llDbPath) {
    log.error('books_census_failed', { error: 'LL_DB_PATH is not set' });
    return 1;
  }
  const databaseUrl = args.appDb
    ? process.env.BOOKS_CENSUS_DATABASE_URL ||
      process.env.OWED_CHECKS_DATABASE_URL ||
      process.env.DATABASE_URL
    : undefined;
  try {
    await runCensusPass(
      {
        llDbPath,
        ...(databaseUrl ? { databaseUrl } : {}),
        holds: args.holds,
        booksRoot: process.env.BOOKS_ROOT || '/data/cephfs-hdd/data/media/books',
      },
      log,
    );
    return 0;
  } catch (error) {
    log.error('books_census_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

// Run only as a script (tests import parseBooksCensusArgs).
if (process.argv[1]?.endsWith('books-census.ts')) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
