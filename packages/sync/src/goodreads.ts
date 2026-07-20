// ADR-055 / DESIGN-028 (PLAN-044) — the `goodreads-sync` mode's READ side. For each LINKED Goodreads
// integration it pages the user's PUBLIC shelf RSS (read-only), enriches each item against Google Books
// (mandatory retry/backoff, comic classification), and hands the enriched snapshot to the @hnet/domain
// `syncGoodreadsIntegration` orchestrator (which does the DB writes + the confined LazyLibrarian pushes).
// Pull-only by construction — Goodreads has no write API. Mirrors the books-sync split (external reads +
// normalize here; the single-writers + confined writes in packages/domain).
import type { DbClient } from '@hnet/db';
import {
  guardedGbResolve,
  listIntegrationsForSync,
  makeGbBudgetTracker,
  markIntegrationSynced,
  noteIntegrationSyncBlip,
  peekGbQuotaGate,
  retryQueuedBookFixes,
  syncGoodreadsIntegration,
  type EnrichedShelfItem,
  type GbCallMeter,
  type KapowarrClientBundle,
  type LazyLibrarianClientBundle,
  type RetryQueuedBookFixesReport,
  type SyncGoodreadsReport,
} from '@hnet/domain';
import {
  classifyGoodreadsFailure,
  isAbsentCustomShelfError,
  isComicText,
  type GbVolume,
  type GoodreadsRssClient,
  type GoodreadsShelfItem,
  type GoogleBooksClient,
} from '@hnet/goodreads';
import { noopLogger, type SyncLogger } from './logger';

/**
 * ADR-057 / PLAN-045 A3 — fetch one shelf, tolerating an ABSENT CUSTOM shelf: 'did-not-finish' is a
 * conventional custom shelf most accounts never created, and Goodreads 404s its RSS. That reads as an
 * EMPTY shelf (zero items — still synced, so tombstoning stays scoped correctly), never an integration
 * error. A built-in shelf failure still throws (private/unreachable — the per-integration error path).
 */
export async function fetchShelfTolerant(
  rss: GoodreadsRssClient,
  externalUserId: string,
  shelf: string,
): Promise<GoodreadsShelfItem[]> {
  try {
    return await rss.fetchShelf(externalUserId, shelf);
  } catch (error) {
    if (isAbsentCustomShelfError(shelf, error)) return [];
    throw error;
  }
}

/** The read clients the goodreads-sync mode needs (RSS + GB enrichment). */
export interface GoodreadsSourceBundle {
  rss: GoodreadsRssClient;
  googleBooks: GoogleBooksClient;
}

export interface GoodreadsSyncReport {
  /** Integrations on the worklist this run ('linked' + due 'error' rows — the self-healing worklist). */
  integrations: number;
  synced: number;
  failed: number;
  /**
   * ADR-057 amend (goodreads-sync resilience) — integrations whose run hit a TRANSIENT upstream blip on
   * one or more shelves (5xx/429/network/timeout). The link is KEPT (never flipped to 'error') and the
   * blip is recorded as a soft note in last_sync_error; the integration retries next run.
   */
  transientBlips: number;
  /**
   * ADR-067 C-07 (PLAN-055) — shelf items whose GB enrichment was SKIPPED because the quota
   * breaker was/went open this run (they mirror honestly un-enriched; one log line, zero 429s).
   */
  skippedEnrichment: number;
  /**
   * DESIGN-039 D-23 — shelf items whose GB enrichment was skipped because the 'goodreads' daily CALL
   * BUDGET was spent (distinct from skippedEnrichment, the shared 429 breaker). The item still mirrors
   * honestly un-enriched (the comic text-marker fallback still applies); no breaker trip.
   */
  skippedBudget: number;
  /** ADR-067 C-06 — the queued-book-fix retry pass hosted in this run (absent when LL/GB missing). */
  fixRetries?: RetryQueuedBookFixesReport;
  perIntegration: Array<{
    integrationId: string;
    userId: string;
    ok: boolean;
    error?: string;
    report?: SyncGoodreadsReport;
    /** A transient upstream blip on one or more shelves this run — link kept, retries next run. */
    blip?: string;
  }>;
}

/**
 * Run the goodreads-sync pass: for every integration on the self-healing worklist (every 'linked' row plus
 * any 'error' row past its retry backoff — listIntegrationsForSync), fetch + enrich its shelves and hand
 * them to the domain orchestrator. Per-shelf isolation with TRANSIENT/PERMANENT classification (ADR-057
 * amend): a transient upstream blip (5xx/429/network/timeout) on a shelf is skipped, the link is KEPT, and
 * the integration retries next run (a soft note in last_sync_error only); a PERMANENT failure
 * (profile private/deleted — a built-in shelf 404/403/410, or an unexpected throw) marks THAT integration
 * `error` (via markIntegrationSynced) and continues; it never fails the whole run. A previously-'error'
 * row self-heals to 'linked' the moment a shelf reads cleanly. A run with zero worklist rows is a clean
 * no-op (not a failure).
 */
