// DESIGN-008 D-03 (2026-11-13) — the one-off household watch-history backfill (not a sync mode):
//
//   tsx watch-history-backfill.ts --dry-run|--apply
//
// Pages each configured Tautulli history (page size 500, cap 158) and, on a finished read, stores
// the household play count for every live movie and show that already has a metadata row. A title
// with a usable id and no joined play is stored as 0; one with no usable id stays null. An incomplete read writes nothing and exits 1. No Tautulli
// instance configured exits 2 and writes nothing. Idempotent: a second --apply writes no household
// row when the stored watch columns already match.
//
// Measured 2026-11-13: the largest grouped history was 39,010 rows (79 pages of 500) and one
// get_metadata call took 18 ms. Expect about two minutes when the rating-key match table misses;
// the history walk itself is about half a minute. Do not run this until the image that contains
// it is the one serving haynesnetwork-main.
//
// Env: DATABASE_URL, and the same Tautulli keys the metadata refresh uses. The report is household
// counts and per-instance oldest/newest instants. It names no account and no title.
import { db, getPool } from '@hnet/db';
import { resolveTautulliInstances } from '@hnet/arr';
import { TautulliClient } from '@hnet/arr/read';
import { createConsoleLogger } from '../logger';
import { backfillWatchHistory } from '../watch-history-backfill';

const USAGE = `Usage: watch-history-backfill.ts --dry-run|--apply

  --dry-run  page each Tautulli history and print the household counts (writes nothing)
  --apply    store play_count 0 for an identifiable live movie or show with no joined play, and the
             summed plays for one that has them. Refuses to write when the read is
             incomplete. A second run writes nothing.

Env: DATABASE_URL and the Tautulli instance keys (TAUTULLI_API_KEY,
TAUTULLI_K8PLEX_API_KEY, TAUTULLI_HAYNESTOWER_API_KEY + TAUTULLI_HAYNESTOWER_URL).`;

export function parseWatchHistoryBackfillArgs(
  argv: readonly string[],
): { apply: boolean } | 'help' {
  let mode: 'dry' | 'apply' | null = null;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg !== '--dry-run' && arg !== '--apply') throw new Error(`unknown argument "${arg}"`);
    const next = arg === '--apply' ? 'apply' : 'dry';
    if (mode !== null && mode !== next) throw new Error('--dry-run and --apply are exclusive');
    mode = next;
  }
  if (mode === null) throw new Error('one of --dry-run or --apply is required');
  return { apply: mode === 'apply' };
}

async function main(): Promise<number> {
  const logger = createConsoleLogger();
  let args: { apply: boolean } | 'help';
  try {
    args = parseWatchHistoryBackfillArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`watch-history-backfill: ${(error as Error).message}\n\n${USAGE}`);
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
  const configured = resolveTautulliInstances();
  if (configured.length === 0) {
    logger.error('watch-history-backfill: no Tautulli instance is configured');
    return 2;
  }
  const tautulli = configured.map((inst) => ({
    slug: inst.slug,
    client: new TautulliClient({ baseUrl: inst.baseUrl, apiKey: inst.apiKey }),
  }));
  const report = await backfillWatchHistory({
    db,
    tautulli,
    apply: args.apply,
    logger,
  });
  console.log(JSON.stringify(report, null, 2));
  return report.complete ? 0 : 1;
}

// Run only as a script (tests import parseWatchHistoryBackfillArgs).
if (process.argv[1]?.endsWith('watch-history-backfill.ts')) {
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
