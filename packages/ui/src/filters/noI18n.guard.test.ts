// Guardrail (PLAN-018 recon): the shared filter components must be i18n-FREE. A stray
// `useTranslation('work')` left in a moved file silently passthrough-fails under a DIFFERENT host's
// i18n instance (it renders raw keys instead of throwing), so a unit test — not a human reviewer —
// is the durable guard. This asserts no shared `filters/` source imports or calls `useTranslation`.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('shared filters/ is i18n-free', () => {
  it('no non-test source imports or calls useTranslation', () => {
    const sources = readdirSync(here).filter(
      (f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('.test.'),
    );
    // sanity: we actually scanned the module (not an empty glob)
    expect(sources.length).toBeGreaterThan(0);
    // Flag a REAL coupling — a `react-i18next` import or a `useTranslation(` call — not a comment that
    // merely mentions the word (this module's own docs explain WHY it stays i18n-free).
    const couples = (src: string): boolean =>
      /from\s+['"]react-i18next['"]/.test(src) || /\buseTranslation\s*\(/.test(src);
    const offenders = sources.filter((f) => couples(readFileSync(join(here, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
