// DESIGN-005 D-14 — incremental history polling for one *arr instance:
// `GET /history/since?date=<cursor>` when a cursor exists; first run falls back to the
// paged `GET /history` feed walked newest-first until the cursor (bounded — see
// MAX_HISTORY_PAGES). Records are normalized per the D-07 map and ingested through
// ingestLedgerEvents, which advances sync_state.history_cursor in the SAME transaction
// — a mid-run failure before that commit leaves the cursor untouched, so the next run
// refetches and the (source, source_event_id) dedupe index makes re-delivery a no-op.
import type { ArrKind, DbClient } from '@hnet/db';
import { ingestLedgerEvents, type LedgerEventInput } from '@hnet/domain';
import { requireClient, type SyncClients } from './clients';
import { mediaItemIdsByArrItemId, readHistoryCursor } from './db-reads';
import type { SyncLogger } from './logger';
import {
  historyRecordToLedgerEvent,
  historyTargetArrItemId,
  type ArrHistoryRecord,
} from './normalize';

export const HISTORY_PAGE_SIZE = 100;
/**
 * Bootstrap bound: a cursor-less first run walks at most this many pages of the paged
 * feed (newest-first), so a decades-deep history can't wedge the CronJob. The newest
 * records land, the cursor is set, and every later run is a cheap /history/since poll.
 */
export const MAX_HISTORY_PAGES = 100;

export interface ArrIncrementalSyncInput {
  db: DbClient;
  clients: SyncClients;
  arrKind: ArrKind;
  arrInstanceId: string;
  logger: SyncLogger;
  pageSize?: number;
  maxPages?: number;
}

export interface ArrIncrementalSyncStats extends Record<string, unknown> {
  recordsFetched: number;
  eventsIngested: number;
  /** Overlap re-deliveries skipped by the (source, source_event_id) dedupe index. */
  eventsDeduped: number;
  /** Raw eventTypes outside the D-07 map (renames, ignored, …) — no ledger event. */
  eventsDropped: number;
  cursor: string | null;
  bootstrapTruncated: boolean;
}

function arrClient(clients: SyncClients, arrKind: ArrKind) {
  switch (arrKind) {
    case 'sonarr':
      return requireClient(clients, 'sonarr');
    case 'radarr':
      return requireClient(clients, 'radarr');
    case 'lidarr':
      return requireClient(clients, 'lidarr');
  }
}

/** Walk the paged history feed (sorted date-descending) until `cursor` or the bound. */
async function pagedHistoryWalk(
  client: ReturnType<typeof arrClient>,
  cursor: Date | null,
  pageSize: number,
  maxPages: number,
): Promise<{ records: ArrHistoryRecord[]; truncated: boolean }> {
  const records: ArrHistoryRecord[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const result = await client.getHistory({ page, pageSize });
    if (result.records.length === 0) return { records, truncated: false };
    for (const record of result.records) {
      if (cursor !== null && Date.parse(record.date) <= cursor.getTime()) {
        return { records, truncated: false }; // descending feed reached the cursor
      }
      records.push(record);
    }
    if (page * pageSize >= result.totalRecords) return { records, truncated: false };
  }
  return { records, truncated: true };
}

export async function runArrIncrementalSync(
  input: ArrIncrementalSyncInput,
): Promise<ArrIncrementalSyncStats> {
  const { db, arrKind, arrInstanceId, logger } = input;
  const client = arrClient(input.clients, arrKind);

  const cursor = await readHistoryCursor(db, arrKind);
  let records: ArrHistoryRecord[];
  let bootstrapTruncated = false;
  if (cursor !== null) {
    records = await client.getHistorySince(cursor);
  } else {
    // First run (no cursor): bounded newest-first walk of the paged feed (D-14).
    const walk = await pagedHistoryWalk(
      client,
      cursor,
      input.pageSize ?? HISTORY_PAGE_SIZE,
      input.maxPages ?? MAX_HISTORY_PAGES,
    );
    records = walk.records;
    bootstrapTruncated = walk.truncated;
    if (walk.truncated) {
      logger.warn('incremental sync: bootstrap walk hit the page bound; older history skipped', {
        source: arrKind,
        arrInstanceId,
        recordsFetched: records.length,
      });
    }
  }

  // Resolve targets → media_items FKs, normalize per D-07 (dropped types → no event).
  const itemIdMap = await mediaItemIdsByArrItemId(
    db,
    arrKind,
    arrInstanceId,
    records.map((record) => historyTargetArrItemId(arrKind, record)),
  );
  const events: LedgerEventInput[] = [];
  for (const record of records) {
    const event = historyRecordToLedgerEvent(record, {
      arrKind,
      arrInstanceId,
      mediaItemId: itemIdMap.get(historyTargetArrItemId(arrKind, record)) ?? null,
    });
    if (event !== null) events.push(event);
  }

  // Cursor = max source date over EVERYTHING fetched (dropped types included) so they
  // are not refetched forever; events + cursor commit in one transaction (D-11).
  let nextCursor: Date | undefined;
  for (const record of records) {
    const date = new Date(record.date);
    if (nextCursor === undefined || date.getTime() > nextCursor.getTime()) nextCursor = date;
  }
  const result = await ingestLedgerEvents({ db, source: arrKind, events, cursor: nextCursor });

  const stats: ArrIncrementalSyncStats = {
    recordsFetched: records.length,
    eventsIngested: result.inserted,
    eventsDeduped: result.skipped,
    eventsDropped: records.length - events.length,
    cursor: (nextCursor ?? cursor)?.toISOString() ?? null,
    bootstrapTruncated,
  };
  logger.info('incremental sync: history ingested', {
    source: arrKind,
    arrInstanceId,
    ...stats,
  });
  return stats;
}
