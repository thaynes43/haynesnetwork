// ADR-046 / DESIGN-024 (PLAN-023 — Books & Audiobooks) — the SINGLE WRITER for the books ledger
// (`books_items`). The `books-sync` mode pages Kavita + ABS read-only, the @hnet/sync client normalizes
// each series/item to a BooksItemInput (it knows the wire shapes), and this writer upserts the snapshot
// and TOMBSTONES rows no longer served — all in one transaction. Rebuildable read-model (data of record
// = Kavita/ABS), so no per-row audit event; the no-direct-state-writes guard forbids any other module
// from touching the table. READ-ONLY against the book servers — this writer never calls them.
import { booksItems, type BooksMediaKind, type BooksSource, type DbClient } from '@hnet/db';
import { and, inArray, isNull, lt, sql } from 'drizzle-orm';
import { inTransaction } from './db-client';

/**
 * Issue #661 (DESIGN-024 D-01 amendment 2026-10-04) — one book a Kavita BOOK series holds: one chapter of
 * `GET /api/Series/volumes`, i.e. one book file. The books-sync stores the list as the mirror row's
 * `attrs.heldBooks`, because a Kavita row's `title` is its SERIES name, not a book title (the series
 * "A Song of Ice and Fire" can hold only Fire & Blood). Raw Kavita values, no cleaning: the pairing
 * leg decides what to make of them (DESIGN-036 amendment 2026-10-04).
 */
export interface HeldBook {
  /** The book's own title (the chapter's epub title, else a non-numeric chapter title); null when Kavita has none. */
  title: string | null;
  /** The chapter's first writer; null when none. */
  author: string | null;
  /** All actual chapter Writers, when captured; older snapshots retain the first writer above. */
  authors?: string[];
  /** The chapter's epub ISBN; null when absent. */
  isbn: string | null;
}

const nullableString = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;

/**
 * Read `attrs.heldBooks` back from a mirror row. `undefined` means the row was never read for its held
 * books (an ABS or comic row, a row the books-sync has not reached yet, or one whose every fetch failed):
 * unknown, which is not the same as an empty list (the series holds no book file).
 */
export function readHeldBooks(attrs: Record<string, unknown> | null | undefined): HeldBook[] | undefined {
  const raw = attrs?.heldBooks;
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
    .map((b) => ({
      title: nullableString(b.title), author: nullableString(b.author), isbn: nullableString(b.isbn),
      ...(Array.isArray(b.authors)
        ? { authors: b.authors.every((a) => nullableString(a) !== null)
            ? b.authors.map((a) => nullableString(a)!) : [] }
        : b.authors !== undefined ? { authors: [] } : {}),
    }));
}

/** Explicit source credits retain their declared boundaries; absent differs from explicitly empty. */
export function readSourceAuthors(attrs: Record<string, unknown> | null | undefined): string[] | undefined {
  if (attrs?.authors === undefined) return undefined;
  if (!Array.isArray(attrs.authors)) return [];
  return attrs.authors.every((a) => nullableString(a) !== null)
    ? attrs.authors.map((a) => nullableString(a)!) : [];
}

/** One Kavita series / ABS item reduced to the ledger row the mirror stores. */
export interface BooksItemInput {
  source: BooksSource;
  mediaKind: BooksMediaKind;
  externalId: string;
  libraryId: string;
  libraryName: string;
  title: string;
  sortTitle: string;
  author: string | null;
  narrator: string | null;
  seriesName: string | null;
  year: number | null;
  /** ADR-051 C-05 / DESIGN-026 D-05 — the precise release instant (ABS publishedDate; Kavita null). */
  releasedAt: Date | null;
  genres: string[];
  coverRef: string | null;
  deepLinkUrl: string;
  pageCount: number | null;
  wordCount: number | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  attrs: Record<string, unknown>;
  sourceAddedAt: Date | null;
  sourceUpdatedAt: Date | null;
  // DESIGN-024 D-01 amendment (detail-page parity) — the About/Details enrichment. All nullable; a
  // skipped/un-enriched Kavita series carries these forward from the mirror (the change-gate), so the
  // upsert stays a clean full-replace (the row always equals the snapshot).
  summary?: string | null;
  publisher?: string | null;
  isbn?: string | null;
  fileCount?: number | null;
  /** When the per-series Kavita metadata enrichment last ran (the change-gate bookkeeping). */
  metadataSyncedAt?: Date | null;
}

export interface SyncBooksInput {
  db?: DbClient;
  rows: BooksItemInput[];
  /**
   * The sources whose snapshot is COMPLETE this run — tombstoning is scoped to these so a partial run
   * (e.g. Kavita OK, ABS unreachable) never wrongly tombstones the source it couldn't read.
   */
  syncedSources: readonly BooksSource[];
  now?: Date;
}

