// ADR-065 / DESIGN-036 (PLAN-050 — book ⇄ audiobook format pairing). Three pieces, one file:
//   • matchFormatPairs — the PURE, CONSERVATIVE matcher (normTitle + author agreement, comics
//     excluded, greedy one-to-one; NEVER a wrong pair — ambiguity stays honestly UNPAIRED);
//   • syncFormatPairs — the SINGLE WRITER for the books_format_pairs derived cache (guard-listed;
//     rebuildable, no audit row — the media_plex_matches class): fresh pairs insert, survivors
//     advance last_seen_at, a pair whose either side tombstoned (or whose match no longer holds)
//     drops;
//   • mintPairingWants + runFormatPairing — the PACED estate-wide system-want mint (owner rulings
//     R1/R1a): unpaired items lacking the other format mint book_requests rows (origin='pairing'),
//     capped at PAIRING_MINT_CAP_PER_RUN attempts per run, LL identity resolved reuse-first then
//     Google Books, the confined LL chain pushed for ONLY the missing format behind the 250ms
//     pacer, and open pairing wants reconciled through the EXISTING status machinery
//     (getAllBookStatuses → mapLlStatus → applyRequestReconcile — positives never regress). The
//     orchestrator opens no transaction of its own; external calls stay OUT of any tx (the
//     goodreads-sync discipline). The pairing path touches nothing on the confined LL surface
//     beyond addBook/queueBook/searchBook — the MAM governor is structurally untouched (C-08).
import {
  bookRequests,
  booksFormatPairs,
  booksItems,
  type BookRequestRow,
  type BooksMediaKind,
  type DbClient,
  type FormatPairMatchKind,
} from '@hnet/db';
import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import {
  applyRequestReconcile,
  mapLlStatus,
  markRequestFormatsRequeued,
  normAuthor,
  normTitle,
} from './book-requests';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';

/**
 * ADR-065 C-06 / owner ruling R1a — the per-run mint budget: at most this many ATTEMPTS (each may
 * spend a Google Books resolve + an LL push) per format-pairing run, so LazyLibrarian/SAB digest the
 * ~1000-title backlog over days. Env-tunable.
 */
export const PAIRING_MINT_CAP_PER_RUN = Number(process.env.PAIRING_MINT_CAP_PER_RUN ?? 25);

// ---------------------------------------------------------------------------
// The matcher (pure — unit-tested offline).
// ---------------------------------------------------------------------------

/** The books_items projection the matcher needs. */
export interface PairableItem {
  id: string;
  title: string;
  sortTitle: string;
  author: string | null;
  mediaKind: BooksMediaKind;
}

export interface FormatPairMatch {
  bookItemId: string;
  audioItemId: string;
  matchedVia: FormatPairMatchKind;
}

