// ADR-055 / DESIGN-028 (PLAN-044) — the SINGLE WRITER for integration_shelf_items (the synced shelf-RSS
// mirror). The goodreads-sync mode pages each linked user's PUBLIC shelf RSS read-only, the @hnet/sync
// fetcher normalizes + GB-enriches each item, and this writer upserts the snapshot and TOMBSTONES rows a
// fully-read shelf no longer serves — all in one transaction (with, since issue #735, a LazyLibrarian Release for
// each tombstoned want's queued formats). Rebuildable read-model (books_items class):
// no per-row audit. The guard forbids any other module from touching the table.
import { bookRequests, integrationShelfItems, type DbClient, type IntegrationShelfItemRow } from '@hnet/db';
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { llQueuedFormats, recordLlReleases } from './ll-release-record';

/** One shelf RSS item (+ GB enrichment) reduced to the mirror row. */
export interface ShelfItemInput {
  shelf: string;
  externalBookId: string;
  title: string;
  author: string | null;
  isbn: string | null;
  gbVolumeId: string | null;
  coverUrl: string | null;
  shelvedAt: Date | null;
}

export interface UpsertShelfItemsInput {
  db?: DbClient;
  integrationId: string;
  items: ShelfItemInput[];
  /** The shelves whose snapshot is COMPLETE this run — tombstoning is scoped to these. */
  syncedShelves: readonly string[];
  now?: Date;
}

export interface UpsertShelfItemsResult {
  upserted: number;
  tombstoned: number;
  /** The live shelf items after the upsert (id + fields) — the request-minting reads these. */
  liveItems: IntegrationShelfItemRow[];
}

/**
 * Upsert the fresh shelf snapshot on (integration, shelf, external_book_id) — a re-sync REPLACES each row
 * (and un-tombstones a re-appeared item), advancing last_seen_at. Then TOMBSTONE any live row of a
 * fully-synced shelf not touched this run. Returns the LIVE shelf items for the request minter.
 */
export async function upsertShelfItems(
  input: UpsertShelfItemsInput,
): Promise<UpsertShelfItemsResult> {
  const runStart = input.now ?? new Date();
  let tombstoned = 0;

  await inTransaction(input.db, async (tx) => {
    if (input.items.length > 0) {
      const values = input.items.map((r) => ({
        integrationId: input.integrationId,
        shelf: r.shelf,
        externalBookId: r.externalBookId,
        title: r.title,
        author: r.author,
        isbn: r.isbn,
        gbVolumeId: r.gbVolumeId,
        coverUrl: r.coverUrl,
        shelvedAt: r.shelvedAt,
        firstSeenAt: runStart,
        lastSeenAt: runStart,
        deletedAt: null as Date | null,
        updatedAt: runStart,
      }));
      await tx
        .insert(integrationShelfItems)
        .values(values)
        .onConflictDoUpdate({
          target: [
            integrationShelfItems.integrationId,
            integrationShelfItems.shelf,
            integrationShelfItems.externalBookId,
          ],
          set: {
            title: sql`excluded.title`,
            author: sql`excluded.author`,
            isbn: sql`excluded.isbn`,
            // GB enrichment is best-effort per run — keep a previously-resolved id if this run couldn't.
            gbVolumeId: sql`COALESCE(excluded.gb_volume_id, ${integrationShelfItems.gbVolumeId})`,
            coverUrl: sql`excluded.cover_url`,
            shelvedAt: sql`excluded.shelved_at`,
            lastSeenAt: sql`excluded.last_seen_at`,
            deletedAt: sql`NULL`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }

    if (input.syncedShelves.length > 0) {
      const result = await tx
        .update(integrationShelfItems)
        .set({ deletedAt: runStart, updatedAt: runStart })
        .where(
          and(
            eq(integrationShelfItems.integrationId, input.integrationId),
            inArray(integrationShelfItems.shelf, [...input.syncedShelves]),
            lt(integrationShelfItems.lastSeenAt, runStart),
            isNull(integrationShelfItems.deletedAt),
          ),
        )
        .returning({ id: integrationShelfItems.id });
      tombstoned = result.length;
      // Issue #735 — a want taken off the shelf is no longer the app's: the LazyLibrarian formats it had queued for
      // it are released (same transaction), so LazyLibrarian stops searching them unless another live request asks.
      // Re-shelving the book later picks the request up again (the reconcile, then the Skipped sweep re-queues it).
      if (result.length > 0) {
        const wants = await tx
          .select()
          .from(bookRequests)
          .where(
            and(
              inArray(
                bookRequests.shelfItemId,
                result.map((r) => r.id),
              ),
              isNotNull(bookRequests.llBookId),
              isNull(bookRequests.unroutableReason),
              isNull(bookRequests.comicStatus),
            ),
          );
        for (const want of wants) {
          await recordLlReleases(tx, {
            llBookId: want.llBookId,
            formats: llQueuedFormats(want, ['ebook', 'audiobook']),
            reason: 'shelf_removed',
            requestId: want.id,
            now: runStart,
          });
        }
      }
    }
  });

  const liveItems = await resolveDb(input.db)
    .select()
    .from(integrationShelfItems)
    .where(
      and(
        eq(integrationShelfItems.integrationId, input.integrationId),
        isNull(integrationShelfItems.deletedAt),
      ),
    );

  return { upserted: input.items.length, tombstoned, liveItems };
}
