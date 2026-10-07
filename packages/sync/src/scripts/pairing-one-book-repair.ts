// Issue #825 / DESIGN-036 — scoped retained-series park repair. No book-server or acquisition calls.
// After a forced chapter census, name the exact expected book and park; dry-run first, then apply.
import { getPool } from '@hnet/db';
import {
  repairOneBookPairingPark,
  withRequestEventScope,
  type OneBookParkRepairInput,
} from '@hnet/domain';

const USAGE = `Usage: pairing-one-book-repair.ts --dry-run|--apply --request-id=<uuid> --expected-park=multi_book|no_book --expected-title=<title> --expected-author=<author>
Env: DATABASE_URL. Reads current mirror chapters and pairs; applies only through the guarded domain writer.`;

export function parseOneBookRepairArgs(
  argv: readonly string[],
): 'help' | Omit<OneBookParkRepairInput, 'db' | 'now'> {
  if (argv.includes('--help') || argv.includes('-h')) return 'help' as const;
  const values = new Map<string, string>();
  let mode: 'dry-run' | 'apply' | null = null;
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '--apply') {
      if (mode !== null) throw new Error('choose exactly one of --dry-run or --apply');
      mode = arg === '--apply' ? 'apply' : 'dry-run';
      continue;
    }
    const equal = arg.indexOf('=');
    const key = arg.slice(0, equal);
    if (
      equal < 0 ||
      !['--request-id', '--expected-park', '--expected-title', '--expected-author'].includes(key) ||
      values.has(key)
    )
      throw new Error(`unknown or repeated argument: ${key}`);
    values.set(key, arg.slice(equal + 1));
  }
  const requestId = values.get('--request-id') ?? '';
  const expectedPark = values.get('--expected-park');
  const expectedTitle = values.get('--expected-title')?.trim() ?? '';
  const expectedAuthor = values.get('--expected-author')?.trim() ?? '';
  if (
    !mode ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ||
    (expectedPark !== 'multi_book' && expectedPark !== 'no_book') ||
    !expectedTitle ||
    !expectedAuthor
  )
    throw new Error('mode, request id, allowed park, expected title and author are required');
  return { requestId, expectedPark, expectedTitle, expectedAuthor, dryRun: mode === 'dry-run' };
}

let poolStarted = false;

async function main(): Promise<number> {
  const args = parseOneBookRepairArgs(process.argv.slice(2));
  if (args === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  getPool();
  poolStarted = true;
  const report = await withRequestEventScope(
    { actor: 'repair', site: 'pairing-one-book-repair' },
    () => repairOneBookPairingPark(args),
  );
  console.log(JSON.stringify({ dryRun: args.dryRun, ...report }));
  return report.eligible ? 0 : 1;
}

if (process.argv[1]?.endsWith('pairing-one-book-repair.ts')) {
  main()
    .then(async (code) => {
      if (poolStarted) await getPool().end();
      process.exit(code);
    })
    .catch(async (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      if (poolStarted) {
        await getPool()
          .end()
          .catch(() => {});
      }
      process.exit(1);
    });
}
