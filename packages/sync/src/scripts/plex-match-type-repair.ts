// ADR-123 / DESIGN-025 D-10 — remove media_plex_matches rows whose Plex library type does not fit the
// ledger kind. Dry-run is the default path to inspect; apply deletes only those rows, through the
// domain writer. It does not read or write Plex.
import { getPool } from '@hnet/db';
import {
  repairCrossTypePlexMatches,
  type CrossTypePlexMatchRepairReport,
} from '@hnet/domain';

/** One readable line per selected row: title, year, kind, and server library. */
export function formatCrossTypeRepairReport(report: CrossTypePlexMatchRepairReport): string {
  const lines = report.titles.map((row) => {
    const year = row.year === null ? '' : String(row.year);
    const library = `${row.serverSlug}/${row.libraryName}`;
    return [row.title, year, row.arrKind, library].join('\t');
  });
  const summary = {
    dryRun: report.dryRun,
    selected: report.selected,
    removed: report.removed,
    groups: report.groups,
  };
  return [...lines, JSON.stringify(summary)].join('\n');
}

const USAGE = `Usage: plex-match-type-repair.ts --dry-run|--apply
Env: DATABASE_URL. Selects rows where the library type is not radarr/movie, sonarr/show or lidarr/artist.
--dry-run writes nothing. --apply deletes exactly those rows. A second apply deletes nothing.`;

export function parseCrossTypeRepairArgs(argv: readonly string[]): 'help' | { dryRun: boolean } {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  const modes = argv.filter((arg) => arg === '--dry-run' || arg === '--apply');
  if (modes.length !== 1 || argv.length !== 1) {
    throw new Error('choose exactly one of --dry-run or --apply');
  }
  return { dryRun: modes[0] === '--dry-run' };
}

let poolStarted = false;

async function main(): Promise<number> {
  const args = parseCrossTypeRepairArgs(process.argv.slice(2));
  if (args === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  getPool();
  poolStarted = true;
  const report = await repairCrossTypePlexMatches({ dryRun: args.dryRun });
  console.log(formatCrossTypeRepairReport(report));
  return 0;
}

if (process.argv[1]?.endsWith('plex-match-type-repair.ts')) {
  main()
    .then(async (code) => {
      if (poolStarted) await getPool().end();
      process.stdout.write('', () => process.exit(code));
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
