// Playwright globalTeardown — thin: the harness owns reverse-order teardown
// (dev server → stub OIDC → embedded Postgres, whose stop() also removes the
// throwaway data dir).
import { rmSync } from 'node:fs';
import type { GlobalState } from './global-setup';
import { TMP_DIR } from './env';

export default async function globalTeardown(): Promise<void> {
  const state = (globalThis as { __HNET_E2E_STATE__?: GlobalState }).__HNET_E2E_STATE__ ?? {};

  try {
    await state.stack?.stop();
  } catch (err) {
    console.error('[e2e] stack teardown failed', err);
  }

  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
