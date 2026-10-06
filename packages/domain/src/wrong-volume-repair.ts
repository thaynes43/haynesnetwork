// Issue #693 — the one-off repair of requests pinned to another volume's or work's LazyLibrarian book (DESIGN-028
// amendment 2026-10-05). Run once by `packages/sync/src/scripts/wrong-volume-requests-repair.ts`, `--dry-run` first.
// Every write goes through a single writer guarded on the row still being what was read:
//
//   • pairing wants on a live anchor — the same identity check the mint now runs each hour (`checkPairingWantBooks`):
//     re-identified (id cleared, missing format `requested`, or `landed` for a paired anchor) or re-titled;
//   • collection wants whose book LazyLibrarian names as another volume or work (`llBookMismatch`) — parked
//     `wrong_volume` with the id cleared (`parkCollectionWant`), so nothing queues that book for them again
//     (the BBC Radio Drama Collection → "Terry Pratchett's Discworld" pair);
//   • goodreads wants whose book LazyLibrarian names as another work — re-pointed to the shelf item's current Google
//     Books volume and re-opened `requested` when that volume is another id, else settled `missing`
//     (`reopenWrongVolumeRequest`);
//   • named pairing wants on an anchor that left the library (`removedAnchorWants`, each with the id it must still
//     hold) — the id cleared and the missing format settled `missing` (`settleRemovedAnchorPairingWant`): no anchor,
//     so nothing is held and nothing looks for it;
//   • named pairing wants a repair parked `wrong_volume` BY HAND (a direct write, outside the single writers) —
//     brought to the state the writers leave a park in (`settleParkedPairingWant`): parked, no id, and a missing
//     format that no longer claims the abandoned book (`missing`, or `landed` when the anchor is paired).
//
// No LazyLibrarian write. `skipLlBookIds` leaves alone every row pointing at those ids (records another repair owns).
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  bookRequests,
  booksFormatPairs,
  booksItems,
  integrationShelfItems,
  type DbClient,
} from '@hnet/db';
import { inTransaction, resolveDb } from './db-client';
import { updateBookRequests, withRequestEventScope } from './book-request-events';
import type { BookRequestStatus } from '@hnet/db';
import { parkCollectionWant } from './book-requests';
import { llQueuedFormats, recordLlReleases } from './ll-release-record';
import { llBookMismatch, type LlBookNaming } from './ll-book-check';
import {
  checkPairingWantBooks,
  missingFormatFor,
  type PairingWantBookChange,
} from './format-pairing';

