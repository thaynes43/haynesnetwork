import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Pure stub tests — no network (ADR-010). The group read/write client is driven by an injected fetch.
  },
});
