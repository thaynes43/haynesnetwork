// ADR-091 / DESIGN-050 D-01 — the package boundaries, as static analysis (the packages/mcp import-guard pattern):
// `@hnet/oauth` is PURE — at runtime it imports zod and node:crypto only; `@hnet/db` is allowed as `import type`
// (row shapes), never as a value, and it never imports drizzle, @hnet/domain, Better Auth or the MCP SDK. Also the
// Dockerfile deps-stage invariant: every workspace package's package.json is COPYed (a missing line fails only the
// release image build, which is not a required check).
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(PKG, '..', '..');

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(full)));
    else if (e.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Every import / export-from / dynamic import / require, with whether it is type-only. */
export function importsOf(source: string): Array<{ specifier: string; typeOnly: boolean }> {
  const out: Array<{ specifier: string; typeOnly: boolean }> = [];
  const re =
    /\b(import|export)\s+(type\s+)?[^'";]*?\bfrom\s*(['"])([^'"]+)\3|\bimport\s*(['"])([^'"]+)\5|\bimport\s*\(\s*(['"])([^'"]+)\7|\brequire\s*\(\s*(['"])([^'"]+)\9/g;
  for (const m of source.matchAll(re)) {
    const specifier = m[4] ?? m[6] ?? m[8] ?? m[10] ?? '';
    out.push({ specifier, typeOnly: Boolean(m[2]) });
  }
  return out;
}

describe('D-01 — @hnet/oauth is pure', () => {
  it('the scanner sees every import form (canary)', () => {
    expect(
      importsOf(
        [
          "import { z } from 'zod';",
          "import type {\n  A,\n} from '@hnet/db';",
          "import { b } from '@hnet/db';",
          "export * from './config';",
          "const x = await import('drizzle-orm');",
          "import 'side-effect';",
        ].join('\n'),
      ),
    ).toEqual([
      { specifier: 'zod', typeOnly: false },
      { specifier: '@hnet/db', typeOnly: true },
      { specifier: '@hnet/db', typeOnly: false },
      { specifier: './config', typeOnly: false },
      { specifier: 'drizzle-orm', typeOnly: false },
      { specifier: 'side-effect', typeOnly: false },
    ]);
  });

  it('src/ imports zod and node:crypto at runtime, @hnet/db only as types, and nothing else', async () => {
    const files = await sources(join(PKG, 'src'));
    expect(files.length).toBeGreaterThanOrEqual(7);
    const violations: string[] = [];
    for (const file of files) {
      for (const { specifier, typeOnly } of importsOf(await readFile(file, 'utf8'))) {
        if (specifier.startsWith('./')) continue;
        if (specifier === 'zod' || specifier === 'node:crypto') continue;
        if (specifier === '@hnet/db' && typeOnly) continue;
        violations.push(`${file.slice(PKG.length + 1)} → ${specifier}${typeOnly ? ' (type)' : ''}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('package.json depends on zod (and @hnet/db for types) only', async () => {
    const pkg = JSON.parse(await readFile(join(PKG, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@hnet/db', 'zod']);
  });
});

describe('the Dockerfile deps stage COPYs every workspace package.json', () => {
  it('apps/* and packages/* are all listed', async () => {
    const dockerfile = await readFile(join(REPO, 'Dockerfile'), 'utf8');
    const missing: string[] = [];
    for (const root of ['apps', 'packages']) {
      for (const e of await readdir(join(REPO, root), { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        try {
          await readFile(join(REPO, root, e.name, 'package.json'));
        } catch {
          continue;
        }
        const line = `COPY ${root}/${e.name}/package.json ${root}/${e.name}/package.json`;
        if (!dockerfile.includes(line)) missing.push(line);
      }
    }
    expect(missing).toEqual([]);
    expect(dockerfile).toContain('COPY packages/oauth/package.json packages/oauth/package.json');
  });
});
