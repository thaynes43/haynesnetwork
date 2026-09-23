import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Assembled at runtime: the domain-wide guard (arr-write-import-guard.test.ts) flags the literal anywhere.
const PLEX_WRITE = ['@hnet/plex', 'write'].join('/');

/**
 * DESIGN-049 D-01 (ADR-087) — the layering between the Watch Companion packages, as static analysis (the
 * `packages/domain/__tests__/arr-write-import-guard.test.ts` pattern):
 *
 * - `@hnet/watch` is pure math and SELECT-only reads: it imports `@hnet/db`, `drizzle-orm` and zod only, and
 *   never `@hnet/domain` (the writers), the Plex write surface (`@hnet/plex` + `/write`; Plex writes stay
 *   domain-confined, ADR-017) or the
 *   MCP SDK — the `/sync` bundle flattens its dependencies, so a stray import would ship the SDK there.
 * - `@modelcontextprotocol/sdk` is imported only under `packages/mcp/` (the one MCP surface).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WATCH_SRC = join(REPO_ROOT, 'packages', 'watch', 'src');

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
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (
      entry.isFile() &&
      SCANNED_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))
    )
      files.push(full);
  }
  return files;
}

/** Every module a file imports, re-exports, requires or dynamically imports, with its line. */
function specifiers(source: string): Array<{ specifier: string; line: number }> {
  const out: Array<{ specifier: string; line: number }> = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;
  for (const m of source.matchAll(pattern)) {
    out.push({ specifier: m[2] ?? '', line: source.slice(0, m.index).split('\n').length });
  }
  return out;
}

const rel = (abs: string) => relative(REPO_ROOT, abs).split(sep).join('/');
const isModule = (specifier: string, name: string) =>
  specifier === name || specifier.startsWith(`${name}/`);

describe('DESIGN-049 D-01 — Watch Companion import layering', () => {
  it('the scanner sees imports in every form it guards (a canary for the regex)', () => {
    const found = specifiers(
      [
        "import { a } from '@hnet/domain';",
        'import {\n  b,\n} from "@modelcontextprotocol/sdk/server/mcp.js";',
        `export * from '${PLEX_WRITE}';`,
        "import type { C } from '@hnet/domain/watch';",
        "const d = await import('@modelcontextprotocol/sdk/types.js');",
        "const e = require('@hnet/domain');",
        "import 'zod';",
      ].join('\n'),
    ).map((s) => s.specifier);
    expect(found).toEqual([
      '@hnet/domain',
      '@modelcontextprotocol/sdk/server/mcp.js',
      PLEX_WRITE,
      '@hnet/domain/watch',
      '@modelcontextprotocol/sdk/types.js',
      '@hnet/domain',
      'zod',
    ]);
  });

  it('packages/watch/src never imports @hnet/domain, the Plex write surface or the MCP SDK — only @hnet/db, drizzle-orm and zod', async () => {
    const files = await walk(WATCH_SRC);
    expect(files.length).toBeGreaterThan(10);
    const forbidden: string[] = [];
    const outsideD01: string[] = [];
    for (const file of files) {
      for (const { specifier, line } of specifiers(await readFile(file, 'utf8'))) {
        const at = `${rel(file)}:${line} → ${specifier}`;
        if (
          ['@hnet/domain', PLEX_WRITE, '@modelcontextprotocol/sdk'].some((m) =>
            isModule(specifier, m),
          )
        )
          forbidden.push(at);
        if (
          !specifier.startsWith('.') &&
          !['@hnet/db', 'drizzle-orm', 'zod'].some((m) => isModule(specifier, m))
        )
          outsideD01.push(at);
      }
    }
    expect(forbidden, 'forbidden imports in @hnet/watch').toEqual([]);
    expect(outsideD01, 'D-01: @hnet/watch imports @hnet/db, drizzle-orm and zod only').toEqual([]);
  });

  it('@modelcontextprotocol/sdk is imported only under packages/mcp/', async () => {
    const files = await walk(REPO_ROOT);
    const violations: string[] = [];
    let seenInMcp = 0;
    for (const file of files) {
      const path = rel(file);
      for (const { specifier, line } of specifiers(await readFile(file, 'utf8'))) {
        if (!isModule(specifier, '@modelcontextprotocol/sdk')) continue;
        if (path.startsWith('packages/mcp/')) seenInMcp += 1;
        else violations.push(`${path}:${line} → ${specifier}`);
      }
    }
    expect(violations, 'the MCP SDK outside packages/mcp').toEqual([]);
    // The scan reached the one legitimate importer.
    expect(seenInMcp).toBeGreaterThan(0);
  });
});
