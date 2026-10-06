// DESIGN-053 D-03..D-05 — the pure half of the owed-check runner: a row's timing at a given instant, a query's
// placeholders, how one automated check's observation is judged against its `expect`, and how a row's checks combine.
// No I/O here except the injectable path test.
import { existsSync } from 'node:fs';
import type { OwedAutoCheck, OwedCheckRow } from './tracker';

/** One automated check's outcome. `wait`: what it waits for has not happened; `error`: it could not be evaluated. */
export type CheckResult = 'pass' | 'fail' | 'wait' | 'error';

/** A row's automated verdict: a combined CheckResult, or why nothing ran. */
export type AutoVerdict = CheckResult | 'manual' | 'not_yet' | 'closed' | 'skipped';

/** What a source returned: SQL rows, or one number from a metric query. */
export type Observation =
  { kind: 'rows'; rows: Record<string, unknown>[] } | { kind: 'value'; value: number };

export interface Judgement {
  result: Exclude<CheckResult, 'error'>;
  /** The conditions that did not hold, in words (empty on a pass). */
  unmet: string[];
  /** A short, loggable view of what was observed. */
  observed: Record<string, unknown>;
}

const MAX_SINCE_SECONDS = 30 * 24 * 3600;
const SAMPLE_ROWS = 5;

/** The instant a check looks back to: its own `since`, else the row's `not_before`, else the day it was opened. */
export function checkSince(row: OwedCheckRow, check?: Pick<OwedAutoCheck, 'since'>): number {
  return Date.parse(check?.since ?? row.not_before ?? `${row.opened}T00:00:00Z`);
}

/**
 * Expand a query's placeholders. `$SINCE` becomes a LogQL/PromQL range from `checkSince` to the evaluation instant
 * (at least a minute, at most 30 days), so a check counts only what happened after its event.
 */
export function expandQuery(
  query: string,
  row: OwedCheckRow,
  evalAt: number,
  check?: Pick<OwedAutoCheck, 'since'>,
): string {
  if (!query.includes('$SINCE')) return query;
  const seconds = Math.min(
    MAX_SINCE_SECONDS,
    Math.max(60, Math.ceil((evalAt - checkSince(row, check)) / 1000)),
  );
  return query.replaceAll('$SINCE', `${seconds}s`);
}

export interface RowTiming {
  overdue: boolean;
  /** Whole hours past `due` for an overdue row, else null. */
  overdueHours: number | null;
  /** True when the automated checks should run now (pending, has `auto`, `not_before` reached). */
  evaluable: boolean;
  /** The verdict when nothing runs: closed, manual or not yet. Null when the row is evaluable. */
  idleVerdict: AutoVerdict | null;
}

export function rowTiming(row: OwedCheckRow, now: number): RowTiming {
  if (row.status !== 'pending') {
    return { overdue: false, overdueHours: null, evaluable: false, idleVerdict: 'closed' };
  }
  const due = Date.parse(row.due);
  const overdue = now > due;
  const overdueHours = overdue ? Math.floor((now - due) / 3_600_000) : null;
  if (!row.auto) return { overdue, overdueHours, evaluable: false, idleVerdict: 'manual' };
  if (row.not_before && now < Date.parse(row.not_before)) {
    return { overdue, overdueHours, evaluable: false, idleVerdict: 'not_yet' };
  }
  return { overdue, overdueHours, evaluable: true, idleVerdict: null };
}

/** fail > error > wait > pass: one failing check fails the row, an unreadable one hides a pass. */
export function combineResults(results: readonly CheckResult[]): CheckResult {
  for (const r of ['fail', 'error', 'wait'] as const) if (results.includes(r)) return r;
  return 'pass';
}

function toNumberish(v: unknown): number | string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
}

function firstCell(rows: Record<string, unknown>[]): unknown {
  const first = rows[0];
  return first ? Object.values(first)[0] : undefined;
}

function compact(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] =
      typeof v === 'string' && v.length > 160
        ? `${v.slice(0, 157)}...`
        : typeof v === 'bigint'
          ? Number(v)
          : v;
  }
  return out;
}

