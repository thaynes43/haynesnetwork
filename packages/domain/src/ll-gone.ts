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
import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import {
  bookRequests,
  integrationShelfItems,
  userIntegrations,
  type BookRequestStatus,
  type DbClient,
} from '@hnet/db';
import {
  applyRequestReconcile,
  llFormatAlreadyHeld,
  mapLlStatus,
  type LlHeldSignals,
} from './book-requests';
import { inTransaction, resolveDb } from './db-client';
import { peekGbQuotaGate } from './gb-quota-breaker';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';

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

// ---------------------------------------------------------------------------
// Issue #668 (owner rulings 2026-10-04: "Add them all back now") — the ONE re-request of every settled want.
//
// A want the rule above settled `missing` is handed back to LazyLibrarian once: `addBook` (only for a book LL does
// not hold) and `queueBook` for each lost format, and NOTHING ELSE. No `searchBook`: the search rides LazyLibrarian's
// own daily backlog search (category-only, one query per wanted format per indexer, DELAYSEARCH back-off), so the
// re-request adds no per-book search burst and no book is searched twice. Every origin, all at once, no budget.
// A lost format the library or LazyLibrarian already holds is settled `landed` instead. `ll_rerequested_at` is
// stamped on every attempt and never cleared: a want lost again later stays settled `missing` (no loop).
// ---------------------------------------------------------------------------

/** What the one re-request does with a want. */
export type LlRerequestPlan =
  | { kind: 'skip' }
  | {
      kind: 'rerequest';
      /** The id the want points at afterwards: LazyLibrarian's row for the same book when it has one. */
      toLlBookId: string;
      /** Lost formats already held (by the library or by LazyLibrarian): settled `landed`, no LL write. */
      land: LlFormat[];
      /** Lost formats handed back to LazyLibrarian (`queueBook`), so its daily search looks for them. */
      request: LlFormat[];
    };

/** The want fields the re-request plan reads. */
export interface LlRerequestWant {
  llBookId: string | null;
  title: string;
  author: string | null;
  ebookStatus: BookRequestStatus;
  audioStatus: BookRequestStatus;
  unroutableReason: string | null;
  llRerequestedAt: Date | null;
}

/**
 * Plan one want's re-request. Pure. Eligible: never re-requested, not parked, its id absent from a non-empty
 * snapshot, and at least one of its own `formats` settled `missing`. `libraryHolds` names the formats the library
 * itself holds (a pairing anchor that is paired now). The re-key match (same title, agreeing author) is used
 * whatever its status: a format it holds lands, and the rest are queued on THAT row, so LazyLibrarian's existing
 * book is reused instead of a second one being added.
 */
export function planLlRerequest(input: {
  want: LlRerequestWant;
  snapshot: LlSnapshot | null;
  index: LlRekeyIndex | null;
  formats?: readonly LlFormat[];
  libraryHolds?: readonly LlFormat[];
}): LlRerequestPlan {
  const { want, snapshot } = input;
  if (want.llRerequestedAt !== null || want.unroutableReason !== null || !want.llBookId) {
    return { kind: 'skip' };
  }
  if (!llSnapshotUsable(snapshot) || snapshot.has(want.llBookId)) return { kind: 'skip' };
  const own = input.formats ?? (['ebook', 'audiobook'] as const);
  const lost = own.filter(
    (f) => (f === 'ebook' ? want.ebookStatus : want.audioStatus) === 'missing',
  );
  if (lost.length === 0) return { kind: 'skip' };
  const match = input.index?.find(want.title, want.author) ?? null;
  const row = match ? snapshot.get(match) : undefined;
  const land = lost.filter((f) => input.libraryHolds?.includes(f) || llFormatAlreadyHeld(row, f));
  const request = lost.filter((f) => !land.includes(f));
  return { kind: 'rerequest', toLlBookId: match ?? want.llBookId, land, request };
}

