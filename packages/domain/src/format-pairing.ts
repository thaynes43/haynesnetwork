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
import { makeGbBudgetTracker, type GbBudgetTracker, type GbCallMeter } from './gb-call-budget';
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

/** One token matches another when equal or one is a prefix of the other ("geo"→"george", "l"→"lucy"). */
const tokenMatches = (a: string, b: string): boolean => a === b || a.startsWith(b) || b.startsWith(a);

/**
 * Ordered alignment of the shorter token list into the longer as a SUBSEQUENCE, tokens matching by
 * equality-or-prefix — the bibliographic name tolerances the plain substring check misses:
 * initials spacing ("jrr tolkien" ⇄ "j r r tolkien"), middle-name insertion ("dean koontz" ⇄
 * "dean ray koontz"), initials-to-full-name ("l m montgomery" ⇄ "lucy maud montgomery"), and a
 * leading co-author credit ("george r r martin" ⇄ "geo r r martin gardner duzois …"). Guard: at
 * least one aligned pair must be a REAL word on both sides (≥ 3 chars — the surname anchor), so
 * bare initials alone can never carry an agreement ("j" ⇄ "john grisham" stays refused).
 */
function tokensAlign(shorter: string[], longer: string[]): boolean {
  let i = 0;
  let anchored = false;
  for (const t of shorter) {
    let found = false;
    while (i < longer.length) {
      const u = longer[i++]!;
      if (tokenMatches(t, u)) {
        found = true;
        anchored ||= t.length >= 3 && u.length >= 3;
        break;
      }
    }
    if (!found) return false;
  }
  return anchored;
}

/**
 * Author agreement (ADR-065 C-01, tolerance-widened 2026-07-21 — the live pairing-gap diagnosis):
 * both normalized authors non-empty, then substring either direction OR the ordered token
 * alignment above. Full noise-stripped TITLE equality remains the primary gate (the matcher never
 * consults authors for rows whose titles differ), so the conservatism bar — a wrong pair needs
 * identical titles AND agreeing authors — is unchanged; "Odyssey" by Homer still never pairs with
 * "Odyssey" by Walter Mosley.
 */
