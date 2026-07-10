import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Pure client/read-model tests — stubbed fetch, no embedded Postgres, no network
    // (ADR-010: no live-API tests in CI). Default timeouts are plenty.
  },
});
