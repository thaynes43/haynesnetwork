import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Pure math only (PLAN-068 S4): no database, no network, no clock — every test passes `now`.
  },
});
