// ADR-066 / DESIGN-038 D-03 (PLAN-051 — books collections mirror) — the READ-ONLY fetcher the
// `books-collections-sync` mode hands to the @hnet/domain syncBooksCollections single-writer. It
// reads both book servers through the SAME BooksSyncBundle as books-sync (no new env): Kavita
// collections (GET /api/Collection + the paged all-v2 CollectionTags filter), Kavita reading lists
// (POST /api/ReadingList/lists + GET /api/ReadingList/items — CHAPTER-grain items deduped to series
// grain at the EARLIEST order, ADR-066 C-05), and ABS collections (GET /api/collections — the books
// array IS collectionBook.order ASC, verified). No write to Kavita/ABS ever — external software is
// ALWAYS the collections source of truth (owner doctrine R1). Families whose LISTING errors or
// truncates are NOT scoped, so the writer can never reconcile-drop what this run couldn't see (the
// plex-collections discipline at (source, kind) family grain).
import {
  deriveBooksCollectionProvenance,
  deriveBooksCollectionCategory,
  librettoRecipeIdFromDescription,
} from '@hnet/domain';
import type { BooksCollectionFamily, BooksCollectionSyncInput } from '@hnet/domain';
import type { BooksSyncBundle } from './books';
import { noopLogger, type SyncLogger } from './logger';

// Exported for the truncation tests (a "full page" is defined by these bounds).
export const KAVITA_COLLECTION_PAGE_SIZE = 500;
export const KAVITA_READING_LIST_PAGE_SIZE = 100;
/** Safety cap on pages per listing/collection so a bad total can never loop forever. */
const MAX_PAGES = 200;

export interface BooksCollectionsStats {
  /** Collections fetched across all families (incl. reading lists). */
  collectionsFetched: number;
  /** Member rows fetched (post series-grain dedupe for reading lists). */
  membersFetched: number;
  /** Collections whose member read FAILED or TRUNCATED (never member-reconciled). */
  truncatedCollections: number;
  /** Families whose listing failed/truncated (their collections upsert but nothing reconciles). */
  unscopedFamilies: number;
}

export interface BooksCollectionsSnapshot {
  collections: BooksCollectionSyncInput[];
  /** The (source, kind) families whose LISTING was fully read (the writer's reconcile scope). */
  scopedFamilies: BooksCollectionFamily[];
  stats: BooksCollectionsStats;
}

/**
 * DESIGN-038 D-09 — dedupe Kavita reading-list CHAPTER items to SERIES grain: each series keeps its
 * EARLIEST explicit `order`, then positions re-densify 0..n. Exported for unit tests.
 */
export function dedupeReadingListItems(
  items: Array<{ order: number; seriesId: number }>,
): Array<{ externalRef: string; position: number }> {
  const earliest = new Map<number, number>();
  for (const item of items) {
    const seen = earliest.get(item.seriesId);
    if (seen === undefined || item.order < seen) earliest.set(item.seriesId, item.order);
  }
  return [...earliest.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([seriesId], index) => ({ externalRef: String(seriesId), position: index }));
}

/**
 * Read both servers' collection families. Each family is independent (per-source isolation — a
 * Kavita outage never blocks the ABS mirror); a family whose listing fails is skipped entirely
 * (not scoped); a collection whose MEMBER read fails/truncates is kept un-fullyRead.
 */
