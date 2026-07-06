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

// ---------------------------------------------------------------------------
// ADR-018 / DESIGN-008 — metadata-harvest source config (Tautulli ×3, TMDB, TVDB,
// Maintainerr). ALL are OPTIONAL (per-source degradation, D-03): a tier whose key is
// absent is skipped with one log line — local dev boots with none of them set. None of
// these is in ARR_SERVICES, so assertArrEnv never requires them (sync/fix never touch them).
// ---------------------------------------------------------------------------

export interface TautulliInstanceConfig {
  /** the estate server this Tautulli tracks (matches PLEX_SERVER_SLUGS). */
  slug: string;
  baseUrl: string;
  apiKey: string;
}

/**
 * The three Tautulli instances across the estate (cross-server watch history addendum):
 * HaynesOps (PlexOps) + HaynesKube (K8Plex) are in-cluster Services; HaynesTower is the
 * legacy external box (no cluster default — its URL must be supplied when its key is set).
 * Verified live 2026-07-06: tautulli.media / tautulli-k8plex.media on :8181.
 */
export const TAUTULLI_INSTANCES = [
  {
    slug: 'haynesops',
    urlEnv: 'TAUTULLI_URL',
    keyEnv: 'TAUTULLI_API_KEY',
    urlDefault: 'http://tautulli.media.svc.cluster.local:8181',
  },
  {
    slug: 'hayneskube',
    urlEnv: 'TAUTULLI_K8PLEX_URL',
    keyEnv: 'TAUTULLI_K8PLEX_API_KEY',
    urlDefault: 'http://tautulli-k8plex.media.svc.cluster.local:8181',
  },
  {
    slug: 'haynestower',
    urlEnv: 'TAUTULLI_HAYNESTOWER_URL',
    keyEnv: 'TAUTULLI_HAYNESTOWER_API_KEY',
    urlDefault: undefined, // external legacy box — URL is required when the key is present
  },
] as const;

/**
 * Resolve the ACTIVE Tautulli instances: an instance is active only when its API key is set
 * (and, for HaynesTower, a URL too, since it has no cluster default). Absent keys ⇒ that
 * instance is simply omitted — the harvest logs the skip and continues (D-03/D-04).
 */
export function resolveTautulliInstances(
  env: Record<string, string | undefined> = process.env,
): TautulliInstanceConfig[] {
  const out: TautulliInstanceConfig[] = [];
  for (const inst of TAUTULLI_INSTANCES) {
    const apiKey = env[inst.keyEnv]?.trim() ?? '';
    if (!apiKey) continue;
    const baseUrl = env[inst.urlEnv]?.trim() || inst.urlDefault;
    if (!baseUrl) continue; // key set but no URL/default (haynestower) — cannot reach; skip
    out.push({ slug: inst.slug, baseUrl, apiKey });
  }
  return out;
}

export interface TmdbConfig {
  /** v4 read-access bearer token (preferred) OR undefined when only the v3 key is set. */
  readAccessToken?: string;
  /** v3 API key (query param) — used when no v4 bearer is present. */
  apiKey?: string;
}

/** TMDB direct fallback config (holes/tombstoned rows only, D-05). Null ⇒ tier skipped. */
export function resolveTmdbConfig(
  env: Record<string, string | undefined> = process.env,
): TmdbConfig | null {
  const readAccessToken = env.TMDB_API_READ_ACCESS_TOKEN?.trim();
  const apiKey = env.TMDB_API_KEY?.trim();
  if (readAccessToken) return { readAccessToken };
  if (apiKey) return { apiKey };
  return null;
}

export interface TvdbConfig {
  apiKey: string;
}

/** TVDB v4 direct fallback config (D-05). Null ⇒ tier skipped. */
export function resolveTvdbConfig(
  env: Record<string, string | undefined> = process.env,
): TvdbConfig | null {
  const apiKey = env.TVDB_API_KEY?.trim();
  return apiKey ? { apiKey } : null;
}

export const MAINTAINERR_CLUSTER_URL_DEFAULT = 'http://maintainerr.media.svc.cluster.local:6246';

export interface MaintainerrConfig {
  baseUrl: string;
  apiKey?: string;
}

/**
 * Maintainerr best-effort config (D-06). Opt-in: enabled only when MAINTAINERR_URL or
 * MAINTAINERR_API_KEY is set (so a Maintainerr-less local/dev boot skips the tier cleanly).
 * The URL defaults to the in-cluster Service DNS; the API key is optional (verified live:
 * Maintainerr's read API answered without a key 2026-07-06). Null ⇒ tier skipped.
 */
export function resolveMaintainerrConfig(
  env: Record<string, string | undefined> = process.env,
): MaintainerrConfig | null {
  const url = env.MAINTAINERR_URL?.trim();
  const apiKey = env.MAINTAINERR_API_KEY?.trim();
  if (!url && !apiKey) return null;
  return { baseUrl: url || MAINTAINERR_CLUSTER_URL_DEFAULT, ...(apiKey ? { apiKey } : {}) };
}

export interface MaintainerrWriteConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * ADR-023 / DESIGN-010 D-01 — the Trash section's Maintainerr config, where the API key is
 * REQUIRED (Maintainerr's WRITE endpoints need x-api-key). URL defaults to the in-cluster Service
 * DNS (EXEMPT server-side base URL, like the *arrs); a missing MAINTAINERR_API_KEY throws one
 * ArrConfigError naming it (never echoed). Distinct from resolveMaintainerrConfig (the OPTIONAL,
 * key-less-tolerant harvest tier) so the Trash bundle fails loud when the secret is absent.
 */
export function assertMaintainerrEnv(
  env: Record<string, string | undefined> = process.env,
): MaintainerrWriteConfig {
  const baseUrl = env.MAINTAINERR_URL?.trim() || MAINTAINERR_CLUSTER_URL_DEFAULT;
  const apiKey = env.MAINTAINERR_API_KEY?.trim() ?? '';
  if (!apiKey) throw new ArrConfigError(['MAINTAINERR_API_KEY']);
  return { baseUrl, apiKey };
}
