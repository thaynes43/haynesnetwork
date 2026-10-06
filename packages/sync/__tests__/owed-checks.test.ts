// DESIGN-053 — the owed-check tracker and runner. The real tracker file must parse (a malformed row fails `test`, a
// required check); the evaluator, the read-only guards and the run loop are tested on fixtures. No database server:
// the SQL sources are stubbed, except one SQLite file opened through the real read-only ll-db source.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import type { SyncLogger } from '../src/logger';
import {
  combineResults,
  expandQuery,
  judge,
  renderMarkdown,
  rowTiming,
} from '../src/owed-checks/evaluate';
import { runOwedChecks } from '../src/owed-checks/run';
import {
  assertSingleSelect,
  createSources,
  openLlDb,
  sumInstantResult,
  type Sources,
} from '../src/owed-checks/sources';
import { parseTracker, type OwedCheckRow } from '../src/owed-checks/tracker';
import { parseOwedChecksArgs } from '../src/scripts/owed-checks';

const TRACKER = new URL('../../../.agents/owed-checks.yaml', import.meta.url);

function row(over: Partial<OwedCheckRow> = {}): OwedCheckRow {
  return {
    id: 'OC-900',
    title: 'a check',
    opened: '2026-10-06',
    due: '2026-10-07T12:00:00Z',
    owner: 'tests',
    status: 'pending',
    check: 'by hand',
    evidence: [],
    ...over,
  };
}

const yamlRow = (body: string) => `version: 1\nchecks:\n${body}`;
const BASE_ROW = `  - id: OC-001
    title: t
    opened: 2026-10-06
    due: 2026-10-07T12:00:00Z
    owner: o
    status: pending
    check: c
`;

function captureLogger(): SyncLogger & {
  lines: { msg: string; fields: Record<string, unknown> }[];
} {
  const lines: { msg: string; fields: Record<string, unknown> }[] = [];
  const push = (msg: string, fields?: Record<string, unknown>) =>
    lines.push({ msg, fields: fields ?? {} });
  return { lines, info: push, warn: push, error: push };
}

