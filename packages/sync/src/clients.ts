// DESIGN-005 D-18 — read-client construction for the runner. Unlike
// arrReadClientsFromEnv (which requires all four API keys), the CLI's --source filter
// means a run may only need one service's config, so clients are built per requested
// source; missing keys for the REQUESTED sources throw a single ArrConfigError naming
// every absent variable (values are never echoed).
import {
  ARR_CLUSTER_URL_DEFAULTS,
  ArrConfigError,
  resolveMaintainerrConfig,
  resolveTautulliInstances,
  resolveTmdbConfig,
  resolveTvdbConfig,
} from '@hnet/arr';
import {
  LidarrClient,
  MaintainerrClient,
  RadarrClient,
  SeerrClient,
  SonarrClient,
  TautulliClient,
  TmdbClient,
  TvdbClient,
} from '@hnet/arr/read';
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

// ADR-018 / DESIGN-008 — the OPTIONAL metadata-harvest source clients (Tautulli ×N, TMDB,
// TVDB, Maintainerr). Every one is skip-if-absent (per-source degradation, D-03): a config
// with none of these set yields an empty bundle and the harvest still lands the *arr tier.

export interface TautulliInstanceClient {
  /** the estate server this Tautulli tracks (used as the per-instance breakdown key). */
  slug: string;
  client: TautulliClient;
}

export interface MetadataSourceClients {
  tautulli: TautulliInstanceClient[];
  tmdb?: TmdbClient;
  tvdb?: TvdbClient;
  maintainerr?: MaintainerrClient;
}

/** ADR-035 — the OPTIONAL Maintainerr READ handle the full/incremental modes use to refresh the
 *  Trash candidate snapshot post-step. Skip-if-absent like every metadata tier: neither
 *  MAINTAINERR_URL nor MAINTAINERR_API_KEY set ⇒ undefined and the refresh step is skipped. */
export function buildOptionalMaintainerrRead(
  env: Record<string, string | undefined> = process.env,
): { read: MaintainerrClient } | undefined {
  const config = resolveMaintainerrConfig(env);
  return config ? { read: new MaintainerrClient(config) } : undefined;
}

/** Build the metadata-source clients from env — each tier included only when configured. */
export function buildMetadataSourceClients(
  env: Record<string, string | undefined> = process.env,
): MetadataSourceClients {
  const tautulli = resolveTautulliInstances(env).map((inst) => ({
    slug: inst.slug,
    client: new TautulliClient({ baseUrl: inst.baseUrl, apiKey: inst.apiKey }),
  }));
  const tmdbConfig = resolveTmdbConfig(env);
  const tvdbConfig = resolveTvdbConfig(env);
  const maintainerrConfig = resolveMaintainerrConfig(env);
  return {
    tautulli,
    ...(tmdbConfig ? { tmdb: new TmdbClient(tmdbConfig) } : {}),
    ...(tvdbConfig ? { tvdb: new TvdbClient(tvdbConfig) } : {}),
    ...(maintainerrConfig ? { maintainerr: new MaintainerrClient(maintainerrConfig) } : {}),
  };
}
