// ADR-096 / DESIGN-052 D-27 — the one-off TITLE EXCLUSION BACKFILL (not a sync mode):
//
//   tsx title-exclusion-backfill.ts --dry-run|--apply
//
// Adds a Radarr (by tmdb id) or Sonarr (by tvdb id) import-list exclusion for every title the ledger records as deleted
// through Trash, so Kometa and the *arrs' own import lists never add it again (the owner's ruling of 2026-10-03). It
// leaves out a title the *arr has in its library now (re-added since; the owner decides those separately, and they are
// listed by name) and one already excluded. `--dry-run` only reads (the ledger, `GET /movie`, `GET /series` and each
// exclusion list) and prints the counts; `--apply` writes the rest through the domain's single writer, 25 titles per
// transaction, each read back and audited in `trash_title_exclusions`. Idempotent: a second `--apply` writes nothing.
//
// Env: DATABASE_URL, RADARR_API_KEY, SONARR_API_KEY (RADARR_URL / SONARR_URL default in-cluster).
import { getPool } from '@hnet/db';
import { backfillTitleExclusions, titleExclusionArrClientsFromEnv } from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage: title-exclusion-backfill.ts --dry-run|--apply

  --dry-run  count what would be excluded, per *arr, and list the titles left out (reads only)
  --apply    write the exclusions (read back, audited); a second run writes nothing

Env: DATABASE_URL, RADARR_API_KEY, SONARR_API_KEY (RADARR_URL / SONARR_URL default in-cluster).`;

export function parseTitleExclusionBackfillArgs(argv: readonly string[]): { apply: boolean } | 'help' {
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
    args = parseTitleExclusionBackfillArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`title-exclusion-backfill: ${(error as Error).message}\n\n${USAGE}`);
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
  const report = await backfillTitleExclusions({
    arr: titleExclusionArrClientsFromEnv(),
    apply: args.apply,
    logger,
  });
  console.log(JSON.stringify(report, null, 2));
  return report.radarr.failed !== null || report.sonarr.failed !== null ? 1 : 0;
}

// Run only as a script (tests import parseTitleExclusionBackfillArgs).
if (process.argv[1]?.endsWith('title-exclusion-backfill.ts')) {
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