export interface SyncBooksReport {
  upserted: number;
  /** Rows tombstoned this run (present before, absent from the fresh snapshot of a synced source). */
  tombstoned: number;
  byKind: Record<BooksMediaKind, number>;
}

const BOOKS_UPSERT_CHUNK = 500;

/**
 * ADR-046 — upsert the fresh books snapshot on `(source, external_id)` (ON CONFLICT DO UPDATE): a re-sync
 * REPLACES each row from the just-polled values (and clears any tombstone — a re-appeared item goes live
 * again), advancing `last_seen_at`. Then TOMBSTONE: any row of a fully-synced source not touched this run
 * (its `last_seen_at` predates the run) gets `deleted_at` set — never hard-deleted (the wall shows live
 * rows; a later reader/report can still see what vanished). One transaction; no per-row audit.
 */
export async function syncBooks(input: SyncBooksInput): Promise<SyncBooksReport> {
  const runStart = input.now ?? new Date();
  const byKind: Record<BooksMediaKind, number> = { book: 0, comic: 0, audiobook: 0 };
  for (const r of input.rows) byKind[r.mediaKind] += 1;

  const values = input.rows.map((r) => ({
    source: r.source,
    mediaKind: r.mediaKind,
    externalId: r.externalId,
    libraryId: r.libraryId,
    libraryName: r.libraryName,
    title: r.title,
    sortTitle: r.sortTitle,
    author: r.author,
    narrator: r.narrator,
    seriesName: r.seriesName,
    year: r.year,
    releasedAt: r.releasedAt,
    genres: r.genres,
    coverRef: r.coverRef,
    deepLinkUrl: r.deepLinkUrl,
    pageCount: r.pageCount,
    wordCount: r.wordCount,
    durationSeconds: r.durationSeconds,
    sizeBytes: r.sizeBytes,
    attrs: r.attrs,
    sourceAddedAt: r.sourceAddedAt,
    sourceUpdatedAt: r.sourceUpdatedAt,
    summary: r.summary ?? null,
    publisher: r.publisher ?? null,
    isbn: r.isbn ?? null,
    fileCount: r.fileCount ?? null,
    metadataSyncedAt: r.metadataSyncedAt ?? null,
    firstSeenAt: runStart,
    lastSeenAt: runStart,
    deletedAt: null,
    updatedAt: runStart,
  }));

  let tombstoned = 0;

  await inTransaction(input.db, async (tx) => {
    for (let i = 0; i < values.length; i += BOOKS_UPSERT_CHUNK) {
      const chunk = values.slice(i, i + BOOKS_UPSERT_CHUNK);
      await tx
        .insert(booksItems)
        .values(chunk)
        .onConflictDoUpdate({
          target: [booksItems.source, booksItems.externalId],
          set: {
            mediaKind: sql`excluded.media_kind`,
            libraryId: sql`excluded.library_id`,
            libraryName: sql`excluded.library_name`,
            title: sql`excluded.title`,
            sortTitle: sql`excluded.sort_title`,
            author: sql`excluded.author`,
            narrator: sql`excluded.narrator`,
            seriesName: sql`excluded.series_name`,
            year: sql`excluded.year`,
            releasedAt: sql`excluded.released_at`,
            genres: sql`excluded.genres`,
            coverRef: sql`excluded.cover_ref`,
            deepLinkUrl: sql`excluded.deep_link_url`,
            pageCount: sql`excluded.page_count`,
            wordCount: sql`excluded.word_count`,
            durationSeconds: sql`excluded.duration_seconds`,
            sizeBytes: sql`excluded.size_bytes`,
            attrs: sql`excluded.attrs`,
            sourceAddedAt: sql`excluded.source_added_at`,
            sourceUpdatedAt: sql`excluded.source_updated_at`,
            summary: sql`excluded.summary`,
            publisher: sql`excluded.publisher`,
            isbn: sql`excluded.isbn`,
            fileCount: sql`excluded.file_count`,
            metadataSyncedAt: sql`excluded.metadata_synced_at`,
            lastSeenAt: sql`excluded.last_seen_at`,
            deletedAt: sql`NULL`, // un-tombstone a re-appeared item
            updatedAt: sql`excluded.updated_at`,
            // firstSeenAt / createdAt keep their original values (not in the set).
          },
        });
    }

    // Tombstone rows of a fully-synced source that were not upserted this run.
    if (input.syncedSources.length > 0) {
      const result = await tx
        .update(booksItems)
        .set({ deletedAt: runStart, updatedAt: runStart })
        .where(
          and(
            inArray(booksItems.source, [...input.syncedSources]),
            lt(booksItems.lastSeenAt, runStart),
            isNull(booksItems.deletedAt),
          ),
        )
        .returning({ id: booksItems.id });
      tombstoned = result.length;
    }
  });

  return { upserted: values.length, tombstoned, byKind };
}
