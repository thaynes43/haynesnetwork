import { defineConfig, devices } from '@playwright/test';

// ADR-010 e2e layer, amended by ADR-103: Playwright against one production `next build`
// served by `next start` (HNET_E2E_SERVER=dev opts into `next dev` for debugging) +
// embedded Postgres 16 + the stub OIDC provider — all booted in e2e/support/global-setup.ts (Playwright's
// `webServer` plugin starts BEFORE globalSetup, so it cannot see the embedded PG's
// DATABASE_URL; the donor repo hit the same ordering — see global-setup.ts).
//
// SERIAL on purpose (workers: 1, fullyParallel: false): the suite shares ONE app
// instance + ONE database whose rows are the personas' real state (repeat-login
// AC-03 depends on it), and specs mutate shared state (catalog entries, grants,
// tags) that parallel workers would race on. The stub's persona selection is also
// process-global. Household-scale suite — serial keeps it deterministic and it
// still completes in a few minutes.
export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/*.spec.ts'],
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // CI-only retry absorbs cold-runner jitter; real bugs reproduce locally with 0.
  retries: process.env.CI ? 1 : 0,
  // Per-test budget: 60s in CI (cold IO spikes), 30s locally. Sized for `next dev`'s cold
  // compiles, which the HNET_E2E_SERVER=dev opt-in still has.
  timeout: process.env.CI ? 60_000 : 30_000,
  // First-hit dev-server compile lag can exceed Playwright's 5s expect default
  // even after the globalSetup prewarm (the `next dev` opt-in).
  expect: { timeout: 15_000 },
  reporter: [
    ...(process.env.CI
      ? ([['list'], ['github'], ['html', { open: 'never' }]] as const)
      : ([['list']] as const)),
    // ADR-103 — per-test timings for e2e/support/timings-report.mjs (CI sets HNET_E2E_TIMINGS_DIR).
    ...(process.env.HNET_E2E_TIMINGS_DIR
      ? ([['json', { outputFile: `${process.env.HNET_E2E_TIMINGS_DIR}/results.json` }]] as const)
      : []),
  ],
  globalSetup: './e2e/support/global-setup.ts',
  globalTeardown: './e2e/support/global-teardown.ts',
  use: {
    // Keep in sync with DEFAULT_APP_PORT in e2e/support/env.ts (3100 so the
    // suite coexists with a locally running `pnpm dev` on 3000).
    baseURL: 'http://localhost:3100',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