describe('the tracker file', () => {
  it('parses and validates (.agents/owed-checks.yaml)', async () => {
    const tracker = parseTracker(await readFile(TRACKER, 'utf8'));
    expect(tracker.checks.length).toBeGreaterThan(0);
    for (const r of tracker.checks) expect(r.id).toMatch(/^OC-\d{3}$/);
  });

  it('has no plain value cut short by a YAML comment (quote a value that holds " #")', async () => {
    const cut = (await readFile(TRACKER, 'utf8'))
      .split('\n')
      .filter((l) => /^\s+[a-z_]+: [^"'|>\s[{].* #/.test(l));
    expect(cut).toEqual([]);
  });

  it('rejects duplicate ids, a closed row without evidence and auto without auto_covers', () => {
    expect(() => parseTracker(yamlRow(BASE_ROW + BASE_ROW))).toThrow(/duplicate id OC-001/);
    expect(() =>
      parseTracker(yamlRow(BASE_ROW.replace('status: pending', 'status: passed'))),
    ).toThrow(/needs evidence/);
    const withAuto = `${BASE_ROW}    auto:\n      - {name: n, source: app-db, query: select 1, expect: {rows: 1}}\n`;
    expect(() => parseTracker(yamlRow(withAuto))).toThrow(/needs `auto_covers`/);
    expect(
      parseTracker(yamlRow(`${withAuto}    auto_covers: all\n`)).checks[0]?.auto?.[0]?.mismatch,
    ).toBe('fail');
  });

  it('rejects a failed row with no follow-up, a bad due and SQL-only conditions on a metric check', () => {
    const failed =
      BASE_ROW.replace('status: pending', 'status: failed') +
      '    evidence: ["2026-10-06 failed"]\n';
    expect(() => parseTracker(yamlRow(failed))).toThrow(/names its follow-up/);
    expect(() =>
      parseTracker(yamlRow(BASE_ROW.replace('2026-10-07T12:00:00Z', '2026-10-07 12:00'))),
    ).toThrow(/UTC timestamp/);
    const metric = `${BASE_ROW}    auto_covers: all\n    auto:\n      - {name: n, source: loki, query: x, expect: {rows: 0}}\n`;
    expect(() => parseTracker(yamlRow(metric))).toThrow(/apply to app-db and ll-db checks only/);
    const sqlAt = `${BASE_ROW}    auto_covers: all\n    auto:\n      - {name: n, source: ll-db, query: select 1, at: 2026-10-07T00:00:00Z, expect: {rows: 0}}\n`;
    expect(() => parseTracker(yamlRow(sqlAt))).toThrow(/for loki and prometheus checks only/);
  });
});

describe('row timing', () => {
  const now = Date.parse('2026-10-07T15:30:00Z');

  it('a pending row past due is overdue by whole hours; a closed row never is', () => {
    expect(rowTiming(row(), now)).toMatchObject({
      overdue: true,
      overdueHours: 3,
      idleVerdict: 'manual',
    });
    expect(rowTiming(row({ status: 'passed' }), now)).toMatchObject({
      overdue: false,
      idleVerdict: 'closed',
    });
    expect(rowTiming(row({ due: '2026-10-08T00:00:00Z' }), now)).toMatchObject({
      overdue: false,
      overdueHours: null,
    });
  });

  it('automated checks wait for not_before', () => {
    const auto = [
      {
        name: 'n',
        source: 'app-db' as const,
        query: 'select 1',
        expect: { rows: 1 },
        mismatch: 'fail' as const,
      },
    ];
    const r = row({
      auto,
      auto_covers: 'all',
      not_before: '2026-10-07T16:00:00Z',
      due: '2026-10-07T18:00:00Z',
    });
    expect(rowTiming(r, now)).toMatchObject({ evaluable: false, idleVerdict: 'not_yet' });
    expect(rowTiming(r, Date.parse('2026-10-07T16:00:00Z'))).toMatchObject({
      evaluable: true,
      idleVerdict: null,
    });
  });
});

describe('queries and judgement', () => {
  it('$SINCE spans from the check or row start to the evaluation instant, clamped', () => {
    const r = row({ not_before: '2026-10-07T09:00:00Z' });
    expect(expandQuery('x[$SINCE]', r, Date.parse('2026-10-07T10:00:00Z'))).toBe('x[3600s]');
    expect(expandQuery('x[$SINCE]', r, Date.parse('2026-10-07T09:00:10Z'))).toBe('x[60s]');
    expect(expandQuery('x[$SINCE]', r, Date.parse('2026-12-07T09:00:00Z'))).toBe(
      `x[${30 * 86400}s]`,
    );
    expect(
      expandQuery('[$SINCE]', r, Date.parse('2026-10-07T10:00:00Z'), {
        since: '2026-10-07T08:00:00Z',
      }),
    ).toBe('[7200s]');
    expect(expandQuery('[$SINCE]', row(), Date.parse('2026-10-06T01:00:00Z'))).toBe('[3600s]');
  });

  it('row counts, values and a mismatch that waits', () => {
    const rows = { kind: 'rows' as const, rows: [{ n: '484' }] };
    expect(judge({ expect: { rows: 0 }, mismatch: 'wait' }, rows).result).toBe('wait');
    expect(judge({ expect: { rows: 0 }, mismatch: 'fail' }, rows).result).toBe('fail');
    expect(judge({ expect: { eq: 484 }, mismatch: 'fail' }, rows).result).toBe('pass');
    expect(judge({ expect: { min: 500 }, mismatch: 'fail' }, rows).unmet).toEqual([
      'value 484 < 500',
    ]);
    expect(
      judge(
        { expect: { eq: 'wrong_volume' }, mismatch: 'wait' },
        { kind: 'rows', rows: [{ r: null }] },
      ).result,
    ).toBe('wait');
    expect(
      judge(
        { expect: { eq: 'wrong_volume' }, mismatch: 'wait' },
        { kind: 'rows', rows: [{ r: 'wrong_volume' }] },
      ).result,
    ).toBe('pass');
    expect(
      judge({ expect: { max: 100 }, mismatch: 'fail' }, { kind: 'value', value: 101 }).result,
    ).toBe('fail');
    expect(judge({ expect: { min: 1 }, mismatch: 'fail' }, { kind: 'rows', rows: [] }).result).toBe(
      'fail',
    );
  });

  it('paths_exist reads the first column and ignores empty values', () => {
    const exists = (p: string) => p !== '/gone';
    const obs = {
      kind: 'rows' as const,
      rows: [{ f: '/here' }, { f: '' }, { f: null }, { f: '/gone' }],
    };
    const j = judge({ expect: { paths_exist: true }, mismatch: 'fail' }, obs, exists);
    expect(j.result).toBe('fail');
    expect(j.observed).toMatchObject({ paths: 2, missing: ['/gone'] });
    expect(
      judge(
        { expect: { paths_exist: true }, mismatch: 'fail' },
        { kind: 'rows', rows: [{ f: '/here' }] },
        exists,
      ).result,
    ).toBe('pass');
  });

  it('one failing check fails the row; an unreadable one outranks a wait', () => {
    expect(combineResults(['pass', 'wait', 'fail', 'error'])).toBe('fail');
    expect(combineResults(['pass', 'wait', 'error'])).toBe('error');
    expect(combineResults(['pass', 'wait'])).toBe('wait');
    expect(combineResults(['pass'])).toBe('pass');
  });
});

describe('read-only sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owed-checks-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the SQL guard lets one SELECT or WITH through and nothing else', () => {
    expect(() => assertSingleSelect('select 1;')).not.toThrow();
    expect(() =>
      assertSingleSelect('-- note\n with x as (select 1) select * from x'),
    ).not.toThrow();
    expect(() => assertSingleSelect('delete from books')).toThrow(/only a SELECT/);
    expect(() => assertSingleSelect('select 1; delete from books')).toThrow(/only one statement/);
    expect(() => assertSingleSelect('pragma query_only = off')).toThrow(/only a SELECT/);
  });

  it('ll-db opens the file read-only: a write is refused by SQLite itself', async () => {
    const path = join(dir, 'll.db');
    const w = new DatabaseSync(path);
    w.exec("create table books (BookID text, BookFile text); insert into books values ('a', '/x')");
    w.close();
    const ll = openLlDb(path);
    expect(ll.query('select BookID from books')).toEqual([{ BookID: 'a' }]);
    expect(() => ll.query("insert into books values ('b', '/y')")).toThrow(
      /readonly|read-only|query_only/i,
    );
    ll.close();

    const sources = createSources({ llDbPath: path });
    await expect(
      sources.run({ source: 'll-db', query: "update books set BookFile = ''", at: 0 }),
    ).rejects.toThrow(/only a SELECT/);
    await expect(sources.run({ source: 'app-db', query: 'select 1', at: 0 })).rejects.toThrow(
      /not configured/,
    );
    await sources.close();
  });

  it('sums an instant-query answer and refuses a log query', () => {
    expect(
      sumInstantResult({ status: 'success', data: { resultType: 'vector', result: [] } }),
    ).toBe(0);
    expect(
      sumInstantResult({
        status: 'success',
        data: { resultType: 'vector', result: [{ value: [1, '3'] }, { value: [1, '4'] }] },
      }),
    ).toBe(7);
    expect(
      sumInstantResult({ status: 'success', data: { resultType: 'scalar', result: [1, '2'] } }),
    ).toBe(2);
    expect(() =>
      sumInstantResult({ status: 'success', data: { resultType: 'streams', result: [] } }),
    ).toThrow(/metric query/);
  });

  it('queries Loki at the pinned instant over GET', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: URL | string) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({
          status: 'success',
          data: { resultType: 'vector', result: [{ value: [0, '5'] }] },
        }),
      );
    }) as typeof fetch;
    const sources = createSources({ lokiUrl: 'http://loki:3100', fetchImpl });
    const at = Date.parse('2026-10-07T07:45:00Z');
    expect(await sources.run({ source: 'loki', query: 'sum(x)', at })).toEqual({
      kind: 'value',
      value: 5,
    });
    expect(seen[0]).toContain('/loki/api/v1/query?query=sum%28x%29&time=1791359100.000');
  });
});

