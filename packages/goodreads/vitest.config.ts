import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Pure fixture tests — no network (ADR-010). The RSS parser drives captured feed fixtures; the GB
    // client drives an injected fetchImpl over canned volume responses.
  },
});
