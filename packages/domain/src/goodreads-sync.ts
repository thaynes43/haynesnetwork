// ADR-055 / DESIGN-028 (PLAN-044) — the Goodreads ORCHESTRATOR (the fix-flow / search-flow discipline:
// composes the per-table single-writers + the confined LazyLibrarian bundle; opens NO transaction of its
// own — external LL calls stay OUT of any DB transaction). Two entrypoints: `syncGoodreadsIntegration`
// (the goodreads-sync mode's per-integration pass) and `runManualBookSearch` (the audited manual
// "Search again"). The @hnet/sync mode does the external READS (RSS + GB) and hands the enriched items in;
// the confined LL WRITES happen here through the injected bundle (the poster-guard precedent).
import type { BookRequestFormat, DbClient } from '@hnet/db';
import { KapowarrUpstreamError, LazyLibrarianUpstreamError } from './errors';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';
import type { KapowarrClientBundle } from './kapowarr-clients';
import { markIntegrationSynced } from './user-integrations';
import { upsertShelfItems, type ShelfItemInput } from './integration-shelf-items';
import {
  applyComicReconcile,
  applyRequestReconcile,
  computeCoverage,
  llFormatAlreadyHeld,
  loadLibraryMatcher,
  mapKapowarrVolumeStatus,
  mapLlStatus,
  markComicRouted,
  markRequestFormatsRequeued,
  markRequestPushed,
  pickBestVolume,
  readLlHeldSignals,
  recordManualSearch,
  searchableFormats,
  syncShelfRequests,
  type ComicRouteTarget,
  type Coverage,
  type LlHeldSignals,
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
  /**
   * ADR-056 (PLAN-046) — the confined Kapowarr bundle for COMIC routing. Absent ⇒ comics stay PARKED
   * (unroutable_reason='comic', comic_status='requested') — the honest degraded run when Kapowarr/ComicVine
   * is unreachable or unconfigured. Present ⇒ comics resolve to a ComicVine volume, get added monitored
   * (Wanted), and reconcile their Kapowarr state back into comic_status.
   */
  kapowarr?: KapowarrClientBundle;
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
  /**
   * DESIGN-028 amendment (2026-07-15) — wants LL had parked as `Skipped` that this run re-queued +
   * re-searched (usenet-first by LL's provider priority; MAM only fills gaps when its gate is open).
   */
  requestsRequeued: number;
  /**
   * ADR-055 amendment (2026-09-22 — the push guard) — per-format LL pushes SUPPRESSED this run because
   * LazyLibrarian already holds that format (`Open`/`Have`, or an import date / on-disk path). Counts
   * FORMAT LEGS, not books: a want whose ebook is held and audiobook is not contributes 1. Every one of
   * these would have been a `queueBook` clobbering an imported book back to `Wanted`.
   */
  pushesSkippedHeld: number;
  /** ADR-056 — comics newly routed to Kapowarr this run (resolved + added monitored). */
  comicsRouted: number;
  /** ADR-056 — comics whose Kapowarr state was reconciled back this run (incl. the ones just routed). */
  comicsReconciled: number;
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

  // 3. Mint / reconcile the request rows (single-writer) → the LL + Kapowarr worklists.
  const { minted, toPush, toReconcile, toRouteComics } = await syncShelfRequests({
    db: input.db,
    integrationId: input.integrationId,
    items: requestItems,
    now,
  });

  // 3a. ADR-055 amendment (2026-09-22 — the push guard). Read LL's book table BEFORE the push, so the
  //     guard below sees LL's pre-push truth. This is deliberately a SECOND `getAllBooks` (step 5 keeps
  //     its own post-push read): one snapshot cannot serve both honestly — a pre-push snapshot would
  //     reconcile freshly-pushed wants from stale rows and re-sweep the formats this very run queued.
  //     It costs one extra LL *database* read per integration per run (no Google Books leg, no external
  //     hop). On a read failure the map stays empty and the guard degrades to "push everything" — its
  //     only safe default, because this guard may suppress a write but must never invent one.
  let prePush = new Map<string, LlHeldSignals>();
  if (input.ll && toPush.length > 0) {
    try {
      prePush = await input.ll.read.getAllBookStatuses();
    } catch (error) {
      log.error?.(
        'goodreads-sync: LL getAllBooks failed — push guard degraded to push-everything',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  // 4. Push the routable-unmatched wants to LL, paced: addBook → queueBook (missing formats — mandatory) →
  //    searchBook. addBook alone lands 'Skipped'; queueBook reaches 'Wanted' (the F-10 lesson, R2).
  //    GUARDED since 2026-09-22: a format LazyLibrarian ALREADY HOLDS is never queued or searched.
  //    `queueBook` is an unguarded `UPDATE books SET Status='Wanted'` (LL api.py::_queuebook), so pushing a
  //    held format clobbers an imported book back into the search backlog, where LL re-searches it daily
  //    and qBittorrent rejects every re-grab as a duplicate hash — 292 of LL's rows were in that state on
  //    2026-09-22. A want whose BOTH formats are held is skipped whole (no addBook either) and still marked
  //    pushed: the request is satisfied on LL's side, and step 5 reconciles it to `landed`.
  let pushed = 0;
  let pushesSkippedHeld = 0;
  const BOTH_FORMATS = ['ebook', 'audiobook'] as const;
  if (input.ll) {
    for (let i = 0; i < toPush.length; i += 1) {
      const target = toPush[i]!;
      await pace(i);
      const held = prePush.get(target.llBookId);
      const toQueue = BOTH_FORMATS.filter((f) => !llFormatAlreadyHeld(held, f));
      const skipped = BOTH_FORMATS.filter((f) => !toQueue.includes(f));
      if (skipped.length > 0) {
        pushesSkippedHeld += skipped.length;
        log.info?.('ll_push_skipped_have', {
          site: 'goodreads-sync.push',
          requestId: target.requestId,
          llBookId: target.llBookId,
          formats: skipped,
          ebookStatus: held?.ebookStatus ?? null,
          audioStatus: held?.audioStatus ?? null,
        });
      }
      try {
        if (toQueue.length > 0) {
          await input.ll.write.addBook(target.llBookId);
          for (const format of toQueue) await input.ll.write.queueBook(target.llBookId, format);
          for (const format of toQueue) await input.ll.write.searchBook(target.llBookId, format);
        }
        await markRequestPushed({
          db: input.db,
          requestId: target.requestId,
          llBookId: target.llBookId,
          now,
        });
        // Only a run that actually issued writes counts as a push (an all-held want is `pushesSkippedHeld`,
        // never a phantom push) — but it is still marked pushed so it carries its llBookId and reconciles.
        if (toQueue.length > 0) pushed += 1;
      } catch (error) {
        log.error?.('goodreads-sync: LL push failed (will retry next run)', {
          requestId: target.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // 5. Reconcile LL per-format statuses back onto the requests (both freshly-pushed + prior-run wants).
  //    One `getAllBooks` fetch, taken AFTER the push so a freshly-pushed want reconciles from what the
  //    push actually left behind (the deployed LL build has no `getBook`; a book absent from the map is
  //    one LL doesn't know — the request stays untouched, the honest gap).
  // 5a. The Skipped-want sweep (DESIGN-028 amendment 2026-07-15, owner-directed): a live want whose LL
  //     status is raw `Skipped` is a book LL is NOT looking for — addBook races and the pre-searchBook
  //     PLAN-044 pushes both left rows in this state. Re-queue + re-search each such format immediately so
  //     usenet (SAB) grabs it on LL's usenet-first provider priority — MAM only fills the gaps when its
  //     gate is open (the governor still caps it). Raw `Skipped` ONLY: `Ignored` is an owner ruling and
  //     `Matched` means LL thinks it already holds a file — neither may be re-queued. GUARDED since
  //     2026-09-22 as well: LL carries `Skipped` rows that are nevertheless imported (24 ebook + 15 audio
  //     on that date, each with a library date and a real file), and re-queueing one clobbers it.
  let reconciled = 0;
  let requeued = 0;
  if (input.ll) {
    let statuses: Map<string, LlHeldSignals>;
    try {
      statuses = await input.ll.read.getAllBookStatuses();
    } catch (error) {
      statuses = new Map();
      log.error?.('goodreads-sync: LL getAllBooks failed — reconcile skipped this run', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const target of [...toPush, ...toReconcile]) {
      const status = statuses.get(target.llBookId);
      if (!status) continue;
      try {
        await applyRequestReconcile({
          db: input.db,
          requestId: target.requestId,
          ebookStatus: mapLlStatus(status.ebookStatus),
          audioStatus: mapLlStatus(status.audioStatus),
          now,
        });
        reconciled += 1;
        const skippedFormats: Array<'ebook' | 'audiobook'> = [];
        const heldFormats: Array<'ebook' | 'audiobook'> = [];
        for (const format of BOTH_FORMATS) {
          const raw = format === 'ebook' ? status.ebookStatus : status.audioStatus;
          if (raw?.trim().toLowerCase() !== 'skipped') continue;
          // A `Skipped` row that nevertheless carries a library date / file is one LL HAS — re-queueing
          // it would clobber an imported book back to `Wanted`. Suppress, count, and log.
          if (llFormatAlreadyHeld(status, format)) heldFormats.push(format);
          else skippedFormats.push(format);
        }
        if (heldFormats.length > 0) {
          pushesSkippedHeld += heldFormats.length;
          log.info?.('ll_push_skipped_have', {
            site: 'goodreads-sync.skipped-sweep',
            requestId: target.requestId,
            llBookId: target.llBookId,
            formats: heldFormats,
            ebookStatus: status.ebookStatus ?? null,
            audioStatus: status.audioStatus ?? null,
          });
        }
        if (skippedFormats.length > 0) {
          await pace(requeued + 1);
          for (const format of skippedFormats) {
            await input.ll.write.queueBook(target.llBookId, format);
            await input.ll.write.searchBook(target.llBookId, format);
          }
          await markRequestFormatsRequeued({
            db: input.db,
            requestId: target.requestId,
            formats: skippedFormats,
            now,
          });
          requeued += 1;
        }
      } catch (error) {
        log.error?.('goodreads-sync: LL reconcile failed', {
          requestId: target.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // 5b. ADR-056 (PLAN-046) — route comics to Kapowarr (ITS OWN GetComics DDL sources; NEVER MAM/qB/Prowlarr).
  //     Un-routed comic ⇒ ComicVine search → pick the best volume → add MONITORED (auto-search) → reconcile.
  //     Already-routed comic ⇒ reconcile its Kapowarr state. A per-comic failure is logged and the request
  //     stays PARKED for the next run (never fails the whole sync — the LL-push discipline).
  let comicsRouted = 0;
  let comicsReconciled = 0;
  if (input.kapowarr && toRouteComics.length > 0) {
    const rootFolders = await input.kapowarr.read.getRootFolders().catch((error: unknown) => {
      log.error?.('goodreads-sync: Kapowarr root-folder read failed — comics stay parked', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
    const rootFolderId = rootFolders[0]?.id;
    for (const comic of toRouteComics) {
      try {
        const volumeId = comic.kapowarrVolumeId
          ? Number(comic.kapowarrVolumeId)
          : await routeNewComic(input.db, input.kapowarr, comic, rootFolderId, log);
        if (volumeId == null || Number.isNaN(volumeId)) continue; // no match / no root folder — stays parked
        if (!comic.kapowarrVolumeId) comicsRouted += 1;
        // Reconcile the (just-added or existing) volume's live state into comic_status.
        const vol = await input.kapowarr.read.getVolume(volumeId);
        if (vol) {
          await applyComicReconcile({
            db: input.db,
            requestId: comic.requestId,
            comicStatus: mapKapowarrVolumeStatus(vol),
            now,
          });
          comicsReconciled += 1;
        }
      } catch (error) {
        log.error?.('goodreads-sync: Kapowarr comic routing failed (will retry next run)', {
          requestId: comic.requestId,
          title: comic.title,
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
    requeued,
    pushesSkippedHeld,
    comicsRouted,
    comicsReconciled,
    coverage,
  });

  return {
    shelfItemsUpserted: mirror.upserted,
    shelfItemsTombstoned: mirror.tombstoned,
    requestsMinted: minted,
    requestsPushed: pushed,
    requestsReconciled: reconciled,
    requestsRequeued: requeued,
    pushesSkippedHeld,
    comicsRouted,
    comicsReconciled,
    coverage,
  };
}

/**
 * Resolve a comic want to a ComicVine volume via Kapowarr's own search, add it MONITORED (auto-search), and
 * record the routing (markComicRouted clears the parked flag). Returns the local Kapowarr volume id, or null
 * when there is no ComicVine match / no root folder (the comic stays parked). If Kapowarr already holds the
 * ComicVine volume (search's `already_added`), that local id is reused rather than double-adding.
 */
async function routeNewComic(
  db: DbClient | undefined,
  kapowarr: KapowarrClientBundle,
  comic: ComicRouteTarget,
  rootFolderId: number | undefined,
  log: NonNullable<SyncGoodreadsInput['logger']>,
): Promise<number | null> {
  if (rootFolderId == null) return null;
  const candidates = await kapowarr.read.searchVolumes(comic.title);
  const pick = pickBestVolume(comic.title, candidates);
  if (!pick) {
    log.info?.('goodreads-sync: no ComicVine match for comic — parked', { title: comic.title });
    return null;
  }
  const volumeId =
    pick.alreadyAdded ??
    (await kapowarr.write.addVolume({
      comicvineId: pick.comicvineId,
      rootFolderId,
      monitor: true,
      autoSearch: true,
    }));
  await markComicRouted({
    db,
    requestId: comic.requestId,
    kapowarrVolumeId: String(volumeId),
    comicvineId: String(pick.comicvineId),
    comicStatus: 'wanted',
  });
  return volumeId;
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
  /**
   * ADR-057 amendment (PLAN-047 — the Wanted detail page) — narrow the LL searchBook to ONE format
   * (the detail page's per-format "Force Search" button targets the ebook / audiobook leg separately,
   * the Movies/TV per-grain idiom). Omitted ⇒ the whole request's not-yet-landed formats (the wall
   * puck's existing behaviour). A format already landed narrows to nothing (searched:false).
   */
  format?: Extract<BookRequestFormat, 'ebook' | 'audiobook'>;
}

export interface RunManualBookSearchResult {
  searched: boolean;
  formats: BookRequestFormat[];
  /** When false: nothing was searched — an unroutable comic, a want with no resolved LL id, or (since the
   *  2026-09-22 push guard) every candidate format is one LazyLibrarian already holds (`already_held`). */
  reason?: 'unroutable' | 'no_ll_id' | 'already_held';
}

/**
 * Manual re-search of a Missing request: record the audited `request_book_search` first (it commits), then
 * fire a real LL searchBook for each not-yet-landed format (or the ONE `input.format`, for the detail page's
 * per-format button). A comic (unroutable) or a want with no resolved LL id searches nothing but is STILL
 * audited (the intent is recorded). An LL failure surfaces as LazyLibrarianUpstreamError (BAD_GATEWAY) AFTER
 * the audit — the honest "we tried, LL was down" record.
 *
 * ADR-055 amendment (2026-09-22 — the LL push guard), the SEARCH leg: a format LazyLibrarian already holds
 * is DROPPED before firing, and a click left with nothing to fire returns `already_held`. This path never
 * called `queueBook`, so it never clobbered LL's state — but `searchbook.py::search_book` only enqueues a
 * book whose status is literally `Wanted`, so `searchBook` on a held (`Open`) format is a SILENT NO-OP, and
 * reporting "Search fired" for it is a claim the user has no way to check. Same guard, same one-read budget,
 * same degradation (an LL read failure ⇒ search everything, exactly as before). The `landed` narrowing below
 * (our own row status) is unchanged and still returns the reason-less "nothing fired".
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

  const notLanded = searchableFormats(request);
  const candidates = input.format ? notLanded.filter((f) => f === input.format) : notLanded;
  // One `getAllBooks` per click, and only when there is something to fire (no click, no call).
  const held =
    candidates.length > 0 ? await readLlHeldSignals(input.ll, request.llBookId) : undefined;
  const formats = candidates.filter((f) => !llFormatAlreadyHeld(held, f));
  // Every candidate was a format LL already has filed: an honest decline that points at Fix, never a
  // "Search fired" for a searchBook LazyLibrarian would have dropped on the floor.
  if (formats.length === 0 && candidates.length > 0) {
    return { searched: false, formats: [], reason: 'already_held' };
  }
  try {
    for (const format of formats) await input.ll.write.searchBook(request.llBookId, format);
  } catch (error) {
    throw new LazyLibrarianUpstreamError('LazyLibrarian search failed', { cause: error });
  }
  // A per-format request whose format already landed narrows to nothing — honest "nothing fired".
  return { searched: formats.length > 0, formats };
}

// ---------------------------------------------------------------------------
// ADR-056 (PLAN-046) — the COMIC force-search: the audited user action, then the confined Kapowarr auto_search.
// This is the Kapowarr leg of the `integrations.search` surface (books/audio → runManualBookSearch above;
// comics → here) that PLAN-045's Library "Force Search" button calls for a comic.
// ---------------------------------------------------------------------------

export interface RunComicVolumeSearchInput {
  db?: DbClient;
  requestId: string;
  userId: string;
  actorId: string | null;
  kapowarr: KapowarrClientBundle;
}

export interface RunComicVolumeSearchResult {
  searched: boolean;
  /** When false: nothing was searched — the comic already landed, or has no resolved Kapowarr volume yet. */
  reason?: 'landed' | 'no_kapowarr_id';
}

/**
 * Manual force-search of a comic request: record the audited `request_book_search` first (it commits — the
 * intent is recorded even for a not-yet-routed comic), then fire Kapowarr's `auto_search` task for the volume
 * (search its GetComics DDL sources + grab). A comic with no Kapowarr volume id yet (routing hasn't run /
 * matched) or one already landed searches nothing but is STILL audited. A Kapowarr failure surfaces as
 * KapowarrUpstreamError (BAD_GATEWAY) AFTER the audit — the honest "we tried, Kapowarr was down" record.
 */
export async function runComicVolumeSearch(
  input: RunComicVolumeSearchInput,
): Promise<RunComicVolumeSearchResult> {
  const { request } = await recordManualSearch({
    db: input.db,
    requestId: input.requestId,
    userId: input.userId,
    actorId: input.actorId,
  });

  if (request.comicStatus === 'landed') return { searched: false, reason: 'landed' };
  if (!request.kapowarrVolumeId) return { searched: false, reason: 'no_kapowarr_id' };

  const volumeId = Number(request.kapowarrVolumeId);
  if (Number.isNaN(volumeId)) return { searched: false, reason: 'no_kapowarr_id' };
  try {
    await input.kapowarr.write.searchVolume(volumeId);
  } catch (error) {
    throw new KapowarrUpstreamError('Kapowarr search failed', { cause: error });
  }
  return { searched: true };
}
