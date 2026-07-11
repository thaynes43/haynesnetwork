import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Next's tsconfig sets `jsx: preserve` (Next transforms JSX itself), which vite's oxc transform
  // would honor — passing raw JSX through untransformed. Tests importing .tsx (the D-17
  // motd-markdown renderer) need the automatic runtime here instead.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    include: ['lib/__tests__/**/*.test.ts'],
  },
});
