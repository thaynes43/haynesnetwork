// ADR-055 / DESIGN-028 (PLAN-044) — the Goodreads ORCHESTRATOR (the fix-flow / search-flow discipline:
// composes the per-table single-writers + the confined LazyLibrarian bundle; opens NO transaction of its
// own — external LL calls stay OUT of any DB transaction). Two entrypoints: `syncGoodreadsIntegration`
// (the goodreads-sync mode's per-integration pass) and `runManualBookSearch` (the audited manual
// "Search again"). The @hnet/sync mode does the external READS (RSS + GB) and hands the enriched items in;
// the confined LL WRITES happen here through the injected bundle (the poster-guard precedent).
import { and, asc, eq, inArray, or } from 'drizzle-orm';
import {
  bookRequests,
  booksItems,
  type BookRequestFormat,
  type BookRequestStatus,
  type DbClient,
} from '@hnet/db';
import { resolveDb } from './db-client';
import { pairingBooksItemIdentity } from './format-pairing';
import { withRequestEventScope } from './book-request-events';
import {
  applyLlGoneDecision,
  decideLlGoneWant,
  emptyLlGoneTally,
  emptyLlRerequestTally,
  llSnapshotUsable,
  LlRekeyIndex,
  llRerequestOpen,
  repointRequestLlBook,
  runLlRerequests,
  type LlGoneTally,
  type LlRerequestTally,
  type LlSnapshotRow,
} from './ll-gone';
import { KapowarrUpstreamError, LazyLibrarianUpstreamError } from './errors';
import { llBookMismatch } from './ll-book-check';
import { isForeignLanguage, readLlLanguage } from './book-language';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';
import type { KapowarrClientBundle } from './kapowarr-clients';
import { markIntegrationSynced } from './user-integrations';
import { upsertShelfItems, type ShelfItemInput } from './integration-shelf-items';
import {
  applyComicReconcile,
  applyRequestReconcile,
  computeCoverage,
  llFormatAlreadyHeld,
  llFormatDownloading,
  loadLibraryMatcher,
  mapKapowarrVolumeStatus,
  llReconcileStatus,
  markComicRouted,
  markRequestFormatsRequeued,
  markRequestPushed,
  pickBestVolume,
  revertLandedFormats,
  unheldFormatStatus,
  llRecentSearchCovers,
  recentlySearchedLlBookIds,
  recordManualSearch,
  searchableFormats,
  stampRequestsSearched,
  syncShelfRequests,
  type ComicRouteTarget,
  type Coverage,
  type LlHeldSignals,
  type RequestLlTarget,
  type RequestSyncItem,
} from './book-requests';

/** A shelf item plus the sync's GB comic classification (the mode does the external reads + enrichment). */
export interface EnrichedShelfItem extends ShelfItemInput {
  /** GB (or matched-library) comic classification — comics are parked OUT of the LazyLibrarian route. */
  isComic: boolean;
}

/** Per llBookId, the formats a LazyLibrarian searchBook call already covered (issue #644). */
export type LlSearchCoverage = Map<string, Set<'ebook' | 'audiobook'>>;

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
  /**
   * Issue #644 — books already searched this cron run. The caller that syncs several integrations in one
   * run passes ONE map to all of them, so a book two users both want is searched once per run, not once per
   * integration. Omitted ⇒ a fresh map (dedupe within this integration's run only).
   */
  searchCoverage?: LlSearchCoverage;
}

