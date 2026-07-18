// ADR-065 / DESIGN-036 (PLAN-050 — book ⇄ audiobook format pairing). Three pieces, one file:
//   • matchFormatPairs — the PURE, CONSERVATIVE matcher (the pairing FULL-title key + author
//     agreement, comics excluded, greedy one-to-one). A wrong pair requires IDENTICAL
//     noise-stripped full titles AND agreeing authors; anything less stays honestly UNPAIRED
//     (identifier-backed matching is the known upgrade path — DESIGN-036 Q-02);
//   • syncFormatPairs — the SINGLE WRITER for the books_format_pairs derived cache (guard-listed;
//     rebuildable, no audit row — the media_plex_matches class): fresh pairs insert, survivors
//     advance last_seen_at, a pair whose either side tombstoned (or whose match no longer holds)
//     drops — and a both-landed pairing want whose pair just broke has its missing format reset to
//     `requested` in the SAME tx (the re-vanish self-heal) so it re-enters the mint retry queue;
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
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { inTransaction, resolveDb } from './db-client';
import { guardedGbResolve } from './gb-quota-breaker';
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
  /**
   * The library edition ISBN (ABS `media.metadata.isbn`; Kavita ebooks are null by design). Fed to
   * the GB resolve so the reliable `isbn:` leg fires before the fuzzy file-title leg (PLAN-059 —
   * the pairing-resolve gap: dropping this is why pairing resolved ~4x worse than the Goodreads
   * path, which passes it). Optional — the matcher does not use it; only the mint's GB resolve does.
   */
  isbn?: string | null;
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

/**
 * ADR-065 C-01 (review-hardened 2026-07-16) — the EDITION-NOISE tokens the pairing key drops.
 * Exactly these: the articles plus the packaging words the two ecosystems decorate the SAME work
 * with ("… : A Novel", "… (Unabridged)"). Nothing else — subtitles stay load-bearing.
 */
const PAIRING_NOISE_TOKENS = new Set(['a', 'an', 'the', 'novel', 'unabridged', 'abridged', 'edition']);

/**
 * The PAIRING title key — deliberately NOT the goodreads-match `normTitle` (which cuts at the first
 * ':'/'(' and would collapse DISTINCT franchise works: "Star Wars: Heir to the Empire" and
 * "Star Wars: Thrawn" share an author, and a subtitle-cutting key would mispair them). This key
 * keeps the FULL title: lowercase, collapse non-alphanumerics to single spaces, drop ONLY the
 * PAIRING_NOISE_TOKENS, and the matcher requires FULL EQUALITY of the remaining token sequence.
 * "Project Hail Mary: A Novel" ⇄ "Project Hail Mary (Unabridged)" both reduce to
 * "project hail mary"; "star wars heir to empire" ≠ "star wars thrawn". A bare stem vs a subtitled
 * edition ("Dune" vs "Dune: Book One of the Dune Chronicles") does NOT pair — the conservative
 * miss is correct (DESIGN-036 Q-02 is the upgrade path).
 */
export function pairingTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0 && !PAIRING_NOISE_TOKENS.has(w))
    .join(' ');
}

const byDeterministicOrder = (a: PairableItem, b: PairableItem): number =>
  a.sortTitle.localeCompare(b.sortTitle) || a.id.localeCompare(b.id);

/**
 * The CONSERVATIVE, kind-partitioned matcher (ADR-065 C-01): a Kavita `book` pairs with an ABS
 * `audiobook` only on FULL noise-stripped title equality (pairingTitleKey — never the
 * subtitle-cutting goodreads normTitle) PLUS author agreement. A null/empty author on either side
 * pairs nothing; comics never participate. Greedy one-to-one in deterministic order (sortTitle, id)
 * — each side lands in at most one pair (the schema uniques).
 */