export async function runGoodreadsSync(input: {
  db?: DbClient;
  goodreads: GoodreadsSourceBundle;
  ll?: LazyLibrarianClientBundle;
  /** ADR-056 (PLAN-046) — the confined Kapowarr bundle for comic routing. Absent ⇒ comics stay parked. */
  kapowarr?: KapowarrClientBundle;
  /**
   * DESIGN-039 D-21/D-23 — the daily GB CALL BUDGET meter wired into the GB client's http wrapper.
   * Present ⇒ enrichment is budgeted (consumer 'goodreads') and the queued-fix retry pass is metered
   * (consumer 'bookfix'); absent ⇒ no budgeting/metering (tests / degraded) — pre-budget behaviour.
   */
  meter?: GbCallMeter;
  now?: Date;
  logger?: SyncLogger;
}): Promise<GoodreadsSyncReport> {
  const logger = input.logger ?? noopLogger;
  const integrations = await listIntegrationsForSync({
    db: input.db,
    provider: 'goodreads',
    ...(input.now ? { now: input.now } : {}),
  });
  const perIntegration: GoodreadsSyncReport['perIntegration'] = [];
  let synced = 0;
  let failed = 0;
  let transientBlips = 0;

  // ADR-067 C-07 — the GB quota breaker, consulted ONCE up front (an expired window peeks closed,
  // so the run's first guarded resolve below makes the half-open probe). When open: ZERO GB calls
  // this run, ONE log line, items mirror honestly un-enriched (the text-marker comic fallback
  // still applies) and are counted as skippedEnrichment.
  let quotaOpen = false;
  let skippedEnrichment = 0;
  const gate = await peekGbQuotaGate({ db: input.db, ...(input.now ? { now: input.now } : {}) });
  if (gate.open) {
    quotaOpen = true;
    logger.info('goodreads-sync: GB quota exhausted — enrichment skipped this run', {
      until: gate.until?.toISOString(),
      reason: gate.reason,
    });
  }

  // DESIGN-039 D-23 — the 'goodreads' daily CALL BUDGET (built once per run; only when a meter is
  // wired — the cluster cron). When this consumer's slice is spent, the rest of the run's items mirror
  // honestly un-enriched (counted as skippedBudget) WITHOUT tripping the shared breaker.
  const enrichmentBudget = input.meter
    ? await makeGbBudgetTracker({ db: input.db, consumer: 'goodreads', ...(input.now ? { now: input.now } : {}) })
    : undefined;
  let skippedBudget = 0;
  let budgetLogged = false;

  for (const integ of integrations) {
    const enriched: EnrichedShelfItem[] = [];
    const syncedShelves: string[] = [];
    let blipNote: string | undefined; // last transient blip → soft note, link stays as-is
    let permanentError: unknown; // profile gone/private → flip to 'error' via the outer catch
    try {
      for (const shelf of integ.shelves) {
        let items: GoodreadsShelfItem[];
        try {
          items = await fetchShelfTolerant(input.goodreads.rss, integ.externalUserId, shelf);
        } catch (error) {
          // ADR-057 amend — classify the READ failure. A transient upstream blip (5xx/429/network/
          // timeout — the owner's 502) must NOT break the link: skip THIS shelf and keep going, leaving
          // its mirror intact (no syncedShelves push ⇒ no tombstoning). Only a PERMANENT failure
          // (profile private/deleted — a built-in shelf 404/403/410, or an unexpected throw) breaks the
          // integration and is re-thrown into the outer catch below (→ status='error').
          if (classifyGoodreadsFailure(error) === 'transient') {
            blipNote = error instanceof Error ? error.message : String(error);
            logger.warn('goodreads-sync: shelf transient blip — kept linked, will retry next run', {
              integrationId: integ.id,
              shelf,
              error: blipNote,
            });
            continue; // SKIP this shelf; do NOT push to syncedShelves → tombstoning stays scoped
          }
          permanentError = error; // private/deleted profile → the whole integration is broken
          break;
        }
        for (const item of items) {
          // GB enrichment through the breaker seam: per-attempt retry/backoff stays in the client;
          // a quota 429 trips the shared breaker (skipping the REST of the run — one line, not
          // dozens of doomed errors); any other final failure degrades to no id as before (the
          // want stays honestly un-pushable rather than fabricating a volume).
          let gb: GbVolume | null = null;
          if (quotaOpen) {
            skippedEnrichment += 1;
          } else if (enrichmentBudget && !enrichmentBudget.canSpend()) {
            // D-23 — daily budget spent: skip GB for the rest of the run (item mirrors un-enriched).
            skippedBudget += 1;
            if (!budgetLogged) {
              logger.info(
                'goodreads-sync: GB daily call budget spent — enrichment skipped for the rest of the run',
                { consumer: 'goodreads', used: enrichmentBudget.used() },
              );
              budgetLogged = true;
            }
          } else {
            const before = input.meter?.taken() ?? 0;
            try {
              const guarded = await guardedGbResolve({
                db: input.db,
                gb: input.goodreads.googleBooks,
                query: { isbn: item.isbn, title: item.title, author: item.author },
              });
              if (enrichmentBudget) await enrichmentBudget.spend((input.meter?.taken() ?? 0) - before);
              if (guarded.outcome === 'quota_blocked' || guarded.outcome === 'quota_tripped') {
                quotaOpen = true;
                skippedEnrichment += 1;
                logger.info(
                  'goodreads-sync: GB quota exhausted — enrichment skipped for the rest of the run',
                  { retryAfter: guarded.until.toISOString() },
                );
              } else if (guarded.outcome === 'resolved') {
                gb = guarded.volume;
              }
            } catch (error) {
              if (enrichmentBudget) await enrichmentBudget.spend((input.meter?.taken() ?? 0) - before);
              logger.error('goodreads-sync: GB enrichment failed', {
                title: item.title,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          enriched.push({
            shelf,
            externalBookId: item.externalBookId,
            title: item.title,
            author: item.author,
            isbn: gb?.isbn13 ?? item.isbn,
            gbVolumeId: gb?.volumeId ?? null,
            coverUrl: item.coverUrl,
            shelvedAt: item.shelvedAt,
            // GB classification, OR a comic marker in the shelved title/author — the safety net when GB
            // returns no match (PLAN-044 live leak: a comic must never blind-fire into LazyLibrarian).
            isComic: (gb?.isComic ?? false) || isComicText(item.title, item.author),
          });
        }
        syncedShelves.push(shelf); // only a fully-read shelf counts as synced
      }

      if (permanentError) throw permanentError; // reuse the outer catch → markIntegrationSynced = 'error'

      const allBlipped = syncedShelves.length === 0 && blipNote !== undefined;
      if (allBlipped) {
        // Every shelf blipped transiently — a blip, not a broken link. Keep status as-is ('linked' stays
        // linked; a retried 'error' row stays 'error'), record the soft note, retry next run. Do NOT run
        // the orchestrator / advance last_synced_at (nothing was truthfully read).
        await noteIntegrationSyncBlip({
          db: input.db,
          integrationId: integ.id,
          note: blipNote!,
          ...(input.now ? { now: input.now } : {}),
        });
        transientBlips += 1;
        perIntegration.push({ integrationId: integ.id, userId: integ.userId, ok: true, blip: blipNote });
      } else {
        // Partial (or full, or empty-shelves) success: sync what we read. This marks status 'linked',
        // clears last_sync_error, and advances last_synced_at (step 6 of syncGoodreadsIntegration). Because
        // tombstoning is scoped to syncedShelves, a blipped (un-read) shelf's mirror is left intact.
        const report = await syncGoodreadsIntegration({
          db: input.db,
          integrationId: integ.id,
          items: enriched,
          syncedShelves,
          ...(input.ll ? { ll: input.ll } : {}),
          ...(input.kapowarr ? { kapowarr: input.kapowarr } : {}),
          ...(input.now ? { now: input.now } : {}),
          logger,
        });
        if (blipNote) {
          // Partial: the clean-sync write just cleared last_sync_error — restore the blip so it stays
          // visible. The soft-note writer sets NO status, so it stays 'linked' with last_synced_at advanced.
          await noteIntegrationSyncBlip({
            db: input.db,
            integrationId: integ.id,
            note: blipNote,
            ...(input.now ? { now: input.now } : {}),
          });
          transientBlips += 1;
        }
        synced += 1;
        perIntegration.push({
          integrationId: integ.id,
          userId: integ.userId,
          ok: true,
          report,
          ...(blipNote ? { blip: blipNote } : {}),
        });
      }
    } catch (error) {
      // PERMANENT / orchestrator / DB failure — unchanged behavior: flip to 'error' (self-heals via the
      // worklist backoff once upstream is back and a shelf reads cleanly).
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.error('goodreads-sync: integration failed', { integrationId: integ.id, error: message });
      await markIntegrationSynced({ db: input.db, integrationId: integ.id, error: message }).catch(
        () => {},
      );
      perIntegration.push({ integrationId: integ.id, userId: integ.userId, ok: false, error: message });
    }
  }

  // ADR-067 C-06 — the queued-book-fix RETRY PASS rides this run (it already holds the GB client
  // + the confined LL bundle): oldest-first, capped, breaker-honoring; permanent failures land
  // `failed` honestly inside the pass. Absent LL ⇒ skipped (the degraded run), reported honestly.
  let fixRetries: RetryQueuedBookFixesReport | undefined;
  if (input.ll) {
    fixRetries = await retryQueuedBookFixes({
      db: input.db,
      ll: input.ll,
      gb: input.goodreads.googleBooks,
      // DESIGN-039 D-24 — meter the retry pass's GB legs into the 'bookfix' slice (metered, not
      // budget-blocked: completing a user's queued Fix rides the reserved headroom).
      ...(input.meter ? { meter: input.meter } : {}),
      ...(input.now ? { now: input.now } : {}),
      logger,
    });
    if (fixRetries.queued > 0) {
      logger.info('goodreads-sync: queued book-fix retry pass complete', { ...fixRetries });
    }
  }

  return {
    integrations: integrations.length,
    synced,
    failed,
    transientBlips,
    skippedEnrichment,
    skippedBudget,
    ...(fixRetries !== undefined ? { fixRetries } : {}),
    perIntegration,
  };
}
