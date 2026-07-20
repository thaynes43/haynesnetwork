// ADR-072 / DESIGN-042 D-02 (PLAN-052 PR4b) — the haynes-ops git-write client bundle the Kometa
// collections orchestrator runs against. `@hnet/haynesops/write` is import-guarded to packages/domain (the
// ADR-017/ADR-055 discipline: no other code path may open/merge a haynes-ops PR — see the
// arr-write-import-guard test, extended for @hnet/haynesops/write); packages/api receives this bundle as an
// OPAQUE type and injects a fetch-stubbed client in tests (mirrors libretto-clients.ts). NEVER constructed
// in the browser.
import { assertHaynesopsEnv } from '@hnet/haynesops';
import { HaynesopsReadClient } from '@hnet/haynesops/read';
import { HaynesopsWriteClient } from '@hnet/haynesops/write';

export interface HaynesopsClientBundle {
  read: HaynesopsReadClient;
  write: HaynesopsWriteClient;
  /** The managed-config directory (repo-relative, no trailing slash) the app owns hnet-managed-*.yml in. */
  configDir: string;
  /** The branch PRs target + auto-merge into (the "merged" recipe source of truth). */
  baseBranch: string;
  /** The check-run name the auto-merge gate resolves against (DESIGN-042 D-10 — the named validate check). */
  kometaCheckName: string;
}

export interface HaynesopsBundleOptions {
  token: string;
  repo: string;
  baseBranch: string;
  configDir: string;
  apiBaseUrl: string;
  kometaCheckName: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * Build a bundle from explicit options. Production goes through haynesopsBundleFromEnv; tests inject a
 * `fetchImpl` stub here so no code outside packages/domain ever imports @hnet/haynesops/write (the guard).
 */
export function buildHaynesopsBundle(options: HaynesopsBundleOptions): HaynesopsClientBundle {
  const clientOptions = {
    token: options.token,
    apiBaseUrl: options.apiBaseUrl,
    repo: options.repo,
    baseBranch: options.baseBranch,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
  };
  return {
    read: new HaynesopsReadClient(clientOptions),
    write: new HaynesopsWriteClient(clientOptions),
    configDir: options.configDir,
    baseBranch: options.baseBranch,
    kometaCheckName: options.kometaCheckName,
  };
}

/**
 * Build the haynes-ops bundle from the env contract (`HAYNESOPS_WRITE_TOKEN` required + the non-secret
 * repo/branch/dir/api overrides). A missing token throws one HaynesopsConfigError naming the absent
 * variable (never its value). ⚠ The write token is NOT yet provisioned in the cluster — see
 * docs/ops/014-haynesops-collection-writes.md.
 */
export function haynesopsBundleFromEnv(
  env: Record<string, string | undefined> = process.env,
): HaynesopsClientBundle {
  const config = assertHaynesopsEnv(env);
  return buildHaynesopsBundle({
    token: config.token,
    repo: config.repo,
    baseBranch: config.baseBranch,
    configDir: config.configDir,
    apiBaseUrl: config.apiBaseUrl,
    kometaCheckName: config.kometaCheckName,
  });
}
