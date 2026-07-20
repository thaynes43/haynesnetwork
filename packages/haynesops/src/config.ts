// ADR-072 / DESIGN-042 D-02 (PLAN-052 PR4b) — env contract for the confined haynes-ops git-write client.
//
// The repo slug + base branch + managed-config directory are non-secret config with sensible defaults
// (the live haynes-ops layout, read this session). The WRITE TOKEN is a SECRET (hard rule 7): a GitHub App
// installation token / fine-grained PAT with `contents:write` + `pull_requests:write` on the haynes-ops
// repo, delivered as an ExternalSecret in-cluster and `.env.local` in dev. It is REQUIRED for any write and
// has NO default; its value never appears in an error.
//
// ⚠ RUNTIME SECRET NOT YET PROVISIONED — see docs/ops/014-haynesops-collection-writes.md. The app has no
// existing runtime credential to write the haynes-ops repo (the dev-env bot token is an agent/CI credential,
// not an app-pod secret). This module reads `HAYNESOPS_WRITE_TOKEN`; wiring the ExternalSecret is a
// prerequisite for the Kometa write path to function in the cluster.
import { HaynesopsConfigError } from './errors';

/** The GitOps repo the Kometa managed include lives in (owner/name). */
export const HAYNESOPS_REPO_DEFAULT = 'thaynes43/haynes-ops';
/** The branch PRs target + auto-merge into. */
export const HAYNESOPS_BASE_BRANCH_DEFAULT = 'main';
/** Where the Kometa `collection_files` live in haynes-ops (the app owns hnet-managed-*.yml inside it). */
export const HAYNESOPS_KOMETA_CONFIG_DIR_DEFAULT = 'kubernetes/main/apps/media/kometa/app/config';
/** GitHub REST base — overridable for GHES / a test stub. */
export const GITHUB_API_URL_DEFAULT = 'https://api.github.com';
/** The head-branch namespace every app-authored collection PR uses (the auto-merge diff-scope anchor). */
export const HAYNESOPS_BRANCH_PREFIX = 'hnet-collections';
/**
 * The name of the ONE check-run that IS the auto-merge gate (DESIGN-042 D-09/D-10). A haynes-ops PR head
 * carries the full Flux Local matrix + Diff Scope too; the app gates on THIS check by name and ignores the
 * rest (the `.github/workflows/kometa-validate-managed.yaml` job name). Path-filtered (managed-include PRs
 * only) so it is NOT a branch-protection required check — the app is the gate enforcer, not GitHub.
 */
export const HAYNESOPS_KOMETA_CHECK_NAME_DEFAULT = 'Kometa Validate Managed Files - Success';

export interface HaynesopsEnvConfig {
  token: string;
  /** `owner/repo`. */
  repo: string;
  baseBranch: string;
  /** Directory (no trailing slash) the managed include files live in. */
  configDir: string;
  apiBaseUrl: string;
  /** The check-run name the auto-merge gate resolves against (the `--validate-file` CI gate — D-10). */
  kometaCheckName: string;
}

/**
 * Read the haynes-ops git-write env: `HAYNESOPS_WRITE_TOKEN` (required; never echoed) plus the optional,
 * non-secret repo/branch/dir/api overrides. A missing token throws a single HaynesopsConfigError naming the
 * absent variable.
 */
export function assertHaynesopsEnv(
  env: Record<string, string | undefined> = process.env,
): HaynesopsEnvConfig {
  const missing: string[] = [];
  const token = env.HAYNESOPS_WRITE_TOKEN?.trim() ?? '';
  if (!token) missing.push('HAYNESOPS_WRITE_TOKEN');
  if (missing.length > 0) throw new HaynesopsConfigError(missing);
  return {
    token,
    repo: env.HAYNESOPS_REPO?.trim() || HAYNESOPS_REPO_DEFAULT,
    baseBranch: env.HAYNESOPS_BASE_BRANCH?.trim() || HAYNESOPS_BASE_BRANCH_DEFAULT,
    configDir: (
      env.HAYNESOPS_KOMETA_CONFIG_DIR?.trim() || HAYNESOPS_KOMETA_CONFIG_DIR_DEFAULT
    ).replace(/\/+$/, ''),
    apiBaseUrl: (env.GITHUB_API_URL?.trim() || GITHUB_API_URL_DEFAULT).replace(/\/+$/, ''),
    kometaCheckName: env.HAYNESOPS_KOMETA_CHECK_NAME?.trim() || HAYNESOPS_KOMETA_CHECK_NAME_DEFAULT,
  };
}
