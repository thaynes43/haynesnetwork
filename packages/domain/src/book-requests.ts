// ADR-055 / DESIGN-028 (PLAN-044) — the SINGLE WRITER for book_requests (the request / Missing ledger).
// The goodreads-sync orchestrator hands it the live shelf items (each already matched against the library
// mirror + comic-classified) and it upserts one request per want: matched → landed; unroutable comic →
// parked Missing (Kapowarr's domain, never LL); routable-unmatched → minted 'requested' for the LL push.
// The SYNC-driven mint/reconcile is UNaudited (synced/derived). The USER-initiated manual "Search again"
// (recordManualSearch) DOES co-write a permission_audit row (request_book_search). The guard forbids any
// other module from touching book_requests.
import {
  GOODREADS_SHELVES,
  bookRequests,
  booksItems,
  integrationShelfItems,
  permissionAudit,
  userIntegrations,
  users,
  type BookRequestFormat,
  type BookRequestRow,
  type BookRequestStatus,
  type BooksMediaKind,
  type DbClient,
} from '@hnet/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { KapowarrSearchCandidate, KapowarrVolume } from '@hnet/kapowarr/read';
import { NotFoundError } from './errors';
import { inTransaction, resolveDb } from './db-client';

// ---------------------------------------------------------------------------
// LL status → per-format request status (the domain owns the mapping; the client returns raw strings).
// ---------------------------------------------------------------------------

/**
 * Map a raw LazyLibrarian per-format status to our request status. Open/Have ⇒ landed (we HAVE it);
 * Snatched ⇒ grabbed (downloading); Wanted ⇒ wanted (actively searching — the *arr "Missing/wanted");
 * Skipped/Ignored/Matched ⇒ missing (LL is not looking — the dead-end Missing that offers "Search again").
 * An unknown/absent status returns null (leave the current status unchanged).
 */
export function mapLlStatus(raw: string | null | undefined): BookRequestStatus | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (s === 'open' || s === 'have') return 'landed';
  if (s === 'snatched') return 'grabbed';
  if (s === 'wanted') return 'wanted';
  if (s === 'skipped' || s === 'ignored' || s === 'matched') return 'missing';
  return null;
}

const POSITIVE = new Set<BookRequestStatus>(['grabbed', 'landed']);

/** Advance a per-format status without regressing a positive (grabbed/landed) to a searching state. */
export function advanceStatus(
  current: BookRequestStatus,
  incoming: BookRequestStatus | null,
): BookRequestStatus {
  if (!incoming) return current;
  if (incoming === 'landed') return 'landed';
  if (POSITIVE.has(current) && !POSITIVE.has(incoming)) return current;
  return incoming;
}

// ---------------------------------------------------------------------------
// ADR-056 (PLAN-046) — Kapowarr comic routing: the ComicVine-volume resolver + the Kapowarr-state reconcile.
// The domain owns BOTH (the ACL returns raw candidates/volume-counts; the domain decides the pick + status —
// the mapLlStatus / loadLibraryMatcher precedent). Pure + unit-tested; the orchestrator drives the client.
// ---------------------------------------------------------------------------

const COMIC_STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'vol', 'volume', 'part', 'book', 'no', 'tpb', 'edition',
]);

/**
 * Tokenize a comic title into meaningful, order-free words (lowercase; punctuation, pure-numeric issue markers
 * and volume/edition stop words dropped). The whole title is kept — a Goodreads title's parenthetical often
 * carries the DISAMBIGUATOR (e.g. "Zero Year: Part 1 (DC Comics - … Batman #1)"), so stripping it would lose
 * the "batman"/"dc" tokens that separate DC's "Batman: Zero Year" from an unrelated "Year Zero".
 */
function comicTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 0 && !COMIC_STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

/**
 * Score + pick the best ComicVine volume for a shelf-item title from Kapowarr's own search candidates. The
 * shelf title is fuzzy (Goodreads editions, series/issue suffixes), so we rank by shared distinctive tokens:
 *   1. absolute token overlap (how many of the candidate's words the shelf title contains) — the primary key,
 *      so "Batman: Zero Year" (3 shared) beats a bare "Year Zero" (2 shared);
 *   2. overlap RATIO (share of the candidate's own words matched) — prefers the tight "Scott Pilgrim" over
 *      "Scott Pilgrim Color Collection";
 *   3. ORIGINAL edition — `translated === false` wins (Oni Press over a German Panini reprint);
 *   4. a known publish YEAR, then more issues, then the lower (older/canonical) ComicVine id — deterministic.
 * Returns null when even the best candidate shares no distinctive token (leave the comic parked, never a
 * fabricated add). Author is intentionally unused — Kapowarr search results don't carry it reliably.
 */
export function pickBestVolume(
  query: string,
  candidates: readonly KapowarrSearchCandidate[],
): KapowarrSearchCandidate | null {
  const queryTokens = new Set(comicTokens(query));
  if (queryTokens.size === 0) return null;

  let best: { c: KapowarrSearchCandidate; key: number[] } | null = null;
  for (const c of candidates) {
    const ct = comicTokens(c.title);
    if (ct.length === 0) continue;
    const overlap = ct.filter((t) => queryTokens.has(t)).length;
    if (overlap === 0) continue;
    const ratio = overlap / ct.length;
    // Descending sort key (higher wins): [overlap, ratio×1000, original, hasYear, issueCount, -cvId].
    const key = [
      overlap,
      Math.round(ratio * 1000),
      c.translated ? 0 : 1,
      c.year != null ? 1 : 0,
      c.issueCount ?? 0,
      -c.comicvineId,
    ];
    if (!best || compareDescKey(key, best.key) > 0) best = { c, key };
  }
  return best?.c ?? null;
}

