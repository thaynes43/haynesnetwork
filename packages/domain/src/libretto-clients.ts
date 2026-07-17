// ADR-070 / DESIGN-043 (PLAN-052) — the Libretto client bundle the collections-manager orchestrator runs
// against. `@hnet/libretto/write` is import-guarded to packages/domain (the ADR-011/ADR-017 discipline: no
// other code path may push a content-pulling write — see the arr-write-import-guard test, extended for
// @hnet/libretto/write); packages/api receives this bundle as an OPAQUE type and injects fetch-stubbed
// clients in tests (mirrors lazylibrarian-clients.ts). NEVER constructed in the browser.
import { assertLibrettoEnv } from '@hnet/libretto';
import { LibrettoReadClient, type LibrettoClientOptions } from '@hnet/libretto/read';
import { LibrettoWriteClient } from '@hnet/libretto/write';

export type { LibrettoClientOptions };

export interface LibrettoClientBundle {
  read: LibrettoReadClient;
  write: LibrettoWriteClient;
}

/**
 * Build a bundle from explicit client options. Production goes through librettoBundleFromEnv; tests inject
 * a `fetchImpl` (+ `sleepImpl`) stub here so no code outside packages/domain ever imports
 * @hnet/libretto/write (the guard).
 */
export function buildLibrettoBundle(options: LibrettoClientOptions): LibrettoClientBundle {
  return {
    read: new LibrettoReadClient(options),
    write: new LibrettoWriteClient(options),
  };
}

/**
 * Build the Libretto bundle from the env contract (`LIBRETTO_URL` default to the in-cluster service DNS +
 * `LIBRETTO_API_KEY` required). A missing key throws one LibrettoConfigError naming the absent variable
 * (never its value).
 */
export function librettoBundleFromEnv(
  env: Record<string, string | undefined> = process.env,
): LibrettoClientBundle {
  const config = assertLibrettoEnv(env);
  return buildLibrettoBundle({ baseUrl: config.baseUrl, apiKey: config.apiKey });
}
