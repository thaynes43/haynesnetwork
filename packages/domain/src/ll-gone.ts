// Issue #665 / DESIGN-028 amendment 2026-10-04 — a want whose LazyLibrarian book is GONE.
//
// Every reconcile reads LazyLibrarian through ONE `getAllBooks` snapshot and, until this change, skipped a want
// whose `ll_book_id` the snapshot did not contain ("LL doesn't know this book — the honest gap"). That gap was
// never temporary. LazyLibrarian deletes books on its own: its startup `check_db` removes every author whose
// recount (`update_totals`, counted through `bookauthors`) is zero, and `books.AuthorID` cascades on delete.
// `cmd=addBook` (`gb.py::add_bookid_to_db`) never writes a `bookauthors` row, so an author LazyLibrarian only
// knows through books the app added counts zero, and the next LazyLibrarian restart removes the author and every
// one of those books. On 2026-10-04 that had left about 900 open wants pointing at ids LazyLibrarian no longer
// has: they read `wanted` or `grabbed` forever, no job pushes them again (each mint pushes only `requested`), and
// nothing in LazyLibrarian is searching for them.
//
// The rule, at every unattended reconcile that holds a usable snapshot (DESIGN-028 amendment 2026-10-04):
//   • A want is GONE when its id is absent from a non-empty snapshot, it has a format we pushed that is not
//     settled (`wanted`/`grabbed`; for a collection want, any active format it was force-searched for), and LL
//     has not shown it for `LL_GONE_GRACE_MS` (24 h): `last_reconciled_at` is stamped each time a reconcile
//     finds the book (and by the push), so it is the last time LazyLibrarian had it. A collection want has no
//     such stamp (nothing reconciles it against LL), only `last_searched_at` from its force-search, which the
//     cron renews every cooldown; its grace is `LL_GONE_COLLECTION_GRACE_MS` (1 h), well under any cooldown,
//     so a lost book settles before it comes due again (`addBook` runs with `wait`, so an hour is plenty).
//   • RE-KEY first: when the snapshot holds exactly one row with the same title (normalized, subtitle kept) and
//     an agreeing author, AND that row already settles or tracks the want's format (held, or LazyLibrarian shows
//     it Wanted or Snatched), the want is repointed to that row and reconciled from it. No LazyLibrarian write,
//     and none follows: a row LL holds as `Skipped` would hand the want to the Skipped sweep's search, so that
//     case settles instead and the re-key waits for a person's Search again (`runManualBookSearch`).
//   • Otherwise SETTLE: each such format becomes `missing` (the dead-end Missing state the walls already show,
//     with a user-initiated search that re-adds the book). `missing` overrides the no-regress rule on purpose:
//     a `grabbed` format whose book row is gone has no row left for LazyLibrarian to import into.
//   • Never a search, never an `addBook`. The only LazyLibrarian call any of this makes is the snapshot read
//     the reconcile already took.
// An empty snapshot (an LL error answer parses to an empty map) proves nothing, so it decides nothing.
import { eq } from 'drizzle-orm';
import { bookRequests, type BookRequestStatus, type DbClient } from '@hnet/db';
import {
  applyRequestReconcile,
  llFormatAlreadyHeld,
  mapLlStatus,
  type LlHeldSignals,
} from './book-requests';
import { inTransaction } from './db-client';

/** How long LazyLibrarian must have gone without showing a want's book before it counts as gone (24 h). */
export const LL_GONE_GRACE_MS = Number(process.env.LL_GONE_GRACE_MS ?? 24 * 60 * 60 * 1000);

/**
 * The collection want's grace (1 h), measured from its last force-search. It must stay under the collection
 * cooldown: the cron re-searches a due want and re-stamps `last_searched_at`, so a grace longer than the cooldown
 * would never be reached and the cron would keep re-adding a lost book.
 */
export const LL_GONE_COLLECTION_GRACE_MS = Number(
  process.env.LL_GONE_COLLECTION_GRACE_MS ?? 60 * 60 * 1000,
);

