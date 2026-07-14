// PLAN-047 / ADR-058 / DESIGN-004 D-21 — executable proof of the card-anatomy guard (the
// arr-write-import-guard idiom, applied to markup). Three layers:
//
//   1. FIXTURE proof: the exact ESLint config apps/web/eslint.config.mjs wires
//      (lint/card-anatomy-guard.mjs) is run programmatically over violating fixtures — hand-rolled
//      card markup, a template-literal variant, a deep import of the package internals — and MUST
//      report errors; the sanctioned form (typed cards from the '@/components/cards' barrel) MUST
//      pass. If someone weakens the patterns, this test fails before CI's lint job even runs.
//   2. IMPORT-CONFINEMENT walk (the arr-write walker): no file outside components/cards may import
//      the package's internals — only the barrel.
//   3. The gallery e2e spec (e2e/card-gallery.spec.ts) asserts the rendered DOM shape — this file
//      guards the source; the spec guards the pixels/structure.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import {
  cardAnatomyRestrictedImports,
  cardAnatomyRestrictedSyntax,
} from '../../lint/card-anatomy-guard.mjs';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const linter = new Linter();
const lintConfig: Linter.Config = {
  files: ['**/*.ts', '**/*.tsx'],
  languageOptions: {
    parser: tsParser as Linter.Parser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  },
  rules: {
    'no-restricted-syntax': ['error', ...cardAnatomyRestrictedSyntax],
    'no-restricted-imports': ['error', cardAnatomyRestrictedImports],
  },
};

function lint(code: string): Linter.LintMessage[] {
  return linter.verify(code, lintConfig, { filename: 'fixture.tsx' });
}

describe('card-anatomy ESLint guard (PLAN-047 / ADR-058)', () => {
  it('FAILS a hand-rolled wall card (the PLAN-045 "Wanted strip" failure mode)', () => {
    const messages = lint(`
      export function RogueStrip({ items }: { items: Array<{ id: string; title: string }> }) {
        return (
          <div className="media-list poster-grid">
            {items.map((i) => (
              <div key={i.id} className="media-card poster-card">
                <span className="poster-box" />
                <span className="poster-card__body">
                  <span className="media-card__title">{i.title}</span>
                  <button type="button">Search again</button>
                </span>
              </div>
            ))}
          </div>
        );
      }
    `);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.severity === 2)).toBe(true);
  });

  it('FAILS the template-literal variant (dynamic class lists cannot smuggle anatomy in)', () => {
    const messages = lint(`
      export function Rogue({ on }: { on: boolean }) {
        return <li className={\`twall-tile\${on ? ' is-on' : ''}\`}>x</li>;
      }
    `);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('FAILS trash/ticket tile anatomy outside the package', () => {
    for (const cls of ['bwall-overlay', 'twall-poster', 'pwall-corner', 'glyph-tile']) {
      const messages = lint(`export const x = <span className="${cls}" />;`);
      expect(messages.length, cls).toBeGreaterThan(0);
    }
  });

  it('FAILS deep imports of the card package internals', () => {
    const messages = lint(`
      import { MediaPoster } from '@/components/cards/media-poster';
      export const y = MediaPoster;
    `);
    expect(messages.length).toBeGreaterThan(0);
  });

  it('PASSES the sanctioned form — typed cards from the barrel', () => {
    const messages = lint(`
      import { MediaCard, PosterGrid } from '@/components/cards';
      export function Wall({ items }: { items: Array<{ id: string; title: string }> }) {
        return (
          <PosterGrid>
            {items.map((i) => (
              <MediaCard key={i.id} href={'/library/' + i.id} posterUrl={null} kind="radarr" title={i.title} />
            ))}
          </PosterGrid>
        );
      }
    `);
    expect(messages).toEqual([]);
  });

  it('does NOT lock the detail-head badge-row idiom (media-card__badges stays page-level)', () => {
    const messages = lint(`export const row = <div className="media-card__badges" />;`);
    expect(messages).toEqual([]);
  });
});

// ── layer 2: the import-confinement walk (mirrors packages/domain arr-write-import-guard) ──

const IGNORE_DIRS = new Set(['node_modules', '.next', 'e2e', '__tests__', 'cards']);
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx']);
// A deep import names a module UNDER components/cards/ — the bare barrel path is sanctioned.
const DEEP_IMPORT = /from\s+['"][^'"]*components\/cards\/[^'"]+['"]/;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile() && SCANNED_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.'))))
      files.push(full);
  }
  return files;
}

describe('card package internals are import-confined (ADR-058)', () => {
  it('no deep import of components/cards/* outside the package', async () => {
    const files = [
      ...(await walk(join(WEB_ROOT, 'app'))),
      ...(await walk(join(WEB_ROOT, 'components'))),
      ...(await walk(join(WEB_ROOT, 'lib'))),
    ];
    expect(files.length).toBeGreaterThan(10); // the walk actually found the app
    const violations: string[] = [];
    for (const absPath of files) {
      const lines = (await readFile(absPath, 'utf8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (DEEP_IMPORT.test(lines[i]!)) {
          violations.push(`${relative(WEB_ROOT, absPath).split(sep).join('/')}:${i + 1}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
