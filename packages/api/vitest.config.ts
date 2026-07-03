import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Embedded Postgres boot (initdb + start + migrate) happens in beforeAll hooks;
    // generous timeouts cover cold caches and slow CI runners (ADR-010 C-05).
    hookTimeout: 180_000,
    testTimeout: 60_000,
  },
});
