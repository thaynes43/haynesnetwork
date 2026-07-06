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

/**
 * Bazarr is NOT an *arr (ADR-016 / DESIGN-005 D-19) — it is the subtitle manager the
 * missing_subtitles Fix routes to. It has its own in-cluster service DNS default (verified:
 * `haynes-ops/.../apps/media/bazarr/app/helmrelease.yaml` service port 6767) and is kept out
 * of ARR_SERVICES so BAZARR_API_KEY never becomes a hard requirement of assertArrEnv (sync
 * never touches Bazarr).
 */
export const BAZARR_CLUSTER_URL_DEFAULT = 'http://bazarr.media.svc.cluster.local:6767';

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

export interface BazarrEnvConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * ADR-016 / DESIGN-005 D-19 — the Bazarr subtitle-fix env contract. Reads `BAZARR_URL`
 * (defaulting to the in-cluster service DNS) + `BAZARR_API_KEY` (required; never echoed —
 * same ArrConfigError shape as assertArrEnv). Separate from assertArrEnv so sync, which
 * never touches Bazarr, is not forced to carry BAZARR_API_KEY.
 */
export function assertBazarrEnv(
  env: Record<string, string | undefined> = process.env,
): BazarrEnvConfig {
  const baseUrl = env.BAZARR_URL?.trim() || BAZARR_CLUSTER_URL_DEFAULT;
  const apiKey = env.BAZARR_API_KEY?.trim() ?? '';
  if (!apiKey) throw new ArrConfigError(['BAZARR_API_KEY']);
  return { baseUrl, apiKey };
}
