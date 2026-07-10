// ADR-046 / DESIGN-024 (PLAN-023 — Books & Audiobooks) — the READ-ONLY snapshot fetcher the `books-sync`
// mode hands to the @hnet/domain syncBooks single-writer. It pages Kavita (Books + Comics libraries) and
// Audiobookshelf (Audio Books) and NORMALIZES each series/item to a BooksItemInput (the wire-shape parsing
// lives here — @hnet/sync knows the servers' shapes; the domain writer only persists). Never a live
// cross-DB read; never a write to the book servers.
import type { AbsItem, KavitaSeries } from '@hnet/books';
import { kavitaLibraryKind, type AudiobookshelfClient, type KavitaClient } from '@hnet/books/read';
import type { BooksSource } from '@hnet/db';
import type { BooksItemInput } from '@hnet/domain';
import { noopLogger, type SyncLogger } from './logger';

const KAVITA_PAGE_SIZE = 500;
const ABS_PAGE_SIZE = 500;
/** Safety cap on pages per library so a bad `total` header can never loop forever. */
const MAX_PAGES = 200;

/** The read clients + public deep-link bases the books-sync mode needs. */
export interface BooksSyncBundle {
  kavita: KavitaClient;
  audiobookshelf: AudiobookshelfClient;
  kavitaPublicUrl: string;
  audiobookshelfPublicUrl: string;
}

export interface BooksSnapshot {
  rows: BooksItemInput[];
  /** Sources whose snapshot is COMPLETE (all libraries paged without error) — tombstoning scope. */
  syncedSources: BooksSource[];
  counts: { kavitaSeries: number; absItems: number };
}

// ---------------------------------------------------------------------------
// Normalizers (pure — exported for unit tests)
// ---------------------------------------------------------------------------

const basename = (p: string): string => {
  const parts = p.split('/').filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1]! : '';
};

/**
 * Best-effort author from a Kavita series' folder paths. For books the series folder sits UNDER an author
 * folder (`folderPath` = `…/EBooks/Charlaine Harris`, `lowestFolderPath` = `…/Charlaine Harris/<series>`),
 * so folderPath's basename is the author. For comics both paths are equal (no author folder) → null.
 */
export function deriveKavitaAuthor(
  folderPath: string | null | undefined,
  lowestFolderPath: string | null | undefined,
): string | null {
  if (!folderPath || !lowestFolderPath) return null;
  if (lowestFolderPath === folderPath) return null;
  if (!lowestFolderPath.startsWith(`${folderPath}/`)) return null;
  const author = basename(folderPath);
  return author.length > 0 ? author : null;
}

const toDate = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function normalizeKavitaSeries(
  series: KavitaSeries,
  mediaKind: 'book' | 'comic',
  libraryName: string,
  publicUrl: string,
): BooksItemInput {
  const libraryId = String(series.libraryId);
  const sort = (series.sortName || series.name || String(series.id)).trim().toLowerCase();
  return {
    source: 'kavita',
    mediaKind,
    externalId: String(series.id),
    libraryId,
    libraryName: series.libraryName || libraryName,
    title: series.name,
    sortTitle: sort,
    author: deriveKavitaAuthor(series.folderPath, series.lowestFolderPath),
    narrator: null,
    seriesName: null,
    year: null,
    genres: [],
    coverRef: series.coverImage ?? null,
    deepLinkUrl: `${publicUrl}/library/${libraryId}/series/${series.id}`,
    pageCount: series.pages ?? null,
    wordCount: series.wordCount ?? null,
    durationSeconds: null,
    sizeBytes: null,
    attrs: { format: series.format ?? null },
    sourceAddedAt: toDate(series.created),
    sourceUpdatedAt: toDate(series.lastChapterAddedUtc),
  };
}