describe('a run', () => {
  const tracker = parseTracker(
    yamlRow(`  - id: OC-001
    title: overdue manual
    opened: 2026-10-06
    due: 2026-10-07T00:00:00Z
    owner: o
    status: pending
    check: c
  - id: OC-002
    title: automated
    opened: 2026-10-06
    not_before: 2026-10-07T00:00:00Z
    due: 2026-10-08T00:00:00Z
    owner: o
    status: pending
    check: c
    auto_covers: all
    auto:
      - {name: waits, source: app-db, query: select 1, expect: {rows: 0}, mismatch: wait}
      - {name: later, source: loki, query: x, at: 2026-10-09T00:00:00Z, expect: {eq: 0}}
      - {name: broken, source: prometheus, query: y, expect: {eq: 0}}
  - id: OC-003
    title: done
    opened: 2026-10-06
    due: 2026-10-06T00:00:00Z
    owner: o
    status: passed
    check: c
    evidence: ["2026-10-06 passed"]
`),
  );
  const now = Date.parse('2026-10-07T12:00:00Z');

  it('logs one result per check, one line per pending row and a summary', async () => {
    const log = captureLogger();
    const sources: Sources = {
      run: async (req) => {
        if (req.source === 'prometheus') throw new Error('HTTP 502');
        return { kind: 'rows', rows: [{ n: 1 }] };
      },
      close: async () => {},
    };
    const summary = await runOwedChecks(tracker, { now, sources, log });
    expect(summary).toMatchObject({ rows: 3, pending: 2, overdue: 1, evaluated: 1 });
    const results = log.lines
      .filter((l) => l.msg === 'owed_check_result')
      .map((l) => [l.fields.check, l.fields.result]);
    expect(results).toEqual([
      ['waits', 'wait'],
      ['later', 'wait'],
      ['broken', 'error'],
    ]);
    const rows = log.lines
      .filter((l) => l.msg === 'owed_check')
      .map((l) => [l.fields.id, l.fields.overdue, l.fields.auto]);
    expect(rows).toEqual([
      ['OC-001', true, 'manual'],
      ['OC-002', false, 'error'],
    ]);
    expect(log.lines.at(-1)?.msg).toBe('owed_checks_run');
  });

  it('with no sources it reports timing only, and the issue body lists the overdue rows', async () => {
    const log = captureLogger();
    const summary = await runOwedChecks(tracker, { now, sources: null, log });
    expect(log.lines.filter((l) => l.msg === 'owed_check_result')).toHaveLength(0);
    expect(summary.reports.find((r) => r.id === 'OC-002')?.auto).toBe('skipped');
    const md = renderMarkdown(summary.reports, now);
    expect(md.split('\n')[0]).toBe('<!-- owed-checks-overdue: OC-001 -->');
    expect(md).toContain('| OC-001 |  | overdue manual | 2026-10-07T00:00:00Z | 12 h | o |');
    expect(md).toContain('## Pending, not yet due (1)');
  });
});