/** One row of the `getAllBooks` snapshot as the gone-book logic reads it (a structural subset of the ACL row). */
export interface LlSnapshotRow extends LlHeldSignals {
  /** LL's `BookName`. */
  title?: string | null;
  /** LL's `AuthorName` (from `getAllBooks`'s join on `authors`). */
  author?: string | null;
}

/** The snapshot as every reconcile holds it: BookID → row. */
export type LlSnapshot = ReadonlyMap<string, LlSnapshotRow>;

/**
 * May this snapshot decide that a book is GONE? Only a real, non-empty read can: the ACL turns an LL error
 * answer (a wrong key, an unknown command) into an EMPTY map, and an empty map must never settle anything.
 * A test stub that only implements `get` is not usable either, which keeps every older test's stub inert.
 */
export function llSnapshotUsable(
  snapshot: ReadonlyMap<string, unknown> | null | undefined,
): snapshot is LlSnapshot {
  return (
    snapshot != null &&
    typeof snapshot.size === 'number' &&
    snapshot.size > 0 &&
    typeof snapshot.values === 'function'
  );
}

const ARTICLE = /^(the|a|an)\s+/;

/**
 * The re-key title key: diacritics folded, apostrophes dropped, punctuation collapsed, a leading article
 * stripped. Unlike `normTitle` it KEEPS a subtitle, so "The Kane Chronicles: Survival Guide" never matches
 * "The Kane Chronicles" (LazyLibrarian writes a title's colon as a full stop, which this key also absorbs).
 */
