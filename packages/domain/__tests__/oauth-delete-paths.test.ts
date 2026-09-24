// ADR-091 / DESIGN-050 D-01 / D-03 (PLAN-069 S2) — the OAuth DELETE paths, as static analysis. The repo-wide
// no-direct-state-writes guard keeps every OAuth-table write inside packages/domain; this narrows the DELETE forms
// further, INSIDE the domain: a row of the five OAuth state tables is deleted only by the inline pruner
// (`pruneExpired`, D-03) or by the consent writer that decides the pending request (`grantConsent` /
// `denyConsent`, D-05 step 7), and the append-only `oauth_audit` is never deleted at all. Anything else — a
// disconnect, a revoke, a rotation — revokes or expires, and leaves deleting to the pruner.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DOMAIN_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** file (relative to packages/domain/src) → the functions in it that may delete OAuth state rows. */
const ALLOWED: Record<string, string[]> = {
  'oauth/prune.ts': ['pruneExpired'],
  'oauth/consent.ts': ['grantConsent', 'denyConsent'],
};

const STATE_TABLES_SQL = [
  'oauth_clients',
  'oauth_authorizations',
  'oauth_authorization_codes',
  'oauth_refresh_tokens',
  'oauth_access_tokens',
];
const STATE_TABLES_DRIZZLE = [
  'oauthClients',
  'oauthAuthorizations',
  'oauthAuthorizationCodes',
  'oauthRefreshTokens',
  'oauthAccessTokens',
];

const DELETE_PATTERN = new RegExp(
  [
    `DELETE\\s+FROM\\s+(${[...STATE_TABLES_SQL, 'oauth_audit'].join('|')})\\b`,
    `\\.delete\\(\\s*(?:[A-Za-z_$][\\w$]*\\.)?(${[...STATE_TABLES_DRIZZLE, 'oauthAudit'].join('|')})\\s*,?\\s*\\)`,
  ].join('|'),
  'gi',
);

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every DELETE form in a source text: the table and the 1-based line. */
export function deletesIn(source: string): Array<{ table: string; line: number }> {
  const found: Array<{ table: string; line: number }> = [];
  for (const m of source.matchAll(DELETE_PATTERN)) {
    found.push({ table: m[1] ?? m[2] ?? '', line: source.slice(0, m.index).split('\n').length });
  }
  return found;
}

/**
 * The line span of a top-level function: from its `function NAME(` line to the first line after it that is a
 * lone `}` at column 0 (prettier's close of a top-level declaration). Null when the function is not there.
 */
export function functionSpan(source: string, name: string): { start: number; end: number } | null {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^export (async )?function ${name}\\b`).test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l === '}');
  return end < 0 ? null : { start: start + 1, end: end + 1 };
}

describe('DESIGN-050 D-03 — OAuth rows are deleted only by the pruner and the consent writers', () => {
  it('the scanner finds every DELETE form (a canary for the regex and the span finder)', () => {
    const sample = [
      'export async function pruneExpired() {',
      '  await db.delete(oauthAccessTokens).where(x);',
      '  await tx.execute(sql`DELETE FROM oauth_clients WHERE 1=0`);',
      '  await db.delete(',
      '    schema.oauthAudit,',
      '  );',
      '}',
      'export function other() {',
      '  return db.delete(watchMarks);',
      '}',
    ].join('\n');
    expect(deletesIn(sample)).toEqual([
      { table: 'oauthAccessTokens', line: 2 },
      { table: 'oauth_clients', line: 3 },
      { table: 'oauthAudit', line: 4 },
    ]);
    expect(functionSpan(sample, 'pruneExpired')).toEqual({ start: 1, end: 7 });
    expect(functionSpan(sample, 'other')).toEqual({ start: 8, end: 10 });
    expect(functionSpan(sample, 'missing')).toBeNull();
  });

  it('no DELETE of an OAuth state table outside pruneExpired / grantConsent / denyConsent, and none of oauth_audit', async () => {
    const violations: string[] = [];
    const seen = new Map<string, number>();
    for (const file of await walk(DOMAIN_SRC)) {
      const rel = relative(DOMAIN_SRC, file).split(sep).join('/');
      const source = await readFile(file, 'utf8');
      const deletes = deletesIn(source);
      if (deletes.length === 0) continue;
      const spans = (ALLOWED[rel] ?? []).map((name) => ({
        name,
        span: functionSpan(source, name),
      }));
      for (const d of deletes) {
        if (/audit/i.test(d.table)) {
          violations.push(`${rel}:${d.line} deletes ${d.table} (append-only)`);
          continue;
        }
        const owner = spans.find((s) => s.span && d.line >= s.span.start && d.line <= s.span.end);
        if (!owner)
          violations.push(`${rel}:${d.line} deletes ${d.table} outside the allowed functions`);
        else seen.set(owner.name, (seen.get(owner.name) ?? 0) + 1);
      }
    }
    expect(violations).toEqual([]);
    // The scan reached the allowed paths: the pruner deletes from all five state tables, each consent writer one.
    expect(seen.get('pruneExpired')).toBe(5);
    expect(seen.get('grantConsent')).toBe(1);
    expect(seen.get('denyConsent')).toBe(1);
  });
});
