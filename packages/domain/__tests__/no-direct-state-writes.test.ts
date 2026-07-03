import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR-003 / ADR-010 — the single-writer CI guard (donor: todos-for-dues
 * packages/domain/__tests__/no-direct-state-writes.test.ts): role/permission tables may
 * only be written by the @hnet/domain helpers, which co-write their audit rows in the
 * same transaction (CLAUDE.md hard rule 6). This scan fails the build if any code
 * outside packages/domain/ (packages/api, apps/web, scripts, … as they appear) touches
 * the guarded tables directly — raw SQL or Drizzle call forms.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ALLOWED_DIR_PREFIX = `packages${sep}domain${sep}`;

/**
 * Schema/constraint tests that exercise DB-level invariants directly (CHECK
 * constraints, seed semantics). They validate the schema, not the domain helpers.
 * New code should not add to this list — route through @hnet/domain instead.
 */
const ALLOWED_FILES = new Set<string>(['packages/db/__tests__/migrations.test.ts']);

// DESIGN-001 D-12 guarded tables: users.role / users.is_family, user_app_grants,
// tags, tag_app_grants, user_tags, app_catalog + the audit tables themselves.
const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: 'UPDATE users SET role/is_family (SQL)',
    regex: /UPDATE\s+users\s+SET\s+(role|is_family)\b/i,
  },
  {
    name: 'INSERT INTO guarded/audit table (SQL)',
    regex:
      /INSERT\s+INTO\s+(user_role_transitions|permission_audit|user_app_grants|user_tags|tag_app_grants|app_catalog|tags)\b/i,
  },
  { name: 'UPDATE guarded table (SQL)', regex: /UPDATE\s+(app_catalog|tags)\s+SET\b/i },
  {
    name: 'DELETE FROM guarded table (SQL)',
    regex: /DELETE\s+FROM\s+(user_app_grants|user_tags|tag_app_grants|app_catalog|tags)\b/i,
  },
  {
    name: '.insert() into guarded/audit table (Drizzle)',
    regex:
      /\.insert\(\s*(?:[A-Za-z_$][\w$]*\.)?(userRoleTransitions|permissionAudit|userAppGrants|userTags|tagAppGrants|appCatalog|tags)\s*\)/,
  },
  {
    name: '.update() on guarded table (Drizzle)',
    regex: /\.update\(\s*(?:[A-Za-z_$][\w$]*\.)?(users|appCatalog|tags)\s*\)/,
  },
  {
    name: '.delete() on guarded table (Drizzle)',
    regex:
      /\.delete\(\s*(?:[A-Za-z_$][\w$]*\.)?(userAppGrants|userTags|tagAppGrants|appCatalog|tags)\s*\)/,
  },
];

const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.git',
  '.turbo',
  'coverage',
  'migrations', // raw SQL migrations in packages/db/migrations are the schema source of truth
  'docs',
  '.agents',
  '.claude', // agent worktrees/settings — may hold a full repo copy during parallel work
  'playwright-report',
  'test-results',
  'blob-report',
  '.pg-embedded',
]);

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.'));
      if (SCANNED_EXTENSIONS.has(ext)) {
        files.push(full);
      }
    }
  }
  return files;
}

describe('static analysis — single-writer invariant for role/permission tables', () => {
  it('no direct guarded-table writes outside packages/domain/', async () => {
    // Sanity: REPO_ROOT must look like the repo root.
    const stats = await stat(join(REPO_ROOT, 'pnpm-workspace.yaml'));
    expect(stats.isFile()).toBe(true);

    const files = await walk(REPO_ROOT);
    const violations: Array<{ file: string; pattern: string; line: number }> = [];

    for (const absPath of files) {
      const relPath = relative(REPO_ROOT, absPath);
      if (relPath.startsWith(ALLOWED_DIR_PREFIX)) continue;
      const relWithSlashes = relPath.split(sep).join('/');
      if (ALLOWED_FILES.has(relWithSlashes)) continue;

      const content = await readFile(absPath, 'utf8');
      const lines = content.split('\n');
      for (const { name, regex } of FORBIDDEN_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            violations.push({ file: relWithSlashes, pattern: name, line: i + 1 });
          }
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.file}:${v.line}  →  ${v.pattern}`).join('\n');
      throw new Error(
        `Found ${violations.length} direct role/permission table write(s) outside packages/domain/.\n` +
          `These mutations must go through @hnet/domain (transitionRole, grantApp, revokeApp, ` +
          `setFamilyDesignation, createTag/updateTag/deleteTag, applyTag/removeTag, ` +
          `createApp/updateApp/deleteApp/reorderCatalog) so the audit row commits in the same transaction.\n` +
          detail,
      );
    }
  });
});
