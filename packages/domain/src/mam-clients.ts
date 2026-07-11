// ADR-054 / DESIGN-027 (PLAN-039) — the MAM-governor client bundle the evaluator runs against.
// `@hnet/downloads/write` (the Prowlarr indexer `enable` toggle) is import-guarded to packages/domain (the
// arr-write-import-guard test, extended for `@hnet/downloads/write`): the sync mode receives this bundle as
// an opaque type and never constructs the write client itself. Mirrors plex-clients.ts / arr-clients.ts.
import { assertGovernorClientsEnv, type GovernorClientsConfig } from '@hnet/downloads';
import { QbittorrentClient, ProwlarrReadClient } from '@hnet/downloads/read';
import { ProwlarrWriteClient } from '@hnet/downloads/write';
import type { MamGovernorClients, MamGovernorTargets } from './mam-governor';

export interface MamGovernorBundle {
  clients: MamGovernorClients;
  targets: MamGovernorTargets;
}

/** Build the bundle from an already-resolved config (tests inject fetch-stubbed clients directly instead). */
export function buildMamGovernorBundle(config: GovernorClientsConfig): MamGovernorBundle {
  const qb = new QbittorrentClient({ baseUrl: config.qbittorrent.baseUrl });
  // The write client extends the read client, so a single instance serves both the enable readback and the
  // GET-then-PUT toggle — but the read surface is exposed through the read-typed methods only.
  const prowlarr = new ProwlarrWriteClient({
    baseUrl: config.prowlarr.baseUrl,
    apiKey: config.prowlarr.apiKey,
  });
  const prowlarrRead: ProwlarrReadClient = prowlarr;
  return {
    clients: {
      qb: { countUnsatisfied: (category) => qb.countUnsatisfied(category) },
      prowlarr: {
        getIndexerEnabled: (indexerId) => prowlarrRead.getIndexerEnabled(indexerId),
        setIndexerEnabled: (indexerId, enabled) => prowlarr.setIndexerEnabled(indexerId, enabled),
      },
    },
    targets: {
      category: config.qbittorrent.category,
      indexerId: config.prowlarr.indexerId,
    },
  };
}

/**
 * Build the MAM-governor bundle from the env contract (`QBITTORRENT_URL`/`QBITTORRENT_MAM_CATEGORY`,
 * `PROWLARR_URL`/`PROWLARR_MAM_INDEXER_ID` defaulted, and the REQUIRED `PROWLARR_API_KEY`). Missing key
 * throws one DownloadsConfigError naming it (never a value). qBittorrent needs no secret (its WebAPI
 * answers unauthenticated from the cluster pod network).
 */
export function mamGovernorBundleFromEnv(
  env: Record<string, string | undefined> = process.env,
): MamGovernorBundle {
  return buildMamGovernorBundle(assertGovernorClientsEnv(env));
}
