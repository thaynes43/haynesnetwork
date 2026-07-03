import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * DESIGN-005 D-12/D-18 (ADR-008 enforceability) — the mutating *arr surface
 * `@hnet/arr/write` may be imported ONLY by packages/domain (the fix/restore
 * orchestrators) and by packages/arr itself (its own source/tests). This keeps
 * "no other code path may call a mutating *arr endpoint" executable: sync,
 * packages/api, and apps/web can only reach the write clients through the domain
 * bundle, never construct them.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ALLOWED_DIR_PREFIXES = [`packages${sep}domain${sep}`, `packages${sep}arr${sep}`];

const IMPORT_PATTERN = /@hnet\/arr\/write/;

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

describe('static analysis — @hnet/arr/write is domain-only (ADR-008)', () => {
  it('no @hnet/arr/write reference outside packages/domain and packages/arr', async () => {
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
        `Found ${violations.length} reference(s) to @hnet/arr/write outside packages/domain.\n` +
          `Mutating *arr calls must go through the @hnet/domain fix/restore orchestrators ` +
          `(runFixRequest, executeRestore) so every write-back is recorded (ADR-008).\n` +
          detail,
      );
    }
  });
});
