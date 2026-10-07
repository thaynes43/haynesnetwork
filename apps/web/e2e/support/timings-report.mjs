#!/usr/bin/env node
// Issue #812 — where the e2e suite's minutes go. Reads, from the directory given as argv[2] (or
// HNET_E2E_TIMINGS_DIR):
//   results.json        Playwright's JSON report (per-test durations and start times);
//   stack-timings.json  the harness boot phases (e2e/support/timings.ts);
//   server.log          the app server's output, each line prefixed with the epoch ms it arrived.
// Writes report.md there, appends it to $GITHUB_STEP_SUMMARY when set, and prints it as a few `::notice`
// annotations: the check-run annotations API is the one place a run's numbers can be read back from where the
// run logs and artifacts are not reachable. Never fails the job: a missing input just leaves its section out.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const dir = process.argv[2] || process.env.HNET_E2E_TIMINGS_DIR;
if (!dir) {
  console.log('timings-report: no directory given');
  process.exit(0);
}
const label = process.env.HNET_E2E_SERVER === 'start' ? 'next start' : 'next dev';

const readJson = (name) => {
  const path = join(dir, name);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};
const s = (ms) => (ms / 1000).toFixed(1);
const median = (xs) => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// ---------------------------------------------------------------------------------------------- tests
const results = readJson('results.json');
/** @type {Array<{file: string, title: string, start: number, duration: number, retry: number, status: string}>} */
const attempts = [];
const walk = (suite, file) => {
  const f = suite.file ? basename(suite.file) : file;
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      for (const r of test.results ?? []) {
        attempts.push({
          file: basename(spec.file ?? f ?? '?'),
          title: spec.title,
          start: Date.parse(r.startTime),
          duration: r.duration ?? 0,
          retry: r.retry ?? 0,
          status: r.status,
        });
      }
    }
  }
  for (const child of suite.suites ?? []) walk(child, f);
};
for (const suite of results?.suites ?? []) walk(suite, undefined);
attempts.sort((a, b) => a.start - b.start);

const stats = results?.stats;
const suiteStart = stats ? Date.parse(stats.startTime) : attempts[0]?.start;
const suiteMs = stats?.duration ?? 0;
const firstTest = attempts[0]?.start;
const lastEnd = attempts.reduce((m, a) => Math.max(m, a.start + a.duration), 0);
const testSum = attempts.reduce((m, a) => m + a.duration, 0);

// ------------------------------------------------------------------------------------------ boot phases
const stack = readJson('stack-timings.json');

// --------------------------------------------------------------------------------- dev request log
// ` GET /library 200 in 2.3s (next.js: 1.9s, proxy.ts: 5ms, application-code: 400ms)`; `next.js` is the
// framework's share, which under `next dev` includes the on-demand compile of the route.
const ANSI = /\u001b\[[0-9;]*m/g;
const REQ =
  /^(GET|POST|HEAD|PUT|PATCH|DELETE|OPTIONS) (\S+) (\d{3}) in ([\d.]+)(min|ms|µs|s)(?: \((.*)\))?\s*$/;
const UNIT_MS = { min: 60_000, s: 1000, ms: 1, µs: 0.001 };
const toMs = (v, unit) => Number(v) * (UNIT_MS[unit] ?? 1);
const parseSeg = (text) => {
  const out = {};
  for (const part of (text ?? '').split(', ')) {
    const m = /^(.+?): ([\d.]+)(min|ms|µs|s)$/.exec(part.trim());
    if (m) out[m[1]] = toMs(m[2], m[3]);
  }
  return out;
};
// One key per compiled route module: every tRPC procedure is the one /api/trpc/[trpc] handler and every Better
// Auth endpoint the one /api/auth/[...all] handler, so their first hits are one compile each, not one per path.
const normalize = (url) => {
  const path = url
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':uuid')
    .replace(/\/\d+(?=\/|$)/g, '/:n');
  if (path.startsWith('/api/trpc/')) return '/api/trpc/[trpc]';
  if (path.startsWith('/api/auth/')) return '/api/auth/[...all]';
  return path;
};
/** @type {Array<{at: number, method: string, route: string, total: number, framework: number, app: number, status: number}>} */
const requests = [];
const compiling = [];
const logPath = join(dir, 'server.log');
if (existsSync(logPath)) {
  for (const raw of readFileSync(logPath, 'utf8').split('\n')) {
    const sp = raw.indexOf(' ');
    if (sp < 0) continue;
    const at = Number(raw.slice(0, sp));
    const line = raw
      .slice(sp + 1)
      .replace(/^\[[^\]]*\] /, '')
      .replace(ANSI, '')
      .trim();
    const m = REQ.exec(line);
    if (m) {
      const seg = parseSeg(m[6]);
      requests.push({
        at,
        method: m[1],
        route: normalize(m[2]),
        status: Number(m[3]),
        total: toMs(m[4], m[5]),
        framework: seg['next.js'] ?? seg.compile ?? 0,
        app: seg['application-code'] ?? seg.render ?? 0,
      });
      continue;
    }
    const c = /Compiling (\S+)/.exec(line);
    if (c) compiling.push({ at, route: c[1] });
  }
}

