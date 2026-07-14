// ADR-055 / DESIGN-028 (PLAN-044) — the Goodreads ORCHESTRATOR (the fix-flow / search-flow discipline:
// composes the per-table single-writers + the confined LazyLibrarian bundle; opens NO transaction of its
// own — external LL calls stay OUT of any DB transaction). Two entrypoints: `syncGoodreadsIntegration`
// (the goodreads-sync mode's per-integration pass) and `runManualBookSearch` (the audited manual
// "Search again"). The @hnet/sync mode does the external READS (RSS + GB) and hands the enriched items in;
// the confined LL WRITES happen here through the injected bundle (the poster-guard precedent).
import type { BookRequestFormat, DbClient } from '@hnet/db';
import { LazyLibrarianUpstreamError } from './errors';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';
import { markIntegrationSynced } from './user-integrations';
import { upsertShelfItems, type ShelfItemInput } from './integration-shelf-items';
import {
  applyRequestReconcile,
  computeCoverage,
  loadLibraryMatcher,
  mapLlStatus,
  markRequestPushed,
  recordManualSearch,
  searchableFormats,
  syncShelfRequests,
  type Coverage,
  type RequestSyncItem,
} from './book-requests';

/** A shelf item plus the sync's GB comic classification (the mode does the external reads + enrichment). */
export interface EnrichedShelfItem extends ShelfItemInput {
  /** GB (or matched-library) comic classification — comics are parked OUT of the LazyLibrarian route. */
  isComic: boolean;
}

export interface SyncGoodreadsInput {
  db?: DbClient;
  integrationId: string;
  items: EnrichedShelfItem[];
  /** The shelves whose snapshot is complete this run (tombstoning scope). */
  syncedShelves: string[];
  /** The confined LazyLibrarian bundle. Absent ⇒ mint + mirror only (push skipped — a degraded run). */
  ll?: LazyLibrarianClientBundle;
  now?: Date;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Politeness pacer between LL pushes (LL/GB API paced — R3). Default sleeps ~250ms between books. */
  pacer?: (index: number) => Promise<void>;
}

export interface SyncGoodreadsReport {
  shelfItemsUpserted: number;
  shelfItemsTombstoned: number;
  requestsMinted: number;
  requestsPushed: number;
  requestsReconciled: number;
  coverage: Coverage;
}

const defaultPacer = (index: number): Promise<void> =>
  index === 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, 250));

/**
 * Run one integration's shelf sync: mirror the shelf, match each want against the library, mint/reconcile
 * requests, push the routable-unmatched wants to LazyLibrarian (BOTH formats, paced), reconcile LL statuses
 * back, mark the integration synced, and compute coverage. Never throws for an individual LL failure (it is
 * logged; the request stays for the next run) — only a mirror/DB failure propagates.
 */
