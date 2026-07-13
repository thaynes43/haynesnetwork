// ADR-046 / DESIGN-024 (PLAN-023 — Books & Audiobooks) — the SINGLE WRITER for the books ledger
// (`books_items`). The `books-sync` mode pages Kavita + ABS read-only, the @hnet/sync client normalizes
// each series/item to a BooksItemInput (it knows the wire shapes), and this writer upserts the snapshot
// and TOMBSTONES rows no longer served — all in one transaction. Rebuildable read-model (data of record
// = Kavita/ABS), so no per-row audit event; the no-direct-state-writes guard forbids any other module
// from touching the table. READ-ONLY against the book servers — this writer never calls them.
import { booksItems, type BooksMediaKind, type BooksSource, type DbClient } from '@hnet/db';
import { and, inArray, isNull, lt, sql } from 'drizzle-orm';
import { inTransaction } from './db-client';

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
