// ADR-117 / DESIGN-052 D-29 — one-off load of the release names from before the 2026-07-03 move.
//
//   tsx legacy-release-names-load.ts --dry-run --dir=<directory>
//   tsx legacy-release-names-load.ts --apply   --dir=<directory>
//
// The directory holds some or all of old-radarr-history.tsv, old-radarr-files.tsv, old-sonarr-history.tsv,
// old-sonarr-files.tsv and legacy-sab-full.tsv; a missing file is reported `absent`. --dry-run only reads the
// database. --apply inserts into legacy_release_names and legacy_download_jobs in one transaction; a second
// apply adds nothing. The files are never committed. The report holds counts and line numbers only.
//
// Env: DATABASE_URL only. No *arr or download client is called.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getPool } from '@hnet/db';
import {
  LEGACY_FILE_KINDS,
  LEGACY_FILE_NAMES,
  loadLegacyReleaseNames,
  type LegacyLoadFiles,
} from '@hnet/domain';
import { createConsoleLogger } from '../logger';

const USAGE = `Usage: legacy-release-names-load.ts --dry-run|--apply --dir=<directory>

  --dry-run      count what would be loaded (reads only)
  --apply        insert the rows (one transaction; a second apply adds nothing)
  --dir=<dir>    the directory holding the export files:
                 ${LEGACY_FILE_KINDS.map((k) => LEGACY_FILE_NAMES[k]).join(', ')}

Env: DATABASE_URL.`;

export interface LegacyLoadArgs {
  apply: boolean;
  dir: string;
}

export function parseLegacyLoadArgs(argv: readonly string[]): LegacyLoadArgs | 'help' {
  let mode: 'dry' | 'apply' | null = null;
  let dir: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--dry-run') mode = mode !== null && mode !== 'dry' ? badMode() : 'dry';
    else if (arg === '--apply') mode = mode !== null && mode !== 'apply' ? badMode() : 'apply';
    else if (arg.startsWith('--dir=')) dir = arg.slice('--dir='.length);
    else if (arg === '--dir') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error('--dir needs a directory');
      dir = next;
      i += 1;
    } else throw new Error(`unknown argument "${arg}"`);
  }
  if (mode === null) throw new Error('one of --dry-run or --apply is required');
  if (!dir) throw new Error('--dir is required');
  return { apply: mode === 'apply', dir };
}

function badMode(): never {
  throw new Error('--dry-run and --apply are exclusive');
}

/** The files present in `dir`, by kind; a kind whose file is missing is left out (reported `absent`). */
export function readLegacyLoadFiles(dir: string): LegacyLoadFiles {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('--dir is not a directory');
  const files: LegacyLoadFiles = {};
  for (const kind of LEGACY_FILE_KINDS) {
    const path = join(dir, LEGACY_FILE_NAMES[kind]);
    if (existsSync(path)) files[kind] = readFileSync(path, 'utf8');
  }
  return files;
}

async function main(): Promise<number> {
  const logger = createConsoleLogger();
  let args: LegacyLoadArgs | 'help';
  try {
    args = parseLegacyLoadArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`legacy-release-names-load: ${(error as Error).message}\n\n${USAGE}`);
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
  let files: LegacyLoadFiles;
  try {
    files = readLegacyLoadFiles(args.dir);
  } catch (error) {
    console.error(`legacy-release-names-load: ${(error as Error).message}`);
    return 2;
  }
  const report = await loadLegacyReleaseNames({ files, apply: args.apply, logger });
  console.log(JSON.stringify(report, null, 2));
  return 0;
}

if (process.argv[1]?.endsWith('legacy-release-names-load.ts')) {
  main()
    .then(async (code) => {
      await getPool()
        .end()
        .catch(() => {});
      process.stdout.write('', () => process.exit(code));
    })
    .catch(async (error: unknown) => {
      // The domain's errors carry counts, table, file kind and chunk only, never a line's content.
      console.error(error instanceof Error ? error.message : String(error));
      await getPool()
        .end()
        .catch(() => {});
      process.stdout.write('', () => process.exit(1));
    });
}
