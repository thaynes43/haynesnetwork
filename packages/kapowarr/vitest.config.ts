import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Pure fixture/stub tests — no embedded Postgres, no network (ADR-010: no live-API tests
    // in CI). The Kapowarr client tests drive an injected fetchImpl over canned responses.
  },
});
