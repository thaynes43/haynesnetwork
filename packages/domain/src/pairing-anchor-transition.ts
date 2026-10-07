// Issue #825 / DESIGN-036 — historical pairing wants never initiate acquisition. A queued predecessor only
// protects its existing LazyLibrarian format while an eligible same-work replacement is waiting for its want's id.
// This read is shared by settlement and every release drain, so mint cap/quota cannot cancel the transition.
import {
  bookRequests,
  booksFormatPairs,
  booksItems,
  type BookRequestRow,
  type DbClient,
} from '@hnet/db';
import { eq } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { updateBookRequests } from './book-request-events';
import { isForeignLanguage, readItemLanguage } from './book-language';
import { readHeldBooks } from './books';
import {
  pairingAuthorsAgree,
  matchFormatPairs,
  missingFormatFor,
  pairingIdentity,
  pairingTitleKey,
  type PairableItem,
} from './format-pairing';
import { llQueuedFormats, recordLlReleases, type LlFormat } from './ll-release-record';

export interface RemovedPairingTransitions {
  settle: BookRequestRow[];
  deferred: BookRequestRow[];
  protectedFormats: Map<string, Set<LlFormat>>;
}

/** Current transitions, with full title plus agreeing author (or equal ISBN), never a series-name guess. */
export async function loadRemovedPairingTransitions(
  db?: DbClient,
): Promise<RemovedPairingTransitions> {
  const executor = resolveDb(db);
  const wants = await executor
    .select()
    .from(bookRequests)
    .where(eq(bookRequests.origin, 'pairing'));
  const items = await executor.select().from(booksItems);
  const byId = new Map(items.map((i) => [i.id, i]));
  const byAnchor = new Map(wants.map((w) => [w.pairingBooksItemId, w]));
  const pairs = await executor.select().from(booksFormatPairs);
  const paired = new Set(pairs.flatMap((p) => [p.bookItemId, p.audioItemId]));
  const identityOf = (i: (typeof items)[number]) =>
    pairingIdentity({ ...i, heldBooks: readHeldBooks(i.attrs) } satisfies PairableItem);
  const live = items
    .filter(
      (i) =>
        i.deletedAt === null &&
        i.mediaKind !== 'comic' &&
        !isForeignLanguage(readItemLanguage(i.attrs)),
    )
    .map((i) => ({ item: i, identity: identityOf(i) }));
  const out: RemovedPairingTransitions = { settle: [], deferred: [], protectedFormats: new Map() };
  const isbnKey = (v: string | null) => (v ?? '').replace(/[^0-9xX]/g, '').toUpperCase();
  for (const want of wants) {
    const anchor = want.pairingBooksItemId ? byId.get(want.pairingBooksItemId) : undefined;
    if (
      !anchor ||
      anchor.deletedAt === null ||
      anchor.mediaKind === 'comic' ||
      want.unroutableReason !== null
    )
      continue;
    const missing = missingFormatFor(anchor.mediaKind);
    const queued = llQueuedFormats(want, [missing]);
    const oldIdentity = identityOf(anchor);
    const oldIsbn =
      oldIdentity.kind === 'one' &&
      pairingTitleKey(oldIdentity.title) === pairingTitleKey(want.title)
        ? isbnKey(oldIdentity.isbn)
        : '';
    const waiting =
      want.llBookId !== null &&
      queued.length > 0 &&
      live.some(({ item, identity }) => {
        if (item.mediaKind !== anchor.mediaKind || paired.has(item.id)) return false;
        // A failed detail read cannot prove there is no replacement. Keep the queued predecessor until
        // the same-kind inventory is fully known; this grants no acquisition or collection coverage.
        if (identity.kind === 'unknown') return true;
        if (identity.kind !== 'one') return false;
        if (pairingTitleKey(identity.title) !== pairingTitleKey(want.title)) return false;
        const isbn = isbnKey(identity.isbn);
        if (!pairingAuthorsAgree(want.author, identity.author) && !(oldIsbn && oldIsbn === isbn))
          return false;
        const successor = byAnchor.get(item.id);
        return !successor || (successor.unroutableReason === null && successor.llBookId === null);
      });
    if (!waiting) {
      out.settle.push(want);
      continue;
    }
    out.deferred.push(want);
    const formats = out.protectedFormats.get(want.llBookId!) ?? new Set<LlFormat>();
    formats.add(missing);
    out.protectedFormats.set(want.llBookId!, formats);
  }
  return out;
}

/** Settle only after this run's live mints/re-requests had their chance to claim ownership. */
export async function settleRemovedPairingWants(input: {
  db?: DbClient;
  now?: Date;
}): Promise<{ retiredAnchorsSettled: number; retiredAnchorsDeferred: number }> {
  const transitions = await loadRemovedPairingTransitions(input.db);
  let retiredAnchorsSettled = 0;
  for (const want of transitions.settle) {
    if (
      await settleRemovedAnchorPairingWant({
        ...input,
        requestId: want.id,
        llBookId: want.llBookId,
      })
    )
      retiredAnchorsSettled += 1;
  }
  return { retiredAnchorsSettled, retiredAnchorsDeferred: transitions.deferred.length };
}

/**
 * Issue #693 — settle a pairing want whose anchor LEFT the library and whose id names another book (the two Mistborn
 * sequels on "Mistborn: The Final Empire"): the id is cleared and the missing format becomes `missing` (no anchor, so
 * the library holds neither format and nothing looks for it). Guarded on the id, on the want being unparked, and on
 * the anchor still being removed. Records a `removed_anchor_settled` Request Event (ADR-101).
 */
