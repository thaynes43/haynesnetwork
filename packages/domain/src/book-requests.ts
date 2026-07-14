// ADR-055 / DESIGN-028 (PLAN-044) — the SINGLE WRITER for book_requests (the request / Missing ledger).
// The goodreads-sync orchestrator hands it the live shelf items (each already matched against the library
// mirror + comic-classified) and it upserts one request per want: matched → landed; unroutable comic →
// parked Missing (Kapowarr's domain, never LL); routable-unmatched → minted 'requested' for the LL push.
// The SYNC-driven mint/reconcile is UNaudited (synced/derived). The USER-initiated manual "Search again"
// (recordManualSearch) DOES co-write a permission_audit row (request_book_search). The guard forbids any
// other module from touching book_requests.
import {
  bookRequests,
  booksItems,
  integrationShelfItems,
  permissionAudit,
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