/** Compare two descending sort keys element-wise (first non-equal element decides). */
function compareDescKey(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Map a Kapowarr volume's live counts to a comic request status. All issues on disk ⇒ landed; some issues in
 * ⇒ grabbed (downloading/partial); monitored-but-none ⇒ wanted (the *arr Missing analog, actively searching);
 * unmonitored-and-none ⇒ missing (Kapowarr is not looking — the dead-end that offers "Search again").
 */
export function mapKapowarrVolumeStatus(vol: Pick<KapowarrVolume, 'monitored' | 'issueCount' | 'issuesDownloaded'>): BookRequestStatus {
  if (vol.issueCount > 0 && vol.issuesDownloaded >= vol.issueCount) return 'landed';
  if (vol.issuesDownloaded > 0) return 'grabbed';
  if (vol.monitored) return 'wanted';
  return 'missing';
}

// ---------------------------------------------------------------------------
// Library matching (title/author against the books_items mirror). books_items has NO ISBN column, so the
// match is normalized-title (+ author) — an honest MVP limitation (an ISBN column on the mirror would let
// us do the exact ISBN match the plan named; a documented residual). Comics count for COVERAGE but the
// caller parks a comic OUT of the LazyLibrarian route.
// ---------------------------------------------------------------------------

export interface LibraryMatch {
  id: string;
  mediaKind: BooksMediaKind;
}

function normTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/^(the|a|an)\s+/, '')
    .split(/[:(]/)[0]!
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normAuthor(a: string | null): string {
  return (a ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export type LibraryMatcher = (title: string, author: string | null) => LibraryMatch | null;

/**
 * Load the live books_items into an in-memory normalized-title index and return a matcher. One bounded read
 * per sync (the whole book library, a few thousand rows) — far cheaper than a per-item query, and it lets
 * the normalizer live in JS. When several library rows share a normalized title, an author match wins; a
 * non-comic format is preferred so "we have the ebook" beats a same-title comic for the coverage signal.
 */
export async function loadLibraryMatcher(db?: DbClient): Promise<LibraryMatcher> {
  const rows = await resolveDb(db)
    .select({
      id: booksItems.id,
      title: booksItems.title,
      author: booksItems.author,
      mediaKind: booksItems.mediaKind,
    })
    .from(booksItems)
    .where(isNull(booksItems.deletedAt));

  const index = new Map<string, Array<{ id: string; author: string; mediaKind: BooksMediaKind }>>();
  for (const r of rows) {
    const key = normTitle(r.title);
    if (!key) continue;
    const bucket = index.get(key) ?? [];
    bucket.push({ id: r.id, author: normAuthor(r.author), mediaKind: r.mediaKind });
    index.set(key, bucket);
  }

  return (title, author) => {
    const bucket = index.get(normTitle(title));
    if (!bucket || bucket.length === 0) return null;
    const wantAuthor = normAuthor(author);
    const authorMatches = wantAuthor
      ? bucket.filter((b) => b.author && (b.author.includes(wantAuthor) || wantAuthor.includes(b.author)))
      : [];
    const pool = authorMatches.length > 0 ? authorMatches : bucket;
    const nonComic = pool.find((b) => b.mediaKind !== 'comic');
    const pick = nonComic ?? pool[0]!;
    return { id: pick.id, mediaKind: pick.mediaKind };
  };
}

// ---------------------------------------------------------------------------
// Request minting / reconcile.
// ---------------------------------------------------------------------------

/** One live shelf item + the orchestrator's per-item classification, handed to the request writer. */
export interface RequestSyncItem {
  shelfItemId: string;
  title: string;
  author: string | null;
  /** The GB volume id (the LL bookid) when enrichment resolved one. */
  gbVolumeId: string | null;
  /** The library match (books_items id), when the want is already in the library. */
  matchedBooksItemId: string | null;
  /** True when GB (or the matched library kind) classifies this as a comic — do NOT route to LL. */
  isComic: boolean;
}

export interface SyncShelfRequestsInput {
  db?: DbClient;
  integrationId: string;
  items: RequestSyncItem[];
  now?: Date;
}

/** A request that should be pushed to / reconciled against LazyLibrarian (llBookId = the GB volume id). */
export interface RequestLlTarget {
  requestId: string;
  llBookId: string;
}

/**
 * ADR-056 (PLAN-046) — a comic request the orchestrator should route to / reconcile against Kapowarr.
 * `kapowarrVolumeId` null ⇒ resolve+add (search ComicVine, pick, add monitored); set ⇒ reconcile its state.
 */
export interface ComicRouteTarget {
  requestId: string;
  title: string;
  author: string | null;
  kapowarrVolumeId: string | null;
}

export interface SyncShelfRequestsResult {
  minted: number;
  /** Routable, unmatched, freshly-`requested` requests with a GB id — push both formats to LL, paced. */
  toPush: RequestLlTarget[];
  /** Already-pushed requests (llBookId set, not both landed) — reconcile against LL this run. */
  toReconcile: RequestLlTarget[];
  /** Comic requests not (yet) landed — resolve+add or reconcile against Kapowarr (ADR-056). */
  toRouteComics: ComicRouteTarget[];
}

/**
 * Upsert one book_requests row per live shelf item and classify each: matched ⇒ landed (we have it);
 * unroutable comic ⇒ parked Missing (never LL); routable-unmatched ⇒ 'requested' with the GB id as
 * ll_book_id. Never regresses a positive status. Returns the LL push + reconcile worklists for the
 * orchestrator to drive AFTER commit (external calls stay out of the transaction — the fix-flow discipline).
 */
export async function syncShelfRequests(
  input: SyncShelfRequestsInput,
): Promise<SyncShelfRequestsResult> {
  const now = input.now ?? new Date();
  const toPush: RequestLlTarget[] = [];
  const toReconcile: RequestLlTarget[] = [];
  const toRouteComics: ComicRouteTarget[] = [];
  let minted = 0;

  await inTransaction(input.db, async (tx) => {
    for (const item of input.items) {
      const [existing] = await tx
        .select()
        .from(bookRequests)
        .where(eq(bookRequests.shelfItemId, item.shelfItemId))
        .for('update');

      let ebookStatus: BookRequestStatus;
      let audioStatus: BookRequestStatus;
      let comicStatus: BookRequestStatus | null;
      let unroutableReason: string | null;
      let llBookId: string | null;
      // The Kapowarr volume id is preserved across syncs (set by markComicRouted); comic_status routing owns
      // comicvine_id, so it is not (re)written here on the mint/upsert.
      const kapowarrVolumeId = existing?.kapowarrVolumeId ?? null;

      if (item.matchedBooksItemId) {
        // In the library — we HAVE it (a book or a comic we already hold).
        ebookStatus = 'landed';
        audioStatus = 'landed';
        comicStatus = item.isComic ? 'landed' : (existing?.comicStatus ?? null);
        unroutableReason = null;
        llBookId = existing?.llBookId ?? item.gbVolumeId ?? null;
      } else if (item.isComic) {
        // ADR-056 — a comic want (Kapowarr's domain, never LL). comic_status is the actionable state; ebook/
        // audio are N/A (kept 'missing'). Parked (unroutable) until Kapowarr routes it (kapowarr_volume_id set).
        ebookStatus = 'missing';
        audioStatus = 'missing';
        comicStatus = existing?.comicStatus ?? 'requested';
        unroutableReason = kapowarrVolumeId ? null : 'comic';
        llBookId = null;
      } else {
        // A routable book/audiobook want.
        ebookStatus = existing?.ebookStatus ?? 'requested';
        audioStatus = existing?.audioStatus ?? 'requested';
        comicStatus = null;
        unroutableReason = null;
        llBookId = existing?.llBookId ?? item.gbVolumeId ?? null;
      }

      let requestId: string;
      if (existing) {
        await tx
          .update(bookRequests)
          .set({
            title: item.title,
            author: item.author,
            matchedBooksItemId: item.matchedBooksItemId,
            unroutableReason,
            llBookId,
            ebookStatus,
            audioStatus,
            comicStatus,
            updatedAt: now,
          })
          .where(eq(bookRequests.id, existing.id));
        requestId = existing.id;
        collectTargets(existing.id, llBookId, ebookStatus, audioStatus, unroutableReason, existing.ebookStatus, existing.audioStatus, toPush, toReconcile);
      } else {
        const [row] = await tx
          .insert(bookRequests)
          .values({
            integrationId: input.integrationId,
            shelfItemId: item.shelfItemId,
            matchedBooksItemId: item.matchedBooksItemId,
            unroutableReason,
            llBookId,
            title: item.title,
            author: item.author,
            ebookStatus,
            audioStatus,
            comicStatus,
          })
          .returning({ id: bookRequests.id });
        minted += 1;
        requestId = row?.id ?? '';
        if (row) {
          collectTargets(row.id, llBookId, ebookStatus, audioStatus, unroutableReason, 'requested', 'requested', toPush, toReconcile);
        }
      }

      // A comic that is not (yet) landed needs Kapowarr work: resolve+add (no volume id) or reconcile.
      if (requestId && item.isComic && !item.matchedBooksItemId && comicStatus !== 'landed') {
        toRouteComics.push({ requestId, title: item.title, author: item.author, kapowarrVolumeId });
      }
    }
  });

  return { minted, toPush, toReconcile, toRouteComics };
}

function collectTargets(
  requestId: string,
  llBookId: string | null,
  ebookStatus: BookRequestStatus,
  audioStatus: BookRequestStatus,
  unroutableReason: string | null,
  prevEbook: BookRequestStatus,
  prevAudio: BookRequestStatus,
  toPush: RequestLlTarget[],
  toReconcile: RequestLlTarget[],
): void {
  if (unroutableReason) return; // comics never touch LL
  if (!llBookId) return; // no GB id resolved — can't push yet (honest gap)
  const bothLanded = ebookStatus === 'landed' && audioStatus === 'landed';
  if (bothLanded) return;
  const neverPushed = prevEbook === 'requested' && prevAudio === 'requested';
  if (neverPushed && (ebookStatus === 'requested' || audioStatus === 'requested')) {
    toPush.push({ requestId, llBookId });
  } else {
    toReconcile.push({ requestId, llBookId });
  }
}

/** Mark a request pushed to LL: both formats → wanted (from requested), llBookId set, reconcile stamp. */
export async function markRequestPushed(input: {
  db?: DbClient;
  requestId: string;
  llBookId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await resolveDb(input.db)
    .update(bookRequests)
    .set({
      llBookId: input.llBookId,
      ebookStatus: sql`CASE WHEN ${bookRequests.ebookStatus} = 'requested' THEN 'wanted' ELSE ${bookRequests.ebookStatus} END`,
      audioStatus: sql`CASE WHEN ${bookRequests.audioStatus} = 'requested' THEN 'wanted' ELSE ${bookRequests.audioStatus} END`,
      lastReconciledAt: now,
      updatedAt: now,
    })
    .where(eq(bookRequests.id, input.requestId));
}

/** Apply an LL reconcile: advance each format's status (never regressing a positive). */
export async function applyRequestReconcile(input: {
  db?: DbClient;
  requestId: string;
  ebookStatus: BookRequestStatus | null;
  audioStatus: BookRequestStatus | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await inTransaction(input.db, async (tx) => {
    const [req] = await tx
      .select({ id: bookRequests.id, ebookStatus: bookRequests.ebookStatus, audioStatus: bookRequests.audioStatus })
      .from(bookRequests)
      .where(eq(bookRequests.id, input.requestId))
      .for('update');
    if (!req) return;
    await tx
      .update(bookRequests)
      .set({
        ebookStatus: advanceStatus(req.ebookStatus, input.ebookStatus),
        audioStatus: advanceStatus(req.audioStatus, input.audioStatus),
        lastReconciledAt: now,
        updatedAt: now,
      })
      .where(eq(bookRequests.id, req.id));
  });
}

/**
 * Mark formats RE-QUEUED into LL (the Skipped-want sweep, DESIGN-028 amendment 2026-07-15): each named
 * format advances to 'wanted' — LL is now looking again — without regressing a positive (grabbed/landed).
 * Unaudited (synced/derived — the markRequestPushed class).
 */
export async function markRequestFormatsRequeued(input: {
  db?: DbClient;
  requestId: string;
  formats: ReadonlyArray<'ebook' | 'audiobook'>;
  now?: Date;
}): Promise<void> {
  if (input.formats.length === 0) return;
  const now = input.now ?? new Date();
  await inTransaction(input.db, async (tx) => {
    const [req] = await tx
      .select({ id: bookRequests.id, ebookStatus: bookRequests.ebookStatus, audioStatus: bookRequests.audioStatus })
      .from(bookRequests)
      .where(eq(bookRequests.id, input.requestId))
      .for('update');
    if (!req) return;
    await tx
      .update(bookRequests)
      .set({
        ebookStatus: input.formats.includes('ebook') ? advanceStatus(req.ebookStatus, 'wanted') : req.ebookStatus,
        audioStatus: input.formats.includes('audiobook') ? advanceStatus(req.audioStatus, 'wanted') : req.audioStatus,
        lastSearchedAt: now,
        lastReconciledAt: now,
        updatedAt: now,
      })
      .where(eq(bookRequests.id, req.id));
  });
}

// ---------------------------------------------------------------------------
// ADR-056 (PLAN-046) — comic request writers (the LL markRequestPushed / applyRequestReconcile analogs).
// ---------------------------------------------------------------------------

/**
 * Mark a comic request ROUTED to Kapowarr: record the added volume id + ComicVine id, set comic_status
 * (default 'wanted' — monitored+searching), and CLEAR unroutable_reason (it is no longer parked). ebook/audio
 * stay whatever they were ('missing' for a comic). Unaudited (synced/derived — the markRequestPushed class).
 */
export async function markComicRouted(input: {
  db?: DbClient;
  requestId: string;
  kapowarrVolumeId: string;
  comicvineId: string | null;
  comicStatus?: BookRequestStatus;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await resolveDb(input.db)
    .update(bookRequests)
    .set({
      kapowarrVolumeId: input.kapowarrVolumeId,
      comicvineId: input.comicvineId,
      comicStatus: input.comicStatus ?? 'wanted',
      unroutableReason: null,
      lastReconciledAt: now,
      updatedAt: now,
    })
    .where(eq(bookRequests.id, input.requestId));
}

/** Apply a Kapowarr reconcile: advance comic_status (never regressing a positive). */
export async function applyComicReconcile(input: {
  db?: DbClient;
  requestId: string;
  comicStatus: BookRequestStatus | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  await inTransaction(input.db, async (tx) => {
    const [req] = await tx
      .select({ id: bookRequests.id, comicStatus: bookRequests.comicStatus })
      .from(bookRequests)
      .where(eq(bookRequests.id, input.requestId))
      .for('update');
    if (!req) return;
    await tx
      .update(bookRequests)
      .set({
        comicStatus: advanceStatus(req.comicStatus ?? 'requested', input.comicStatus),
        lastReconciledAt: now,
        updatedAt: now,
      })
      .where(eq(bookRequests.id, req.id));
  });
}

// ---------------------------------------------------------------------------
// Manual "Search again" — the USER-initiated, AUDITED write (R3 / AC-04).
// ---------------------------------------------------------------------------

export interface RecordManualSearchInput {
  db?: DbClient;
  requestId: string;
  /** The acting user (the request's owner; the API re-checks ownership before calling). */
  userId: string;
  actorId: string | null;
}

export interface RecordManualSearchResult {
  request: BookRequestRow;
}

/**
 * Record a manual re-search: stamp last_searched_at and co-write a `request_book_search` permission_audit
 * row in ONE transaction (CLAUDE.md hard rule 6). The actual LL searchBook fires AFTER this commits (the
 * confined write stays in the orchestrator — search-requests.ts precedent). Returns the request so the
 * orchestrator knows the ll_book_id + whether it is routable.
 */
export async function recordManualSearch(
  input: RecordManualSearchInput,
): Promise<RecordManualSearchResult> {
  return inTransaction(input.db, async (tx) => {
    const [req] = await tx
      .select()
      .from(bookRequests)
      .where(eq(bookRequests.id, input.requestId))
      .for('update');
    if (!req) throw new NotFoundError(`Book request ${input.requestId} not found`);

    const now = new Date();
    await tx
      .update(bookRequests)
      .set({ lastSearchedAt: now, updatedAt: now })
      .where(eq(bookRequests.id, req.id));

    await tx.insert(permissionAudit).values({
      actorId: input.actorId,
      action: 'request_book_search',
      subjectUserId: input.userId,
      detail: {
        request_id: req.id,
        ll_book_id: req.llBookId,
        kapowarr_volume_id: req.kapowarrVolumeId,
        comic: req.comicStatus != null,
        title: req.title,
        unroutable_reason: req.unroutableReason,
      },
    });

    return { request: { ...req, lastSearchedAt: now } };
  });
}

// ---------------------------------------------------------------------------
// Reads — the wall + coverage.
// ---------------------------------------------------------------------------

/** A request row joined with its live shelf item, for the requests/Missing wall. */
export interface BookRequestView {
  id: string;
  shelfItemId: string;
  shelf: string;
  externalBookId: string;
  title: string;
  author: string | null;
  coverUrl: string | null;
  matchedBooksItemId: string | null;
  llBookId: string | null;
  ebookStatus: BookRequestStatus;
  audioStatus: BookRequestStatus;
  /** ADR-056 — the comic lifecycle status; null ⇒ this request is a book/audiobook (not a comic). */
  comicStatus: BookRequestStatus | null;
  /** ADR-056 — the added Kapowarr volume id (the comic force-search + reconcile key); null until routed. */
  kapowarrVolumeId: string | null;
  unroutableReason: string | null;
  lastSearchedAt: Date | null;
  createdAt: Date;
}

/** Read the requests for an integration (live shelf items only), newest-shelved first. */
export async function getBookRequestsForIntegration(input: {
  db?: DbClient;
  integrationId: string;
}): Promise<BookRequestView[]> {
  const rows = await resolveDb(input.db)
    .select({
      id: bookRequests.id,
      shelfItemId: bookRequests.shelfItemId,
      shelf: integrationShelfItems.shelf,
      externalBookId: integrationShelfItems.externalBookId,
      title: bookRequests.title,
      author: bookRequests.author,
      coverUrl: integrationShelfItems.coverUrl,
      matchedBooksItemId: bookRequests.matchedBooksItemId,
      llBookId: bookRequests.llBookId,
      ebookStatus: bookRequests.ebookStatus,
      audioStatus: bookRequests.audioStatus,
      comicStatus: bookRequests.comicStatus,
      kapowarrVolumeId: bookRequests.kapowarrVolumeId,
      unroutableReason: bookRequests.unroutableReason,
      lastSearchedAt: bookRequests.lastSearchedAt,
      createdAt: bookRequests.createdAt,
      shelvedAt: integrationShelfItems.shelvedAt,
    })
    .from(bookRequests)
    .innerJoin(integrationShelfItems, eq(bookRequests.shelfItemId, integrationShelfItems.id))
    .where(
      and(
        eq(bookRequests.integrationId, input.integrationId),
        isNull(integrationShelfItems.deletedAt),
      ),
    );
  rows.sort((a, b) => (b.shelvedAt?.getTime() ?? 0) - (a.shelvedAt?.getTime() ?? 0));
  return rows.map(({ shelvedAt: _shelvedAt, ...rest }) => rest);
}

export interface Coverage {
  total: number;
  covered: number;
  pct: number;
}

/**
 * Coverage = "we have N% of your shelf". A live shelf want is COVERED when it matches a library book
 * (matched_books_item_id set) OR either format has landed. Comics count toward coverage (they can be in the
 * library) even though they never route to LL. pct is rounded; 0 wants ⇒ 0%.
 */
export async function computeCoverage(input: {
  db?: DbClient;
  integrationId: string;
}): Promise<Coverage> {
  const [row] = await resolveDb(input.db)
    .select({
      total: sql<number>`count(*)::int`,
      covered: sql<number>`count(*) FILTER (WHERE ${bookRequests.matchedBooksItemId} IS NOT NULL OR ${bookRequests.ebookStatus} = 'landed' OR ${bookRequests.audioStatus} = 'landed' OR ${bookRequests.comicStatus} = 'landed')::int`,
    })
    .from(bookRequests)
    .innerJoin(integrationShelfItems, eq(bookRequests.shelfItemId, integrationShelfItems.id))
    .where(
      and(
        eq(bookRequests.integrationId, input.integrationId),
        isNull(integrationShelfItems.deletedAt),
      ),
    );
  const total = row?.total ?? 0;
  const covered = row?.covered ?? 0;
  const pct = total > 0 ? Math.round((covered / total) * 100) : 0;
  return { total, covered, pct };
}

/** Read a request by id (the API authorizes a manual search against its integration's owner). */
export async function getBookRequestById(input: {
  db?: DbClient;
  id: string;
}): Promise<BookRequestRow | null> {
  const [row] = await resolveDb(input.db)
    .select()
    .from(bookRequests)
    .where(eq(bookRequests.id, input.id));
  return row ?? null;
}

/**
 * ADR-057 amendment (PLAN-047 — the Wanted DETAIL page) — one request resolved for the
 * `/library/books/wanted/[requestId]` parity page: joined with its live shelf item (source shelf,
 * externalBookId), its integration OWNER (the `canSearch` ownership key), its library match's cover keys
 * (the cover-proxy art when the want is in the library), plus the HOUSEHOLD requester roll-up — everyone
 * whose LINKED shelf wants the same Goodreads book (the attribution that was pulled off the card face,
 * DESIGN-029 amendment-2). Null when the id is unknown or its shelf item is gone (⇒ NOT_FOUND).
 */
export interface BookRequestDetailView {
  requestId: string;
  /** The app user whose integration minted the request (the ownership key for canSearch). */
  integrationUserId: string;
  /** Display names of everyone whose shelves want this book (deduped, the request's own owner first). */
  requestedBy: string[];
  title: string;
  author: string | null;
  /** The source shelf this request was minted from (the detail's shelf attribution). */
  shelf: string;
  shelvedAt: Date | null;
  externalBookId: string;
  matchedBooksItemId: string | null;
  /** The matched library row's cover keys (the cover-proxy art), when the want is in the library. */
  matched: { source: string; externalId: string; coverRef: string | null } | null;
  ebookStatus: BookRequestStatus;
  audioStatus: BookRequestStatus;
  comicStatus: BookRequestStatus | null;
  isComic: boolean;
  unroutableReason: string | null;
  llBookId: string | null;
  kapowarrVolumeId: string | null;
  lastSearchedAt: Date | null;
}

export async function getBookRequestDetail(input: {
  db?: DbClient;
  requestId: string;
}): Promise<BookRequestDetailView | null> {
  const db = resolveDb(input.db);
  const [row] = await db
    .select({
      requestId: bookRequests.id,
      integrationUserId: userIntegrations.userId,
      requesterName: users.displayName,
      title: bookRequests.title,
      author: bookRequests.author,
      shelf: integrationShelfItems.shelf,
      shelvedAt: integrationShelfItems.shelvedAt,
      externalBookId: integrationShelfItems.externalBookId,
      matchedBooksItemId: bookRequests.matchedBooksItemId,
      ebookStatus: bookRequests.ebookStatus,
      audioStatus: bookRequests.audioStatus,
      comicStatus: bookRequests.comicStatus,
      unroutableReason: bookRequests.unroutableReason,
      llBookId: bookRequests.llBookId,
      kapowarrVolumeId: bookRequests.kapowarrVolumeId,
      lastSearchedAt: bookRequests.lastSearchedAt,
      matchedSource: booksItems.source,
      matchedExternalId: booksItems.externalId,
      matchedCoverRef: booksItems.coverRef,
    })
    .from(bookRequests)
    .innerJoin(integrationShelfItems, eq(bookRequests.shelfItemId, integrationShelfItems.id))
    .innerJoin(userIntegrations, eq(bookRequests.integrationId, userIntegrations.id))
    .innerJoin(users, eq(userIntegrations.userId, users.id))
    .leftJoin(booksItems, eq(booksItems.id, bookRequests.matchedBooksItemId))
    .where(and(eq(bookRequests.id, input.requestId), isNull(integrationShelfItems.deletedAt)));
  if (!row) return null;

  // Household roll-up: everyone whose LINKED integration wants the same Goodreads book (deduped names).
  const requesterRows = await db
    .select({ name: users.displayName })
    .from(bookRequests)
    .innerJoin(integrationShelfItems, eq(bookRequests.shelfItemId, integrationShelfItems.id))
    .innerJoin(userIntegrations, eq(bookRequests.integrationId, userIntegrations.id))
    .innerJoin(users, eq(userIntegrations.userId, users.id))
    .where(
      and(
        eq(integrationShelfItems.externalBookId, row.externalBookId),
        eq(userIntegrations.status, 'linked'),
        isNull(integrationShelfItems.deletedAt),
      ),
    );
  const requestedBy: string[] = [];
  for (const name of [row.requesterName, ...requesterRows.map((r) => r.name)]) {
    if (!requestedBy.includes(name)) requestedBy.push(name);
  }

  return {
    requestId: row.requestId,
    integrationUserId: row.integrationUserId,
    requestedBy,
    title: row.title,
    author: row.author,
    shelf: row.shelf,
    shelvedAt: row.shelvedAt,
    externalBookId: row.externalBookId,
    matchedBooksItemId: row.matchedBooksItemId,
    matched:
      row.matchedSource && row.matchedExternalId
        ? { source: row.matchedSource, externalId: row.matchedExternalId, coverRef: row.matchedCoverRef }
        : null,
    ebookStatus: row.ebookStatus,
    audioStatus: row.audioStatus,
    comicStatus: row.comicStatus,
    isComic: row.comicStatus != null,
    unroutableReason: row.unroutableReason,
    llBookId: row.llBookId,
    kapowarrVolumeId: row.kapowarrVolumeId,
    lastSearchedAt: row.lastSearchedAt,
  };
}

/**
 * The LazyLibrarian formats a BOOK request should search on demand (both, unless one has already landed).
 * Narrowed to the two LL formats — 'comic' (ADR-056) is a Kapowarr format, never an LL searchBook target.
 */
export function searchableFormats(request: {
  ebookStatus: BookRequestStatus;
  audioStatus: BookRequestStatus;
}): Array<Extract<BookRequestFormat, 'ebook' | 'audiobook'>> {
  const formats: Array<Extract<BookRequestFormat, 'ebook' | 'audiobook'>> = [];
  if (request.ebookStatus !== 'landed') formats.push('ebook');
  if (request.audioStatus !== 'landed') formats.push('audiobook');
  return formats;
}

/**
 * ADR-056/ADR-057 — is a request FORCE-SEARCHABLE (the `integrations.search` dispatch has a real target)?
 * A COMIC is searchable once routed to Kapowarr (has a volume id) and not yet fully landed; a BOOK is
 * searchable once pushed to LL (has a GB/LL id) and not both-format-landed. A PARKED comic (no volume id
 * yet — Kapowarr unreachable / no ComicVine match) is not force-searchable. One definition shared by the
 * Integrations sub-section wall AND the Library composed-Wanted tiles (PLAN-045).
 */
export function isRequestSearchable(request: {
  ebookStatus: BookRequestStatus;
  audioStatus: BookRequestStatus;
  comicStatus: BookRequestStatus | null;
  kapowarrVolumeId: string | null;
  llBookId: string | null;
  unroutableReason: string | null;
}): boolean {
  if (request.comicStatus != null) {
    return request.kapowarrVolumeId != null && request.comicStatus !== 'landed';
  }
  if (request.unroutableReason) return false;
  if (!request.llBookId) return false;
  return request.ebookStatus !== 'landed' || request.audioStatus !== 'landed';
}

// ---------------------------------------------------------------------------
// ADR-057 (PLAN-045) — the composed read-models: per-shelf stats, the Goodreads items wall, and the
// household Library-Wanted overlay. All READS over the request ledger + the live shelf mirror — the
// books_items mirror stays pure (ADR-046); Wanted is a composition, never a mirror row.
// ---------------------------------------------------------------------------

/** The coarse phase a request is in — drives the corner-puck badge + the stats summary tiles. */
export type BookRequestPhase = 'have' | 'searching' | 'missing' | 'parked';

/**
 * Collapse a request's per-format statuses into the wall phase. Priority: a library match or any landed
 * format ⇒ 'have'; a parked comic ⇒ 'parked'; any format still actively looking (requested/wanted/grabbed)
 * ⇒ 'searching'; only when EVERY live format dead-ended ⇒ 'missing' (the state that offers Search again).
 */
export function requestPhase(request: {
  matchedBooksItemId: string | null;
  ebookStatus: BookRequestStatus;
  audioStatus: BookRequestStatus;
  comicStatus: BookRequestStatus | null;
  unroutableReason: string | null;
}): BookRequestPhase {
  if (request.matchedBooksItemId) return 'have';
  if (request.comicStatus != null) {
    if (request.comicStatus === 'landed') return 'have';
    if (request.unroutableReason === 'comic') return 'parked';
    return request.comicStatus === 'missing' ? 'missing' : 'searching';
  }
  if (request.ebookStatus === 'landed' || request.audioStatus === 'landed') return 'have';
  const active = (s: BookRequestStatus) => s === 'requested' || s === 'wanted' || s === 'grabbed';
  if (active(request.ebookStatus) || active(request.audioStatus)) return 'searching';
  return 'missing';
}

export interface ShelfCoverageRow {
  shelf: string;
  total: number;
  covered: number;
  pct: number;
}

export interface RequestPhaseSummary {
  have: number;
  searching: number;
  missing: number;
  parked: number;
}

export interface ShelfStats {
  /** Per-shelf coverage, in GOODREADS_SHELVES canonical order (unknown shelves after, A–Z). */
  shelves: ShelfCoverageRow[];
  /** Requests bucketed by phase (one bucket per request — the stats summary tiles). */
  phases: RequestPhaseSummary;
}

const shelfOrder = (shelf: string): number => {
  const i = (GOODREADS_SHELVES as readonly string[]).indexOf(shelf);
  return i === -1 ? GOODREADS_SHELVES.length : i;
};

/**
 * Per-shelf coverage + the request phase rollup for one integration (the Goodreads stats page — Q-02:
 * the headline stays the want shelf; this read supplies the per-shelf breakdown under it). Coverage uses
 * the computeCoverage predicate per shelf; a book shelved on several shelves counts in EACH shelf's row
 * (per-shelf coverage is per-shelf honest), while the phase rollup counts each REQUEST once.
 */
export async function computeShelfStats(input: {
  db?: DbClient;
  integrationId: string;
}): Promise<ShelfStats> {
  const rows = await resolveDb(input.db)
    .select({
      shelf: integrationShelfItems.shelf,
      matchedBooksItemId: bookRequests.matchedBooksItemId,
      ebookStatus: bookRequests.ebookStatus,
      audioStatus: bookRequests.audioStatus,
      comicStatus: bookRequests.comicStatus,
      unroutableReason: bookRequests.unroutableReason,
    })
    .from(bookRequests)
    .innerJoin(integrationShelfItems, eq(bookRequests.shelfItemId, integrationShelfItems.id))
    .where(
      and(
        eq(bookRequests.integrationId, input.integrationId),
        isNull(integrationShelfItems.deletedAt),
      ),
    );

  const perShelf = new Map<string, { total: number; covered: number }>();
  const phases: RequestPhaseSummary = { have: 0, searching: 0, missing: 0, parked: 0 };
  for (const row of rows) {
    const bucket = perShelf.get(row.shelf) ?? { total: 0, covered: 0 };
    bucket.total += 1;
    const phase = requestPhase(row);
    if (phase === 'have') bucket.covered += 1;
    perShelf.set(row.shelf, bucket);
    phases[phase] += 1;
  }

  const shelves = [...perShelf.entries()]
    .sort((a, b) => shelfOrder(a[0]) - shelfOrder(b[0]) || a[0].localeCompare(b[0]))
    .map(([shelf, c]) => ({
      shelf,
      total: c.total,
      covered: c.covered,
      pct: c.total > 0 ? Math.round((c.covered / c.total) * 100) : 0,
    }));
  return { shelves, phases };
}

/** One tile of the Goodreads ITEMS wall — a distinct shelf BOOK (shelf memberships aggregated). */
export interface ShelfWallItem {
  /** The Goodreads book id — the stable per-book key (the dedupe/grouping key across shelves). */
  externalBookId: string;
  title: string;
  author: string | null;
  /** Every live shelf the book sits on, in GOODREADS_SHELVES canonical order (the chip filter target). */
  shelves: string[];
  /** The newest shelved-at across its shelves (the wall's default sort key). */
  shelvedAt: Date | null;
  /** The canonical request (shelf-priority pick when the book sits on several shelves). */
  requestId: string | null;
  /** The matched books_items row id — the "Have it" card's click-through to `/library/books/[id]`. */
  matchedBooksItemId: string | null;
  /** The matched books_items row's cover keys, when the want is in the library (the cover-proxy art). */
  matched: { source: string; externalId: string; coverRef: string | null } | null;
  ebookStatus: BookRequestStatus | null;
  audioStatus: BookRequestStatus | null;
  comicStatus: BookRequestStatus | null;
  unroutableReason: string | null;
  llBookId: string | null;
  kapowarrVolumeId: string | null;
  lastSearchedAt: Date | null;
}

/**
 * The Goodreads items wall read (PLAN-045): every live shelf item of an integration joined with its
 * request + its library match, GROUPED per distinct book (a book on several shelves renders ONE tile
 * wearing all its shelf memberships; the canonical request follows GOODREADS_SHELVES priority).
 * Newest-shelved first.
 */
export async function getShelfWallItems(input: {
  db?: DbClient;
  integrationId: string;
}): Promise<ShelfWallItem[]> {
  const rows = await resolveDb(input.db)
    .select({
      shelf: integrationShelfItems.shelf,
      externalBookId: integrationShelfItems.externalBookId,
      itemTitle: integrationShelfItems.title,
      itemAuthor: integrationShelfItems.author,
      shelvedAt: integrationShelfItems.shelvedAt,
      requestId: bookRequests.id,
      matchedBooksItemId: bookRequests.matchedBooksItemId,
      ebookStatus: bookRequests.ebookStatus,
      audioStatus: bookRequests.audioStatus,
      comicStatus: bookRequests.comicStatus,
      unroutableReason: bookRequests.unroutableReason,
      llBookId: bookRequests.llBookId,
      kapowarrVolumeId: bookRequests.kapowarrVolumeId,
      lastSearchedAt: bookRequests.lastSearchedAt,
      matchedSource: booksItems.source,
      matchedExternalId: booksItems.externalId,
      matchedCoverRef: booksItems.coverRef,
    })
    .from(integrationShelfItems)
    .leftJoin(bookRequests, eq(bookRequests.shelfItemId, integrationShelfItems.id))
    .leftJoin(booksItems, eq(booksItems.id, bookRequests.matchedBooksItemId))
    .where(
      and(
        eq(integrationShelfItems.integrationId, input.integrationId),
        isNull(integrationShelfItems.deletedAt),
      ),
    );

  const byBook = new Map<string, { canonicalRank: number; item: ShelfWallItem }>();
  for (const row of rows) {
    const rank = shelfOrder(row.shelf);
    const existing = byBook.get(row.externalBookId);
    if (!existing) {
      byBook.set(row.externalBookId, {
        canonicalRank: rank,
        item: {
          externalBookId: row.externalBookId,
          title: row.itemTitle,
          author: row.itemAuthor,
          shelves: [row.shelf],
          shelvedAt: row.shelvedAt,
          requestId: row.requestId,
          matchedBooksItemId: row.matchedBooksItemId,
          matched:
            row.matchedSource && row.matchedExternalId
              ? { source: row.matchedSource, externalId: row.matchedExternalId, coverRef: row.matchedCoverRef }
              : null,
          ebookStatus: row.ebookStatus,
          audioStatus: row.audioStatus,
          comicStatus: row.comicStatus,
          unroutableReason: row.unroutableReason,
          llBookId: row.llBookId,
          kapowarrVolumeId: row.kapowarrVolumeId,
          lastSearchedAt: row.lastSearchedAt,
        },
      });
      continue;
    }
    if (!existing.item.shelves.includes(row.shelf)) existing.item.shelves.push(row.shelf);
    if ((row.shelvedAt?.getTime() ?? 0) > (existing.item.shelvedAt?.getTime() ?? 0)) {
      existing.item.shelvedAt = row.shelvedAt;
    }
    if (rank < existing.canonicalRank && row.requestId) {
      // A higher-priority shelf carries the canonical request/status for the tile.
      existing.canonicalRank = rank;
      existing.item.requestId = row.requestId;
      existing.item.matchedBooksItemId = row.matchedBooksItemId;
      existing.item.matched =
        row.matchedSource && row.matchedExternalId
          ? { source: row.matchedSource, externalId: row.matchedExternalId, coverRef: row.matchedCoverRef }
          : null;
      existing.item.ebookStatus = row.ebookStatus;
      existing.item.audioStatus = row.audioStatus;
      existing.item.comicStatus = row.comicStatus;
      existing.item.unroutableReason = row.unroutableReason;
      existing.item.llBookId = row.llBookId;
      existing.item.kapowarrVolumeId = row.kapowarrVolumeId;
      existing.item.lastSearchedAt = row.lastSearchedAt;
    }
  }

  const items = [...byBook.values()].map((v) => {
    v.item.shelves.sort((a, b) => shelfOrder(a) - shelfOrder(b) || a.localeCompare(b));
    return v.item;
  });
  items.sort((a, b) => (b.shelvedAt?.getTime() ?? 0) - (a.shelvedAt?.getTime() ?? 0));
  return items;
}

/** A Library-Wanted tile source row (the household composed-Wanted overlay, PLAN-045 / ADR-057). */
export interface WantedBookRequestView {
  requestId: string;
  /** The app user whose integration minted the request (the ownership key for canSearch). */
  integrationUserId: string;
  /** Display names of everyone whose shelves want this book (deduped tile — household view). */
  requestedBy: string[];
  title: string;
  author: string | null;
  /** The canonical source shelf (GOODREADS_SHELVES priority) — the tile's shelf badge. */
  shelf: string;
  shelvedAt: Date | null;
  /** The wall format's own status (ebook_status / audio_status / comic_status per requested format). */
  status: BookRequestStatus;
  isComic: boolean;
  unroutableReason: string | null;
  ebookStatus: BookRequestStatus;
  audioStatus: BookRequestStatus;
  comicStatus: BookRequestStatus | null;
  llBookId: string | null;
  kapowarrVolumeId: string | null;
  externalBookId: string;
}

/**
 * The HOUSEHOLD Wanted overlay for one Library book wall (PLAN-045 step 4 — composed from the request
 * ledger; books_items untouched, ADR-046). Format decides the wall: 'ebook' ⇒ Books, 'audiobook' ⇒
 * Audiobooks, 'comic' ⇒ Comics. A request is WANTED on a wall while that format hasn't landed and the
 * want isn't already matched into the library. Reads across ALL linked integrations (household
 * visibility — the books-section gate is the caller's, Q-01), deduped per distinct book (same Goodreads
 * id wanted by several users ⇒ one tile listing every requester; the canonical request follows
 * GOODREADS_SHELVES priority, then age). Newest-shelved first.
 */
export async function getWantedBookRequests(input: {
  db?: DbClient;
  format: BookRequestFormat;
}): Promise<WantedBookRequestView[]> {
  const formatPredicate =
    input.format === 'comic'
      ? sql`${bookRequests.comicStatus} IS NOT NULL AND ${bookRequests.comicStatus} <> 'landed'`
      : input.format === 'audiobook'
        ? sql`${bookRequests.comicStatus} IS NULL AND ${bookRequests.audioStatus} <> 'landed'`
        : sql`${bookRequests.comicStatus} IS NULL AND ${bookRequests.ebookStatus} <> 'landed'`;

  const rows = await resolveDb(input.db)
    .select({
      requestId: bookRequests.id,
      integrationUserId: userIntegrations.userId,
      requesterName: users.displayName,
      title: bookRequests.title,
      author: bookRequests.author,
      shelf: integrationShelfItems.shelf,
      shelvedAt: integrationShelfItems.shelvedAt,
      externalBookId: integrationShelfItems.externalBookId,
      ebookStatus: bookRequests.ebookStatus,
      audioStatus: bookRequests.audioStatus,
      comicStatus: bookRequests.comicStatus,
      unroutableReason: bookRequests.unroutableReason,
      llBookId: bookRequests.llBookId,
      kapowarrVolumeId: bookRequests.kapowarrVolumeId,
      createdAt: bookRequests.createdAt,
    })
    .from(bookRequests)
    .innerJoin(integrationShelfItems, eq(bookRequests.shelfItemId, integrationShelfItems.id))
    .innerJoin(userIntegrations, eq(bookRequests.integrationId, userIntegrations.id))
    .innerJoin(users, eq(userIntegrations.userId, users.id))
    .where(
      and(
        isNull(integrationShelfItems.deletedAt),
        isNull(bookRequests.matchedBooksItemId),
        eq(userIntegrations.status, 'linked'),
        formatPredicate,
      ),
    );

  const statusFor = (row: (typeof rows)[number]): BookRequestStatus =>
    input.format === 'comic'
      ? (row.comicStatus ?? 'requested')
      : input.format === 'audiobook'
        ? row.audioStatus
        : row.ebookStatus;

  const byBook = new Map<string, { rank: number; createdAt: Date; view: WantedBookRequestView }>();
  for (const row of rows) {
    const rank = shelfOrder(row.shelf);
    const existing = byBook.get(row.externalBookId);
    if (!existing) {
      byBook.set(row.externalBookId, {
        rank,
        createdAt: row.createdAt,
        view: {
          requestId: row.requestId,
          integrationUserId: row.integrationUserId,
          requestedBy: [row.requesterName],
          title: row.title,
          author: row.author,
          shelf: row.shelf,
          shelvedAt: row.shelvedAt,
          status: statusFor(row),
          isComic: row.comicStatus != null,
          unroutableReason: row.unroutableReason,
          ebookStatus: row.ebookStatus,
          audioStatus: row.audioStatus,
          comicStatus: row.comicStatus,
          llBookId: row.llBookId,
          kapowarrVolumeId: row.kapowarrVolumeId,
          externalBookId: row.externalBookId,
        },
      });
      continue;
    }
    if (!existing.view.requestedBy.includes(row.requesterName)) {
      existing.view.requestedBy.push(row.requesterName);
    }
    if ((row.shelvedAt?.getTime() ?? 0) > (existing.view.shelvedAt?.getTime() ?? 0)) {
      existing.view.shelvedAt = row.shelvedAt;
    }
    const wins =
      rank < existing.rank ||
      (rank === existing.rank && row.createdAt.getTime() < existing.createdAt.getTime());
    if (wins) {
      existing.rank = rank;
      existing.createdAt = row.createdAt;
      const keepRequesters = existing.view.requestedBy;
      existing.view = {
        ...existing.view,
        requestId: row.requestId,
        integrationUserId: row.integrationUserId,
        requestedBy: keepRequesters,
        title: row.title,
        author: row.author,
        shelf: row.shelf,
        status: statusFor(row),
        isComic: row.comicStatus != null,
        unroutableReason: row.unroutableReason,
        ebookStatus: row.ebookStatus,
        audioStatus: row.audioStatus,
        comicStatus: row.comicStatus,
        llBookId: row.llBookId,
        kapowarrVolumeId: row.kapowarrVolumeId,
      };
    }
  }

  const views = [...byBook.values()].map((v) => v.view);
  views.sort((a, b) => (b.shelvedAt?.getTime() ?? 0) - (a.shelvedAt?.getTime() ?? 0));
  return views;
}
