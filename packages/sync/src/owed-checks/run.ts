// DESIGN-053 D-04 / D-05 — one pass of the owed-check runner over the tracker at an instant. It logs one
// `owed_check_result` line per automated check it ran, one `owed_check` line per row, and one `owed_checks_run`
// summary; the haynes-ops Loki rules alert on those lines (DESIGN-053 D-06). It never writes to a source, and it never
// edits the tracker: a person or agent records the result there.
import type { SyncLogger } from '../logger';
import {
  combineResults,
  expandQuery,
  judge,
  rowTiming,
  type AutoVerdict,
  type CheckResult,
  type RowReport,
} from './evaluate';
import type { Sources } from './sources';
import type { OwedCheckTracker } from './tracker';

export interface RunOptions {
  now: number;
  /** null: report timing only and run no automated check (the GitHub Action, which cannot reach the data). */
  sources: Sources | null;
  log: SyncLogger;
  /** For the paths_exist condition; defaults to fs.existsSync. */
  pathExists?: (p: string) => boolean;
}

export interface RunSummary {
  rows: number;
  pending: number;
  overdue: number;
  evaluated: number;
  verdicts: Record<string, number>;
  reports: RowReport[];
}

const ERROR_TEXT_MAX = 300;

export async function runOwedChecks(
  tracker: OwedCheckTracker,
  opts: RunOptions,
): Promise<RunSummary> {
  const reports: RowReport[] = [];
  const verdicts: Record<string, number> = {};
  let evaluated = 0;

  for (const row of tracker.checks) {
    const timing = rowTiming(row, opts.now);
    let verdict: AutoVerdict;
    if (!timing.evaluable || !row.auto) {
      verdict = timing.idleVerdict ?? 'manual';
    } else if (!opts.sources) {
      verdict = 'skipped';
    } else {
      evaluated += 1;
      const results: CheckResult[] = [];
      for (const check of row.auto) {
        const at = check.at ? Date.parse(check.at) : opts.now;
        const base = { id: row.id, check: check.name, source: check.source };
        if (at > opts.now) {
          results.push('wait');
          opts.log.info('owed_check_result', {
            ...base,
            result: 'wait',
            unmet: [`evaluates at ${check.at}`],
          });
          continue;
        }
        try {
          const obs = await opts.sources.run({
            source: check.source,
            query: expandQuery(check.query, row, at, check),
            at,
          });
          const j = judge(check, obs, opts.pathExists);
          results.push(j.result);
          opts.log.info('owed_check_result', {
            ...base,
            result: j.result,
            unmet: j.unmet,
            observed: j.observed,
          });
        } catch (error) {
          results.push('error');
          const message = (error instanceof Error ? error.message : String(error)).slice(
            0,
            ERROR_TEXT_MAX,
          );
          opts.log.info('owed_check_result', { ...base, result: 'error', error: message });
        }
      }
      verdict = combineResults(results);
    }

    verdicts[verdict] = (verdicts[verdict] ?? 0) + 1;
    const report: RowReport = {
      id: row.id,
      ...(row.legacy ? { legacy: row.legacy } : {}),
      title: row.title,
      owner: row.owner,
      status: row.status,
      due: row.due,
      overdue: timing.overdue,
      overdueHours: timing.overdueHours,
      auto: verdict,
    };
    reports.push(report);
    if (row.status === 'pending') {
      opts.log.info('owed_check', { ...report, autoCovers: row.auto_covers ?? null });
    }
  }

  const pending = reports.filter((r) => r.status === 'pending').length;
  const overdue = reports.filter((r) => r.overdue).length;
  opts.log.info('owed_checks_run', { rows: reports.length, pending, overdue, evaluated, verdicts });
  return { rows: reports.length, pending, overdue, evaluated, verdicts, reports };
}