/** Judge one observation against a check's `expect`. A mismatch is a `fail` or a `wait` as the check says. */
export function judge(
  check: Pick<OwedAutoCheck, 'expect' | 'mismatch'>,
  obs: Observation,
  pathExists: (p: string) => boolean = existsSync,
): Judgement {
  const e = check.expect;
  const unmet: string[] = [];
  const observed: Record<string, unknown> = {};

  let value: number | string | null;
  if (obs.kind === 'rows') {
    const n = obs.rows.length;
    observed.rows = n;
    observed.sample = obs.rows.slice(0, SAMPLE_ROWS).map(compact);
    if (e.rows !== undefined && n !== e.rows) unmet.push(`rows ${n} != ${e.rows}`);
    if (e.min_rows !== undefined && n < e.min_rows) unmet.push(`rows ${n} < ${e.min_rows}`);
    if (e.max_rows !== undefined && n > e.max_rows) unmet.push(`rows ${n} > ${e.max_rows}`);
    if (e.paths_exist) {
      const paths = obs.rows
        .map((r) => Object.values(r)[0])
        .filter((p): p is string => typeof p === 'string' && p.trim() !== '');
      const missing = paths.filter((p) => !pathExists(p));
      observed.paths = paths.length;
      observed.missing = missing.slice(0, SAMPLE_ROWS);
      if (missing.length > 0) unmet.push(`${missing.length} of ${paths.length} paths missing`);
    }
    value = toNumberish(firstCell(obs.rows));
  } else {
    value = obs.value;
    observed.value = obs.value;
  }

  if (e.eq !== undefined || e.min !== undefined || e.max !== undefined) {
    if (obs.kind === 'rows') observed.value = value;
    if (e.eq !== undefined) {
      const same =
        typeof e.eq === 'number'
          ? typeof value === 'number' && value === e.eq
          : String(value) === e.eq;
      if (!same) unmet.push(`value ${JSON.stringify(value)} != ${JSON.stringify(e.eq)}`);
    }
    if (e.min !== undefined && !(typeof value === 'number' && value >= e.min)) {
      unmet.push(`value ${JSON.stringify(value)} < ${e.min}`);
    }
    if (e.max !== undefined && !(typeof value === 'number' && value <= e.max)) {
      unmet.push(`value ${JSON.stringify(value)} > ${e.max}`);
    }
  }

  const result = unmet.length === 0 ? 'pass' : check.mismatch === 'wait' ? 'wait' : 'fail';
  return { result, unmet, observed };
}

/** A pending row's state for the reports (one per row, every run). */
export interface RowReport {
  id: string;
  legacy?: string;
  title: string;
  owner: string;
  status: OwedCheckRow['status'];
  due: string;
  overdue: boolean;
  overdueHours: number | null;
  auto: AutoVerdict;
}

/** The GitHub issue body: the overdue rows first, then what is pending and not yet due. */
export function renderMarkdown(reports: readonly RowReport[], now: number): string {
  const pending = reports.filter((r) => r.status === 'pending');
  const overdue = pending.filter((r) => r.overdue);
  const waiting = pending.filter((r) => !r.overdue);
  const cell = (s: string) => s.replaceAll('|', '\\|');
  const line = (r: RowReport, late: string | null) =>
    `| ${r.id} | ${r.legacy ?? ''} | ${cell(r.title)} | ${r.due} |${late === null ? '' : ` ${late} |`} ${cell(r.owner)} |`;
  const overdueHead =
    '| Id | Was | Check | Due (UTC) | Late by | Owner |\n|---|---|---|---|---|---|';
  const waitingHead = '| Id | Was | Check | Due (UTC) | Owner |\n|---|---|---|---|---|';
  const out = [
    `<!-- owed-checks-overdue: ${overdue.map((r) => r.id).join(',')} -->`,
    `Evaluated ${new Date(now).toISOString().slice(0, 16)}Z from \`.agents/owed-checks.yaml\` on main (DESIGN-053).`,
    '',
    `## Overdue (${overdue.length})`,
    '',
  ];
  if (overdue.length === 0) out.push('None.');
  else out.push(overdueHead, ...overdue.map((r) => line(r, `${r.overdueHours ?? 0} h`)));
  out.push('', `## Pending, not yet due (${waiting.length})`, '');
  if (waiting.length === 0) out.push('None.');
  else out.push(waitingHead, ...waiting.map((r) => line(r, null)));
  out.push(
    '',
    'To clear a row, record its result in `.agents/owed-checks.yaml` (`status` and a dated `evidence` line) and merge,',
    'or move its `due` with an evidence line that says why. This issue updates itself every hour and closes when',
    'nothing is overdue. The automated results are in Loki (`owed_check` and `owed_check_result` lines from the',
    'in-cluster runner, namespace `downloads`); this Action cannot reach the data.',
  );
  return out.join('\n');
}