export async function fetchBooksCollectionsSnapshot(input: {
  books: BooksSyncBundle;
  logger?: SyncLogger;
}): Promise<BooksCollectionsSnapshot> {
  const logger = input.logger ?? noopLogger;
  const collections: BooksCollectionSyncInput[] = [];
  const scopedFamilies: BooksCollectionFamily[] = [];
  const stats: BooksCollectionsStats = {
    collectionsFetched: 0,
    membersFetched: 0,
    truncatedCollections: 0,
    unscopedFamilies: 0,
  };
  const errorText = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

  // --- Kavita collections (kavita/collection — UNORDERED, D-09) ---
  try {
    const kavitaCollections = await input.books.kavita.listCollections();
    for (const collection of kavitaCollections) {
      stats.collectionsFetched += 1;
      let members: Array<{ externalRef: string; position: number }> = [];
      let fullyRead = false;
      try {
        const seriesIds: number[] = [];
        let page = 1;
        let truncated = false;
        for (;;) {
          const { items, total, hasAuthoritativeTotal } =
            await input.books.kavita.listCollectionSeriesPage(
              collection.id,
              page,
              KAVITA_COLLECTION_PAGE_SIZE,
            );
          for (const s of items) seriesIds.push(s.id);
          if (items.length === 0) break; // an empty page is an honest end-of-list
          if (hasAuthoritativeTotal) {
            if (page * KAVITA_COLLECTION_PAGE_SIZE >= total) break; // complete per the header
          } else if (items.length < KAVITA_COLLECTION_PAGE_SIZE) {
            break; // a SHORT page without a header is an honest end-of-list too
          } else {
            // Adversarial-review fix — a FULL page with NO authoritative Pagination header cannot
            // prove completion (the page-length fallback would claim it): treat the read as
            // TRUNCATED so degradation is keep-don't-reconcile, never a tail delete.
            truncated = true;
            break;
          }
          if (page >= MAX_PAGES) {
            truncated = true; // page cap hit with more upstream — never member-reconcile
            break;
          }
          page += 1;
        }
        members = seriesIds.map((id, index) => ({ externalRef: String(id), position: index }));
        fullyRead = !truncated;
        if (truncated) {
          stats.truncatedCollections += 1;
          logger.warn('books-collections-sync: kavita collection member read truncated', {
            collection: collection.id,
            title: collection.title,
            fetched: members.length,
          });
        }
        stats.membersFetched += members.length;
      } catch (error) {
        // Member read failed — keep the collection row (title/count advance), never reconcile
        // members from a read we don't have.
        stats.truncatedCollections += 1;
        logger.error(
          'books-collections-sync: kavita collection member read failed (kept, un-reconciled)',
          {
            collection: collection.id,
            error: errorText(error),
          },
        );
      }
      collections.push({
        source: 'kavita',
        externalId: String(collection.id),
        kind: 'collection',
        libraryId: null, // Kavita collections are server-wide
        title: collection.title,
        itemCount: collection.itemCount ?? members.length,
        ordered: false, // the Kavita API exposes no collection member order (D-09)
        // Provenance — 'libretto' when the summary carries Libretto's marker, else 'kavita'.
        createdBy: deriveBooksCollectionProvenance('kavita', collection.summary),
        // Recipe id (D-13) — the recipeId from the same marker (null when hand-made).
        librettoRecipeId: librettoRecipeIdFromDescription(collection.summary) ?? null,
        // Category (D-12) — the forward-compatible Libretto `cat=` derive (null today); the writer
        // COALESCE-preserves the agent-set value when this is null.
        category: deriveBooksCollectionCategory(collection.summary),
        members,
        fullyRead,
      });
    }
    scopedFamilies.push({ source: 'kavita', kind: 'collection' });
  } catch (error) {
    stats.unscopedFamilies += 1;
    logger.error('books-collections-sync: kavita collections listing failed (family not scoped)', {
      error: errorText(error),
    });
  }

  // --- Kavita reading lists (kavita/reading_list — ORDERED, explicit positions) ---
  try {
    const lists: Array<{
      id: number;
      title: string;
      itemCount: number | null | undefined;
      summary: string | null | undefined;
    }> = [];
    let page = 1;
    let listingTruncated = false;
    for (;;) {
      const { items, total, hasAuthoritativeTotal } = await input.books.kavita.listReadingListsPage(
        page,
        KAVITA_READING_LIST_PAGE_SIZE,
      );
      for (const l of items)
        lists.push({ id: l.id, title: l.title, itemCount: l.itemCount, summary: l.summary });
      if (items.length === 0) break; // an empty page is an honest end-of-list
      if (hasAuthoritativeTotal) {
        if (page * KAVITA_READING_LIST_PAGE_SIZE >= total) break; // complete per the header
      } else if (items.length < KAVITA_READING_LIST_PAGE_SIZE) {
        break; // a SHORT page without a header is an honest end-of-list too
      } else {
        // Adversarial-review fix — a FULL page with NO authoritative header cannot prove the
        // LISTING complete: truncated ⇒ the family is NOT scoped, so nothing beyond what this
        // run saw can ever be reconcile-deleted from it.
        listingTruncated = true;
        break;
      }
      if (page >= MAX_PAGES) {
        listingTruncated = true;
        break;
      }
      page += 1;
    }
    for (const list of lists) {
      stats.collectionsFetched += 1;
      let members: Array<{ externalRef: string; position: number }> = [];
      let fullyRead = false;
      try {
        const items = await input.books.kavita.listReadingListItems(list.id);
        members = dedupeReadingListItems(items); // chapter grain → series grain (D-09)
        fullyRead = true; // the items endpoint is unpaged — a successful read is complete
        stats.membersFetched += members.length;
      } catch (error) {
        stats.truncatedCollections += 1;
        logger.error(
          'books-collections-sync: reading list item read failed (kept, un-reconciled)',
          {
            readingList: list.id,
            error: errorText(error),
          },
        );
      }
      collections.push({
        source: 'kavita',
        externalId: String(list.id),
        kind: 'reading_list',
        libraryId: null, // reading lists are server-wide
        title: list.title,
        itemCount: list.itemCount ?? members.length,
        ordered: true, // explicit positions (update-position API) — the reading-order payoff
        // Provenance — 'libretto' when the summary carries Libretto's marker, else 'kavita'.
        createdBy: deriveBooksCollectionProvenance('kavita', list.summary),
        // Recipe id (D-13) — the recipeId from the same marker (null when hand-made).
        librettoRecipeId: librettoRecipeIdFromDescription(list.summary) ?? null,
        // Category (D-12) — forward-compatible Libretto `cat=` derive (null today); COALESCE-preserved.
        category: deriveBooksCollectionCategory(list.summary),
        members,
        fullyRead,
      });
    }
    if (listingTruncated) {
      // The listing itself is incomplete — everything seen upserts, but the family is NOT
      // scoped, so no reading list can be reconcile-deleted from a partial read.
      stats.unscopedFamilies += 1;
      logger.warn('books-collections-sync: reading list LISTING truncated (family not scoped)', {
        fetched: lists.length,
      });
    } else {
      scopedFamilies.push({ source: 'kavita', kind: 'reading_list' });
    }
  } catch (error) {
    stats.unscopedFamilies += 1;
    logger.error('books-collections-sync: reading list listing failed (family not scoped)', {
      error: errorText(error),
    });
  }

  // --- ABS collections (audiobookshelf/collection — ORDERED: books[] is collectionBook.order ASC) ---
  try {
    const absCollections = await input.books.audiobookshelf.listCollections();
    for (const collection of absCollections) {
      stats.collectionsFetched += 1;
      const books = collection.books ?? [];
      const members = books.map((b, index) => ({ externalRef: b.id, position: index }));
      stats.membersFetched += members.length;
      collections.push({
        source: 'audiobookshelf',
        externalId: collection.id,
        kind: 'collection',
        libraryId: collection.libraryId ?? null,
        title: collection.name,
        itemCount: books.length,
        ordered: true, // verified: the response array carries the curated order
        // Provenance — 'libretto' when the description carries Libretto's marker, else 'audiobookshelf'.
        createdBy: deriveBooksCollectionProvenance('audiobookshelf', collection.description),
        // Recipe id (D-13) — the recipeId from the same marker (null when hand-made).
        librettoRecipeId: librettoRecipeIdFromDescription(collection.description) ?? null,
        // Category (D-12) — forward-compatible Libretto `cat=` derive (null today); COALESCE-preserved.
        category: deriveBooksCollectionCategory(collection.description),
        members,
        fullyRead: true, // the single read returns the whole collection
      });
    }
    scopedFamilies.push({ source: 'audiobookshelf', kind: 'collection' });
  } catch (error) {
    stats.unscopedFamilies += 1;
    logger.error('books-collections-sync: abs collections listing failed (family not scoped)', {
      error: errorText(error),
    });
  }

  return { collections, scopedFamilies, stats };
}
