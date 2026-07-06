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
const ALLOWED_FILES = new Set<string>([
  'packages/db/__tests__/migrations.test.ts',
  'packages/db/__tests__/media-ledger.test.ts',
]);

// DESIGN-001 D-12 / ADR-012 guarded tables: users.role_id, roles, role_app_grants,
// app_catalog + the audit tables (user_role_transitions, permission_audit). DESIGN-005
// D-12 extends the watched list with the Phase 2 media-ledger tables: media_items,
// ledger_events, fix_requests, restore_runs, sync_runs, sync_state. ADR-017 / DESIGN-007
// D-01 adds the Phase 3 Plex tables: plex_servers, plex_libraries, role_library_grants,
// plex_share_audit (registry refresh + role grants + share ledger all go through
// packages/domain single-writers).
const FORBIDDEN_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  {
    name: 'UPDATE users SET role_id (SQL)',
    regex: /UPDATE\s+users\s+SET\s+role_id\b/i,
  },
  {
    name: 'INSERT INTO guarded/audit table (SQL)',
    regex:
      /INSERT\s+INTO\s+(user_role_transitions|permission_audit|roles|role_app_grants|app_catalog|media_items|ledger_events|fix_requests|restore_runs|sync_runs|sync_state|plex_servers|plex_libraries|role_library_grants|plex_share_audit)\b/i,
  },
  {
    name: 'UPDATE guarded table (SQL)',
    regex:
      /UPDATE\s+(roles|app_catalog|media_items|ledger_events|fix_requests|restore_runs|sync_runs|sync_state|plex_servers|plex_libraries|role_library_grants)\s+SET\b/i,
  },
  {
    name: 'DELETE FROM guarded table (SQL)',
    regex:
      /DELETE\s+FROM\s+(role_app_grants|roles|app_catalog|media_items|ledger_events|fix_requests|restore_runs|sync_runs|sync_state|plex_servers|plex_libraries|role_library_grants|plex_share_audit)\b/i,
  },
  {
    name: '.insert() into guarded/audit table (Drizzle)',
    regex:
      /\.insert\(\s*(?:[A-Za-z_$][\w$]*\.)?(userRoleTransitions|permissionAudit|roleAppGrants|roles|appCatalog|mediaItems|ledgerEvents|fixRequests|restoreRuns|syncRuns|syncState|plexServers|plexLibraries|roleLibraryGrants|plexShareAudit)\s*\)/,
  },
  {
    name: '.update() on guarded table (Drizzle)',
    regex:
      /\.update\(\s*(?:[A-Za-z_$][\w$]*\.)?(users|roles|appCatalog|mediaItems|ledgerEvents|fixRequests|restoreRuns|syncRuns|syncState|plexServers|plexLibraries|roleLibraryGrants)\s*\)/,
  },
  {
    name: '.delete() on guarded table (Drizzle)',
    regex:
      /\.delete\(\s*(?:[A-Za-z_$][\w$]*\.)?(roleAppGrants|roles|appCatalog|mediaItems|ledgerEvents|fixRequests|restoreRuns|syncRuns|syncState|roleLibraryGrants|plexLibraries|plexServers)\s*\)/,
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
          `These mutations must go through @hnet/domain (createRole/updateRole/deleteRole, ` +
          `assignRole, createApp/updateApp/deleteApp/reorderCatalog) so the audit row commits ` +
          `in the same transaction.\n` +
          detail,
      );
    }
  });
});
