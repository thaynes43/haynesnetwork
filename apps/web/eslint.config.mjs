import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import {
  cardAnatomyRestrictedImports,
  cardAnatomyRestrictedSyntax,
} from './lint/card-anatomy-guard.mjs';
import { actionAnatomyRestrictedSyntax } from './lint/action-anatomy-guard.mjs';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
  ]),
  // PLAN-047 / ADR-058 — the card-anatomy guard: wall-card markup (poster cards/grids, trash/ticket
  // tiles, corner pucks) exists ONLY inside components/cards; every other app/components/lib file
  // must consume the typed card family from the '@/components/cards' barrel.
  // ADR-071 / DESIGN-004 D-24 — the action-anatomy guard (spread in alongside): a per-item media
  // action (Fix / Force Search / Retry import / consume) is rendered ONLY through the sealed @hnet/ui
  // family (<MediaAction> off MEDIA_ACTIONS, <ConsumeLink>) — a hand-rolled action button, a retired
  // label, an unknown registry key, or a bespoke .btn__ext consume link is an error. Both guards
  // share this ONE no-restricted-syntax rule (a flat-config rule id is replaced, not merged, per
  // matching file — so the two selector sets must live in the same array).
  // e2e specs/support are deliberately out of scope (they SELECT by these classes). Proven by
  // lib/__tests__/card-system-guard.test.ts and lib/__tests__/action-system-guard.test.ts (violating
  // fixtures fail this exact config).
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    // components/cards IS the card package; each guard's own test carries violating FIXTURES on purpose.
    ignores: [
      'components/cards/**',
      'lib/__tests__/card-system-guard.test.ts',
      'lib/__tests__/action-system-guard.test.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...cardAnatomyRestrictedSyntax,
        ...actionAnatomyRestrictedSyntax,
      ],
      'no-restricted-imports': ['error', cardAnatomyRestrictedImports],
    },
  },
]);

export default eslintConfig;
