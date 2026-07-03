// DESIGN-005 D-14 — full sync for one *arr instance: profile/tag lookups, unpaged item
// list, batched domain upserts (external-id re-match inside upsertMediaItemsBatch),
// then the tombstone pass with the mass-tombstone guard (MassTombstoneAbortedError
// propagates so the orchestrator can record the run as 'aborted').
import type { ArrKind, DbClient } from '@hnet/db';
import { tombstoneMissingItems, upsertMediaItemsBatch, type MediaItemSyncFields } from '@hnet/domain';
import { adaptLidarrArtist, adaptRadarrMovie, adaptSonarrSeries, buildLookupMaps } from './adapt';
import { requireClient, type SyncClients } from './clients';
import type { SyncLogger } from './logger';

/** D-14: batched upserts, 500 per transaction. */
export const UPSERT_BATCH_SIZE = 500;

export interface ArrFullSyncInput {
  db: DbClient;
  clients: SyncClients;
  arrKind: ArrKind;
  arrInstanceId: string;
  /** --force-tombstones (Q-03): skip the mass-tombstone guard. */
  forceTombstones: boolean;
  logger: SyncLogger;
  batchSize?: number;
}

export interface ArrFullSyncStats extends Record<string, unknown> {
  itemsSeen: number;
  inserted: number;
  updated: number;
  rematched: number;
  tombstoned: number;
  liveCount: number;
}

/** Fetch + adapt the instance's full item list (D-14 steps 1-2 + the D-02 adapters). */
async function fetchAdaptedItems(
  clients: SyncClients,
  arrKind: ArrKind,
): Promise<MediaItemSyncFields[]> {
  switch (arrKind) {
    case 'sonarr': {
      const client = requireClient(clients, 'sonarr');
      const [profiles, tags, series] = await Promise.all([
        client.listQualityProfiles(),
        client.listTags(),
        client.listSeries(),
      ]);
      const maps = buildLookupMaps(profiles, tags);
      return series.map((s) => adaptSonarrSeries(s, maps));
    }
    case 'radarr': {
      const client = requireClient(clients, 'radarr');
      const [profiles, tags, movies] = await Promise.all([
        client.listQualityProfiles(),
        client.listTags(),
        client.listMovies(),
      ]);
      const maps = buildLookupMaps(profiles, tags);
      return movies.map((m) => adaptRadarrMovie(m, maps));
    }
    case 'lidarr': {
      const client = requireClient(clients, 'lidarr');
      const [profiles, tags, artists] = await Promise.all([
        client.listQualityProfiles(),
        client.listTags(),
        client.listArtists(),
      ]);
      const maps = buildLookupMaps(profiles, tags);
      return artists.map((a) => adaptLidarrArtist(a, maps));
    }
  }
}

export async function runArrFullSync(input: ArrFullSyncInput): Promise<ArrFullSyncStats> {
  const { db, arrKind, arrInstanceId, logger } = input;
  const batchSize = input.batchSize ?? UPSERT_BATCH_SIZE;

  const items = await fetchAdaptedItems(input.clients, arrKind);
  logger.info('full sync: fetched item list', {
    source: arrKind,
    arrInstanceId,
    itemsSeen: items.length,
  });

  let inserted = 0;
  let updated = 0;
  let rematched = 0;
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const batch = items.slice(offset, offset + batchSize);
    const result = await upsertMediaItemsBatch({ db, arrKind, arrInstanceId, items: batch });
    inserted += result.inserted;
    updated += result.updated;
    rematched += result.rematched;
  }

  // D-14 steps 4-5: tombstone pass; the guard throws MassTombstoneAbortedError with
  // nothing written unless forced — the caller records the run as 'aborted'.
  const tombstoneResult = await tombstoneMissingItems({
    db,
    arrKind,
    arrInstanceId,
    seenArrItemIds: items.map((item) => item.arrItemId),
    force: input.forceTombstones,
  });
  if (tombstoneResult.tombstoned > 0) {
    logger.warn('full sync: tombstoned items missing from the *arr', {
      source: arrKind,
      arrInstanceId,
      tombstoned: tombstoneResult.tombstoned,
      liveCount: tombstoneResult.liveCount,
      forced: input.forceTombstones,
    });
  }

  return {
    itemsSeen: items.length,
    inserted,
    updated,
    rematched,
    tombstoned: tombstoneResult.tombstoned,
    liveCount: tombstoneResult.liveCount,
  };
}
