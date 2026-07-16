// ADR-055 / DESIGN-028 (PLAN-044) — the `goodreads-sync` mode's READ side. For each LINKED Goodreads
// integration it pages the user's PUBLIC shelf RSS (read-only), enriches each item against Google Books
// (mandatory retry/backoff, comic classification), and hands the enriched snapshot to the @hnet/domain
// `syncGoodreadsIntegration` orchestrator (which does the DB writes + the confined LazyLibrarian pushes).
// Pull-only by construction — Goodreads has no write API. Mirrors the books-sync split (external reads +
// normalize here; the single-writers + confined writes in packages/domain).
import type { DbClient } from '@hnet/db';
import {
  guardedGbResolve,
  listLinkedIntegrations,
  markIntegrationSynced,
  peekGbQuotaGate,
  retryQueuedBookFixes,
  syncGoodreadsIntegration,
  type EnrichedShelfItem,
  type KapowarrClientBundle,
  type LazyLibrarianClientBundle,
  type RetryQueuedBookFixesReport,
  type SyncGoodreadsReport,
} from '@hnet/domain';
import {
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
  /** Linked integrations found. */
  integrations: number;
  synced: number;
  failed: number;
  /**
   * ADR-067 C-07 (PLAN-055) — shelf items whose GB enrichment was SKIPPED because the quota
   * breaker was/went open this run (they mirror honestly un-enriched; one log line, zero 429s).
   */
  skippedEnrichment: number;
  /** ADR-067 C-06 — the queued-book-fix retry pass hosted in this run (absent when LL/GB missing). */
  fixRetries?: RetryQueuedBookFixesReport;
  perIntegration: Array<{
    integrationId: string;
    userId: string;
    ok: boolean;
    error?: string;
    report?: SyncGoodreadsReport;
  }>;
}

/**
 * Run the goodreads-sync pass: for every LINKED Goodreads integration, fetch + enrich its shelves and hand
 * them to the domain orchestrator. Per-integration isolation — one unreachable/private shelf marks THAT
 * integration `error` (via markIntegrationSynced) and continues; it never fails the whole run. A run with
 * zero linked integrations is a clean no-op (not a failure).
 */
export async function runGoodreadsSync(input: {
  db?: DbClient;
  goodreads: GoodreadsSourceBundle;
  ll?: LazyLibrarianClientBundle;
  /** ADR-056 (PLAN-046) — the confined Kapowarr bundle for comic routing. Absent ⇒ comics stay parked. */
  kapowarr?: KapowarrClientBundle;
  now?: Date;
  logger?: SyncLogger;
}): Promise<GoodreadsSyncReport> {
  const logger = input.logger ?? noopLogger;
  const integrations = await listLinkedIntegrations({ db: input.db, provider: 'goodreads' });
  const perIntegration: GoodreadsSyncReport['perIntegration'] = [];
  let synced = 0;
  let failed = 0;

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

  for (const integ of integrations) {
    try {
      const enriched: EnrichedShelfItem[] = [];
      const syncedShelves: string[] = [];
      for (const shelf of integ.shelves) {
        const items = await fetchShelfTolerant(input.goodreads.rss, integ.externalUserId, shelf);
        for (const item of items) {
          // GB enrichment through the breaker seam: per-attempt retry/backoff stays in the client;
          // a quota 429 trips the shared breaker (skipping the REST of the run — one line, not
          // dozens of doomed errors); any other final failure degrades to no id as before (the
          // want stays honestly un-pushable rather than fabricating a volume).
          let gb: GbVolume | null = null;
          if (quotaOpen) {
            skippedEnrichment += 1;
          } else {
            try {
              const guarded = await guardedGbResolve({
                db: input.db,
                gb: input.goodreads.googleBooks,
                query: { isbn: item.isbn, title: item.title, author: item.author },
              });
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
        syncedShelves.push(shelf);
      }

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
      synced += 1;
      perIntegration.push({ integrationId: integ.id, userId: integ.userId, ok: true, report });
    } catch (error) {
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
    skippedEnrichment,
    ...(fixRetries !== undefined ? { fixRetries } : {}),
    perIntegration,
  };
}
