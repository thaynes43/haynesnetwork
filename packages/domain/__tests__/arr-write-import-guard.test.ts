import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * DESIGN-005 D-12/D-18 (ADR-008 enforceability) + ADR-017 / DESIGN-007 D-03 + ADR-045 / DESIGN-023 —
 * the mutating external write surfaces `@hnet/arr/write` (fix/restore *arr write-backs),
 * `@hnet/plex/write` (Plex share apply/revoke), `@hnet/authentik/write` (Authentik group create +
 * membership), and `@hnet/openwebui/write` (OWUI tier-group pre-create) may be imported ONLY by
 * packages/domain (the orchestrators) and by their own package's source/tests (packages/arr,
 * packages/plex, packages/authentik, packages/openwebui). This keeps "no other code path may call a
 * mutating endpoint" executable: sync, packages/api, and apps/web can only reach the write clients
 * through the domain bundles, never construct them.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ALLOWED_DIR_PREFIXES = [
  `packages${sep}domain${sep}`,
  `packages${sep}arr${sep}`,
  `packages${sep}plex${sep}`,
  `packages${sep}authentik${sep}`,
  `packages${sep}openwebui${sep}`,
  // ADR-054 (PLAN-039) — @hnet/downloads/write is the MAM-governor gate seam (the Prowlarr indexer
  // `enable` toggle); only packages/domain (the governor evaluator) + its own package may import it.
  `packages${sep}downloads${sep}`,
  // ADR-055 (PLAN-044) — @hnet/lazylibrarian/write is the Goodreads-request acquisition surface
  // (addBook/queueBook/searchBook); only packages/domain (the goodreads orchestrator) + its own package.
  `packages${sep}lazylibrarian${sep}`,
];

const IMPORT_PATTERN = /@hnet\/(arr|plex|authentik|openwebui|downloads|lazylibrarian)\/write/;

const IGNORE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  '.git',
  '.turbo',
  'coverage',
  'migrations',
  'docs',
  '.agents',
  '.claude',
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
      if (SCANNED_EXTENSIONS.has(ext)) files.push(full);
    }
  }
  return files;
}

describe('static analysis — @hnet/{arr,plex,authentik,openwebui,downloads}/write is domain-only (ADR-008 / ADR-017 / ADR-045 / ADR-054)', () => {
  it('no @hnet/{arr,plex,authentik,openwebui,downloads}/write reference outside packages/{domain,arr,plex,authentik,openwebui,downloads}', async () => {
    const stats = await stat(join(REPO_ROOT, 'pnpm-workspace.yaml'));
    expect(stats.isFile()).toBe(true);

    const files = await walk(REPO_ROOT);
    const violations: Array<{ file: string; line: number }> = [];
    for (const absPath of files) {
      const relPath = relative(REPO_ROOT, absPath);
      if (ALLOWED_DIR_PREFIXES.some((prefix) => relPath.startsWith(prefix))) continue;
      const lines = (await readFile(absPath, 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (IMPORT_PATTERN.test(lines[i]!)) {
          violations.push({ file: relPath.split(sep).join('/'), line: i + 1 });
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations.map((v) => `  ${v.file}:${v.line}`).join('\n');
      throw new Error(
        `Found ${violations.length} reference(s) to @hnet/{arr,plex,authentik,openwebui,downloads}/write outside the allowed dirs.\n` +
          `Mutating *arr calls must go through the @hnet/domain fix/restore orchestrators ` +
          `(runFixRequest, executeRestore), Plex share calls through shareLibrary/unshareLibrary, ` +
          `Authentik/OWUI group calls through the assignRolePortal/provisionSyncedTier orchestrators, and ` +
          `the MAM-governor Prowlarr indexer toggle through evaluateMamGovernor ` +
          `so every write-back is recorded (ADR-008 / ADR-017 / ADR-045 / ADR-054).\n` +
          detail,
      );
    }
  });
});
