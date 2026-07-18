import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Embedded Postgres boot (initdb + start + migrate) happens in beforeAll hooks;
    // generous timeouts cover cold caches and slow CI runners (ADR-010 C-05). Raised to 240s as the
    // embedded-PG suite count grew (PR4b) — many files boot their own PG in parallel, so a cold boot
    // under contention can exceed 180s; the extra headroom keeps the run deterministic.
    hookTimeout: 240_000,
    testTimeout: 60_000,
  },
});
