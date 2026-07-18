// ADR-071 / DESIGN-004 D-24 — executable proof of the action-anatomy guard (the card-system-guard
// idiom, for the media-action vocabulary). Four layers:
//
//   1. FIXTURE proof: the exact no-restricted-syntax entries apps/web/eslint.config.mjs wires
//      (lint/action-anatomy-guard.mjs) are run programmatically over VIOLATING fixtures — a
//      hand-rolled Fix button, a retired "Force re-search" label, an unknown <MediaAction action>
//      key, a bespoke `.btn__ext` consume link — each MUST report the actionable message; the
//      sanctioned forms (<MediaAction action="fix">, <ConsumeLink>) and legitimate non-action uses
//      (prose, the ADR-065 books pairing "Search for …" button, the inert Not-on-Disk pill, the
//      bulletin ticket transition buttons) MUST pass. If someone weakens a pattern, this fails
//      before CI's lint job runs.
//   2. REGISTRY PARITY: the guard's label/key MIRROR lists are asserted against the real @hnet/ui
//      MEDIA_ACTIONS / MEDIA_ACTION_TYPES — so the guard can never silently drift from the registry
//      (the "one label/variant per verb" lock; adding/renaming a verb forces a guard update).
//   3. REPO WALK: the guard is run over every live app/components/lib source file and MUST find zero
//      violations — the proof the tree is clean on main when the lock closes.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { MEDIA_ACTIONS, MEDIA_ACTION_TYPES } from '@hnet/ui';
import {
  actionAnatomyRestrictedSyntax,
  ACTION_ANATOMY_MESSAGES,
  CANONICAL_ACTION_LABELS,
  RETIRED_ACTION_LABELS,
  MEDIA_ACTION_KEYS,
} from '../../lint/action-anatomy-guard.mjs';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const linter = new Linter();
const lintConfig: Linter.Config = {
  files: ['**/*.ts', '**/*.tsx'],
  languageOptions: {
    parser: tsParser as Linter.Parser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  },
  // The real repo files carry inline eslint-disable directives for rules not in this minimal config
  // (react-hooks, @next/next); silence the "definition not found" churn so the walk sees only ours.
  linterOptions: { reportUnusedDisableDirectives: 'off' },
  rules: { 'no-restricted-syntax': ['error', ...actionAnatomyRestrictedSyntax] },
};

const GUARD_MESSAGES = new Set(Object.values(ACTION_ANATOMY_MESSAGES));
/** Messages from THIS guard only (ignore any unrelated linter chatter). */
function guardHits(code: string, filename = 'fixture.tsx'): Linter.LintMessage[] {
  return linter.verify(code, lintConfig, { filename }).filter((m) => GUARD_MESSAGES.has(m.message));
}

describe('action-anatomy ESLint guard — violations (ADR-071 / DESIGN-004 D-24)', () => {
  it('FAILS a hand-rolled green primary Fix button (the headline drift mode)', () => {
    const hits = guardHits(
      `export const X = () => <button type="button" className="btn primary">Fix</button>;`,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.message).toBe(ACTION_ANATOMY_MESSAGES.R1);
  });

  it('FAILS a hand-rolled Force Search / Retry import in a btn button (text and anchor)', () => {
    for (const code of [
      `export const X = () => <button className="btn sm">Force Search</button>;`,
      `export const X = () => <a className="btn">Retry import</a>;`,
      `export const X = () => <button className="btn">\n  Force Search\n</button>;`,
      `export const X = () => <button className={\`btn \${armed ? 'primary' : ''}\`}>Fix</button>;`,
    ]) {
      const hits = guardHits(code);
      expect(hits.length, code).toBeGreaterThan(0);
      expect(hits[0]!.message).toBe(ACTION_ANATOMY_MESSAGES.R1);
    }
  });

  it('FAILS an action smuggled via aria-label on an icon-only btn button', () => {
    const hits = guardHits(
      `export const X = () => <button className="btn" aria-label="Fix"><Icon /></button>;`,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.message).toBe(ACTION_ANATOMY_MESSAGES.R1);
  });

  it('FAILS every retired label variant ADR-071 normalized', () => {
    for (const label of RETIRED_ACTION_LABELS) {
      const hits = guardHits(
        `export const X = () => <button className="btn sm">${label}</button>;`,
      );
      expect(hits.length, label).toBeGreaterThan(0);
      expect(hits[0]!.message, label).toBe(ACTION_ANATOMY_MESSAGES.R2);
    }
  });

  it('FAILS an unknown key passed to <MediaAction action="…">', () => {
    for (const code of [
      `export const X = () => <MediaAction action="fixx" />;`,
      `export const X = () => <MediaAction action="search" onFire={f} />;`,
    ]) {
      const hits = guardHits(code);
      expect(hits.length, code).toBeGreaterThan(0);
      expect(hits[0]!.message).toBe(ACTION_ANATOMY_MESSAGES.R3);
    }
  });

  it('FAILS a hand-rolled .btn__ext consume ↗ link (string and template class)', () => {
    for (const code of [
      `export const X = () => <a className="btn primary" href={u}>Watch on Plex<span className="btn__ext"> ↗</span></a>;`,
      `export const X = () => <span className={\`btn__ext \${extra}\`}> ↗</span>;`,
    ]) {
      const hits = guardHits(code);
      expect(hits.length, code).toBeGreaterThan(0);
      expect(hits.some((h) => h.message === ACTION_ANATOMY_MESSAGES.R4)).toBe(true);
    }
  });

  it('every guard message names the fix (render through the @hnet/ui component)', () => {
    expect(ACTION_ANATOMY_MESSAGES.R1).toContain('<MediaAction');
    expect(ACTION_ANATOMY_MESSAGES.R2).toContain('<MediaAction');
    expect(ACTION_ANATOMY_MESSAGES.R3).toContain('MEDIA_ACTIONS');
    expect(ACTION_ANATOMY_MESSAGES.R4).toContain('<ConsumeLink');
  });
});

