// DESIGN-053 — the owed-check runner (agent tooling, not a sync mode):
//
//   tsx owed-checks.ts [--tracker=<path|url>] [--no-data] [--markdown=<path>] [--now=<UTC instant>]
//
// Reads the Owed Check tracker (`.agents/owed-checks.yaml`; the CronJob reads main from GitHub), works out which pending
// rows are overdue, runs the automated read-only checks of the rows whose `not_before` has passed, and logs one JSON line
// per check, per row and per run (DESIGN-053 D-05). haynes-ops alerts on those lines. It never writes to a source and
// never edits the tracker.
//
//   --tracker    where to read the tracker (default: $OWED_CHECKS_URL, else ./.agents/owed-checks.yaml)
//   --no-data    timing only: no source is opened (the GitHub Action, which maintains the overdue issue)
//   --markdown   also write the overdue report there (the GitHub issue body)
//   --now        evaluate as of this instant (tests and dry runs)
//
// Env (each source is optional; a check whose source is missing reports `error`):
//   OWED_CHECKS_DATABASE_URL  app Postgres, pointed at the read-only service (falls back to DATABASE_URL)
//   LL_DB_PATH                LazyLibrarian's database file (mounted from its PVC; opened mode=ro)
//   LOKI_URL, PROMETHEUS_URL  in-cluster query APIs
//
// Exit 0 when the pass completed, whatever the checks found (findings are alerts, not job failures); 1 when the tracker
// could not be read or is invalid; 2 on bad arguments.
import { writeFile } from 'node:fs/promises';
import { createConsoleLogger } from '../logger';
import { renderMarkdown } from '../owed-checks/evaluate';
import { runOwedChecks } from '../owed-checks/run';
import { createSources } from '../owed-checks/sources';
import { loadTrackerText, parseTracker } from '../owed-checks/tracker';

export interface OwedChecksArgs {
  tracker: string;
  noData: boolean;
  markdown: string | null;
  now: number;
}

export function parseOwedChecksArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): OwedChecksArgs {
  const args: OwedChecksArgs = {
    tracker: env.OWED_CHECKS_URL || '.agents/owed-checks.yaml',
    noData: false,
    markdown: null,
    now: Date.now(),
  };
  for (const arg of argv) {
    const [flag, value] = arg.split(/=(.*)/s, 2) as [string, string | undefined];
    if (flag === '--no-data' && value === undefined) args.noData = true;
    else if (flag === '--tracker' && value) args.tracker = value;
    else if (flag === '--markdown' && value) args.markdown = value;
    else if (flag === '--now' && value && !Number.isNaN(Date.parse(value)))
      args.now = Date.parse(value);
    else throw new Error(`unknown or malformed argument: ${arg}`);
  }
  return args;
}

export async function main(): Promise<number> {
  const log = createConsoleLogger();
  let args: OwedChecksArgs;
  try {
    args = parseOwedChecksArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  let tracker;
  try {
    tracker = parseTracker(await loadTrackerText(args.tracker));
  } catch (error) {
    log.error('owed_checks_run_failed', {
      tracker: args.tracker,
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }

  const sources = args.noData
    ? null
    : createSources({
        databaseUrl: process.env.OWED_CHECKS_DATABASE_URL || process.env.DATABASE_URL,
        llDbPath: process.env.LL_DB_PATH,
        lokiUrl: process.env.LOKI_URL,
        prometheusUrl: process.env.PROMETHEUS_URL,
      });
  try {
    const summary = await runOwedChecks(tracker, { now: args.now, sources, log });
    if (args.markdown)
      await writeFile(args.markdown, `${renderMarkdown(summary.reports, args.now)}\n`);
    return 0;
  } finally {
    await sources?.close();
  }
}

// Run only as a script (tests import parseOwedChecksArgs).
if (process.argv[1]?.endsWith('owed-checks.ts')) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
