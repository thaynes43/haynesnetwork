// ADR-055 / DESIGN-028 (PLAN-044) — the LazyLibrarian client bundle the goodreads-sync orchestrator +
// the manual re-search run against. `@hnet/lazylibrarian/write` is import-guarded to packages/domain (the
// ADR-011/ADR-017 discipline: no other code path may push an acquisition write — see the
// arr-write-import-guard test, extended for @hnet/lazylibrarian/write); packages/api + packages/sync
// receive this bundle as an OPAQUE type and inject fetch-stubbed clients in tests (mirrors plex-clients.ts).
import { assertLazyLibrarianEnv } from '@hnet/lazylibrarian';
import {
  LazyLibrarianReadClient,
  type LazyLibrarianClientOptions,
} from '@hnet/lazylibrarian/read';
import { LazyLibrarianWriteClient } from '@hnet/lazylibrarian/write';

export type { LazyLibrarianClientOptions };

export interface LazyLibrarianClientBundle {
  read: LazyLibrarianReadClient;
  write: LazyLibrarianWriteClient;
}

/**
 * Build a bundle from explicit client options. Production goes through lazyLibrarianBundleFromEnv; tests
 * inject a `fetchImpl` (+ `sleepImpl`) stub here so no code outside packages/domain ever imports
 * @hnet/lazylibrarian/write (the guard).
 */
export function buildLazyLibrarianBundle(
  options: LazyLibrarianClientOptions,
): LazyLibrarianClientBundle {
  return {
    read: new LazyLibrarianReadClient(options),
    write: new LazyLibrarianWriteClient(options),
  };
}

/**
 * Build the LazyLibrarian bundle from the env contract (`LAZYLIBRARIAN_URL` default to the in-cluster
 * service DNS + `LAZYLIBRARIAN_API_KEY` required). A missing key throws one LazyLibrarianConfigError
 * naming the absent variable (never its value).
 */
export function lazyLibrarianBundleFromEnv(
  env: Record<string, string | undefined> = process.env,
): LazyLibrarianClientBundle {
  const config = assertLazyLibrarianEnv(env);
  return buildLazyLibrarianBundle({ baseUrl: config.baseUrl, apiKey: config.apiKey });
}
