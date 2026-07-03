// Token contract test (ADR-005 C-01, DESIGN-004 test strategy): every shipped
// theme must define every REQUIRED_TOKEN — a missing token fails here, a rogue
// hex fails `pnpm lint:css`. The donor proved this with jsdom-rendered
// components; this workspace has no DOM package installed, so the same
// contract is proven by parsing tokens.css directly and backing the
// `getComputedStyle` global that `missingTokens()` consumes with the parsed
// cascade (theme block over :root, `var()` references resolved like a browser
// would — an unresolvable var() reads as empty, exactly as on a real element).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME,
  REQUIRED_TOKENS,
  THEMES,
  missingTokens,
} from '../src/theme/tokenContract';

const TOKENS_CSS = readFileSync(
  fileURLToPath(new URL('../src/theme/tokens.css', import.meta.url)),
  'utf8',
);

type Declarations = Map<string, string>;

/** Parse `selector { decls }` blocks (tokens.css is flat — no nesting). */
function parseBlocks(css: string): Map<string, Declarations> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = new Map<string, Declarations>();
  for (const match of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (match[1] ?? '').trim();
    const decls: Declarations = blocks.get(selector) ?? new Map();
    for (const decl of (match[2] ?? '').split(';')) {
      const colon = decl.indexOf(':');
      if (colon === -1) continue;
      decls.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
    }
    blocks.set(selector, decls);
  }
  return blocks;
}

/** Resolve `var(--x)` references against the merged cascade; '' if undefined. */
function resolve(value: string | undefined, decls: Declarations, depth = 0): string {
  if (value === undefined || depth > 10) return '';
  const ref = /^var\((--[\w-]+)\)$/.exec(value.trim());
  if (!ref) return value.trim();
  return resolve(decls.get(ref[1] ?? ''), decls, depth + 1);
}

/** The computed custom properties of `<html data-theme={theme}>`: theme block
 *  layered over :root, as the CSS cascade would apply them. */
function cascadeFor(theme: string): Declarations {
  const blocks = parseBlocks(TOKENS_CSS);
  const root = blocks.get(':root');
  const themed = blocks.get(`[data-theme='${theme}']`);
  expect(root, ':root structural block must exist in tokens.css').toBeDefined();
  expect(themed, `tokens.css must define a [data-theme='${theme}'] block`).toBeDefined();
  return new Map([...(root ?? []), ...(themed ?? [])]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('theme token contract (tokens.css × tokenContract.ts)', () => {
  it.each(THEMES.map((t) => [t] as const))('%s defines every required token', (theme) => {
    const cascade = cascadeFor(theme);
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => resolve(cascade.get(name), cascade),
    }));
    expect(missingTokens({} as Element)).toEqual([]);
  });

  it('ships exactly the hnet themes, defaulting to dark', () => {
    expect([...THEMES]).toEqual(['hnet-dark', 'hnet-light']);
    expect(DEFAULT_THEME).toBe('hnet-dark');
    expect(REQUIRED_TOKENS.length).toBeGreaterThan(0);
  });
});
