// DESIGN-005 D-18 — env contract for the four media-stack instances.
// URLs are non-secret config with in-cluster service-DNS defaults (D-01); API keys are
// secrets (ExternalSecret in-cluster, .env.local in dev — CLAUDE.md hard rule 7) and
// are REQUIRED: there is no key default and key values never appear in errors.
import { ArrConfigError } from './errors';

export const ARR_SERVICES = ['sonarr', 'radarr', 'lidarr', 'seerr'] as const;
export type ArrServiceName = (typeof ARR_SERVICES)[number];

/**
 * In-cluster service DNS defaults (verified live, DESIGN-005 D-01). Local dev overrides
 * with the LAN ingresses (`https://sonarr.haynesops.com` etc. — see .env.example);
 * those are backend config only and must never be shown to users (hard rule 3).
 */
export const ARR_CLUSTER_URL_DEFAULTS: Record<ArrServiceName, string> = {
  sonarr: 'http://sonarr.media.svc.cluster.local:8989',
  radarr: 'http://radarr.media.svc.cluster.local:7878',
  lidarr: 'http://lidarr.media.svc.cluster.local:8686',
  seerr: 'http://seerr.media.svc.cluster.local:5055',
};

export interface ArrInstanceConfig {
  baseUrl: string;
  apiKey: string;
}

export type ArrEnvConfig = Record<ArrServiceName, ArrInstanceConfig>;

/**
 * Read `SONARR_URL`/`SONARR_API_KEY` (+ RADARR_/LIDARR_/SEERR_) from `env`.
 * URLs default to the cluster service DNS; missing API keys throw a single
 * ArrConfigError naming every absent variable (values are never echoed).
 */
export function assertArrEnv(
  env: Record<string, string | undefined> = process.env,
): ArrEnvConfig {
  const missing: string[] = [];
  const config = {} as ArrEnvConfig;
  for (const service of ARR_SERVICES) {
    const prefix = service.toUpperCase();
    const baseUrl = env[`${prefix}_URL`]?.trim() || ARR_CLUSTER_URL_DEFAULTS[service];
    const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? '';
    if (!apiKey) missing.push(`${prefix}_API_KEY`);
    config[service] = { baseUrl, apiKey };
  }
  if (missing.length > 0) throw new ArrConfigError(missing);
  return config;
}