describe('arguments', () => {
  it('reads the tracker location from the env and refuses unknown flags', () => {
    const a = parseOwedChecksArgs(['--no-data', '--now=2026-10-07T00:00:00Z'], {
      OWED_CHECKS_URL: 'https://x/y.yaml',
    });
    expect(a).toMatchObject({
      tracker: 'https://x/y.yaml',
      noData: true,
      now: Date.parse('2026-10-07T00:00:00Z'),
    });
    expect(parseOwedChecksArgs(['--tracker=t.yaml', '--markdown=o.md'], {})).toMatchObject({
      tracker: 't.yaml',
      markdown: 'o.md',
    });
    expect(() => parseOwedChecksArgs(['--apply'], {})).toThrow(/unknown/);
  });
});

// A file the paths_exist check can see, so the real existsSync path is exercised once.
it('paths_exist uses the filesystem by default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owed-paths-'));
  const file = join(dir, 'book.epub');
  writeFileSync(file, 'x');
  const j = judge(
    { expect: { paths_exist: true }, mismatch: 'fail' },
    { kind: 'rows', rows: [{ f: file }, { f: `${file}.gone` }] },
  );
  expect(j.unmet).toEqual(['1 of 2 paths missing']);
  rmSync(dir, { recursive: true, force: true });
});
