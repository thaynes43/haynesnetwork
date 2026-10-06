// Issue #759 (DESIGN-028 amendment 2026-10-06, DESIGN-038 D-13) — a collection want LazyLibrarian has DOWNLOADED but
// the library cannot show: "Downloaded, not in the library yet".
//
// A collection want is Libretto's missing set made visible: it exists while Libretto lists the member missing from the
// collection's library, and the wants pass deletes it once the library holds the member. LazyLibrarian holding the file
// does not end it. Usually that gap is only the library's next scan, but some files never arrive: Kavita's Books library
// opens epub and pdf only, so a `.mobi` or `.azw3` LazyLibrarian took stays out of it for good. Such a want read
// `requested` ("Wanted") while the book sat downloaded, which is wrong in the other direction.
//
// So, once an hour after the wants pass, the collection want's OWN format reads `landed` while all of this is true, and
// goes back to `requested` as soon as any of it stops being true:
//
//   1. LazyLibrarian holds the format (`llFormatAlreadyHeld`: `Open`/`Have`, or an import date or file);
//   2. its book is the member's (both Volume Checks: `llBookMismatch` finds nothing, and `llBookNamesTitle` reads the
//      member's own title; and, issue #771, the Author Check: LazyLibrarian does not credit it to another author, unless
//      an author-guarded resolve vouched for that book), so another work's book never says the member was downloaded;
//   3. the library shows nothing named like LazyLibrarian's book (`libraryShowsTitle` over the live mirror of that
//      format). When it does, the file reached the library and only the pairing failed (a title that differs in
//      words), and "not in the library" would be false: the want stays `requested`.
//
// The drill keeps such a want as a tile (`getCollectionWantedBookRequests`) and labels it Downloaded. The force-search
// already skips a `landed` format, so nothing searches for a book LazyLibrarian holds. Records a Request Event (ADR-101),
// like every book_requests write; one guarded writer (`setCollectionWantDownloaded`). An empty or failed `getAllBooks` read decides
// nothing.
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { bookRequests, booksCollections, booksItems, type DbClient } from '@hnet/db';
import { inTransaction, resolveDb } from './db-client';
import { updateBookRequests } from './book-request-events';
import { llFormatAlreadyHeld } from './book-requests';
import { llBookAuthorMismatch, llBookMismatch, llBookNamesTitle } from './ll-book-check';
import { llSnapshotUsable, type LlSnapshotRow } from './ll-gone';
import { collectionFormatForSource } from './ll-release-record';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';

type BookFormat = 'ebook' | 'audiobook';

/**
 * Fold a title for the "does the library show it" test: diacritics, bracketed noise, apostrophes and punctuation, and a
 * leading article go; `&` reads `and`. Empty when nothing comparable is left. Pure.
 */
