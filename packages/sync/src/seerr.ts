// DESIGN-005 D-14 — Seerr (Jellyseerr 3.3) request attribution sync: poll
// `GET /request?take=&skip=&sort=added` newest-first until createdAt ≤ the seerr
// cursor; map request → media item (movie → radarr tmdb, tv → sonarr tvdb fallback
// tmdb) and requester → app user (case-insensitive email only, Q-01 resolution —
// plexUsername is recorded as a payload suggestion, never auto-linked). Requests that
// precede the *arr add land with media_item_id NULL and are re-resolved later by
// backfillEventAttribution (orchestrator post-step).
import type { SeerrRequest } from '@hnet/arr';
import type { SeerrClient } from '@hnet/arr/read';
import type { DbClient } from '@hnet/db';
import { ingestLedgerEvents, type LedgerEventInput } from '@hnet/domain';
import { requireClient, type SyncClients } from './clients';
import { readHistoryCursor, resolveSeerrMediaItemId, resolveUserIdByEmail } from './db-reads';
import type { SyncLogger } from './logger';

export const SEERR_PAGE_SIZE = 100;
/** Safety bound on one run's request-page walk (100 pages × 100 = 10k requests). */
export const MAX_SEERR_PAGES = 100;

export interface SeerrSyncInput {
  db: DbClient;
  clients: SyncClients;
  logger: SyncLogger;
  pageSize?: number;
  maxPages?: number;
}

export interface SeerrSyncStats extends Record<string, unknown> {
  requestsFetched: number;
  eventsIngested: number;
  eventsDeduped: number;
  /** Requests whose media item was already in the ledger at ingest time. */
  itemsMatched: number;
  /** Requests auto-linked to an app user by email at ingest time. */
  usersMatched: number;
  cursor: string | null;
}

/** Fetch requests newer than `cursor`, newest-first, across pages (D-14). */
async function fetchNewRequests(
  client: SeerrClient,
  cursor: Date | null,
  pageSize: number,
  maxPages: number,
): Promise<SeerrRequest[]> {
  const requests: SeerrRequest[] = [];
  let skip = 0;
  for (let page = 0; page < maxPages; page++) {
    const result = await client.getRequests({ take: pageSize, skip, sort: 'added' });
    if (result.results.length === 0) break;
    for (const request of result.results) {
      if (cursor !== null && Date.parse(request.createdAt) <= cursor.getTime()) {
        return requests; // sorted newest-first — everything further back is ingested
      }
      requests.push(request);
    }
    skip += result.results.length;
    if (result.pageInfo.page >= result.pageInfo.pages) break;
  }
  return requests;
}

export async function runSeerrSync(input: SeerrSyncInput): Promise<SeerrSyncStats> {
  const { db, logger } = input;
  const client = requireClient(input.clients, 'seerr');

  const cursor = await readHistoryCursor(db, 'seerr');
  const requests = await fetchNewRequests(
    client,
    cursor,
    input.pageSize ?? SEERR_PAGE_SIZE,
    input.maxPages ?? MAX_SEERR_PAGES,
  );

  let itemsMatched = 0;
  let usersMatched = 0;
  const events: LedgerEventInput[] = [];
  for (const request of requests) {
    const mediaItemId = await resolveSeerrMediaItemId(db, {
      type: request.type,
      tmdbId: request.media.tmdbId ?? null,
      tvdbId: request.media.tvdbId ?? null,
    });
    const requestedByUserId = await resolveUserIdByEmail(db, request.requestedBy.email);
    if (mediaItemId !== null) itemsMatched += 1;
    if (requestedByUserId !== null) usersMatched += 1;
    events.push({
      mediaItemId,
      eventType: 'requested',
      source: 'seerr',
      sourceEventId: String(request.id),
      occurredAt: new Date(request.createdAt),
      requestedByUserId,
      payload: {
        // External ids + mediaType are the backfill keys for events ingested before
        // the item appears in the ledger (D-07 nullable-FK note).
        mediaType: request.type,
        tmdbId: request.media.tmdbId ?? null,
        tvdbId: request.media.tvdbId ?? null,
        seerrMediaStatus: request.media.status,
        seerrRequestStatus: request.status,
        requestedBy: {
          id: request.requestedBy.id,
          email: request.requestedBy.email ?? null,
          plexUsername: request.requestedBy.plexUsername ?? null, // suggestion only (Q-01)
          displayName: request.requestedBy.displayName ?? null,
        },
      },
    });
  }

  // Cursor = max createdAt of the fetched batch; events + cursor in one tx (D-11).
  let nextCursor: Date | undefined;
  for (const request of requests) {
    const date = new Date(request.createdAt);
    if (nextCursor === undefined || date.getTime() > nextCursor.getTime()) nextCursor = date;
  }
  const result = await ingestLedgerEvents({ db, source: 'seerr', events, cursor: nextCursor });

  const stats: SeerrSyncStats = {
    requestsFetched: requests.length,
    eventsIngested: result.inserted,
    eventsDeduped: result.skipped,
    itemsMatched,
    usersMatched,
    cursor: (nextCursor ?? cursor)?.toISOString() ?? null,
  };
  logger.info('seerr sync: requests ingested', stats);
  return stats;
}