describe('action-anatomy ESLint guard — sanctioned + non-action forms pass', () => {
  it('PASSES the sanctioned <MediaAction> / <ConsumeLink> family', () => {
    for (const key of MEDIA_ACTION_TYPES) {
      expect(guardHits(`export const X = () => <MediaAction action="${key}" />;`), key).toEqual([]);
    }
    expect(
      guardHits(
        `export const X = () => <MediaAction action={dynamicKey} scopeLabel="Season 2" />;`,
      ),
    ).toEqual([]);
    expect(
      guardHits(`export const X = () => <ConsumeLink label="Watch on Plex — Movies" url={u} />;`),
    ).toEqual([]);
  });

  it('PASSES legitimate non-action uses of the action words (not btn buttons)', () => {
    for (const code of [
      // prose (about-content): the words in copy, inside a <strong>/<p>, not an interactive element
      `export const X = () => <p>Open the title and hit <strong>Fix</strong>. The <strong>Fix this</strong> button on a book.</p>;`,
      // section headings
      `export const X = () => <h1>Fix requests</h1>;`,
      `export const X = () => <h2>Fixes on this item</h2>;`,
      // the activity child-row LABEL span (a caption, not the button)
      `export const X = () => <span className="child-row__label">Force Search</span>;`,
      // the ADR-065 books pairing-backfill "Search for …" button (NOT a registry action — non-goal)
      `export const X = () => <button className="btn sm">Search for {missingLabel.toLowerCase()}</button>;`,
      // the bulletin ticket transition button (dynamic label expression, not a registry action)
      `export const X = () => <button className="btn sm">{transitionLabel(status, to)}</button>;`,
      // the shared inert Not-on-Disk pill (notOnDisk is excluded from label matching by design)
      `export const X = () => <button className="btn btn--missing" disabled>Not on Disk</button>;`,
      // a plain non-action btn link
      `export const X = () => <a className="btn sm" href={h}>view wanted status</a>;`,
    ]) {
      expect(guardHits(code), code).toEqual([]);
    }
  });
});

describe('action-anatomy guard mirrors the @hnet/ui registry (parity lock)', () => {
  it('the guard label MIRROR equals the ACTIVE-fire registry labels (fix/forceSearch/retryImport)', () => {
    const activeLabels = (['fix', 'forceSearch', 'retryImport'] as const).map(
      (t) => MEDIA_ACTIONS[t].label,
    );
    expect(new Set(CANONICAL_ACTION_LABELS)).toEqual(new Set(activeLabels));
    // consume (per-app label) and notOnDisk (inert pill) are deliberately NOT label-matched.
    expect(CANONICAL_ACTION_LABELS).not.toContain(MEDIA_ACTIONS.notOnDisk.label);
  });

  it('the guard key MIRROR equals MEDIA_ACTION_TYPES exactly', () => {
    expect(new Set(MEDIA_ACTION_KEYS)).toEqual(new Set(MEDIA_ACTION_TYPES));
    expect(MEDIA_ACTION_KEYS).toHaveLength(MEDIA_ACTION_TYPES.length);
  });

  it('no retired variant collides with a live canonical label', () => {
    for (const retired of RETIRED_ACTION_LABELS) {
      expect(CANONICAL_ACTION_LABELS, retired).not.toContain(retired);
    }
  });
});

// ── layer 3: the repo walk — zero live violations on the current tree ─────────────────────────────

const IGNORE_DIRS = new Set(['node_modules', '.next', 'e2e', '__tests__', 'cards']);
const SCANNED = new Set(['.ts', '.tsx']);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile() && SCANNED.has(entry.name.slice(entry.name.lastIndexOf('.'))))
      files.push(full);
  }
  return files;
}

describe('action-anatomy guard is clean on the live tree (ADR-071)', () => {
  it('no media-action anatomy violations across app/components/lib', async () => {
    const files = [
      ...(await walk(join(WEB_ROOT, 'app'))),
      ...(await walk(join(WEB_ROOT, 'components'))),
      ...(await walk(join(WEB_ROOT, 'lib'))),
    ];
    expect(files.length).toBeGreaterThan(10); // the walk actually found the app
    const violations: string[] = [];
    for (const absPath of files) {
      const code = await readFile(absPath, 'utf8');
      for (const m of guardHits(code, absPath)) {
        violations.push(`${relative(WEB_ROOT, absPath).split(sep).join('/')}:${m.line}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
