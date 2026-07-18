// ADR-071 / DESIGN-033 D-09 (media-action UX unification) — the books leg of "Force Search". Unlike
// Fix (the reasoned, durable book_fix_requests repair) this is the ONE-CLICK QUICK RE-SEARCH: it
// re-runs the acquisition search for the CURRENT on-disk title and grabs the best result (a fresh/
// better copy), leaving NO durable row — the movies force-search "no durable row" idiom (D-20/D-21),
// applied to books. It reuses the confined acquisition writes (LL addBook→queueBook→searchBook /
// Kapowarr setMonitored→searchVolume) exactly as the Fix orchestrator does, but WITHOUT writing a
// book_fix_request and WITHOUT a reason.
//
// Identity: the on-disk title's re-grab needs an LL book id / Kapowarr volume id. We reuse the
// linked `book_requests` seed (the row that acquired or pairs this title) — the same seed the Fix
// path prefers. A title with no such seed cannot be re-grabbed here (an honest `no_ll_id` /
// `no_kapowarr_id`), exactly like the pairing/manual search paths. NO GB resolve on the request
// path (that fragile fallback stays in the worker-hosted Fix flow).
//
// Audit: a single `request_book_search` permission_audit row (the same audit the manual/pairing
// search records), committed BEFORE the external call (the fix-flow crash-safety discipline). That
// is an AUDIT row, not a durable action row — no synthetic-reason fix is ever written.
import {
  bookRequests,
  booksItems,
  permissionAudit,
  type DbClient,
} from '@hnet/db';
import { and, desc, eq } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { NotFoundError } from './errors';
import { KapowarrUpstreamError, LazyLibrarianUpstreamError } from './errors';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';
import type { KapowarrClientBundle } from './kapowarr-clients';

export interface RunBookItemForceSearchInput {
  db?: DbClient;
  /** The on-disk books_item to re-search. */
  booksItemId: string;
  /** The caller — audited as the actor (and subject) of the search. */
  requesterId: string;
  ll?: LazyLibrarianClientBundle;
  kapowarr?: KapowarrClientBundle;
}

export interface RunBookItemForceSearchResult {
  searched: boolean;
  /** When false: nothing fired — the item has no LL/Kapowarr identity to re-grab, or its route is
   *  not configured. Never an error; the UI shows an honest note. */
  reason?: 'no_ll_id' | 'no_kapowarr_id' | 'unroutable';
}

/**
 * Fire a one-click quick re-search for an on-disk title. Resolves the acquisition identity from the
 * linked `book_requests` seed, audits the intent (committed first), then re-runs the confined
 * acquisition search for the item's own format — regardless of "landed" state, since Force Search's
 * whole purpose is to re-grab a better copy of a title that is already on disk. Leaves no durable
 * row. An LL/Kapowarr outage surfaces as *UpstreamError (BAD_GATEWAY) AFTER the audit.
 */
export async function runBookItemForceSearch(
  input: RunBookItemForceSearchInput,
): Promise<RunBookItemForceSearchResult> {
  const db = resolveDb(input.db);
  const [item] = await db
    .select({
      id: booksItems.id,
      title: booksItems.title,
      mediaKind: booksItems.mediaKind,
      deletedAt: booksItems.deletedAt,
    })
    .from(booksItems)
    .where(eq(booksItems.id, input.booksItemId))
    .limit(1);
  if (!item) throw new NotFoundError(`Books item ${input.booksItemId} not found`);
  if (item.deletedAt !== null) {
    throw new NotFoundError(`Books item ${input.booksItemId} is tombstoned`);
  }

  // The acquisition identity seed — the request that acquired (or pairs) this title. Newest first.
  const [request] = await db
    .select({
      id: bookRequests.id,
      llBookId: bookRequests.llBookId,
      kapowarrVolumeId: bookRequests.kapowarrVolumeId,
    })
    .from(bookRequests)
    .where(eq(bookRequests.matchedBooksItemId, item.id))
    .orderBy(desc(bookRequests.createdAt))
    .limit(1);

  const isComic = item.mediaKind === 'comic';
  const format = item.mediaKind === 'audiobook' ? ('audiobook' as const) : ('ebook' as const);
  const llBookId = request?.llBookId ?? null;
  const kapowarrVolumeId = request?.kapowarrVolumeId != null ? Number(request.kapowarrVolumeId) : null;

  // Nothing to re-grab without an identity — honest, not an error (the UI notes it).
  if (isComic && (kapowarrVolumeId === null || Number.isNaN(kapowarrVolumeId))) {
    return { searched: false, reason: 'no_kapowarr_id' };
  }
  if (!isComic && llBookId === null) {
    return { searched: false, reason: 'no_ll_id' };
  }

  // Audit the intent FIRST (committed before the external call — fix-flow crash-safety).
  await inTransaction(input.db, async (tx) => {
    await tx.insert(permissionAudit).values({
      actorId: input.requesterId,
      action: 'request_book_search',
      subjectUserId: input.requesterId,
      detail: {
        books_item_id: item.id,
        title: item.title,
        media_kind: item.mediaKind,
        via: 'force_search',
        ...(isComic
          ? { kapowarr_volume_id: kapowarrVolumeId }
          : { ll_book_id: llBookId, format }),
      },
    });
  });

  if (isComic) {
    if (!input.kapowarr) return { searched: false, reason: 'unroutable' };
    try {
      await input.kapowarr.write.setMonitored(kapowarrVolumeId!, true);
      await input.kapowarr.write.searchVolume(kapowarrVolumeId!);
    } catch (error) {
      throw new KapowarrUpstreamError('Kapowarr search failed', { cause: error });
    }
    return { searched: true };
  }

  if (!input.ll) return { searched: false, reason: 'unroutable' };
  try {
    // Re-grab regardless of landed state — addBook is idempotent; queueBook is MANDATORY (addBook
    // alone lands Skipped); searchBook fires the actual re-search for the item's own format.
    await input.ll.write.addBook(llBookId!);
    await input.ll.write.queueBook(llBookId!, format);
    await input.ll.write.searchBook(llBookId!, format);
  } catch (error) {
    throw new LazyLibrarianUpstreamError('LazyLibrarian search failed', { cause: error });
  }
  return { searched: true };
}