export function libraryTitleKey(title: string | null | undefined): string {
  return (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/['’`ʼ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^(the|a|an)\s+/, '')
    .trim();
}

/** A key long enough to say something on its own: two words, or one of six letters ("Rapport", not "Me"). */
const telling = (key: string): boolean => key.includes(' ') || key.length >= 6;

/** `inner` occurs in `outer` as whole words. */
const within = (outer: string, inner: string): boolean => ` ${outer} `.includes(` ${inner} `);

/**
 * Does the library show a book named like `llTitle`? True when a live library title equals it, contains it as whole
 * words ("From Percy Jackson: Camp Half-Blood Confidential: Your Real Guide..." for "Camp Half-Blood Confidential"), or
 * is contained in it ("The World of Divergent" for "The World of Divergent. The Path to Allegiant"), the contained side
 * long enough to tell. It errs toward true: a wrong true only keeps a want `requested`, as it was before. Pure.
 */
export function libraryShowsTitle(
  llTitle: string | null | undefined,
  libraryKeys: Iterable<string>,
): boolean {
  const key = libraryTitleKey(llTitle);
  if (key.length === 0) return true; // nothing to compare: never claim the library lacks it
  for (const library of libraryKeys) {
    if (library.length === 0) continue;
    if (library === key) return true;
    if (telling(key) && within(library, key)) return true;
    if (telling(library) && within(key, library)) return true;
  }
  return false;
}

/**
 * Is this collection want's own format downloaded but not in the library (the three conditions in the header)? Pure.
 * `libraryKeys` are `libraryTitleKey`s of the live library items of that format.
 */
export function collectionWantDownloaded(input: {
  want: {
    title: string;
    author: string | null;
    llBookId?: string | null;
    wrongAuthorLlBookId?: string | null;
  };
  book: LlSnapshotRow | undefined;
  format: BookFormat;
  libraryKeys: Iterable<string>;
}): boolean {
  const { want, book, format } = input;
  if (!book || !llFormatAlreadyHeld(book, format)) return false;
  if (llBookMismatch(want, book) !== null || !llBookNamesTitle(want.title, book)) return false;
  const vouched = want.llBookId != null && want.llBookId === want.wrongAuthorLlBookId;
  if (!vouched && llBookAuthorMismatch(want.author, book)) return false;
  return !libraryShowsTitle(book.title, input.libraryKeys);
}

/**
 * The one writer for the downloaded state: the collection want's own format becomes `landed` (downloaded) or goes back
 * to `requested`. Guarded on the want still being an unparked, unmatched collection want on `llBookId`, and on the
 * format reading what the decision was made from (not `landed` to land it, `landed` to revert it), so a concurrent
 * change wins. Records a `collection_want_downloaded` / `collection_want_download_reverted` Request Event (ADR-101).
 * Returns whether it wrote.
 */
export async function setCollectionWantDownloaded(input: {
  db?: DbClient;
  requestId: string;
  llBookId: string;
  format: BookFormat;
  downloaded: boolean;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const column = input.format === 'audiobook' ? bookRequests.audioStatus : bookRequests.ebookStatus;
  return inTransaction(input.db, async (tx) => {
    const updated = await updateBookRequests(
      tx,
      {
        writer: 'setCollectionWantDownloaded',
        reason: input.downloaded
          ? 'collection_want_downloaded'
          : 'collection_want_download_reverted',
        detail: { llBookId: input.llBookId, format: input.format },
      },
      and(
        eq(bookRequests.id, input.requestId),
        eq(bookRequests.origin, 'collection'),
        isNull(bookRequests.unroutableReason),
        isNull(bookRequests.matchedBooksItemId),
        eq(bookRequests.llBookId, input.llBookId),
        input.downloaded ? ne(column, 'landed') : eq(column, 'landed'),
      )!,
      input.format === 'audiobook'
        ? { audioStatus: input.downloaded ? 'landed' : 'requested', updatedAt: now }
        : { ebookStatus: input.downloaded ? 'landed' : 'requested', updatedAt: now },
    );
    return updated.length > 0;
  });
}

export interface CollectionWantsDownloadedReport {
  /** Collection wants whose own format now reads downloaded (`landed`). */
  downloaded: number;
  /** Collection wants that read downloaded and went back to `requested`. */
  reverted: number;
  /** True when LazyLibrarian could not be read (or answered empty): nothing was decided. */
  skipped: boolean;
}

/**
 * The hourly pass (the `books-collections-sync` job, after the wants pass): one `getAllBooks`, one read of the live
 * library titles per format, then every unparked, unmatched collection want with a LazyLibrarian id is decided and
 * written only when its state changes.
 */
export async function reconcileCollectionWantsDownloaded(input: {
  db?: DbClient;
  /** Only the one read this pass makes (`getAllBooks`). */
  ll: { read: Pick<LazyLibrarianClientBundle['read'], 'getAllBookStatuses'> };
  now?: Date;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<CollectionWantsDownloadedReport> {
  const log = input.logger ?? {};
  const report: CollectionWantsDownloadedReport = { downloaded: 0, reverted: 0, skipped: false };
  let snapshot: ReadonlyMap<string, LlSnapshotRow>;
  try {
    snapshot = await input.ll.read.getAllBookStatuses();
  } catch (error) {
    report.skipped = true;
    log.warn?.('collection-wants-downloaded: getAllBooks failed — nothing decided', {
      error: error instanceof Error ? error.message : String(error),
    });
    return report;
  }
  if (!llSnapshotUsable(snapshot)) {
    report.skipped = true;
    return report;
  }

  const db = resolveDb(input.db);
  const wants = await db
    .select({
      id: bookRequests.id,
      title: bookRequests.title,
      author: bookRequests.author,
      llBookId: bookRequests.llBookId,
      wrongAuthorLlBookId: bookRequests.wrongAuthorLlBookId,
      ebookStatus: bookRequests.ebookStatus,
      audioStatus: bookRequests.audioStatus,
      source: booksCollections.source,
    })
    .from(bookRequests)
    .innerJoin(booksCollections, eq(booksCollections.id, bookRequests.collectionId))
    .where(
      and(
        eq(bookRequests.origin, 'collection'),
        isNull(bookRequests.unroutableReason),
        isNull(bookRequests.matchedBooksItemId),
        isNull(bookRequests.comicStatus),
        isNotNull(bookRequests.llBookId),
      ),
    );
  if (wants.length === 0) return report;

  const titles = await db
    .select({ title: booksItems.title, mediaKind: booksItems.mediaKind })
    .from(booksItems)
    .where(isNull(booksItems.deletedAt));
  const libraryKeys: Record<BookFormat, string[]> = { ebook: [], audiobook: [] };
  for (const item of titles) {
    if (item.mediaKind === 'book') libraryKeys.ebook.push(libraryTitleKey(item.title));
    else if (item.mediaKind === 'audiobook')
      libraryKeys.audiobook.push(libraryTitleKey(item.title));
  }

  for (const want of wants) {
    const llBookId = want.llBookId!;
    const format = collectionFormatForSource(want.source);
    const current = format === 'audiobook' ? want.audioStatus : want.ebookStatus;
    const downloaded = collectionWantDownloaded({
      want,
      book: snapshot.get(llBookId),
      format,
      libraryKeys: libraryKeys[format],
    });
    if (downloaded === (current === 'landed')) continue;
    const wrote = await setCollectionWantDownloaded({
      db: input.db,
      requestId: want.id,
      llBookId,
      format,
      downloaded,
      ...(input.now ? { now: input.now } : {}),
    });
    if (!wrote) continue;
    if (downloaded) report.downloaded += 1;
    else report.reverted += 1;
    log.info?.(downloaded ? 'collection_want_downloaded' : 'collection_want_download_reverted', {
      requestId: want.id,
      llBookId,
      format,
      title: want.title,
    });
  }
  return report;
}
