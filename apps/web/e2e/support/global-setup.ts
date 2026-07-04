// Playwright globalSetup — a THIN consumer of the reusable stack harness
// (harness.ts boots embedded PG16 + migrations + stub OIDC + stub *arr + `next dev`;
// `pnpm dev:local` (apps/web/dev/local.ts) reuses the same modules interactively).
//
// The stack boots HERE, not via Playwright's `webServer` block: the webServer
// plugin starts BEFORE globalSetup (runner createGlobalSetupTasks ordering —
// donor lesson, todos-for-dues), so it would launch with a stale env, missing
// the embedded PG's DATABASE_URL and the stub's OIDC_DISCOVERY_URL that only
// exist once the harness has run.
import { rmSync } from 'node:fs';
import { startStack, type RunningStack } from './harness';
import { writeRuntimeEnv, TMP_DIR } from './env';

export interface GlobalState {
  stack?: RunningStack;
}

const state: GlobalState = {};
(globalThis as { __HNET_E2E_STATE__?: GlobalState }).__HNET_E2E_STATE__ = state;

export default async function globalSetup(): Promise<void> {
  rmSync(TMP_DIR, { recursive: true, force: true });

  const stack = await startStack();
  state.stack = stack;

  // Hand the composed env to the test workers: process.env for this process,
  // the on-disk copy for the workers (they don't reliably inherit these
  // mutations across Playwright versions).
  Object.assign(process.env, stack.env);
  writeRuntimeEnv(stack.env);

  console.log(
    `[e2e] ready: pg=${stack.env.DATABASE_URL} oidc=${stack.oidc.baseUrl} arr=${stack.arr.baseUrl} app=${stack.appUrl}`,
  );
}