/** What one pass's re-requests did (rides on each job's run report). */
export interface LlRerequestTally {
  /** Wants handed back to LazyLibrarian (addBook as needed + queueBook), now `wanted`. */
  llRerequested: number;
  /** Wants whose lost formats were already held and settled `landed` instead (no LazyLibrarian write). */
  llRerequestLanded: number;
  /** Hand-offs LazyLibrarian refused (addBook answered `false`, or the book never appeared): tried again a day
   *  later, given up after three refusals. */
  llRerequestNotAdded: number;
  /** Wants that needed an `addBook` but were left for a later run: the shared Google Books key is out of quota (the
   *  app's breaker is open, or three adds in a row were refused), or a person's want is still waiting first. */
  llRerequestDeferred: number;
}

export const emptyLlRerequestTally = (): LlRerequestTally => ({
  llRerequested: 0,
  llRerequestLanded: 0,
  llRerequestNotAdded: 0,
  llRerequestDeferred: 0,
});

/** A refused hand-off is tried again only after this long (a Google Books quota-day). */
export const LL_REREQUEST_RETRY_MS = 20 * 60 * 60 * 1000;
/** After this many refusals the re-request ends: the want stays settled `missing`. */
export const LL_REREQUEST_MAX_FAILURES = 3;
/** This many refused adds in a row end a pass's adds (the shared Google Books key is most likely out of quota). */
const LL_REREQUEST_FAIL_STREAK = 3;

/**
 * The SQL-side eligibility every caller adds to its candidate query: the one re-request has not ended, and a refused
 * want waits out a day. Callers order by `ll_rerequest_failures` then `created_at`, so a refused want goes last.
 */
export function llRerequestOpen(now: Date) {
  return and(
    isNull(bookRequests.llRerequestedAt),
    or(
      isNull(bookRequests.llRerequestFailedAt),
      lt(bookRequests.llRerequestFailedAt, new Date(now.getTime() - LL_REREQUEST_RETRY_MS)),
    ),
  );
}

/** One want a job hands to `runLlRerequests`. */
export interface LlRerequestCandidate {
  want: LlRerequestWant & { id: string; llRerequestFailures: number };
  /** The formats this want acquires (both for goodreads, the anchor-missing one for pairing, the active one for
   *  a collection want). */
  formats?: readonly LlFormat[];
  /** Formats the library itself holds (pairing: the anchor is paired now). */
  libraryHolds?: readonly LlFormat[];
  /** A collection want: its `last_searched_at` is stamped with the hand-off (its cooldown and 1 h grace). */
  collection?: boolean;
}

/**
 * Run the one re-request for a job's candidates, against the snapshot the job already read:
 *   1. plan each; a held-only plan settles `landed` at once;
 *   2. a want LazyLibrarian holds the book for (the re-key match) is queued there, no add;
 *   3. a want that needs `addBook` is added unless adds are deferred (`deferAdds`: a person's want is still waiting,
 *      or the app's Google Books breaker is open: LazyLibrarian's add looks the volume up on the SAME key). An add
 *      answered `false` is a refusal: no queue, and three in a row end the pass's adds. Then `queueBook` once per
 *      (book, format) unless the row already reads it `Wanted`/`Snatched`. Paced. NEVER `searchBook`;
 *   4. one more `getAllBooks` confirms each add.
 * An LL write that throws (LL down) leaves that want untouched for the next run.
 */
