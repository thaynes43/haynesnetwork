import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Pure stub tests — no network (ADR-010: no live-API tests in CI). The read/write client
    // tests drive an injected fetch stub against captured Authentik API response shapes.
  },
});
