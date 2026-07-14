// ADR-056 (PLAN-046) — env contract for Kapowarr (the comics *arr, deployed by PLAN-023 in ns `downloads`).
// The URL is non-secret config with an in-cluster service-DNS default (Kapowarr runs in ns `downloads`,
// container `app`, API on :5656 — verified live 2026-07-14). The API key is a SECRET (ExternalSecret
// in-cluster from the `kapowarr` 1Password item, .env.local in dev — hard rule 7) and is REQUIRED: there is
// no default and the value never appears in errors. The app talks to Kapowarr's HTTP API READ + the confined
// write surface only. Kapowarr acquisition uses ITS OWN sources (GetComics DDL) — it is NEVER wired to
// MAM/qBittorrent/Prowlarr/the governor (PLAN-046 hard constraint).
import { KapowarrConfigError } from './errors';

/** In-cluster service DNS default (Kapowarr is ns `downloads`, container `app`, API on :5656). */
export const KAPOWARR_CLUSTER_URL_DEFAULT = 'http://kapowarr.downloads.svc.cluster.local:5656';

export interface KapowarrEnvConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Read `KAPOWARR_URL` (defaulted) + `KAPOWARR_API_KEY` (required) from `env`. A missing key throws a single
 * KapowarrConfigError naming the absent variable — the value is never echoed.
 */
export function assertKapowarrEnv(
  env: Record<string, string | undefined> = process.env,
): KapowarrEnvConfig {
  const missing: string[] = [];
  const apiKey = env.KAPOWARR_API_KEY?.trim() ?? '';
  if (!apiKey) missing.push('KAPOWARR_API_KEY');
  if (missing.length > 0) throw new KapowarrConfigError(missing);
  return {
    baseUrl: (env.KAPOWARR_URL?.trim() || KAPOWARR_CLUSTER_URL_DEFAULT).replace(/\/+$/, ''),
    apiKey,
  };
}
