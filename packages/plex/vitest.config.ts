import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Pure fixture/stub tests — no embedded Postgres, no network (ADR-010: no live-API
    // tests in CI). XML parser + client tests drive captured plex.tv/PMS fixture snippets.
  },
});