/** Author agreement (ADR-065 C-01): both normalized authors non-empty, substring either direction. */
function authorsAgree(a: string, b: string): boolean {
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

const byDeterministicOrder = (a: PairableItem, b: PairableItem): number =>
  a.sortTitle.localeCompare(b.sortTitle) || a.id.localeCompare(b.id);

/**
 * The CONSERVATIVE, kind-partitioned matcher (ADR-065 C-01): a Kavita `book` pairs with an ABS
 * `audiobook` only on normalized-title equality (the normTitle idiom) PLUS author agreement. A
 * null/empty author on either side pairs nothing; comics never participate. Greedy one-to-one in
 * deterministic order (sortTitle, id) — each side lands in at most one pair (the schema uniques).
 */
export function matchFormatPairs(items: readonly PairableItem[]): FormatPairMatch[] {
  const books = items.filter((i) => i.mediaKind === 'book').sort(byDeterministicOrder);
  const audios = items.filter((i) => i.mediaKind === 'audiobook').sort(byDeterministicOrder);

  const audioByTitle = new Map<string, PairableItem[]>();
  for (const a of audios) {
    const key = normTitle(a.title);
    if (!key) continue;
    const bucket = audioByTitle.get(key) ?? [];
    bucket.push(a);
    audioByTitle.set(key, bucket);
  }

  const taken = new Set<string>();
  const pairs: FormatPairMatch[] = [];
  for (const book of books) {
    const key = normTitle(book.title);
    if (!key) continue;
    const bookAuthor = normAuthor(book.author);
    if (!bookAuthor) continue; // null/empty author ⇒ no auto-pair, ever
    const bucket = audioByTitle.get(key);
    if (!bucket) continue;
    const match = bucket.find(
      (a) => !taken.has(a.id) && authorsAgree(bookAuthor, normAuthor(a.author)),
    );
    if (!match) continue;
    taken.add(match.id);
    pairs.push({ bookItemId: book.id, audioItemId: match.id, matchedVia: 'title_author' });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// The pair-cache single-writer.
// ---------------------------------------------------------------------------

export interface SyncFormatPairsReport {
  /** Pairs the fresh match declared this run (the cache's post-run row count). */
  paired: number;
  added: number;
  /** Pairs dropped (a side tombstoned, or the match no longer holds — the reconcile). */
  dropped: number;
}

/**
 * Rebuild the books_format_pairs derived cache from the LIVE mirror: compute the fresh pair set
 * (matchFormatPairs), then in ONE transaction drop rows no longer declared, insert the new pairs,
 * and advance last_seen_at on survivors. No per-row audit (rebuildable derived cache — ADR-065 C-02).
 */
export async function syncFormatPairs(input: {
  db?: DbClient;
  now?: Date;
}): Promise<SyncFormatPairsReport> {
  const now = input.now ?? new Date();
  const rows = await resolveDb(input.db)
    .select({
      id: booksItems.id,
      title: booksItems.title,
      sortTitle: booksItems.sortTitle,
      author: booksItems.author,
      mediaKind: booksItems.mediaKind,
    })
    .from(booksItems)
    .where(isNull(booksItems.deletedAt));
  const fresh = matchFormatPairs(rows);
  const freshByBook = new Map(fresh.map((p) => [p.bookItemId, p]));

  let added = 0;
  let dropped = 0;
  await inTransaction(input.db, async (tx) => {
    const existing = await tx
      .select({
        id: booksFormatPairs.id,
        bookItemId: booksFormatPairs.bookItemId,
        audioItemId: booksFormatPairs.audioItemId,
      })
      .from(booksFormatPairs);
    const stale = existing.filter(
      (e) => freshByBook.get(e.bookItemId)?.audioItemId !== e.audioItemId,
    );
    if (stale.length > 0) {
      await tx.delete(booksFormatPairs).where(
        inArray(
          booksFormatPairs.id,
          stale.map((e) => e.id),
        ),
      );
      dropped = stale.length;
    }
    const surviving = new Set(
      existing
        .filter((e) => freshByBook.get(e.bookItemId)?.audioItemId === e.audioItemId)
        .map((e) => e.bookItemId),
    );
    const toInsert = fresh.filter((p) => !surviving.has(p.bookItemId));
    if (toInsert.length > 0) {
      await tx.insert(booksFormatPairs).values(
        toInsert.map((p) => ({
          bookItemId: p.bookItemId,
          audioItemId: p.audioItemId,
          matchedVia: p.matchedVia,
          firstSeenAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      );
      added = toInsert.length;
    }
    if (surviving.size > 0) {
      await tx
        .update(booksFormatPairs)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(inArray(booksFormatPairs.bookItemId, [...surviving]));
    }
  });

  return { paired: fresh.length, added, dropped };
}

// ---------------------------------------------------------------------------
// The paced mint pass.
// ---------------------------------------------------------------------------

/** The missing format an unpaired item wants: a book anchor wants audio; an audio anchor wants ebook. */
export function missingFormatFor(kind: BooksMediaKind): 'ebook' | 'audiobook' {
  return kind === 'book' ? 'audiobook' : 'ebook';
}

/** The GB resolver seam (the book-fix precedent — injected so tests stay offline, ADR-010). */
export interface PairingGbResolver {
  resolveVolume(input: { title: string; author?: string | null }): Promise<{ volumeId: string } | null>;
}

export interface MintPairingWantsInput {
  db?: DbClient;
  /** The confined LL bundle. Absent ⇒ mint only (no push) — the degraded goodreads-sync mode. */
  ll?: LazyLibrarianClientBundle;
  /** The GB fallback resolver. Absent ⇒ reuse-only resolution (unresolved wants stay unmintable). */
  gb?: PairingGbResolver | null;
  /** The per-run attempt budget (tests inject; defaults to PAIRING_MINT_CAP_PER_RUN). */
  cap?: number;
  now?: Date;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Politeness pacer between attempts (the goodreads-sync 250ms default). */
  pacer?: (index: number) => Promise<void>;
}

export interface MintPairingWantsReport {
  /** Unpaired live items lacking the other format (the whole backlog, pre-cap). */
  candidates: number;
  /** Items processed this run (≤ cap — the R1a pace). */
  attempted: number;
  /** NEW pairing want rows inserted this run. */
  minted: number;
  /** Wants whose missing-format chain was pushed to LL this run. */
  pushed: number;
  /** Attempts that ended honestly unmintable (no LL identity) — retried on later runs. */
  unmintable: number;
}

const defaultPacer = (index: number): Promise<void> =>
  index === 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, 250));

const statusOfFormat = (row: BookRequestRow, format: 'ebook' | 'audiobook') =>
  format === 'ebook' ? row.ebookStatus : row.audioStatus;

/**
 * Upsert ONE pairing want (single-writer, tx): insert with the held format `landed` and the missing
 * format `requested`, or refresh an existing want's snapshot + llBookId (updated_at always advances —
 * it is the retry backoff key). Unaudited (the syncShelfRequests sync-mint class). Returns the row +
 * whether it was freshly minted.
 */
async function upsertPairingWant(input: {
  db?: DbClient;
  item: PairableItem;
  llBookId: string | null;
  now: Date;
}): Promise<{ row: BookRequestRow; minted: boolean }> {
  const missing = missingFormatFor(input.item.mediaKind);
  return inTransaction(input.db, async (tx) => {
    const [existing] = await tx
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.pairingBooksItemId, input.item.id))
      .for('update');
    if (existing) {
      const llBookId = existing.llBookId ?? input.llBookId;
      const [row] = await tx
        .update(bookRequests)
        .set({ title: input.item.title, author: input.item.author, llBookId, updatedAt: input.now })
        .where(eq(bookRequests.id, existing.id))
        .returning();
      return { row: row!, minted: false };
    }
    const [row] = await tx
      .insert(bookRequests)
      .values({
        origin: 'pairing',
        pairingBooksItemId: input.item.id,
        title: input.item.title,
        author: input.item.author,
        llBookId: input.llBookId,
        // The held format IS in the library — honest `landed`; only the missing format runs the
        // lifecycle (ADR-065 C-03).
        ebookStatus: missing === 'ebook' ? 'requested' : 'landed',
        audioStatus: missing === 'audiobook' ? 'requested' : 'landed',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    return { row: row!, minted: true };
  });
}

/** Advance a pushed pairing want: the missing format `requested → wanted`, llBookId + stamps set. */
export async function markPairingWantPushed(input: {
  db?: DbClient;
  requestId: string;
  llBookId: string;
  format: 'ebook' | 'audiobook';
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await inTransaction(input.db, async (tx) => {
    const [req] = await tx
      .select({
        id: bookRequests.id,
        ebookStatus: bookRequests.ebookStatus,
        audioStatus: bookRequests.audioStatus,
      })
      .from(bookRequests)
      .where(eq(bookRequests.id, input.requestId))
      .for('update');
    if (!req) return;
    await tx
      .update(bookRequests)
      .set({
        llBookId: input.llBookId,
        ebookStatus:
          input.format === 'ebook' && req.ebookStatus === 'requested' ? 'wanted' : req.ebookStatus,
        audioStatus:
          input.format === 'audiobook' && req.audioStatus === 'requested'
            ? 'wanted'
            : req.audioStatus,
        lastReconciledAt: now,
        updatedAt: now,
      })
      .where(eq(bookRequests.id, req.id));
  });
}

/**
 * The PACED estate-wide mint (owner rulings R1/R1a): every unpaired live item lacking the other
 * format is a candidate; at most `cap` are ATTEMPTED per run — fresh candidates oldest-first
 * (first_seen_at, id), then retryable existing wants (unmintable / never-pushed) least-recently-
 * tried first (the backoff-by-recency). Per attempt: resolve the LL identity (reuse a goodreads
 * request's llBookId for the same normalized title+author, else gb.resolveVolume), upsert the want
 * (single-writer), and — when resolvable — push the confined chain for ONLY the missing format
 * (addBook → queueBook(missing) → searchBook(missing)), paced. A resolve/push failure leaves the
 * want honestly unmintable/`requested` for the next run; nothing is ever fabricated.
 */
export async function mintPairingWants(
  input: MintPairingWantsInput,
): Promise<MintPairingWantsReport> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const cap = input.cap ?? PAIRING_MINT_CAP_PER_RUN;
  const pace = input.pacer ?? defaultPacer;
  const log = input.logger ?? {};

  // 1. The backlog: live, non-comic items with no pair on their side.
  const items = await db
    .select({
      id: booksItems.id,
      title: booksItems.title,
      sortTitle: booksItems.sortTitle,
      author: booksItems.author,
      mediaKind: booksItems.mediaKind,
      firstSeenAt: booksItems.firstSeenAt,
    })
    .from(booksItems)
    .where(and(isNull(booksItems.deletedAt), ne(booksItems.mediaKind, 'comic')));
  const pairRows = await db
    .select({ bookItemId: booksFormatPairs.bookItemId, audioItemId: booksFormatPairs.audioItemId })
    .from(booksFormatPairs);
  const pairedIds = new Set<string>();
  for (const p of pairRows) {
    pairedIds.add(p.bookItemId);
    pairedIds.add(p.audioItemId);
  }
  const unpaired = items.filter((i) => !pairedIds.has(i.id));

  // 2. Existing pairing wants by anchor (one per anchor by schema).
  const wants = await db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'));
  const wantByAnchor = new Map(wants.map((w) => [w.pairingBooksItemId!, w] as const));

  // 3. The capped worklist: fresh mints oldest-first, then retries least-recently-tried first.
  const fresh = unpaired
    .filter((i) => !wantByAnchor.has(i.id))
    .sort(
      (a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime() || a.id.localeCompare(b.id),
    );
  const retry = unpaired
    .filter((i) => {
      const w = wantByAnchor.get(i.id);
      if (!w) return false;
      return w.llBookId === null || statusOfFormat(w, missingFormatFor(i.mediaKind)) === 'requested';
    })
    .sort((a, b) => {
      const wa = wantByAnchor.get(a.id)!;
      const wb = wantByAnchor.get(b.id)!;
      return wa.updatedAt.getTime() - wb.updatedAt.getTime() || a.id.localeCompare(b.id);
    });
  const worklist = [...fresh, ...retry].slice(0, cap);

  // 4. The llBookId reuse index over goodreads requests (same normalized title + author agreement).
  const reuseRows = await db
    .select({ title: bookRequests.title, author: bookRequests.author, llBookId: bookRequests.llBookId })
    .from(bookRequests)
    .where(and(eq(bookRequests.origin, 'goodreads'), isNotNull(bookRequests.llBookId)));
  const reuseByTitle = new Map<string, Array<{ author: string; llBookId: string }>>();
  for (const r of reuseRows) {
    if (!r.llBookId) continue;
    const key = normTitle(r.title);
    if (!key) continue;
    const bucket = reuseByTitle.get(key) ?? [];
    bucket.push({ author: normAuthor(r.author), llBookId: r.llBookId });
    reuseByTitle.set(key, bucket);
  }
  const reuseLlBookId = (item: PairableItem): string | null => {
    const author = normAuthor(item.author);
    if (!author) return null;
    const bucket = reuseByTitle.get(normTitle(item.title));
    return bucket?.find((r) => authorsAgree(author, r.author))?.llBookId ?? null;
  };

  // 5. Attempt each worklist item, paced.
  let minted = 0;
  let pushed = 0;
  let unmintable = 0;
  for (let i = 0; i < worklist.length; i += 1) {
    const item = worklist[i]!;
    await pace(i);
    const missing = missingFormatFor(item.mediaKind);
    let llBookId = wantByAnchor.get(item.id)?.llBookId ?? reuseLlBookId(item) ?? null;
    if (llBookId === null && input.gb) {
      llBookId = await input.gb
        .resolveVolume({ title: item.title, author: item.author })
        .then((v) => v?.volumeId ?? null)
        .catch((error: unknown) => {
          log.error?.('format-pairing: GB resolve failed (want stays unmintable)', {
            title: item.title,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
    }

    const { row, minted: isNew } = await upsertPairingWant({ db: input.db, item, llBookId, now });
    if (isNew) minted += 1;
    if (llBookId === null) {
      unmintable += 1;
      continue;
    }
    if (!input.ll || statusOfFormat(row, missing) !== 'requested') continue;
    try {
      await input.ll.write.addBook(llBookId);
      await input.ll.write.queueBook(llBookId, missing);
      await input.ll.write.searchBook(llBookId, missing);
      await markPairingWantPushed({
        db: input.db,
        requestId: row.id,
        llBookId,
        format: missing,
        now,
      });
      pushed += 1;
    } catch (error) {
      log.error?.('format-pairing: LL push failed (will retry next run)', {
        requestId: row.id,
        title: item.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { candidates: unpaired.length, attempted: worklist.length, minted, pushed, unmintable };
}

// ---------------------------------------------------------------------------
// The run orchestrator (the format-pairing sync mode's body).
// ---------------------------------------------------------------------------

export interface FormatPairingReport extends SyncFormatPairsReport, MintPairingWantsReport {
  /** Open pairing wants whose LL statuses reconciled this run. */
  reconciled: number;
  /** Pairing wants whose raw-`Skipped` missing format was re-queued + re-searched this run. */
  requeued: number;
}

export interface RunFormatPairingInput extends MintPairingWantsInput {}

/**
 * One format-pairing run: rebuild the pair cache (syncFormatPairs), mint the paced system wants
 * (mintPairingWants), then reconcile every OPEN pushed pairing want against ONE getAllBookStatuses
 * read via the existing machinery — mapLlStatus → applyRequestReconcile (positives never regress),
 * with the goodreads-sync raw-`Skipped` sweep applied to the missing format (addBook races land
 * Skipped for pairing pushes exactly as they do for shelf pushes). Opens no transaction of its own.
 */
export async function runFormatPairing(input: RunFormatPairingInput): Promise<FormatPairingReport> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const pace = input.pacer ?? defaultPacer;
  const log = input.logger ?? {};

  const pairs = await syncFormatPairs({ db: input.db, now });
  const mint = await mintPairingWants({ ...input, now });

  let reconciled = 0;
  let requeued = 0;
  if (input.ll) {
    const open = (await db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'))).filter(
      (w) =>
        w.llBookId !== null &&
        w.pairingBooksItemId !== null &&
        (w.ebookStatus !== 'landed' || w.audioStatus !== 'landed'),
    );
    if (open.length > 0) {
      let statuses: Map<string, { ebookStatus: string | null; audioStatus: string | null }>;
      try {
        statuses = await input.ll.read.getAllBookStatuses();
      } catch (error) {
        statuses = new Map();
        log.error?.('format-pairing: LL getAllBooks failed — reconcile skipped this run', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      for (const want of open) {
        const status = statuses.get(want.llBookId!);
        if (!status) continue;
        const missing = want.ebookStatus === 'landed' ? ('audiobook' as const) : ('ebook' as const);
        try {
          await applyRequestReconcile({
            db: input.db,
            requestId: want.id,
            ebookStatus: mapLlStatus(status.ebookStatus),
            audioStatus: mapLlStatus(status.audioStatus),
            now,
          });
          reconciled += 1;
          // The Skipped sweep, missing format only (the held format never re-queues — it is ours).
          const raw = missing === 'ebook' ? status.ebookStatus : status.audioStatus;
          if (raw?.trim().toLowerCase() === 'skipped') {
            await pace(requeued + 1);
            await input.ll.write.queueBook(want.llBookId!, missing);
            await input.ll.write.searchBook(want.llBookId!, missing);
            await markRequestFormatsRequeued({
              db: input.db,
              requestId: want.id,
              formats: [missing],
              now,
            });
            requeued += 1;
          }
        } catch (error) {
          log.error?.('format-pairing: LL reconcile failed', {
            requestId: want.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  const report: FormatPairingReport = { ...pairs, ...mint, reconciled, requeued };
  log.info?.('format-pairing run complete', { ...report });
  return report;
}