export function normalizeAbsItem(
  item: AbsItem,
  libraryId: string,
  libraryName: string,
  publicUrl: string,
): BooksItemInput {
  const meta = item.media?.metadata ?? undefined;
  const title = meta?.title || item.id;
  const sort = (meta?.titleIgnorePrefix || title).trim().toLowerCase();
  let year: number | null = null;
  if (meta?.publishedYear != null) {
    const y = typeof meta.publishedYear === 'number' ? meta.publishedYear : parseInt(meta.publishedYear, 10);
    if (Number.isFinite(y)) year = y;
  }
  const duration = item.media?.duration;
  return {
    source: 'audiobookshelf',
    mediaKind: 'audiobook',
    externalId: item.id,
    libraryId: item.libraryId || libraryId,
    libraryName,
    title,
    sortTitle: sort,
    author: meta?.authorName || null,
    narrator: meta?.narratorName || null,
    seriesName: meta?.seriesName || null,
    year,
    genres: (meta?.genres ?? []).filter((g): g is string => typeof g === 'string'),
    coverRef: item.updatedAt != null ? String(item.updatedAt) : null,
    deepLinkUrl: `${publicUrl}/item/${item.id}`,
    pageCount: null,
    wordCount: null,
    durationSeconds: duration != null ? Math.round(duration) : null,
    sizeBytes: item.media?.size ?? null,
    attrs: {
      numTracks: item.media?.numTracks ?? null,
      numChapters: item.media?.numChapters ?? null,
      language: meta?.language ?? null,
    },
    sourceAddedAt: item.addedAt != null ? new Date(item.addedAt) : null,
    sourceUpdatedAt: item.updatedAt != null ? new Date(item.updatedAt) : null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot fetch
// ---------------------------------------------------------------------------

/**
 * Page both book servers and normalize every series/item. A source is added to `syncedSources` ONLY when
 * ALL its libraries paged without error — so a partial run (a library or the whole server throwing) still
 * upserts what it read (idempotent, refreshes last_seen) but never lets syncBooks tombstone the source it
 * couldn't fully read (ADR-046 — tombstoning is scoped to syncedSources).
 */
export async function fetchBooksSnapshot(
  bundle: BooksSyncBundle,
  logger: SyncLogger = noopLogger,
): Promise<BooksSnapshot> {
  const rows: BooksItemInput[] = [];
  const syncedSources: BooksSource[] = [];
  let kavitaSeries = 0;
  let absItems = 0;

  // --- Kavita (Books + Comics) ---
  let kavitaComplete = true;
  try {
    const libs = await bundle.kavita.listLibraries();
    for (const lib of libs) {
      const kind = kavitaLibraryKind(lib.type);
      if (!kind) continue;
      try {
        let page = 1;
        for (;;) {
          const { items, total } = await bundle.kavita.listSeriesPage(lib.id, page, KAVITA_PAGE_SIZE);
          for (const s of items) {
            rows.push(normalizeKavitaSeries(s, kind, lib.name, bundle.kavitaPublicUrl));
            kavitaSeries += 1;
          }
          if (items.length === 0 || page * KAVITA_PAGE_SIZE >= total || page >= MAX_PAGES) break;
          page += 1;
        }
      } catch (error) {
        kavitaComplete = false;
        logger.error('books-sync: kavita library failed', {
          library: lib.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    kavitaComplete = false;
    logger.error('books-sync: kavita listLibraries failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (kavitaComplete) syncedSources.push('kavita');

  // --- Audiobookshelf (Audio Books) ---
  let absComplete = true;
  try {
    const libs = await bundle.audiobookshelf.listLibraries();
    for (const lib of libs) {
      if (lib.mediaType && lib.mediaType !== 'book') continue; // skip podcast libraries
      try {
        let page = 0;
        for (;;) {
          const { items, total } = await bundle.audiobookshelf.listItemsPage(
            lib.id,
            page,
            ABS_PAGE_SIZE,
          );
          for (const it of items) {
            rows.push(normalizeAbsItem(it, lib.id, lib.name, bundle.audiobookshelfPublicUrl));
            absItems += 1;
          }
          if (items.length === 0 || (page + 1) * ABS_PAGE_SIZE >= total || page >= MAX_PAGES) break;
          page += 1;
        }
      } catch (error) {
        absComplete = false;
        logger.error('books-sync: audiobookshelf library failed', {
          library: lib.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    absComplete = false;
    logger.error('books-sync: audiobookshelf listLibraries failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (absComplete) syncedSources.push('audiobookshelf');

  return { rows, syncedSources, counts: { kavitaSeries, absItems } };
}
