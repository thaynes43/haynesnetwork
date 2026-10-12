// ADR-107 / DESIGN-054 D-02..D-03 — one SELECT-only snapshot per batch/context call.
import { mediaItems, mediaMetadata, watchMarks, type DbClient } from '@hnet/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  checkPersonalSnapshot,
  viewingContextFromSnapshot,
  type WatchCandidateInput,
  type WatchBatchCheck,
  type WatchPersonalSnapshot,
  type WatchTitleLookup,
  type WatchViewingContext,
} from '../personal';
import type { WatchKind } from '../types';
import { ledgerSelect, type LedgerCandidate } from './ledger';
import { selectAccountEvents } from './events';
import { selectTitleRows } from './titles';
import { selectWatchlist } from './watchlist';
import { selectSignals, selectSignalsFetchedAt } from './signals';

export async function selectPersonalSnapshot(input: {
  db: DbClient;
  plexAccountId: number;
  isOwner: boolean;
  now: Date;
}): Promise<WatchPersonalSnapshot> {
  const { db, plexAccountId, isOwner } = input;
  const [
    titles,
    events,
    marks,
    ledger,
    watchlist,
    watchlistFetchedAt,
    ledgerAt,
    cachedCatalog,
    cachedWatchlist,
  ] = await Promise.all([
    selectTitleRows(db, plexAccountId),
    selectAccountEvents(db, plexAccountId),
    db.select().from(watchMarks).where(eq(watchMarks.plexAccountId, plexAccountId)),
    db
      .select(ledgerSelect())
      .from(mediaItems)
      .leftJoin(mediaMetadata, eq(mediaMetadata.mediaItemId, mediaItems.id))
      .where(
        and(inArray(mediaItems.arrKind, ['sonarr', 'radarr']), isNull(mediaItems.deletedFromArrAt)),
      ),
    isOwner
      ? selectWatchlist(db, plexAccountId, { now: input.now }).then((w) => w.entries)
      : Promise.resolve([]),
    isOwner ? selectSignalsFetchedAt(db, plexAccountId, 'watchlist') : Promise.resolve(null),
    db
      .select({ at: sql<Date | string | null>`max(${mediaItems.lastSeenAt})` })
      .from(mediaItems)
      .where(
        and(inArray(mediaItems.arrKind, ['sonarr', 'radarr']), isNull(mediaItems.deletedFromArrAt)),
      ),
    selectSignals(db, plexAccountId, 'tmdb_seed'),
    isOwner ? selectSignals(db, plexAccountId, 'watchlist') : Promise.resolve([]),
  ]);
  const at = ledgerAt[0]?.at;
  return {
    titles,
    events,
    marks,
    ledger: ledger as LedgerCandidate[],
    watchlist,
    watchlistFetchedAt,
    ledgerRefreshedAt: at ? new Date(at) : null,
    cachedCatalog: [...cachedCatalog, ...cachedWatchlist],
    isOwner,
  };
}

/** Ten candidates, two simultaneous single-attempt catalog lookups, never user-facing writes. */
export async function checkWatchTitles(input: {
  db: DbClient;
  plexAccountId: number;
  isOwner: boolean;
  titles: readonly WatchCandidateInput[];
  lookup?: WatchTitleLookup | null;
  now: Date;
}): Promise<WatchBatchCheck> {
  if (input.titles.length < 1 || input.titles.length > 10)
    throw new RangeError('one to ten candidate titles required');
  return checkPersonalSnapshot(await selectPersonalSnapshot(input), input);
}

export async function selectViewingContext(input: {
  db: DbClient;
  plexAccountId: number;
  isOwner: boolean;
  kind?: WatchKind | 'any';
  section?: 'viewing' | 'feedback';
  limit?: number;
  offset?: number;
  now: Date;
}): Promise<WatchViewingContext> {
  return viewingContextFromSnapshot(await selectPersonalSnapshot(input), input);
}
