import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';
import {
  cardAnatomyRestrictedImports,
  cardAnatomyRestrictedSyntax,
} from './lint/card-anatomy-guard.mjs';

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
  // must consume the typed card family from the '@/components/cards' barrel. e2e specs/support are
  // deliberately out of scope (they SELECT by these classes). Proven by
  // lib/__tests__/card-system-guard.test.ts (a violating fixture fails this exact config).
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    // components/cards IS the package; the guard's own test carries violating FIXTURES on purpose.
    ignores: ['components/cards/**', 'lib/__tests__/card-system-guard.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...cardAnatomyRestrictedSyntax],
      'no-restricted-imports': ['error', cardAnatomyRestrictedImports],
    },
  },
]);

export default eslintConfig;
