// Playwright globalTeardown — mirror of global-setup, in reverse: dev server first
// (frees the app port), then the stub OIDC, then embedded Postgres (its stop() also
// removes the throwaway data dir).
import { rmSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import type { GlobalState } from './global-setup';
import { TMP_DIR } from './runtime-env';

async function killDev(dev: ChildProcess): Promise<void> {
  if (dev.exitCode !== null || dev.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    dev.once('exit', () => resolve());
    try {
      dev.kill('SIGTERM');
    } catch {
      resolve();
      return;
    }
    const escalate = setTimeout(() => {
      try {
        dev.kill('SIGKILL');
      } catch {
        // already gone
      }
    }, 5_000);
    escalate.unref();
  });
}

export default async function globalTeardown(): Promise<void> {
  const state = (globalThis as { __HNET_E2E_STATE__?: GlobalState }).__HNET_E2E_STATE__ ?? {};

  try {
    if (state.dev) await killDev(state.dev);
  } catch (err) {
    console.error('[e2e] dev server teardown failed', err);
  }

  try {
    await state.oidc?.stop();
  } catch (err) {
    console.error('[e2e] stub OIDC teardown failed', err);
  }

  try {
    await state.pg?.stop();
  } catch (err) {
    console.error('[e2e] embedded postgres teardown failed', err);
  }

  try {
    rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