export function matchFormatPairs(items: readonly PairableItem[]): FormatPairMatch[] {
  const books = items.filter((i) => i.mediaKind === 'book').sort(byDeterministicOrder);
  const audios = items.filter((i) => i.mediaKind === 'audiobook').sort(byDeterministicOrder);

  const audioByTitle = new Map<string, PairableItem[]>();
  for (const a of audios) {
    const key = pairingTitleKey(a.title);
    if (!key) continue;
    const bucket = audioByTitle.get(key) ?? [];
    bucket.push(a);
    audioByTitle.set(key, bucket);
  }

  const taken = new Set<string>();
  const pairs: FormatPairMatch[] = [];
  for (const book of books) {
    const key = pairingTitleKey(book.title);
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
  /**
   * RE-VANISH self-heal (review finding 3): both-landed pairing wants whose anchor is unpaired
   * again — the missing format was reset to `requested` so the mint retry queue picks it back up.
   */
  revived: number;
}

/**
 * Rebuild the books_format_pairs derived cache from the LIVE mirror: compute the fresh pair set
 * (matchFormatPairs), then in ONE transaction drop rows no longer declared, insert the new pairs,
 * and advance last_seen_at on survivors. No per-row audit (rebuildable derived cache — ADR-065 C-02).
 *
 * The SAME transaction runs the RE-VANISH reconcile: a pairing want exists once per anchor for its
 * lifetime (the partial unique), and one whose formats are BOTH landed is inert — so when its
 * anchor is unpaired again (the counterpart vanished) the missing format is reset to `requested`,
 * putting the want back on the mint retry queue (ADR-065 C-03 self-heal).
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
  let revived = 0;
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

    // RE-VANISH reconcile (same tx as the pair drop): a want per anchor exists for its LIFETIME —
    // when the counterpart vanishes after the want went both-landed (inert), reset the MISSING
    // format to `requested` so the estate wants it again (the mint retry queue re-pushes it).
    const liveById = new Map(rows.map((r) => [r.id, r]));
    const pairedIds = new Set<string>();
    for (const p of fresh) {
      pairedIds.add(p.bookItemId);
      pairedIds.add(p.audioItemId);
    }
    const pairingWants = await tx
      .select({
        id: bookRequests.id,
        pairingBooksItemId: bookRequests.pairingBooksItemId,
        ebookStatus: bookRequests.ebookStatus,
        audioStatus: bookRequests.audioStatus,
      })
      .from(bookRequests)
      .where(eq(bookRequests.origin, 'pairing'));
    for (const want of pairingWants) {
      const anchor = want.pairingBooksItemId ? liveById.get(want.pairingBooksItemId) : undefined;
      if (!anchor || anchor.mediaKind === 'comic' || pairedIds.has(anchor.id)) continue;
      const missing = missingFormatFor(anchor.mediaKind);
      const missingStatus = missing === 'ebook' ? want.ebookStatus : want.audioStatus;
      if (missingStatus !== 'landed') continue; // still in flight / already retryable — nothing to heal
      await tx
        .update(bookRequests)
        .set({
          ebookStatus: missing === 'ebook' ? 'requested' : want.ebookStatus,
          audioStatus: missing === 'audiobook' ? 'requested' : want.audioStatus,
          updatedAt: now,
        })
        .where(eq(bookRequests.id, want.id));
      revived += 1;
    }
  });

  return { paired: fresh.length, added, dropped, revived };
}

// ---------------------------------------------------------------------------
// The paced mint pass.
// ---------------------------------------------------------------------------

/** The missing format an unpaired item wants: a book anchor wants audio; an audio anchor wants ebook. */
export function missingFormatFor(kind: BooksMediaKind): 'ebook' | 'audiobook' {
  return kind === 'book' ? 'audiobook' : 'ebook';
}

/** The GB resolver seam (the book-fix precedent — injected so tests stay offline, ADR-010). Accepts
 * the anchor ISBN so the resolver's reliable `isbn:` leg fires first (PLAN-059 pairing-resolve fix). */
export interface PairingGbResolver {
  resolveVolume(input: {
    isbn?: string | null;
    title: string;
    author?: string | null;
  }): Promise<{ volumeId: string } | null>;
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
  /**
   * ADR-067 C-08 (PLAN-055) — GB-requiring candidates skipped because the quota breaker was/went
   * OPEN: NOT attempts (the cap is not consumed, the want row is not touched — `updated_at`, the
   * retry-recency key, does not advance). Closes the PLAN-050 residual.
   */
  skippedQuota: number;
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
    const refresh = async (existing: BookRequestRow): Promise<{ row: BookRequestRow; minted: boolean }> => {
      const llBookId = existing.llBookId ?? input.llBookId;
      const [row] = await tx
        .update(bookRequests)
        .set({ title: input.item.title, author: input.item.author, llBookId, updatedAt: input.now })
        .where(eq(bookRequests.id, existing.id))
        .returning();
      return { row: row!, minted: false };
    };

    const [existing] = await tx
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.pairingBooksItemId, input.item.id))
      .for('update');
    if (existing) return refresh(existing);

    // Review finding 2 (TOCTOU): the select-then-insert races a concurrent minter — land the insert
    // ON CONFLICT DO NOTHING against the pairing partial unique so a 23505 can never abort the run,
    // and re-select (the row the rival won) when the insert returns nothing.
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
      .onConflictDoNothing({
        target: bookRequests.pairingBooksItemId,
        where: sql`${bookRequests.pairingBooksItemId} IS NOT NULL`,
      })
      .returning();
    if (row) return { row, minted: true };
    const [raced] = await tx
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.pairingBooksItemId, input.item.id))
      .for('update');
    if (!raced) throw new Error('pairing want insert conflicted but no row exists'); // unreachable
    return refresh(raced);
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
 * request's llBookId for the same normalized title+author, else gb.resolveVolume through the
 * ADR-067 quota breaker), upsert the want (single-writer), and — when resolvable — push the
 * confined chain for ONLY the missing format (addBook → queueBook(missing) → searchBook(missing)),
 * paced. A resolve/push failure leaves the want honestly unmintable/`requested` for the next run;
 * nothing is ever fabricated. QUOTA WEATHER is different (ADR-067 C-08, the PLAN-050 residual):
 * an open/tripping breaker SKIPS GB-requiring candidates without consuming the cap or touching
 * their rows — llBookId-reusing mints still proceed, so the backlog drains on quota days.
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
      isbn: booksItems.isbn,
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

  // 3. The ordered candidate list: fresh mints oldest-first, then retries least-recently-tried
  //    first. NOT pre-capped (ADR-067 C-08): only REAL attempts consume the cap — a GB-requiring
  //    candidate met while the quota breaker is open is skipped without burning budget, so the
  //    identity-holding candidates behind it still mint on a quota day.
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
  const candidates = [...fresh, ...retry];

  // 4. The llBookId reuse index over ALREADY-RESOLVED requests (same normalized title + author
  //    agreement). Draws from BOTH goodreads shelf requests AND prior pairing wants: a GB volume id
  //    is the same identity key on either origin, so a pairing candidate whose same-work sibling
  //    (e.g. its format twin, or a shelf request) already resolved reuses that id and needs ZERO GB
  //    calls — the GB-avoidance that lets the pairing backlog keep draining on a quota-exhausted day
  //    (the 2026-07-18 shared-key starvation: LazyLibrarian drains the per-project GB quota, so every
  //    pairing want that can resolve WITHOUT a fresh GB hop is one more that mints regardless).
  const reuseRows = await db
    .select({ title: bookRequests.title, author: bookRequests.author, llBookId: bookRequests.llBookId })
    .from(bookRequests)
    .where(and(inArray(bookRequests.origin, ['goodreads', 'pairing']), isNotNull(bookRequests.llBookId)));
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

  // 5. Attempt candidates in order, paced, until the cap of REAL attempts is spent. A candidate
  //    that would need a Google Books resolve while the breaker is open (or after it trips
  //    mid-run) is SKIPPED — no cap consumed, no upsert (updated_at is the retry-recency key and
  //    must not advance on a non-attempt), no per-item error spam (ADR-067 C-08).
  let minted = 0;
  let pushed = 0;
  let unmintable = 0;
  let skippedQuota = 0;
  let attempted = 0;
  let paceSeq = 0;
  let quotaOpen = false;
  for (const item of candidates) {
    if (attempted >= cap) break;
    const missing = missingFormatFor(item.mediaKind);
    let llBookId = wantByAnchor.get(item.id)?.llBookId ?? reuseLlBookId(item) ?? null;
    const needsGb = llBookId === null && input.gb != null;
    if (needsGb && quotaOpen) {
      skippedQuota += 1;
      continue;
    }
    await pace(paceSeq);
    paceSeq += 1;
    if (needsGb) {
      try {
        const guarded = await guardedGbResolve({
          db: input.db,
          gb: input.gb!,
          // Pass the anchor ISBN (PLAN-059): the resolver tries `isbn:` first — the exact leg that
          // makes the Goodreads path resolve ~99% — before falling back to the fuzzy file-title.
          query: { isbn: item.isbn ?? null, title: item.title, author: item.author },
        });
        if (guarded.outcome === 'quota_blocked' || guarded.outcome === 'quota_tripped') {
          quotaOpen = true;
          skippedQuota += 1;
          log.info?.('format-pairing: GB quota exhausted — GB-requiring mints skipped, cap preserved', {
            retryAfter: guarded.until.toISOString(),
          });
          continue;
        }
        llBookId = guarded.outcome === 'resolved' ? guarded.volume.volumeId : null;
      } catch (error) {
        // Non-429 failure — today's semantics: an honest unmintable ATTEMPT (cap consumed below).
        log.error?.('format-pairing: GB resolve failed (want stays unmintable)', {
          title: item.title,
          error: error instanceof Error ? error.message : String(error),
        });
        llBookId = null;
      }
    }

    attempted += 1;
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

  return { candidates: unpaired.length, attempted, minted, pushed, unmintable, skippedQuota };
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

export type RunFormatPairingInput = MintPairingWantsInput;

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