function authorsAgree(a: string, b: string): boolean {
  if (a.length === 0 || b.length === 0) return false;
  // Substring either direction — but only when the shorter side is a REAL word (≥ 3 chars), the
  // same anchor bar the alignment uses; a bare initial could previously ride "j" ⊂ "john grisham".
  if (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))) return true;
  const at = a.split(' ');
  const bt = b.split(' ');
  return at.length <= bt.length ? tokensAlign(at, bt) : tokensAlign(bt, at);
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
  /**
   * DESIGN-039 D-18 — predicate: does LazyLibrarian ALREADY hold this llBookId (= GB volume id under
   * `book_api=GoogleBooks`)? Derived from one getAllBookStatuses read per run. When it returns true,
   * the push SKIPS `addBook` — LL already holds the volume, so re-adding only makes LL re-resolve it
   * (and its author/series/pubdate) from Google Books for nothing — and issues ONLY queueBook +
   * searchBook (neither touches GB). Absent ⇒ addBook always fires (the safe default: never skip a
   * seat we cannot confirm). This is the lever that ends the all-day re-add amplification (the same
   * ~23 already-seated wants were re-added every :32 run, each addBook fanning out to several GB
   * calls) — see DESIGN-039 D-18.
   */
  llHasSeededBook?: (llBookId: string) => boolean;
  /**
   * DESIGN-039 D-21/D-23 — the daily GB CALL BUDGET meter + tracker (consumer 'pairing'). The meter is
   * wired into the GB client's http wrapper (counts every outbound GB leg); the tracker holds this
   * consumer's remaining daily allowance. Absent ⇒ no budget enforcement + no metering (tests /
   * degraded runs) — exact pre-budget behaviour. When the tracker's allowance is spent, GB-requiring
   * candidates are skipped as `skippedBudget` (cap preserved, want untouched, breaker NOT tripped).
   */
  meter?: GbCallMeter;
  budget?: GbBudgetTracker;
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
  /**
   * DESIGN-039 D-23 — GB-requiring candidates skipped because THIS consumer's daily CALL BUDGET was
   * spent (distinct from skippedQuota, which is the shared 429 breaker). Same non-attempt discipline:
   * no cap consumed, no want upsert, no breaker trip — the honest "we paced ourselves off GB today".
   */
  skippedBudget: number;
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

  // 3. The ordered candidate list (DESIGN-039 D-22 — OLDEST-FIRST DRAIN, ISBN-priority). A candidate
  //    is eligible when it has no want yet (fresh) OR its want is unresolved / the missing format is
  //    still `requested`. The OLD ordering walked ALL fresh (which includes today's newest library
  //    items) BEFORE any retry, so the frozen oldest cohort (the 2026-07-16 set — same first_seen,
  //    last tried days ago) never got reached while new items churned ahead of it. The NEW single
  //    order drains front-to-back regardless of fresh/retry:
  //      1. first_seen_at ASC   — the oldest cohort first (ends the newest-first churn);
  //      2. ISBN-bearing first  — WITHIN the same first_seen, the anchors carrying an ISBN go first
  //                               (the `isbn:` leg is the cheap, reliable one — cheapest drain);
  //      3. last-tried ASC      — least-recently-attempted next (fresh = first_seen; a retried want =
  //                               its updated_at), so a bounded daily budget MARCHES through the cohort
  //                               instead of re-hammering the same top items every run (a no-match
  //                               advances updated_at and sinks below its not-yet-tried siblings);
  //      4. id ASC              — the deterministic final tiebreak.
  //    NOT pre-capped (ADR-067 C-08): only REAL attempts consume the cap — a GB-requiring candidate met
  //    while the quota breaker is open (skippedQuota) or the daily budget is spent (skippedBudget) is
  //    skipped without burning cap, so identity-holding candidates behind it still mint.
  const hasIsbn = (i: (typeof unpaired)[number]): boolean => Boolean(i.isbn && i.isbn.trim().length > 0);
  const lastTriedAt = (i: (typeof unpaired)[number]): number =>
    (wantByAnchor.get(i.id)?.updatedAt ?? i.firstSeenAt).getTime();
  const candidates = unpaired
    .filter((i) => {
      const w = wantByAnchor.get(i.id);
      if (!w) return true; // fresh — never yet minted
      return w.llBookId === null || statusOfFormat(w, missingFormatFor(i.mediaKind)) === 'requested';
    })
    .sort(
      (a, b) =>
        a.firstSeenAt.getTime() - b.firstSeenAt.getTime() ||
        (hasIsbn(b) ? 1 : 0) - (hasIsbn(a) ? 1 : 0) ||
        lastTriedAt(a) - lastTriedAt(b) ||
        a.id.localeCompare(b.id),
    );

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
  let skippedBudget = 0;
  let attempted = 0;
  let paceSeq = 0;
  let quotaOpen = false;
  let budgetLogged = false;
  for (const item of candidates) {
    if (attempted >= cap) break;
    const missing = missingFormatFor(item.mediaKind);
    let llBookId = wantByAnchor.get(item.id)?.llBookId ?? reuseLlBookId(item) ?? null;
    const needsGb = llBookId === null && input.gb != null;
    if (needsGb && quotaOpen) {
      skippedQuota += 1;
      continue;
    }
    // DESIGN-039 D-23 — the daily CALL BUDGET: once this consumer's slice is spent, skip GB-requiring
    // candidates for the rest of the quota-day WITHOUT consuming the cap, upserting the want, or
    // tripping the shared breaker (this is our own pacing, not a real 429). Reuse-resolvable candidates
    // (needsGb false) still mint free.
    if (needsGb && input.budget && !input.budget.canSpend()) {
      skippedBudget += 1;
      if (!budgetLogged) {
        log.info?.('format-pairing: GB daily call budget spent — GB-requiring mints skipped, cap preserved', {
          consumer: input.budget.consumer,
          used: input.budget.used(),
        });
        budgetLogged = true;
      }
      continue;
    }
    await pace(paceSeq);
    paceSeq += 1;
    if (needsGb) {
      const before = input.meter?.taken() ?? 0;
      try {
        const guarded = await guardedGbResolve({
          db: input.db,
          gb: input.gb!,
          // Pass the anchor ISBN (PLAN-059): the resolver tries `isbn:` first — the exact leg that
          // makes the Goodreads path resolve ~99% — before falling back to the fuzzy file-title.
          query: { isbn: item.isbn ?? null, title: item.title, author: item.author },
        });
        // Persist the GB legs this resolve actually spent (D-21): the meter counts each outbound leg;
        // a quota_blocked outcome made ZERO calls (delta 0, no-op), a quota_tripped made one.
        if (input.budget) await input.budget.spend((input.meter?.taken() ?? 0) - before);
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
        if (input.budget) await input.budget.spend((input.meter?.taken() ?? 0) - before);
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
      // DESIGN-039 D-18 — addBook ONLY seats a volume LL does not already hold. When LL already has
      // it (the common case for a re-pushed want), skip addBook so LL makes ZERO Google Books calls
      // this push; queueBook + searchBook (neither hits GB) still drive the acquisition retry.
      if (!input.llHasSeededBook?.(llBookId)) await input.ll.write.addBook(llBookId);
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

  return { candidates: unpaired.length, attempted, minted, pushed, unmintable, skippedQuota, skippedBudget };
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

  // DESIGN-039 D-18 — read LL's seated-book set ONCE per run (a single getAllBookStatuses — an LL DB
  // read, never a Google Books call) and use it for BOTH: (a) the mint push's addBook gate below
  // (skip re-adding a volume LL already holds — the fix for the all-day re-add GB amplification) and
  // (b) the status reconcile. One read, two consumers. On an LL read failure the map stays null, so
  // the addBook gate degrades to today's always-addBook behaviour and reconcile is skipped — the
  // exact pre-D-18 semantics. A volume mint FIRST-seats this run is (correctly) absent from this
  // pre-mint snapshot: it gets addBook'd now and reconciles on the next run (a benign one-run delay,
  // since a just-pushed want has no status to reconcile yet).
  let seated: Map<string, { ebookStatus: string | null; audioStatus: string | null }> | null = null;
  if (input.ll) {
    try {
      seated = await input.ll.read.getAllBookStatuses();
    } catch (error) {
      log.error?.('format-pairing: LL getAllBooks failed — addBook gate + reconcile skipped this run', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const seatedMap = seated;

  // DESIGN-039 D-23 — build the 'pairing' daily-budget tracker once per run (reads the start-of-run
  // usage). Only when a meter is wired (the cluster cron); absent ⇒ no budgeting (tests / degraded).
  const budget = input.meter
    ? await makeGbBudgetTracker({ db: input.db, consumer: 'pairing', now })
    : input.budget;

  const mint = await mintPairingWants({
    ...input,
    now,
    ...(budget ? { budget } : {}),
    llHasSeededBook: seatedMap ? (id) => seatedMap.get(id) != null : undefined,
  });

  let reconciled = 0;
  let requeued = 0;
  if (input.ll && seatedMap) {
    const open = (await db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'))).filter(
      (w) =>
        w.llBookId !== null &&
        w.pairingBooksItemId !== null &&
        (w.ebookStatus !== 'landed' || w.audioStatus !== 'landed'),
    );
    for (const want of open) {
      const status = seatedMap.get(want.llBookId!);
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

  const report: FormatPairingReport = { ...pairs, ...mint, reconciled, requeued };
  log.info?.('format-pairing run complete', { ...report });
  return report;
}
