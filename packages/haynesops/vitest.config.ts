import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Pure fixture/stub tests — no network (ADR-010: no live-API tests in CI). The git-write client
    // tests drive an injected fetchImpl over canned GitHub REST responses.
  },
});
