// DESIGN-053 — the Owed Check tracker: `.agents/owed-checks.yaml`, one row per post-deploy check a deploy record leaves
// for later. This module is the file's schema and loader; `evaluate.ts` decides what a row's state is at a given time,
// `sources.ts` runs a row's read-only automated checks, `run.ts` ties them together for the CronJob and the GitHub
// Action. Nothing here writes anywhere.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';

/** A UTC instant written the one way the tracker allows: `2026-10-07T12:00:00Z` (seconds optional). */
const utcInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/, 'a UTC timestamp like 2026-10-07T12:00:00Z')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'not a real date');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date like 2026-10-06');

export const OWED_CHECK_SOURCES = ['app-db', 'll-db', 'loki', 'prometheus'] as const;
export type OwedCheckSource = (typeof OWED_CHECK_SOURCES)[number];
export const SQL_SOURCES: readonly OwedCheckSource[] = ['app-db', 'll-db'];

export const OWED_CHECK_STATUSES = ['pending', 'passed', 'failed', 'waived'] as const;
export type OwedCheckStatus = (typeof OWED_CHECK_STATUSES)[number];

const expectSchema = z
  .object({
    /** SQL: exactly this many rows. */
    rows: z.number().int().min(0).optional(),
    /** SQL: at least / at most this many rows. */
    min_rows: z.number().int().min(0).optional(),
    max_rows: z.number().int().min(0).optional(),
    /** The value: a metric query's number, or the first column of a SQL query's first row. */
    eq: z.union([z.number(), z.string()]).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    /** SQL: every non-empty value of the first column names a file that exists (read-only mounts). */
    paths_exist: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (e) => Object.values(e).some((v) => v !== undefined),
    'expect needs at least one condition',
  );
export type OwedCheckExpect = z.infer<typeof expectSchema>;

const autoCheckSchema = z
  .object({
    name: z.string().min(1),
    source: z.enum(OWED_CHECK_SOURCES),
    query: z.string().min(1),
    /** Loki / Prometheus only: evaluate the query at this instant instead of now; before it, the check waits. */
    at: utcInstant.optional(),
    /** Loki / Prometheus only: where `$SINCE` starts for this check (default: the row's `not_before`, else `opened`). */
    since: utcInstant.optional(),
    expect: expectSchema,
    /** What a mismatch means: `fail` (the check found a defect) or `wait` (what it waits for has not happened yet). */
    mismatch: z.enum(['fail', 'wait']).default('fail'),
  })
  .strict()
  .superRefine((c, ctx) => {
    const sql = SQL_SOURCES.includes(c.source);
    if (sql && (c.at || c.since)) {
      ctx.addIssue({
        code: 'custom',
        message: '`at` and `since` are for loki and prometheus checks only',
      });
    }
    if (c.since && c.at && Date.parse(c.since) >= Date.parse(c.at)) {
      ctx.addIssue({ code: 'custom', message: '`since` is not before `at`' });
    }
    const sqlOnly = (['rows', 'min_rows', 'max_rows', 'paths_exist'] as const).filter(
      (k) => c.expect[k] !== undefined,
    );
    if (!sql && sqlOnly.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `${sqlOnly.join(', ')} apply to app-db and ll-db checks only`,
      });
    }
  });
export type OwedAutoCheck = z.infer<typeof autoCheckSchema>;

const linksSchema = z
  .object({
    prs: z.array(z.string().min(1)).optional(),
    issues: z.array(z.string().min(1)).optional(),
    /** The HANDOFF block that wrote the check. */
    handoff: z.string().min(1).optional(),
    /** The row or issue that carries the work on after this one (a failed row names it). */
    followup: z.string().min(1).optional(),
  })
  .strict();

const rowSchema = z
  .object({
    id: z.string().regex(/^OC-\d{3}$/, 'OC-NNN'),
    /** The HANDOFF letter the check had before the tracker, e.g. `(k)`. */
    legacy: z.string().min(1).optional(),
    title: z.string().min(1),
    opened: isoDate,
    /** The event the check follows, in words ("after the 2026-10-07 04:54Z LazyLibrarian backlog run"). */
    after: z.string().min(1).optional(),
    /** The automated checks do not run before this instant (the event's expected time). */
    not_before: utcInstant.optional(),
    /** The result must be recorded by this instant; a pending row past it is overdue. */
    due: utcInstant,
    owner: z.string().min(1),
    status: z.enum(OWED_CHECK_STATUSES),
    /** The exact check, by hand: the query or command and the expected result. */
    check: z.string().min(1),
    auto: z.array(autoCheckSchema).min(1).optional(),
    /** Whether the automated checks cover the whole check (`all`) or only part of it (`part`). */
    auto_covers: z.enum(['all', 'part']).optional(),
    /** Dated results, newest last: "2026-10-06 09:30Z passed: ...". */
    evidence: z.array(z.string().min(1)).default([]),
    links: linksSchema.optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.auto && !r.auto_covers)
      ctx.addIssue({ code: 'custom', message: 'a row with `auto` needs `auto_covers`' });
    if (!r.auto && r.auto_covers)
      ctx.addIssue({ code: 'custom', message: '`auto_covers` without `auto`' });
    if (r.status !== 'pending' && r.evidence.length === 0) {
      ctx.addIssue({ code: 'custom', message: `a ${r.status} row needs evidence` });
    }
    if (r.status === 'failed' && !r.links?.issues?.length && !r.links?.followup) {
      ctx.addIssue({
        code: 'custom',
        message: 'a failed row names its follow-up (links.issues or links.followup)',
      });
    }
    if (r.not_before && Date.parse(r.not_before) > Date.parse(r.due)) {
      ctx.addIssue({ code: 'custom', message: '`not_before` is after `due`' });
    }
    const names = new Set<string>();
    for (const c of r.auto ?? []) {
      if (names.has(c.name))
        ctx.addIssue({ code: 'custom', message: `duplicate auto check name "${c.name}"` });
      names.add(c.name);
    }
  });
export type OwedCheckRow = z.infer<typeof rowSchema>;

export const trackerSchema = z
  .object({
    version: z.literal(1),
    checks: z.array(rowSchema),
  })
  .strict()
  .superRefine((t, ctx) => {
    const seen = new Set<string>();
    for (const row of t.checks) {
      if (seen.has(row.id)) ctx.addIssue({ code: 'custom', message: `duplicate id ${row.id}` });
      seen.add(row.id);
    }
  });
export type OwedCheckTracker = z.infer<typeof trackerSchema>;

/** Parse and validate the tracker's YAML text. Throws an Error naming every problem. */
export function parseTracker(text: string): OwedCheckTracker {
  const doc: unknown = parse(text);
  const result = trackerSchema.safeParse(doc);
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`owed-checks tracker is invalid:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}

/** Read the tracker from a local path or an http(s) URL (the CronJob reads `main` from GitHub). */
export async function loadTrackerText(
  location: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (/^https?:\/\//.test(location)) {
    const res = await fetchImpl(location, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`tracker fetch ${location} answered HTTP ${res.status}`);
    return res.text();
  }
  return readFile(location, 'utf8');
}