export function llRekeyTitleKey(title: string | null | undefined): string {
  return (title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(ARTICLE, '');
}

/** The re-key author key: diacritics folded, punctuation collapsed ("J.K. Rowling" ≡ "J. K. Rowling"). */
export function llRekeyAuthorKey(author: string | null | undefined): string {
  return (author ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Two author keys agree when both are known and one equals or contains the other (a co-author credit). */
function authorsAgree(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && ` ${long} `.includes(` ${short} `);
}

/**
 * The snapshot indexed by re-key title, built once per pass. `find` returns the ONE row LazyLibrarian holds for a
 * book (same title key, agreeing author), or null when there is none or more than one. A want with no author
 * never re-keys: a title alone is not enough evidence to point a want at a different LazyLibrarian book.
 */
export class LlRekeyIndex {
  private readonly byTitle = new Map<string, Array<{ bookId: string; authorKey: string }>>();

  constructor(snapshot: LlSnapshot) {
    for (const [bookId, row] of snapshot) {
      const key = llRekeyTitleKey(row.title);
      if (!key) continue;
      const rows = this.byTitle.get(key) ?? [];
      rows.push({ bookId, authorKey: llRekeyAuthorKey(row.author) });
      this.byTitle.set(key, rows);
    }
  }

  find(title: string | null | undefined, author: string | null | undefined): string | null {
    const titleKey = llRekeyTitleKey(title);
    const authorKey = llRekeyAuthorKey(author);
    if (!titleKey || !authorKey) return null;
    const hits = (this.byTitle.get(titleKey) ?? []).filter((r) =>
      authorsAgree(r.authorKey, authorKey),
    );
    return hits.length === 1 ? hits[0]!.bookId : null;
  }
}

type LlFormat = 'ebook' | 'audiobook';

/** What a pass does with one want whose id the snapshot lacks. */
export type LlGoneDecision =
  | { kind: 'not_gone' }
  | { kind: 'rekey'; toLlBookId: string }
  | { kind: 'settle'; formats: LlFormat[] };

/** The want fields the decision reads. */
export interface LlGoneWant {
  llBookId: string | null;
  title: string;
  author: string | null;
  ebookStatus: BookRequestStatus;
  audioStatus: BookRequestStatus;
  /**
   * When LazyLibrarian last had (or was last handed) this book: `last_reconciled_at` for a goodreads or pairing
   * want (each reconcile that finds the book stamps it, and so does the push), `last_searched_at` for a
   * collection want (its force-search stamps it; nothing reconciles a collection want against LL). Null means
   * LazyLibrarian was never handed the book, so its absence proves nothing.
   */
  lastSeenAt: Date | null;
}

/** The per-format statuses a pushed-then-lost goodreads or pairing want can carry. */
const PUSHED_UNSETTLED = new Set<BookRequestStatus>(['wanted', 'grabbed']);
/** A collection want's active format stays `requested` through its force-searches (nothing marks it pushed). */
const COLLECTION_UNSETTLED = new Set<BookRequestStatus>(['requested', 'wanted', 'grabbed']);

/**
 * Decide one want. Pure. `formats` names the formats this want acquires (both for a goodreads want, the missing
 * one for a pairing want, the active one for a collection want); `collection` switches the unsettled set,
 * because a collection want's active format never leaves `requested`.
 */
export function decideLlGoneWant(input: {
  want: LlGoneWant;
  snapshot: LlSnapshot | null;
  index: LlRekeyIndex | null;
  now: Date;
  formats?: readonly LlFormat[];
  collection?: boolean;
  graceMs?: number;
}): LlGoneDecision {
  const { want, snapshot } = input;
  if (!want.llBookId || !llSnapshotUsable(snapshot) || snapshot.has(want.llBookId)) {
    return { kind: 'not_gone' };
  }
  if (!want.lastSeenAt) return { kind: 'not_gone' };
  const grace = input.graceMs ?? LL_GONE_GRACE_MS;
  if (input.now.getTime() - want.lastSeenAt.getTime() < grace) return { kind: 'not_gone' };
  const unsettled = input.collection ? COLLECTION_UNSETTLED : PUSHED_UNSETTLED;
  const own = input.formats ?? (['ebook', 'audiobook'] as const);
  const formats = own.filter((f) =>
    unsettled.has(f === 'ebook' ? want.ebookStatus : want.audioStatus),
  );
  if (formats.length === 0) return { kind: 'not_gone' };
  const toLlBookId = input.index?.find(want.title, want.author) ?? null;
  // Every format the want acquires must be tracked by the new row, not only the unsettled ones: the goodreads
  // Skipped sweep reads both formats' raw status, so a `Skipped` sibling format would still be searched.
  if (
    toLlBookId &&
    toLlBookId !== want.llBookId &&
    own.every((f) => llRowTracksFormat(snapshot.get(toLlBookId), f))
  ) {
    return { kind: 'rekey', toLlBookId };
  }
  return { kind: 'settle', formats };
}

/** LazyLibrarian's statuses that mean it already has, or is already after, a format (no push needed). */
const TRACKED = new Set<BookRequestStatus>(['wanted', 'grabbed', 'landed']);

/**
 * Does this LazyLibrarian row already settle or track the format, so that pointing a want at it needs no
 * LazyLibrarian write now or later? Held (status or file signals), or `Wanted` / `Snatched`. A `Skipped` row
 * would be re-queued and searched by the next Skipped sweep, so it does not count; `Ignored` is an owner ruling.
 */
export function llRowTracksFormat(row: LlSnapshotRow | undefined, format: LlFormat): boolean {
  if (!row) return false;
  if (llFormatAlreadyHeld(row, format)) return true;
  const mapped = mapLlStatus(format === 'ebook' ? row.ebookStatus : row.audioStatus);
  return mapped !== null && TRACKED.has(mapped);
}

// ---------------------------------------------------------------------------
// The two single-writers (unaudited: synced/derived state, the markRequestPushed class).
// ---------------------------------------------------------------------------

/**
 * Point a want at the row LazyLibrarian holds for its book now. Guarded on the old id, so a concurrent writer
 * that already changed the want wins. Returns whether the row changed.
 */
export async function repointRequestLlBook(input: {
  db?: DbClient;
  requestId: string;
  fromLlBookId: string;
  toLlBookId: string;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const [req] = await tx
      .select({ id: bookRequests.id, llBookId: bookRequests.llBookId })
      .from(bookRequests)
      .where(eq(bookRequests.id, input.requestId))
      .for('update');
    if (!req || req.llBookId !== input.fromLlBookId) return false;
    await tx
      .update(bookRequests)
      .set({ llBookId: input.toLlBookId, updatedAt: now })
      .where(eq(bookRequests.id, req.id));
    return true;
  });
}

/**
 * Settle a want whose LazyLibrarian book is gone: each named format that has not landed becomes `missing`.
 * Deliberately NOT `advanceStatus` — a `grabbed` format is settled too, because the book row its grab would
 * import into no longer exists. Guarded on the id the decision was made for. Returns whether the row changed.
 */
export async function settleRequestLlGone(input: {
  db?: DbClient;
  requestId: string;
  llBookId: string;
  formats: readonly LlFormat[];
  now?: Date;
}): Promise<boolean> {
  if (input.formats.length === 0) return false;
  const now = input.now ?? new Date();
  return inTransaction(input.db, async (tx) => {
    const [req] = await tx
      .select({
        id: bookRequests.id,
        llBookId: bookRequests.llBookId,
        ebookStatus: bookRequests.ebookStatus,
        audioStatus: bookRequests.audioStatus,
      })
      .from(bookRequests)
      .where(eq(bookRequests.id, input.requestId))
      .for('update');
    if (!req || req.llBookId !== input.llBookId) return false;
    const settle = (format: LlFormat, current: BookRequestStatus): BookRequestStatus =>
      input.formats.includes(format) && current !== 'landed' ? 'missing' : current;
    const ebookStatus = settle('ebook', req.ebookStatus);
    const audioStatus = settle('audiobook', req.audioStatus);
    if (ebookStatus === req.ebookStatus && audioStatus === req.audioStatus) return false;
    await tx
      .update(bookRequests)
      .set({ ebookStatus, audioStatus, lastReconciledAt: now, updatedAt: now })
      .where(eq(bookRequests.id, req.id));
    return true;
  });
}

/** What one pass did with its gone wants (rides on each job's run report). */
export interface LlGoneTally {
  /** Wants repointed to the row LazyLibrarian holds for their book now. */
  llGoneRekeyed: number;
  /** Wants whose pushed formats settled to `missing` because LazyLibrarian no longer has the book. */
  llGoneSettled: number;
}

export const emptyLlGoneTally = (): LlGoneTally => ({ llGoneRekeyed: 0, llGoneSettled: 0 });

/**
 * Apply one decision: repoint (and, when `reconcile` is set, reconcile the want from the row it now points at,
 * through the usual no-regress `applyRequestReconcile`) or settle. Logs `ll_book_gone` for each want it changes.
 * Never calls LazyLibrarian.
 */
export async function applyLlGoneDecision(input: {
  db?: DbClient;
  requestId: string;
  llBookId: string;
  decision: LlGoneDecision;
  snapshot: LlSnapshot;
  /** Reconcile statuses from the re-keyed row (goodreads, pairing). A collection want is never reconciled. */
  reconcile: boolean;
  tally: LlGoneTally;
  site: string;
  now: Date;
  log?: { info?: (msg: string, meta?: Record<string, unknown>) => void };
}): Promise<void> {
  const { decision } = input;
  if (decision.kind === 'rekey') {
    const moved = await repointRequestLlBook({
      db: input.db,
      requestId: input.requestId,
      fromLlBookId: input.llBookId,
      toLlBookId: decision.toLlBookId,
      now: input.now,
    });
    if (!moved) return;
    const row = input.snapshot.get(decision.toLlBookId);
    if (input.reconcile && row) {
      await applyRequestReconcile({
        db: input.db,
        requestId: input.requestId,
        ebookStatus: mapLlStatus(row.ebookStatus),
        audioStatus: mapLlStatus(row.audioStatus),
        now: input.now,
      });
    }
    input.tally.llGoneRekeyed += 1;
    input.log?.info?.('ll_book_gone', {
      site: input.site,
      outcome: 'rekeyed',
      requestId: input.requestId,
      llBookId: input.llBookId,
      toLlBookId: decision.toLlBookId,
    });
    return;
  }
  if (decision.kind === 'settle') {
    const settled = await settleRequestLlGone({
      db: input.db,
      requestId: input.requestId,
      llBookId: input.llBookId,
      formats: decision.formats,
      now: input.now,
    });
    if (!settled) return;
    input.tally.llGoneSettled += 1;
    input.log?.info?.('ll_book_gone', {
      site: input.site,
      outcome: 'settled',
      requestId: input.requestId,
      llBookId: input.llBookId,
      formats: decision.formats,
    });
  }
}