export async function syncGoodreadsIntegration(
  input: SyncGoodreadsInput,
): Promise<SyncGoodreadsReport> {
  const now = input.now ?? new Date();
  const pace = input.pacer ?? defaultPacer;
  const log = input.logger ?? {};

  // 1. Mirror the shelf (tombstoning scoped to the shelves fully read this run).
  const mirror = await upsertShelfItems({
    db: input.db,
    integrationId: input.integrationId,
    items: input.items,
    syncedShelves: input.syncedShelves,
    now,
  });

  // 2. Match each live want against the library mirror + classify comics.
  const match = await loadLibraryMatcher(input.db);
  const enrichedByKey = new Map(
    input.items.map((i) => [`${i.shelf}::${i.externalBookId}`, i] as const),
  );
  const requestItems: RequestSyncItem[] = mirror.liveItems.map((li) => {
    const enriched = enrichedByKey.get(`${li.shelf}::${li.externalBookId}`);
    const libMatch = match(li.title, li.author);
    return {
      shelfItemId: li.id,
      title: li.title,
      author: li.author,
      gbVolumeId: li.gbVolumeId,
      matchedBooksItemId: libMatch?.id ?? null,
      isComic: (enriched?.isComic ?? false) || libMatch?.mediaKind === 'comic',
    };
  });

  // 3. Mint / reconcile the request rows (single-writer) → the LL worklists.
  const { minted, toPush, toReconcile } = await syncShelfRequests({
    db: input.db,
    integrationId: input.integrationId,
    items: requestItems,
    now,
  });

  // 4. Push the routable-unmatched wants to LL, paced: addBook → queueBook (BOTH formats — mandatory) →
  //    searchBook (BOTH). addBook alone lands 'Skipped'; queueBook reaches 'Wanted' (the F-10 lesson, R2).
  let pushed = 0;
  if (input.ll) {
    for (let i = 0; i < toPush.length; i += 1) {
      const target = toPush[i]!;
      await pace(i);
      try {
        await input.ll.write.addBook(target.llBookId);
        await input.ll.write.queueBook(target.llBookId, 'ebook');
        await input.ll.write.queueBook(target.llBookId, 'audiobook');
        await input.ll.write.searchBook(target.llBookId, 'ebook');
        await input.ll.write.searchBook(target.llBookId, 'audiobook');
        await markRequestPushed({
          db: input.db,
          requestId: target.requestId,
          llBookId: target.llBookId,
          now,
        });
        pushed += 1;
      } catch (error) {
        log.error?.('goodreads-sync: LL push failed (will retry next run)', {
          requestId: target.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // 5. Reconcile LL per-format statuses back onto the requests (both freshly-pushed + prior-run wants).
  let reconciled = 0;
  if (input.ll) {
    for (const target of [...toPush, ...toReconcile]) {
      try {
        const status = await input.ll.read.getBook(target.llBookId);
        if (status) {
          await applyRequestReconcile({
            db: input.db,
            requestId: target.requestId,
            ebookStatus: mapLlStatus(status.ebookStatus),
            audioStatus: mapLlStatus(status.audioStatus),
            now,
          });
          reconciled += 1;
        }
      } catch (error) {
        log.error?.('goodreads-sync: LL reconcile failed', {
          requestId: target.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // 6. Mark the integration synced (bookkeeping — unaudited) and compute coverage.
  await markIntegrationSynced({ db: input.db, integrationId: input.integrationId, now });
  const coverage = await computeCoverage({ db: input.db, integrationId: input.integrationId });

  log.info?.('goodreads-sync integration complete', {
    integrationId: input.integrationId,
    upserted: mirror.upserted,
    tombstoned: mirror.tombstoned,
    minted,
    pushed,
    reconciled,
    coverage,
  });

  return {
    shelfItemsUpserted: mirror.upserted,
    shelfItemsTombstoned: mirror.tombstoned,
    requestsMinted: minted,
    requestsPushed: pushed,
    requestsReconciled: reconciled,
    coverage,
  };
}

// ---------------------------------------------------------------------------
// Manual "Search again" (R3 / AC-04) — the audited user action, then the confined LL searchBook.
// ---------------------------------------------------------------------------

export interface RunManualBookSearchInput {
  db?: DbClient;
  requestId: string;
  userId: string;
  actorId: string | null;
  ll: LazyLibrarianClientBundle;
}

export interface RunManualBookSearchResult {
  searched: boolean;
  formats: BookRequestFormat[];
  /** When false: nothing was searched — an unroutable comic or a want with no resolved LL id. */
  reason?: 'unroutable' | 'no_ll_id';
}

/**
 * Manual re-search of a Missing request: record the audited `request_book_search` first (it commits), then
 * fire a real LL searchBook for each not-yet-landed format. A comic (unroutable) or a want with no resolved
 * LL id searches nothing but is STILL audited (the intent is recorded). An LL failure surfaces as
 * LazyLibrarianUpstreamError (BAD_GATEWAY) AFTER the audit — the honest "we tried, LL was down" record.
 */
export async function runManualBookSearch(
  input: RunManualBookSearchInput,
): Promise<RunManualBookSearchResult> {
  const { request } = await recordManualSearch({
    db: input.db,
    requestId: input.requestId,
    userId: input.userId,
    actorId: input.actorId,
  });

  if (request.unroutableReason) return { searched: false, formats: [], reason: 'unroutable' };
  if (!request.llBookId) return { searched: false, formats: [], reason: 'no_ll_id' };

  const formats = searchableFormats(request);
  try {
    for (const format of formats) await input.ll.write.searchBook(request.llBookId, format);
  } catch (error) {
    throw new LazyLibrarianUpstreamError('LazyLibrarian search failed', { cause: error });
  }
  return { searched: true, formats };
}