export interface SyncGoodreadsReport extends LlGoneTally, LlRerequestTally {
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
  /**
   * Issue #719 — pushes SUPPRESSED this run because LazyLibrarian labels the want's book non-English (the F10 rule): the
   * book it already held, or the one this run's addBook just seated. Nothing is queued or searched; the English-edition
   * pass switches the want to an English edition (or parks it) on its next run.
   */
  pushesSkippedForeign: number;
  /**
   * Issue #715 (DESIGN-028 amendment 2026-10-05) — requests with a format taken OUT of `landed` this run because
   * nothing held it any more: the library match was gone and LazyLibrarian (or Kapowarr, for a comic) does not hold
   * the format, or the request no longer points at a matching LazyLibrarian book.
   */
  requestsLandedReverted: number;
  /**
   * Issue #734 (DESIGN-028 amendment 2026-10-06) — requests with an ebook or audiobook taken OUT of `grabbed` this run
   * because LazyLibrarian is not downloading it: the grab failed and LazyLibrarian put the format back to `Wanted`
   * (reads `wanted`), or it reads `Skipped`/`Ignored` (reads `missing`), or the book names another volume or work.
   */
  requestsGrabReverted: number;
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
  let prePush = new Map<string, LlSnapshotRow>();
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
  let pushesSkippedForeign = 0;
  const BOTH_FORMATS = ['ebook', 'audiobook'] as const;
  // ONE searchBook per book per run (issue #644). LazyLibrarian's `searchBook` IGNORES its `type`
  // parameter: `api.py::_searchbook` only forwards it to a log line, and `searchbook.search_book` searches
  // EVERY format of the book whose Status/AudioStatus is `Wanted`. So a call per format searched a book
  // wanted in both formats twice, hitting every indexer twice for the same thing. This map records, per
  // llBookId, the formats a searchBook call this run already covered (they were all `Wanted` when it
  // fired); the push leg and the Skipped sweep both consult it so a book is never searched twice.
  const searchCovered: LlSearchCoverage = input.searchCoverage ?? new Map();
  const needsSearch = (llBookId: string, formats: ReadonlyArray<'ebook' | 'audiobook'>): boolean =>
    formats.some((f) => !searchCovered.get(llBookId)?.has(f));
  // Cross-JOB leg: books another job (format-pairing, the collection force-search) searched within the hour.
  // A recent search only covers formats LL already shows as Wanted — a format we flip is always searched.
  const recentSearched = input.ll
    ? await recentlySearchedLlBookIds(input.db, now)
    : new Set<string>();
  const searchOnce = async (
    ll: LazyLibrarianClientBundle,
    llBookId: string,
    formats: ReadonlyArray<'ebook' | 'audiobook'>,
    status?: LlHeldSignals,
  ): Promise<void> => {
    if (!needsSearch(llBookId, formats)) return;
    if (llRecentSearchCovers(recentSearched, llBookId, status, formats)) {
      log.info?.('ll_search_skipped_covered', {
        site: 'goodreads-sync.recent-search',
        llBookId,
        formats: [...formats],
      });
      return;
    }
    // `type` is ignored by LL (see above); the first format rides along only to keep the wire shape.
    await ll.write.searchBook(llBookId, formats[0]!);
    const covered = searchCovered.get(llBookId) ?? new Set();
    for (const f of formats) covered.add(f);
    searchCovered.set(llBookId, covered);
  };
  if (input.ll) {
    for (let i = 0; i < toPush.length; i += 1) {
      const target = toPush[i]!;
      const held = prePush.get(target.llBookId);
      // Issue #693 — never queue a book LazyLibrarian holds as another volume or work than the want. The want stays
      // `requested` (nothing was asked of LazyLibrarian), and the reconcile below never lands it from that book.
      const mismatch = llBookMismatch(target, held);
      if (mismatch) {
        log.info?.('ll_push_skipped_wrong_volume', {
          site: 'goodreads-sync.push',
          requestId: target.requestId,
          llBookId: target.llBookId,
          title: target.title,
          llTitle: held?.title ?? null,
          reason: mismatch,
        });
        continue;
      }
      // Issue #719 — never queue a book LazyLibrarian labels non-English (the F10 rule), whatever its format status. The
      // want stays `requested` and the English-edition pass moves it to an English edition, or parks it.
      if (held && isForeignLanguage(held.language)) {
        pushesSkippedForeign += 1;
        log.info?.('ll_push_skipped_foreign', {
          site: 'goodreads-sync.push',
          requestId: target.requestId,
          llBookId: target.llBookId,
          llLanguage: held.language ?? null,
        });
        continue;
      }
      await pace(i);
      const toQueue = BOTH_FORMATS.filter((f) => !llFormatAlreadyHeld(held, f) && !llFormatDownloading(held, f),
      );
      const downloading = BOTH_FORMATS.filter((f) => llFormatDownloading(held, f));
      const skipped = BOTH_FORMATS.filter((f) => llFormatAlreadyHeld(held, f));
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
      if (downloading.length > 0)
        log.info?.('ll_push_adopted_active', {
          site: 'goodreads-sync.push',
          requestId: target.requestId,
          llBookId: target.llBookId,
          formats: downloading,
          rawStatus: 'snatched',
        });
      try {
        if (toQueue.length > 0) {
          // A second request row for the same book (another user's want) is fully covered by the first
          // row's chain: no second addBook/queueBook/searchBook, but it is still marked pushed below.
          if (needsSearch(target.llBookId, toQueue)) {
            // addBook only seats a book LazyLibrarian does not hold (issue #665, DESIGN-028 amendment rule 6): on a
            // held book its upsert resets both formats to `Skipped`. A failed read leaves `held` undefined (as before).
            if (held == null) {
              await input.ll.write.addBook(target.llBookId);
              // Issue #719 — LazyLibrarian only labels a book's language once addBook has seated it, so a book it
              // did not hold is read back before anything is queued: a non-English one is left as seated (`Skipped`,
              // never searched) and the want stays `requested` for the English-edition pass.
              const seatedLanguage = await readLlLanguage(input.ll, target.llBookId);
              if (isForeignLanguage(seatedLanguage)) {
                pushesSkippedForeign += 1;
                log.info?.('ll_push_skipped_foreign', {
                  site: 'goodreads-sync.push',
                  requestId: target.requestId,
                  llBookId: target.llBookId,
                  llLanguage: seatedLanguage ?? null,
                });
                continue;
              }
            }
            for (const format of toQueue) await input.ll.write.queueBook(target.llBookId, format);
            await searchOnce(input.ll, target.llBookId, toQueue, held);
          }
        }
        // Stamp the search on this row (the cross-job coverage signal): it was searched by this run's call.
        if (toQueue.length > 0 && searchCovered.get(target.llBookId)) {
          await stampRequestsSearched(input.db, [target.requestId], now);
        }
        await markRequestPushed({
          db: input.db,
          requestId: target.requestId,
          llBookId: target.llBookId,
          now,
        });
        if (downloading.length > 0)
          await applyRequestReconcile({
            db: input.db,
            requestId: target.requestId,
            ebookStatus: downloading.includes('ebook') ? 'grabbed' : null,
            audioStatus: downloading.includes('audiobook') ? 'grabbed' : null,
            site: 'goodreads-sync.push-adopt-active',
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
  let landedReverted = 0;
  let grabReverted = 0;
  const gone = emptyLlGoneTally();
  let reconcileSnapshot: Map<string, LlSnapshotRow> | null = null;
  if (input.ll) {
    let statuses: Map<string, LlSnapshotRow>;
    try {
      statuses = await input.ll.read.getAllBookStatuses();
    } catch (error) {
      statuses = new Map();
      log.error?.('goodreads-sync: LL getAllBooks failed — reconcile skipped this run', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // 5-gone. Issue #665 (DESIGN-028 amendment 2026-10-04) — a pushed want whose id LazyLibrarian no longer has is
    //     re-keyed to the row LL holds for the same book, or settled `missing`. Same snapshot, no LL write; an
    //     empty snapshot decides nothing. A want pushed this run was stamped by the push, so the grace skips it.
    reconcileSnapshot = statuses;
    const targets = [...toPush, ...toReconcile];
    const goneIndex = llSnapshotUsable(statuses) ? new LlRekeyIndex(statuses) : null;
    const goneRows = new Map<string, typeof bookRequests.$inferSelect>();
    if (goneIndex) {
      const absentIds = targets.filter((t) => !statuses.has(t.llBookId)).map((t) => t.requestId);
      if (absentIds.length > 0) {
        const rows = await resolveDb(input.db)
          .select()
          .from(bookRequests)
          .where(inArray(bookRequests.id, absentIds));
        for (const row of rows) goneRows.set(row.id, row);
      }
    }
    const revertLanded = async (
      target: RequestLlTarget,
      ebook: BookRequestStatus | null,
      audio: BookRequestStatus | null,
      reason: string,
      site: string,
    ): Promise<number> => {
      const reverted = await revertLandedFormats({
        db: input.db,
        requestId: target.requestId,
        llBookId: target.llBookId,
        ebook,
        audio,
        site,
        cause: reason,
        now,
      });
      if (!reverted.ebook && !reverted.audio) return 0;
      // Issue #734 — a format that left `grabbed` (LazyLibrarian is not downloading it) is its own log line and count.
      const grabbedEbook = reverted.fromGrabbed.includes('ebook');
      const grabbedAudio = reverted.fromGrabbed.includes('audiobook');
      if (grabbedEbook || grabbedAudio) {
        grabReverted += 1;
        log.info?.('request_grab_reverted', {
          site,
          reason,
          requestId: target.requestId,
          llBookId: target.llBookId,
          title: target.title,
          ebook: grabbedEbook ? ebook : null,
          audio: grabbedAudio ? audio : null,
        });
      }
      const landedEbook = reverted.ebook && !grabbedEbook;
      const landedAudio = reverted.audio && !grabbedAudio;
      if (!landedEbook && !landedAudio) return 0;
      log.info?.('request_landed_reverted', {
        site,
        reason,
        requestId: target.requestId,
        llBookId: target.llBookId,
        title: target.title,
        ebook: landedEbook ? ebook : null,
        audio: landedAudio ? audio : null,
      });
      return 1;
    };
    for (const target of targets) {
      const status = statuses.get(target.llBookId);
      if (!status) {
        const row = goneRows.get(target.requestId);
        if (!goneIndex || !row) continue;
        try {
          await applyLlGoneDecision({
            db: input.db,
            requestId: row.id,
            llBookId: target.llBookId,
            decision: decideLlGoneWant({
              want: { ...row, lastSeenAt: row.lastReconciledAt ?? row.createdAt },
              snapshot: statuses,
              index: goneIndex,
              now,
              // Issue #715: every target here is a want the library does not hold, so a `landed` format is only
              // true while LazyLibrarian holds it.
              includeLanded: true,
            }),
            snapshot: statuses,
            reconcile: true,
            includeLanded: true,
            tally: gone,
            site: 'goodreads-sync.reconcile',
            now,
            log,
          });
        } catch (error) {
          log.error?.('goodreads-sync: gone-book settle failed', {
            requestId: target.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      // Issue #693 — a want is never landed from, nor re-queued on, a book LazyLibrarian names as another volume or
      // work ("The Art of the Fellowship of the Ring" on "The Lord of the Rings").
      const mismatch = llBookMismatch(target, status);
      if (mismatch) {
        log.info?.('ll_book_mismatch', {
          site: 'goodreads-sync.reconcile',
          requestId: target.requestId,
          llBookId: target.llBookId,
          title: target.title,
          llTitle: status.title ?? null,
          reason: mismatch,
        });
        // Issue #715 — a format that reads `landed` from a book that is another volume or work is not held: it
        // settles `missing` (the dead-end the repair uses), and nothing is queued on that book. Issue #734: so does a
        // `grabbed` one (a download of another work is not this want's).
        landedReverted += await revertLanded(target, 'missing', 'missing', 'll_book_mismatch', 'goodreads-sync.reconcile');
        continue;
      }
      try {
        // Issue #715 — `landed` is only true while LazyLibrarian holds the format: a format it does not hold goes back
        // to the status LazyLibrarian shows (wanted, grabbed, or missing). Issue #734 — and `grabbed` only while
        // LazyLibrarian shows it `Snatched`: a failed grab LazyLibrarian put back to `Wanted` reads `wanted`. Before the
        // reconcile below, which never regresses a positive.
        landedReverted += await revertLanded(
          target,
          unheldFormatStatus(status, 'ebook'),
          unheldFormatStatus(status, 'audiobook'),
          'll_not_held',
          'goodreads-sync.reconcile',
        );
        await applyRequestReconcile({
          db: input.db,
          requestId: target.requestId,
          ebookStatus: llReconcileStatus(status, 'ebook'),
          audioStatus: llReconcileStatus(status, 'audiobook'),
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
          else if (isForeignLanguage(status.language)) {
            // Issue #715 / #700 — never queue a book LazyLibrarian itself labels non-English (the F10 rule): the
            // format stays `missing`, where a person's Search again can still lift it.
            log.info?.('ll_push_skipped_foreign', {
              site: 'goodreads-sync.skipped-sweep',
              requestId: target.requestId,
              llBookId: target.llBookId,
              format,
              llLanguage: status.language ?? null,
            });
          } else skippedFormats.push(format);
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
          }
          // One search covers every format just queued (and none already searched this run).
          await searchOnce(input.ll, target.llBookId, skippedFormats);
          await stampRequestsSearched(input.db, [target.requestId], now);
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

  // 5c. Issue #668 (owner ruling 2026-10-04, "Add them all back now") — the ONE re-request of a person's want that
  //     the gone rule settled `missing` (LazyLibrarian lost its book): addBook + queueBook for the lost formats, never
  //     a search (LazyLibrarian's daily backlog search looks for it); a format LazyLibrarian holds under another id
  //     for the same book lands instead. The library match (step 2) already landed every want the library holds.
  let rerequest = emptyLlRerequestTally();
  if (input.ll && llSnapshotUsable(reconcileSnapshot)) {
    const snapshot = reconcileSnapshot;
    const ids = [...toPush, ...toReconcile]
      .filter((t) => !snapshot.has(t.llBookId))
      .map((t) => t.requestId);
    if (ids.length > 0) {
      const rows = await resolveDb(input.db)
        .select()
        .from(bookRequests)
        .where(
          and(
            inArray(bookRequests.id, ids),
            llRerequestOpen(now),
            or(eq(bookRequests.ebookStatus, 'missing'), eq(bookRequests.audioStatus, 'missing')),
          ),
        )
        .orderBy(
          asc(bookRequests.llRerequestFailures),
          asc(bookRequests.createdAt),
          asc(bookRequests.id),
        );
      rerequest = await runLlRerequests({
        db: input.db,
        ll: input.ll,
        candidates: rows.map((want) => ({ want })),
        snapshot,
        now,
        site: 'goodreads-sync.rerequest',
        pace,
        log,
      });
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
    const revertComicLanded = async (
      comic: ComicRouteTarget,
      comicStatus: BookRequestStatus,
      reason: string,
    ): Promise<number> => {
      const reverted = await revertLandedFormats({
        db: input.db,
        requestId: comic.requestId,
        llBookId: null,
        comic: comicStatus,
        site: 'goodreads-sync.comics',
        cause: reason,
        now,
      });
      if (!reverted.comic) return 0;
      log.info?.('request_landed_reverted', {
        site: 'goodreads-sync.comics',
        reason,
        requestId: comic.requestId,
        title: comic.title,
        comic: comicStatus,
      });
      return 1;
    };
    for (const comic of toRouteComics) {
      try {
        const volumeId = comic.kapowarrVolumeId
          ? Number(comic.kapowarrVolumeId)
          : await routeNewComic(input.db, input.kapowarr, comic, rootFolderId, log);
        if (volumeId == null || Number.isNaN(volumeId)) {
          // No match / no root folder — stays parked. Issue #715: a parked comic with no volume holds nothing, so
          // a `landed` it kept from a library match that is gone goes back to `requested`.
          if (!comic.kapowarrVolumeId) {
            landedReverted += await revertComicLanded(comic, 'requested', 'no_kapowarr_volume');
          }
          continue;
        }
        if (!comic.kapowarrVolumeId) comicsRouted += 1;
        // Reconcile the (just-added or existing) volume's live state into comic_status.
        const vol = await input.kapowarr.read.getVolume(volumeId);
        if (vol) {
          const volumeStatus = mapKapowarrVolumeStatus(vol);
          // Issue #715: `landed` is only true while Kapowarr holds every issue (the reconcile never regresses).
          if (volumeStatus !== 'landed') {
            landedReverted += await revertComicLanded(comic, volumeStatus, 'kapowarr_not_held');
          }
          await applyComicReconcile({
            db: input.db,
            requestId: comic.requestId,
            comicStatus: volumeStatus,
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
    pushesSkippedForeign,
    landedReverted,
    grabReverted,
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
    pushesSkippedForeign,
    requestsLandedReverted: landedReverted,
    requestsGrabReverted: grabReverted,
    ...gone,
    ...rerequest,
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
  /** Issue #665 — LazyLibrarian no longer had the book, so this search added it back first (addBook + queueBook). */
  reseated?: boolean;
  /** Issue #665 — LazyLibrarian no longer had the want's id but holds the same book under this one: the want was
   *  repointed to it and its formats queued there (no addBook). */
  rekeyedTo?: string;
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
 *
 * ADR-101 — a person's click: the re-point, reconcile and re-queue it may write record `actor: 'user'` and their id.
 */
export async function runManualBookSearch(
  input: RunManualBookSearchInput,
): Promise<RunManualBookSearchResult> {
  return withRequestEventScope(
    { actor: 'user', actorUserId: input.actorId, site: 'search-again' },
    () => runManualBookSearchAs(input),
  );
}

async function runManualBookSearchAs(
  input: RunManualBookSearchInput,
): Promise<RunManualBookSearchResult> {
  const { request } = await recordManualSearch({
    db: input.db,
    requestId: input.requestId,
    userId: input.userId,
    actorId: input.actorId,
  });

  if (request.origin === 'pairing') {
    const [anchor] = await resolveDb(input.db)
      .select()
      .from(booksItems)
      .where(eq(booksItems.id, request.pairingBooksItemId!));
    if (
      !anchor ||
      anchor.deletedAt !== null || pairingBooksItemIdentity(anchor).kind !== 'one') {
      return { searched: false, formats: [], reason: 'unroutable' };
    }
  }
  if (request.unroutableReason) return { searched: false, formats: [], reason: 'unroutable' };
  if (!request.llBookId) return { searched: false, formats: [], reason: 'no_ll_id' };

  const notLanded = searchableFormats(request);
  const candidates = input.format ? notLanded.filter((f) => f === input.format) : notLanded;
  // One `getAllBooks` per click, and only when there is something to fire (no click, no call). A failed read
  // is not fatal: it leaves the snapshot undefined, which reads as "not held" (search everything, as before).
  let snapshot: Map<string, LlHeldSignals> | undefined;
  if (candidates.length > 0) {
    try {
      snapshot = await input.ll.read.getAllBookStatuses();
    } catch {
      snapshot = undefined;
    }
  }
  const held = snapshot?.get(request.llBookId);
  const formats = candidates.filter((f) => !llFormatAlreadyHeld(held, f));
  // Every candidate was a format LL already has filed: an honest decline that points at Fix, never a
  // "Search fired" for a searchBook LazyLibrarian would have dropped on the floor.
  if (formats.length === 0 && candidates.length > 0) {
    return { searched: false, formats: [], reason: 'already_held' };
  }
  // Issue #665 — LazyLibrarian no longer has the book (a usable snapshot without it): the want was settled
  // `missing` because LL lost it. `searchBook` alone would be a silent no-op (LL searches only rows it holds as
  // `Wanted`). Never on a failed or empty read — the guard may only ever add a call when it KNOWS the book is gone.
  const gone = formats.length > 0 && llSnapshotUsable(snapshot) && held === undefined;
  if (gone && snapshot) {
    // LazyLibrarian may hold the same book under another id (the unattended reconcile leaves a row it holds as
    // `Skipped` to this click, so it never searches on its own). Point the want at it and queue that row.
    const rekeyedTo = new LlRekeyIndex(snapshot).find(request.title, request.author);
    if (rekeyedTo) return rekeyManualSearch(input, request, snapshot, rekeyedTo, formats);
  }
  // Otherwise add it back first: addBook, queueBook per format, then the one search.
  const reseat = gone;
  try {
    if (reseat) {
      await input.ll.write.addBook(request.llBookId);
      for (const format of formats) await input.ll.write.queueBook(request.llBookId, format);
    }
    // ONE call: LazyLibrarian's searchBook ignores `type` and searches every Wanted format of the book
    // (issue #644), so a call per format would hit the indexers twice for a book wanted in both.
    if (formats.length > 0) await input.ll.write.searchBook(request.llBookId, formats[0]!);
  } catch (error) {
    throw new LazyLibrarianUpstreamError('LazyLibrarian search failed', { cause: error });
  }
  if (reseat) {
    // The re-added formats are being looked for again (`missing` → `wanted`), and the stamp restarts the grace.
    await markRequestFormatsRequeued({ db: input.db, requestId: request.id, formats });
    return { searched: true, formats, reseated: true };
  }
  // A per-format request whose format already landed narrows to nothing — honest "nothing fired".
  return { searched: formats.length > 0, formats };
}

/**
 * Issue #665 — the Search-again leg for a want whose id LazyLibrarian lost but whose book it holds under another
 * id: repoint the want, reconcile it from that row (a held format lands), then queue + search the formats that row
 * does not hold — on LL's existing row, so no addBook and no duplicate book.
 */
async function rekeyManualSearch(
  input: RunManualBookSearchInput,
  request: { id: string; llBookId: string | null },
  snapshot: Map<string, LlHeldSignals>,
  rekeyedTo: string,
  formats: Array<'ebook' | 'audiobook'>,
): Promise<RunManualBookSearchResult> {
  const now = new Date();
  const moved = await repointRequestLlBook({
    db: input.db,
    requestId: request.id,
    fromLlBookId: request.llBookId!,
    toLlBookId: rekeyedTo,
    now,
  });
  // Another writer changed the want's id since this click read it: fire nothing on a row it may no longer
  // point at (an honest "nothing fired"; the person can search again).
  if (!moved) return { searched: false, formats: [] };
  const row = snapshot.get(rekeyedTo);
  await applyRequestReconcile({
    db: input.db,
    requestId: request.id,
    ebookStatus: llReconcileStatus(row, 'ebook'),
    audioStatus: llReconcileStatus(row, 'audiobook'),
    now,
  });
  const toQueue = formats.filter((f) => !llFormatAlreadyHeld(row, f));
  if (toQueue.length === 0) return { searched: false, formats: [], reason: 'already_held', rekeyedTo };
  try {
    for (const format of toQueue) await input.ll.write.queueBook(rekeyedTo, format);
    await input.ll.write.searchBook(rekeyedTo, toQueue[0]!);
  } catch (error) {
    throw new LazyLibrarianUpstreamError('LazyLibrarian search failed', { cause: error });
  }
  await markRequestFormatsRequeued({ db: input.db, requestId: request.id, formats: toQueue, now });
  return { searched: true, formats: toQueue, rekeyedTo };
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
