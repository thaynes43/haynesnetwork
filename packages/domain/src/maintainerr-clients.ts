// ADR-023 / DESIGN-010 D-01 — the Maintainerr client bundle the Trash orchestrators run against.
// `@hnet/arr/write`'s MaintainerrWriteClient is import-guarded to packages/domain (ADR-008 guard
// test — no other code path may construct a Maintainerr mutation client); packages/api receives
// this bundle as an opaque type and injects a fetch-stubbed bundle in tests.
import { ArrError, assertMaintainerrEnv } from '@hnet/arr';
import { MaintainerrClient } from '@hnet/arr/read';
import { MaintainerrWriteClient } from '@hnet/arr/write';
import { MaintainerrUpstreamError } from './errors';

export interface MaintainerrClientBundle {
  read: MaintainerrClient;
  write: MaintainerrWriteClient;
}

export interface MaintainerrBundleOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Build a Maintainerr bundle from explicit options. Production goes through
 * maintainerrClientBundleFromEnv; tests inject `fetchImpl` stubs here so no code outside
 * packages/domain ever imports @hnet/arr/write's MaintainerrWriteClient (the ADR-008 guard).
 */
export function buildMaintainerrClientBundle(
  options: MaintainerrBundleOptions,
): MaintainerrClientBundle {
  return {
    read: new MaintainerrClient(options),
    write: new MaintainerrWriteClient(options),
  };
}

/**
 * Build the Trash client bundle from the env contract (MAINTAINERR_URL default + MAINTAINERR_API_KEY
 * required — assertMaintainerrEnv throws one ArrConfigError naming the missing key).
 */
export function maintainerrClientBundleFromEnv(
  env: Record<string, string | undefined> = process.env,
): MaintainerrClientBundle {
  return buildMaintainerrClientBundle(assertMaintainerrEnv(env));
}

/**
 * Wrap a Maintainerr read/write call, mapping the shared @hnet/arr HTTP taxonomy (ArrError) to
 * MaintainerrUpstreamError (BAD_GATEWAY) — fail closed, exactly like guardArrCall for the *arrs.
 */
export async function guardMaintainerrCall<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ArrError) {
      throw new MaintainerrUpstreamError(`${what} failed: ${err.message}`, { cause: err });
    }
    throw err;
  }
}