export async function settleRemovedAnchorPairingWant(input: {
  db?: DbClient;
  requestId: string;
  llBookId: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const [row] = await tx
      .select({
        want: bookRequests,
        mediaKind: booksItems.mediaKind,
        deletedAt: booksItems.deletedAt,
      })
      .from(bookRequests)
      .innerJoin(booksItems, eq(booksItems.id, bookRequests.pairingBooksItemId))
      .where(eq(bookRequests.id, input.requestId))
      .for('update', { of: bookRequests });
    if (
      !row ||
      row.deletedAt === null ||
      row.want.origin !== 'pairing' ||
      row.want.llBookId !== input.llBookId ||
      row.want.unroutableReason !== null
    ) {
      return false;
    }
    const missing = missingFormatFor(row.mediaKind);
    if (
      row.want.llBookId === null &&
      (missing === 'ebook' ? row.want.ebookStatus : row.want.audioStatus) === 'missing'
    )
      return false;
    await updateBookRequests(
      tx,
      {
        writer: 'settleRemovedAnchorPairingWant',
        reason: 'removed_anchor_settled',
        detail: { llBookId: input.llBookId },
      },
      eq(bookRequests.id, row.want.id),
      {
        llBookId: null,
        ...(missing === 'ebook'
          ? { ebookStatus: 'missing' as const }
          : { audioStatus: 'missing' as const }),
        updatedAt: now,
      },
    );
    // Issue #735 — the id is cleared, so what LazyLibrarian was searching on the other book for it is released.
    await recordLlReleases(tx, {
      llBookId: input.llBookId,
      formats: llQueuedFormats(row.want, [missing]),
      reason: 'repaired:removed_anchor',
      requestId: row.want.id,
      now,
    });
    return true;
  });
}

export interface OneBookParkRepairInput {
  db?: DbClient;
  requestId: string;
  expectedPark: 'multi_book' | 'no_book';
  expectedTitle: string;
  expectedAuthor: string;
  dryRun: boolean;
  now?: Date;
}

/**
 * Issue #825 — the scoped migration repair for a retained id whose fresh chapter census now holds one book.
 * The caller names the exact row, old park and expected current title/author. No automatic park lift: wrong-volume,
 * language and pushed wants stay untouched. A live counterpart whose current identity matches proves the pair held.
 */
export async function repairOneBookPairingPark(input: OneBookParkRepairInput): Promise<{
  eligible: boolean;
  applied: boolean;
  requestId: string;
  title?: string;
  author?: string | null;
  paired?: boolean;
}> {
  return inTransaction(input.db, async (tx) => {
    const declined = { eligible: false, applied: false, requestId: input.requestId };
    const [want] = await tx
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.id, input.requestId))
      .for('update');
    if (
      !want ||
      want.origin !== 'pairing' ||
      want.llBookId !== null ||
      want.unroutableReason !== input.expectedPark ||
      !want.pairingBooksItemId
    )
      return declined;
    const [anchor] = await tx
      .select()
      .from(booksItems)
      .where(eq(booksItems.id, want.pairingBooksItemId))
      .for('share');
    if (
      !anchor ||
      anchor.deletedAt !== null ||
      anchor.mediaKind !== 'book' ||
      isForeignLanguage(readItemLanguage(anchor.attrs))
    )
      return declined;
    const anchorInput = { ...anchor, heldBooks: readHeldBooks(anchor.attrs) };
    const identity = pairingIdentity(anchorInput);
    if (
      identity.kind !== 'one' ||
      pairingTitleKey(identity.title) !== pairingTitleKey(input.expectedTitle) ||
      !pairingAuthorsAgree(identity.author, input.expectedAuthor)
    )
      return declined;
    const pairs = await tx.select().from(booksFormatPairs);
    const pair = pairs.find((p) => p.bookItemId === anchor.id || p.audioItemId === anchor.id);
    let paired = false;
    if (pair) {
      const otherId = pair.bookItemId === anchor.id ? pair.audioItemId : pair.bookItemId;
      const [other] = await tx
        .select()
        .from(booksItems)
        .where(eq(booksItems.id, otherId))
        .for('share');
      if (other && other.deletedAt === null) {
        paired = matchFormatPairs([
          anchorInput,
          { ...other, heldBooks: readHeldBooks(other.attrs) },
        ]).some((p) => p.bookItemId === pair.bookItemId && p.audioItemId === pair.audioItemId);
      }
    }
    const result = {
      eligible: true,
      applied: !input.dryRun,
      requestId: want.id,
      title: identity.title,
      author: identity.author,
      paired,
    };
    if (input.dryRun) return result;
    const missing = missingFormatFor(anchor.mediaKind);
    const missingStatus = paired ? ('landed' as const) : ('requested' as const);
    await updateBookRequests(
      tx,
      {
        writer: 'repairOneBookPairingPark',
        reason: 'unparked',
        actor: 'repair',
        site: 'pairing-one-book-repair',
        detail: { priorReason: input.expectedPark, cause: 'fresh_one_book', anchorId: anchor.id },
      },
      eq(bookRequests.id, want.id),
      {
        title: identity.title,
        author: identity.author,
        unroutableReason: null,
        ebookStatus: missing === 'ebook' ? missingStatus : 'landed',
        audioStatus: missing === 'audiobook' ? missingStatus : 'landed',
        llRerequestedAt: null,
        llRerequestFailures: 0,
        llRerequestFailedAt: null,
        llRerequestAddedAt: null,
        mintBackoffCount: 0,
        mintBackoffUntil: null,
        mintBackoffKey: null,
        updatedAt: input.now ?? new Date(),
      },
    );
    return result;
  });
}
