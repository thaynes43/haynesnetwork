// DESIGN-005 D-18 — read-client construction for the runner. Unlike
// arrReadClientsFromEnv (which requires all four API keys), the CLI's --source filter
// means a run may only need one service's config, so clients are built per requested
// source; missing keys for the REQUESTED sources throw a single ArrConfigError naming
// every absent variable (values are never echoed).
import { ARR_CLUSTER_URL_DEFAULTS, ArrConfigError } from '@hnet/arr';
import { LidarrClient, RadarrClient, SeerrClient, SonarrClient } from '@hnet/arr/read';
import type { SyncSource } from '@hnet/db';

/** The (possibly partial) client set a sync run operates on. Tests inject stubs. */
export interface SyncClients {
  sonarr?: SonarrClient;
  radarr?: RadarrClient;
  lidarr?: LidarrClient;
  seerr?: SeerrClient;
}

const CLIENT_CTORS = {
  sonarr: SonarrClient,
  radarr: RadarrClient,
  lidarr: LidarrClient,
  seerr: SeerrClient,
} as const;

/**
 * Build read clients for exactly `sources` from the D-18 env contract
 * (`SONARR_URL`/`SONARR_API_KEY` + RADARR_/LIDARR_/SEERR_; URLs default to the
 * in-cluster service DNS).
 */
export function buildSyncClients(
  sources: readonly SyncSource[],
  env: Record<string, string | undefined> = process.env,
): SyncClients {
  const missing: string[] = [];
  const clients: SyncClients = {};
  for (const source of new Set(sources)) {
    const prefix = source.toUpperCase();
    const baseUrl = env[`${prefix}_URL`]?.trim() || ARR_CLUSTER_URL_DEFAULTS[source];
    const apiKey = env[`${prefix}_API_KEY`]?.trim() ?? '';
    if (!apiKey) {
      missing.push(`${prefix}_API_KEY`);
      continue;
    }
    // The union of ctor types collapses per-source; the keyed assignment is type-safe.
    clients[source] = new CLIENT_CTORS[source]({ baseUrl, apiKey }) as never;
  }
  if (missing.length > 0) throw new ArrConfigError(missing);
  return clients;
}

/** Narrow a possibly-absent client with a actionable error naming the source. */
export function requireClient<S extends SyncSource>(
  clients: SyncClients,
  source: S,
): NonNullable<SyncClients[S]> {
  const client = clients[source];
  if (!client) {
    throw new Error(`no ${source} client configured for this run`);
  }
  return client;
}