/** The test attempt running at `at` (attempts are serial), or undefined during boot/teardown. */
const attemptAt = (at) => {
  let lo = 0;
  let hi = attempts.length - 1;
  let found;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (attempts[mid].start <= at) {
      found = attempts[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found && at <= found.start + found.duration + 50 ? found : undefined;
};

// First hit vs repeat hits per route: the first hit's framework time minus the median of its repeats is the
// compile estimate for that route (a route hit only once counts its whole framework time).
const byRoute = new Map();
for (const r of requests) {
  const key = `${r.method} ${r.route}`;
  if (!byRoute.has(key)) byRoute.set(key, []);
  byRoute.get(key).push(r);
}
const routeRows = [];
let compileBootMs = 0;
let compileTestMs = 0;
const compileBySpec = new Map();
for (const [key, hits] of byRoute) {
  const first = hits[0];
  const repeats = hits.slice(1).map((h) => h.framework);
  const repeatMedian = median(repeats);
  const excess = Math.max(0, first.framework - repeatMedian);
  const during = attemptAt(first.at);
  if (during) {
    compileTestMs += excess;
    compileBySpec.set(during.file, (compileBySpec.get(during.file) ?? 0) + excess);
  } else compileBootMs += excess;
  routeRows.push({
    key,
    hits: hits.length,
    first: first.framework,
    repeatMedian,
    repeatTotalMedian: median(hits.slice(1).map((h) => h.total)),
    excess,
    phase: during ? during.file : 'boot',
  });
}
routeRows.sort((a, b) => b.excess - a.excess);
const frameworkTotal = requests.reduce((m, r) => m + r.framework, 0);
const appTotal = requests.reduce((m, r) => m + r.app, 0);
const reqInTests = requests.filter((r) => attemptAt(r.at));
const frameworkInTests = reqInTests.reduce((m, r) => m + r.framework, 0);

// ------------------------------------------------------------------------------------------- per spec
const specs = new Map();
for (const a of attempts) {
  const row = specs.get(a.file) ?? {
    file: a.file,
    tests: 0,
    retries: 0,
    sum: 0,
    first: a.start,
    last: 0,
  };
  if (a.retry === 0) row.tests += 1;
  else row.retries += 1;
  row.sum += a.duration;
  row.first = Math.min(row.first, a.start);
  row.last = Math.max(row.last, a.start + a.duration);
  specs.set(a.file, row);
}
const specRows = [...specs.values()].sort((a, b) => b.sum - a.sum);

// ------------------------------------------------------------------------------------------------ out
const sections = [];
{
  const lines = [`e2e timings, ${label}`];
  if (stats) {
    lines.push(
      `suite ${s(suiteMs)} s; tests ${attempts.filter((a) => a.retry === 0).length}, attempts ${attempts.length}, ` +
        `flaky ${stats.flaky ?? 0}, failed ${stats.unexpected ?? 0}, skipped ${stats.skipped ?? 0}`,
    );
  }
  if (firstTest && suiteStart) {
    lines.push(
      `global setup ${s(firstTest - suiteStart)} s; tests (first start to last end) ${s(lastEnd - firstTest)} s; ` +
        `sum of test durations ${s(testSum)} s; teardown+report ${s(suiteStart + suiteMs - lastEnd)} s`,
    );
  }
  if (stack?.marks) {
    lines.push(
      'boot phases (ms since startStack): ' +
        stack.marks.map((m) => `${m.phase} ${m.sinceStartMs}`).join(', '),
    );
  }
  if (requests.length) {
    lines.push(
      `server requests logged ${requests.length} (${reqInTests.length} during tests); next.js time ${s(frameworkTotal)} s ` +
        `(${s(frameworkInTests)} s during tests), application-code ${s(appTotal)} s`,
    );
    lines.push(
      `first-hit compile estimate: boot ${s(compileBootMs)} s, during tests ${s(compileTestMs)} s, ` +
        `over ${byRoute.size} routes; slow-compile log lines ${compiling.length} ` +
        `(${compiling.filter((c) => attemptAt(c.at)).length} during tests)`,
    );
  }
  sections.push(lines.join('\n'));
}
if (specRows.length) {
  const lines = ['per spec: file | tests | retries | sum s | wall s | first-hit compile s'];
  for (const r of specRows) {
    lines.push(
      `${r.file} | ${r.tests} | ${r.retries} | ${s(r.sum)} | ${s(r.last - r.first)} | ${s(compileBySpec.get(r.file) ?? 0)}`,
    );
  }
  sections.push(lines.join('\n'));
}
if (attempts.length) {
  const lines = ['slowest 40 test attempts: s | file | title'];
  for (const a of [...attempts].sort((x, y) => y.duration - x.duration).slice(0, 40)) {
    lines.push(
      `${s(a.duration)} | ${a.file} | ${a.title.slice(0, 70)}${a.retry ? ` (retry ${a.retry})` : ''}`,
    );
  }
  sections.push(lines.join('\n'));
}
if (routeRows.length) {
  const lines = [
    'routes by first-hit excess: route | hits | first next.js ms | repeat median next.js ms | repeat median total ms | excess ms | where',
  ];
  for (const r of routeRows.slice(0, 45)) {
    lines.push(
      `${r.key.slice(0, 90)} | ${r.hits} | ${Math.round(r.first)} | ${Math.round(r.repeatMedian)} | ${Math.round(r.repeatTotalMedian)} | ${Math.round(r.excess)} | ${r.phase}`,
    );
  }
  sections.push(lines.join('\n'));
}

const report = sections.join('\n\n');
writeFileSync(join(dir, 'report.md'), report + '\n');
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, '```\n' + report + '\n```\n');
}
console.log(report);

// Annotations: at most 10 notices per step, so pack the lines into at most 9 chunks of ~3.5 kB.
const escape = (t) => t.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const allLines = report.split('\n');
const chunks = [];
let current = '';
for (const line of allLines) {
  if (current.length + line.length + 1 > 3500 && current) {
    chunks.push(current);
    current = '';
  }
  current += (current ? '\n' : '') + line;
}
if (current) chunks.push(current);
const total = Math.min(chunks.length, 9);
for (let i = 0; i < total; i += 1) {
  console.log(`::notice title=e2e timings ${label} ${i + 1}/${total}::${escape(chunks[i])}`);
}