export interface WrongVolumeRepairInput {
  db?: DbClient;
  /** LazyLibrarian's books by id, from one real, non-empty `getAllBooks` read. */
  snapshot: ReadonlyMap<string, LlBookNaming>;
  dryRun: boolean;
  /** Rows pointing at these LazyLibrarian ids are left exactly as they are. */
  skipLlBookIds?: ReadonlySet<string>;
  /** Pairing wants on removed anchors to settle, each with the id it must still hold. */
  removedAnchorWants?: ReadonlyArray<{ requestId: string; llBookId: string }>;
  /** Pairing wants parked `wrong_volume` by hand, to bring to the state the single writers leave a park in. */
  parkedPairingWants?: ReadonlyArray<string>;
  now?: Date;
  log?: { info?: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface WrongVolumeRepairRow {
  requestId: string;
  origin: 'pairing' | 'collection' | 'goodreads';
  action: 'reidentify' | 'retitle' | 'park' | 'repoint' | 'settle';
  reason: string | null;
  title: string;
  llBookId: string | null;
  llTitle: string | null;
  /** What the row becomes (the new title, the new id, or the settled status), for the record. */
  detail: string;
  /** False in a dry run, or when the guarded write found the row changed. */
  applied: boolean;
}

export interface WrongVolumeRepairReport {
  dryRun: boolean;
  rows: WrongVolumeRepairRow[];
}

/**
 * Issue #693 — re-open (or settle) a goodreads want whose LazyLibrarian book is another work. With `toLlBookId` (the
 * shelf item's current Google Books volume, a different id): point the want at it and set both formats `requested`, so
 * the next goodreads sync pushes the right book; the one re-request (#668) restarts with it. Without: the formats that
 * read `landed`, `wanted` or `grabbed` from the wrong book settle `missing`. Guarded on the id it was judged on and on
 * the want not being matched into the library (a library match lands it on its own). Records a `wrong_volume_repaired`
 * Request Event (ADR-101).
 */
export async function reopenWrongVolumeRequest(input: {
  db?: DbClient;
  requestId: string;
  fromLlBookId: string;
  toLlBookId: string | null;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const [req] = await tx
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.id, input.requestId))
      .for('update');
    if (
      !req ||
      req.origin !== 'goodreads' ||
      req.llBookId !== input.fromLlBookId ||
      req.matchedBooksItemId !== null ||
      req.unroutableReason !== null
    ) {
      return false;
    }
    const settle = (s: BookRequestStatus): BookRequestStatus =>
      s === 'landed' || s === 'wanted' || s === 'grabbed' ? 'missing' : s;
    await updateBookRequests(
      tx,
      {
        writer: 'reopenWrongVolumeRequest',
        reason: 'wrong_volume_repaired',
        detail: { fromLlBookId: input.fromLlBookId, toLlBookId: input.toLlBookId },
      },
      eq(bookRequests.id, req.id),
      input.toLlBookId
        ? {
            llBookId: input.toLlBookId,
            ebookStatus: 'requested',
            audioStatus: 'requested',
            lastReconciledAt: null,
            llRerequestedAt: null,
            llRerequestFailures: 0,
            llRerequestFailedAt: null,
            llRerequestAddedAt: null,
            updatedAt: now,
          }
        : {
            ebookStatus: settle(req.ebookStatus),
            audioStatus: settle(req.audioStatus),
            updatedAt: now,
          },
    );
    // Issue #735 — re-pointed off the other work's book: what LazyLibrarian was searching there for it is released.
    if (input.toLlBookId) {
      await recordLlReleases(tx, {
        llBookId: input.fromLlBookId,
        formats: llQueuedFormats(req, ['ebook', 'audiobook']),
        reason: 'repaired:wrong_volume',
        requestId: req.id,
        now,
      });
    }
    return true;
  });
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
  llBookId: string;
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

/**
 * Issue #693 — conform a pairing want a repair parked `wrong_volume` by hand. Guarded on the park the single writers
 * leave (`unroutable_reason = 'wrong_volume'`, `ll_book_id` NULL); a parked want is out of the mint, the reconcile, the
 * Skipped sweep and the re-request, so only its statuses can still be wrong. The missing format becomes `landed` when
 * the anchor is in the library and paired (the library holds it), else `missing` if it still reads `landed`, `wanted`
 * or `grabbed` from the abandoned book (nothing holds it and nothing looks for it); the held format is `landed` while
 * the anchor is in the library. One transaction, a `parked_want_conformed` Request Event (ADR-101). Returns
 * the statuses it wrote, or null when the row is not such a park or is already right.
 */
export async function settleParkedPairingWant(input: {
  db?: DbClient;
  requestId: string;
  now?: Date;
  /** Compute the statuses it would write, and write nothing (the repair's dry run). */
  dryRun?: boolean;
}): Promise<{ ebookStatus: BookRequestStatus; audioStatus: BookRequestStatus } | null> {
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
      row.want.origin !== 'pairing' ||
      row.want.unroutableReason !== 'wrong_volume' ||
      row.want.llBookId !== null
    ) {
      return null;
    }
    const live = row.deletedAt === null;
    const [pair] = live
      ? await tx
          .select({ id: booksFormatPairs.id })
          .from(booksFormatPairs)
          .where(
            sql`${booksFormatPairs.bookItemId} = ${row.want.pairingBooksItemId} OR ${booksFormatPairs.audioItemId} = ${row.want.pairingBooksItemId}`,
          )
          .limit(1)
      : [];
    const missing = missingFormatFor(row.mediaKind);
    const statusOf = (f: 'ebook' | 'audiobook'): BookRequestStatus =>
      f === 'ebook' ? row.want.ebookStatus : row.want.audioStatus;
    const missingNow = statusOf(missing);
    const nextMissing: BookRequestStatus = pair
      ? 'landed'
      : missingNow === 'landed' || missingNow === 'wanted' || missingNow === 'grabbed'
        ? 'missing'
        : missingNow;
    const held = missing === 'ebook' ? 'audiobook' : 'ebook';
    const nextHeld: BookRequestStatus = live ? 'landed' : statusOf(held);
    const next = {
      ebookStatus: missing === 'ebook' ? nextMissing : nextHeld,
      audioStatus: missing === 'audiobook' ? nextMissing : nextHeld,
    };
    if (next.ebookStatus === row.want.ebookStatus && next.audioStatus === row.want.audioStatus)
      return null;
    if (input.dryRun) return next;
    await updateBookRequests(
      tx,
      { writer: 'settleParkedPairingWant', reason: 'parked_want_conformed' },
      eq(bookRequests.id, row.want.id),
      { ...next, updatedAt: now },
    );
    return next;
  });
}

