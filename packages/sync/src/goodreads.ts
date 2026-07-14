// ADR-055 / DESIGN-028 (PLAN-044) — the `goodreads-sync` mode's READ side. For each LINKED Goodreads
// integration it pages the user's PUBLIC shelf RSS (read-only), enriches each item against Google Books
// (mandatory retry/backoff, comic classification), and hands the enriched snapshot to the @hnet/domain
// `syncGoodreadsIntegration` orchestrator (which does the DB writes + the confined LazyLibrarian pushes).
// Pull-only by construction — Goodreads has no write API. Mirrors the books-sync split (external reads +
// normalize here; the single-writers + confined writes in packages/domain).
import type { DbClient } from '@hnet/db';
import {
  listLinkedIntegrations,
  markIntegrationSynced,
  syncGoodreadsIntegration,
  type EnrichedShelfItem,
  type KapowarrClientBundle,
  type LazyLibrarianClientBundle,
  type SyncGoodreadsReport,
} from '@hnet/domain';
import { isComicText, type GoodreadsRssClient, type GoogleBooksClient } from '@hnet/goodreads';
import { noopLogger, type SyncLogger } from './logger';

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

  for (const integ of integrations) {
    try {
      const enriched: EnrichedShelfItem[] = [];
      const syncedShelves: string[] = [];
      for (const shelf of integ.shelves) {
        const items = await input.goodreads.rss.fetchShelf(integ.externalUserId, shelf);
        for (const item of items) {
          // GB enrichment: mandatory retry/backoff lives in the client; a final failure degrades to no id
          // (the want stays honestly un-pushable rather than fabricating a volume).
          const gb = await input.goodreads.googleBooks
            .resolveVolume({ isbn: item.isbn, title: item.title, author: item.author })
            .catch((error: unknown) => {
              logger.error('goodreads-sync: GB enrichment failed', {
                title: item.title,
                error: error instanceof Error ? error.message : String(error),
              });
              return null;
            });
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

  return { integrations: integrations.length, synced, failed, perIntegration };
}