export async function runLlRerequests(input: {
  db?: DbClient;
  ll: LazyLibrarianClientBundle;
  candidates: readonly LlRerequestCandidate[];
  snapshot: LlSnapshot;
  now: Date;
  site: string;
  /** Leave every add for a later run (a person's want comes first). Queue-only and held-only plans still run. */
  deferAdds?: boolean;
  pace?: (index: number) => Promise<void>;
  log?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<LlRerequestTally> {
  const tally = emptyLlRerequestTally();
  if (!llSnapshotUsable(input.snapshot) || input.candidates.length === 0) return tally;
  const snapshot = input.snapshot;
  const index = new LlRekeyIndex(snapshot);
  let addsStopped =
    input.deferAdds === true || (await peekGbQuotaGate({ db: input.db, now: input.now })).open;
  let failStreak = 0;
  const verify: Array<{
    c: LlRerequestCandidate;
    plan: Extract<LlRerequestPlan, { kind: 'rerequest' }>;
  }> = [];
  const added = new Set<string>();
  const queued = new Set<string>();
  let i = 0;
  for (const c of input.candidates) {
    const plan = planLlRerequest({
      want: c.want,
      snapshot,
      index,
      ...(c.formats ? { formats: c.formats } : {}),
      ...(c.libraryHolds ? { libraryHolds: c.libraryHolds } : {}),
    });
    if (plan.kind === 'skip') continue;
    if (plan.request.length === 0) {
      await recordLlRerequest({ ...input, c, plan, outcome: 'landed', tally });
      continue;
    }
    const target = plan.toLlBookId;
    const row = snapshot.get(target);
    const needsAdd = row == null && !added.has(target);
    if (needsAdd && addsStopped) {
      tally.llRerequestDeferred += 1;
      continue;
    }
    try {
      await input.pace?.(i);
      i += 1;
      if (needsAdd) {
        const answer = String((await input.ll.write.addBook(target)) ?? '')
          .trim()
          .toLowerCase();
        if (answer === 'false') {
          await recordLlRerequest({ ...input, c, plan, outcome: 'not_added', tally });
          failStreak += 1;
          if (failStreak >= LL_REREQUEST_FAIL_STREAK) addsStopped = true;
          continue;
        }
        failStreak = 0;
        added.add(target);
      }
      for (const f of plan.request) {
        const raw = (f === 'ebook' ? row?.ebookStatus : row?.audioStatus)?.trim().toLowerCase();
        if (raw === 'wanted' || raw === 'snatched' || queued.has(`${target}:${f}`)) continue;
        await input.ll.write.queueBook(target, f);
        queued.add(`${target}:${f}`);
      }
      if (row != null) await recordLlRerequest({ ...input, c, plan, outcome: 'requeued', tally });
      else verify.push({ c, plan });
    } catch (error) {
      input.log?.error?.(`${input.site}: LL re-request failed (retried next run)`, {
        requestId: c.want.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (verify.length === 0) return tally;
  // One read after the adds: did LazyLibrarian keep each? A failed read assumes it did (the gone rule settles a
  // want whose book never appears, and the end stamp keeps it from looping).
  let after: Map<string, unknown> | null = null;
  try {
    after = await input.ll.read.getAllBookStatuses();
  } catch {
    after = null;
  }
  for (const { c, plan } of verify) {
    const kept = !llSnapshotUsable(after) || after.has(plan.toLlBookId);
    await recordLlRerequest({ ...input, c, plan, outcome: kept ? 'requeued' : 'not_added', tally });
  }
  return tally;
}

/**
 * The single writer of a re-request (one transaction, unaudited: the markRequestPushed class). Guarded on the want
 * still pointing at the planned id, its re-request not ended, and its planned formats still `missing`.
 *   - `landed`: the held formats become `landed` (repointed to the plan's id); nothing is stamped.
 *   - `requeued`: the handed formats become `wanted`, held ones `landed`, the want repointed; `ll_rerequested_at`
 *     (the end, never cleared) and `last_reconciled_at` stamped, plus `last_searched_at` for a collection want.
 *   - `not_added`: one more refusal (`ll_rerequest_failures`, `ll_rerequest_failed_at`); the third ends it
 *     (`ll_rerequested_at`), and the want stays settled `missing`.
 * Logs `ll_rerequest`.
 */
async function recordLlRerequest(input: {
  db?: DbClient;
  c: LlRerequestCandidate;
  plan: Extract<LlRerequestPlan, { kind: 'rerequest' }>;
  outcome: 'landed' | 'requeued' | 'not_added';
  tally: LlRerequestTally;
  site: string;
  now: Date;
  log?: { info?: (msg: string, meta?: Record<string, unknown>) => void };
}): Promise<void> {
  const { plan, c, outcome } = input;
  const changed = await inTransaction(input.db, async (tx) => {
    const [req] = await tx
      .select({
        id: bookRequests.id,
        llBookId: bookRequests.llBookId,
        ebookStatus: bookRequests.ebookStatus,
        audioStatus: bookRequests.audioStatus,
        llRerequestedAt: bookRequests.llRerequestedAt,
        llRerequestFailures: bookRequests.llRerequestFailures,
      })
      .from(bookRequests)
      .where(eq(bookRequests.id, c.want.id))
      .for('update');
    if (!req || req.llBookId !== c.want.llBookId || req.llRerequestedAt !== null) return false;
    const statusOf = (f: LlFormat) => (f === 'ebook' ? req.ebookStatus : req.audioStatus);
    if (![...plan.land, ...plan.request].every((f) => statusOf(f) === 'missing')) return false;
    if (outcome === 'not_added') {
      const failures = req.llRerequestFailures + 1;
      await tx
        .update(bookRequests)
        .set({
          llRerequestFailures: failures,
          llRerequestFailedAt: input.now,
          ...(failures >= LL_REREQUEST_MAX_FAILURES ? { llRerequestedAt: input.now } : {}),
          updatedAt: input.now,
        })
        .where(eq(bookRequests.id, req.id));
      return true;
    }
    const next = (f: LlFormat): BookRequestStatus =>
      plan.land.includes(f)
        ? 'landed'
        : plan.request.includes(f) && outcome === 'requeued'
          ? 'wanted'
          : statusOf(f);
    await tx
      .update(bookRequests)
      .set({
        llBookId: plan.toLlBookId,
        ebookStatus: next('ebook'),
        audioStatus: next('audiobook'),
        ...(outcome === 'requeued'
          ? {
              llRerequestedAt: input.now,
              lastReconciledAt: input.now,
              ...(c.collection ? { lastSearchedAt: input.now } : {}),
            }
          : {}),
        updatedAt: input.now,
      })
      .where(eq(bookRequests.id, req.id));
    return true;
  });
  if (!changed) return;
  if (outcome === 'landed') input.tally.llRerequestLanded += 1;
  else if (outcome === 'requeued') input.tally.llRerequested += 1;
  else input.tally.llRerequestNotAdded += 1;
  input.log?.info?.('ll_rerequest', {
    site: input.site,
    outcome,
    requestId: c.want.id,
    llBookId: c.want.llBookId,
    ...(plan.toLlBookId !== c.want.llBookId ? { toLlBookId: plan.toLlBookId } : {}),
    queued: outcome === 'requeued' ? plan.request : [],
    landed: plan.land,
  });
}

/**
 * Are people's (goodreads) re-requests still waiting? While one is, the pairing and collection passes defer their
 * adds, so on a quota-short day the shared Google Books key goes to people's wants first (the owner's order). Waiting
 * means: its re-request is open (`llRerequestOpen`), it is on a live shelf item of a linked integration, it has a
 * `missing` format, and its id is absent from the caller's snapshot.
 */
export async function peoplesRerequestsWaiting(
  db: DbClient | undefined,
  snapshot: LlSnapshot,
  now: Date,
): Promise<boolean> {
  const rows = await resolveDb(db)
    .select({ llBookId: bookRequests.llBookId })
    .from(bookRequests)
    .innerJoin(integrationShelfItems, eq(integrationShelfItems.id, bookRequests.shelfItemId))
    .innerJoin(userIntegrations, eq(userIntegrations.id, bookRequests.integrationId))
    .where(
      and(
        eq(bookRequests.origin, 'goodreads'),
        // Only an integration the goodreads job syncs: an unlinked one would hold the app's adds back forever.
        eq(userIntegrations.status, 'linked'),
        llRerequestOpen(now),
        isNull(bookRequests.unroutableReason),
        isNull(integrationShelfItems.deletedAt),
        isNotNull(bookRequests.llBookId),
        or(eq(bookRequests.ebookStatus, 'missing'), eq(bookRequests.audioStatus, 'missing')),
      ),
    );
  return rows.some((r) => r.llBookId !== null && !snapshot.has(r.llBookId));
}