/** The Request Event site of this repair's writes (ADR-101: they record `actor: 'repair'`). */
export const WRONG_VOLUME_REPAIR_SITE = 'wrong-volume-requests-repair';

/** Run (or, with `dryRun`, list) the repair. See the file header. Every write records `actor: 'repair'` (ADR-101). */
export async function repairWrongVolumeRequests(
  input: WrongVolumeRepairInput,
): Promise<WrongVolumeRepairReport> {
  return withRequestEventScope({ actor: 'repair', site: WRONG_VOLUME_REPAIR_SITE }, () =>
    runWrongVolumeRepair(input),
  );
}

async function runWrongVolumeRepair(
  input: WrongVolumeRepairInput,
): Promise<WrongVolumeRepairReport> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const skip = input.skipLlBookIds ?? new Set<string>();
  const llBookOf = (id: string): LlBookNaming | undefined => input.snapshot.get(id);
  const rows: WrongVolumeRepairRow[] = [];

  // 1. Pairing wants on a live anchor: the mint's identity check.
  const pairingWants = (
    await db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'))
  ).filter((w) => !(w.llBookId && skip.has(w.llBookId)));
  const pairing = await checkPairingWantBooks({
    db: input.db,
    llBookOf,
    wants: pairingWants,
    now,
    dryRun: input.dryRun,
    ...(input.log ? { log: input.log } : {}),
  });
  const pairingRow = (c: PairingWantBookChange): WrongVolumeRepairRow => ({
    requestId: c.requestId,
    origin: 'pairing',
    action: c.kind === 'clear' ? 'reidentify' : 'retitle',
    reason: c.reason,
    title: c.from,
    llBookId: c.llBookId,
    llTitle: c.llTitle,
    detail:
      c.kind === 'clear'
        ? `→ "${c.to}", id cleared, ${c.formerStatus} → ${c.status}`
        : `→ "${c.to}"`,
    applied: !input.dryRun,
  });
  rows.push(...pairing.changes.map(pairingRow));

  // 2. Collection wants on another volume's or work's book: parked.
  const collectionWants = await db
    .select()
    .from(bookRequests)
    .where(
      and(
        eq(bookRequests.origin, 'collection'),
        isNull(bookRequests.unroutableReason),
        isNotNull(bookRequests.llBookId),
      ),
    );
  for (const want of collectionWants) {
    if (skip.has(want.llBookId!)) continue;
    const book = llBookOf(want.llBookId!);
    const mismatch = llBookMismatch(want, book);
    if (!mismatch) continue;
    const applied = input.dryRun
      ? false
      : await parkCollectionWant({
          db: input.db,
          requestId: want.id,
          llBookId: want.llBookId!,
          now,
        });
    rows.push({
      requestId: want.id,
      origin: 'collection',
      action: 'park',
      reason: mismatch,
      title: want.title,
      llBookId: want.llBookId,
      llTitle: book?.title ?? null,
      detail: `parked wrong_volume, id cleared (${want.ebookStatus}/${want.audioStatus})`,
      applied,
    });
  }

  // 3. Goodreads wants on another work's book: re-pointed to the shelf's current volume, else settled.
  const goodreadsWants = await db
    .select({ want: bookRequests, gbVolumeId: integrationShelfItems.gbVolumeId })
    .from(bookRequests)
    .innerJoin(integrationShelfItems, eq(integrationShelfItems.id, bookRequests.shelfItemId))
    .where(
      and(
        eq(bookRequests.origin, 'goodreads'),
        isNull(bookRequests.unroutableReason),
        isNull(bookRequests.matchedBooksItemId),
        isNotNull(bookRequests.llBookId),
        isNull(integrationShelfItems.deletedAt),
      ),
    );
  for (const { want, gbVolumeId } of goodreadsWants) {
    if (skip.has(want.llBookId!)) continue;
    const book = llBookOf(want.llBookId!);
    const mismatch = llBookMismatch(want, book);
    if (!mismatch) continue;
    // The shelf's current volume, unless it is the same id or LazyLibrarian names it as another work as well.
    const to =
      gbVolumeId && gbVolumeId !== want.llBookId && !llBookMismatch(want, llBookOf(gbVolumeId))
        ? gbVolumeId
        : null;
    const applied = input.dryRun
      ? false
      : await reopenWrongVolumeRequest({
          db: input.db,
          requestId: want.id,
          fromLlBookId: want.llBookId!,
          toLlBookId: to,
          now,
        });
    rows.push({
      requestId: want.id,
      origin: 'goodreads',
      action: to ? 'repoint' : 'settle',
      reason: mismatch,
      title: want.title,
      llBookId: want.llBookId,
      llTitle: book?.title ?? null,
      detail: to
        ? `→ ${to}, both formats requested`
        : `formats settled missing (${want.ebookStatus}/${want.audioStatus})`,
      applied,
    });
  }

  // 4. Named pairing wants on removed anchors.
  for (const named of input.removedAnchorWants ?? []) {
    if (skip.has(named.llBookId)) continue;
    const [want] = await db
      .select({ title: bookRequests.title, llBookId: bookRequests.llBookId })
      .from(bookRequests)
      .where(
        and(
          eq(bookRequests.id, named.requestId),
          sql`${bookRequests.pairingBooksItemId} IN (SELECT id FROM books_items WHERE deleted_at IS NOT NULL)`,
        ),
      );
    if (!want || want.llBookId !== named.llBookId) {
      rows.push({
        requestId: named.requestId,
        origin: 'pairing',
        action: 'settle',
        reason: 'not as recorded (anchor live, row gone, or id changed): left alone',
        title: want?.title ?? '',
        llBookId: want?.llBookId ?? null,
        llTitle: null,
        detail: 'skipped',
        applied: false,
      });
      continue;
    }
    const applied = input.dryRun
      ? false
      : await settleRemovedAnchorPairingWant({
          db: input.db,
          requestId: named.requestId,
          llBookId: named.llBookId,
          now,
        });
    rows.push({
      requestId: named.requestId,
      origin: 'pairing',
      action: 'settle',
      reason: 'removed anchor',
      title: want.title,
      llBookId: named.llBookId,
      llTitle: llBookOf(named.llBookId)?.title ?? null,
      detail: 'id cleared, missing format settled missing',
      applied,
    });
  }

  // 5. Pairing wants parked by hand: brought to the state the single writers leave a park in.
  for (const requestId of input.parkedPairingWants ?? []) {
    const [want] = await db
      .select({
        title: bookRequests.title,
        llBookId: bookRequests.llBookId,
        unroutableReason: bookRequests.unroutableReason,
        ebookStatus: bookRequests.ebookStatus,
        audioStatus: bookRequests.audioStatus,
      })
      .from(bookRequests)
      .where(and(eq(bookRequests.id, requestId), eq(bookRequests.origin, 'pairing')));
    const before = want ? `${want.ebookStatus}/${want.audioStatus}` : 'no such pairing want';
    if (!want || want.unroutableReason !== 'wrong_volume' || want.llBookId !== null) {
      rows.push({
        requestId,
        origin: 'pairing',
        action: 'settle',
        reason: 'not a wrong_volume park without an id: left alone',
        title: want?.title ?? '',
        llBookId: want?.llBookId ?? null,
        llTitle: null,
        detail: `skipped (${before})`,
        applied: false,
      });
      continue;
    }
    // The dry run computes what it would write the same way (no write), so its listing shows each change.
    const next = await settleParkedPairingWant({
      db: input.db,
      requestId,
      now,
      dryRun: input.dryRun,
    });
    rows.push({
      requestId,
      origin: 'pairing',
      action: 'settle',
      reason: 'parked by hand',
      title: want.title,
      llBookId: null,
      llTitle: null,
      detail: next
        ? `${before} → ${next.ebookStatus}/${next.audioStatus}`
        : `${before} (already right)`,
      applied: !input.dryRun && next !== null,
    });
  }

  return { dryRun: input.dryRun, rows };
}
