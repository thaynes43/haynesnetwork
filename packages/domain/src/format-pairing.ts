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
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { gbQueryTitle } from '@hnet/goodreads';
import { readHeldBooks, type HeldBook } from './books';
import { FOREIGN_LANGUAGE_REASON, isForeignLanguage, readItemLanguage } from './book-language';
import { inTransaction, resolveDb } from './db-client';
import { guardedGbResolve } from './gb-quota-breaker';
import { makeGbBudgetTracker, type GbBudgetTracker, type GbCallMeter } from './gb-call-budget';
import {
  applyRequestReconcile,
  llFormatAlreadyHeld,
  mapLlStatus,
  markRequestFormatsRequeued,
  normAuthor,
  llRecentSearchCovers,
  recentlySearchedLlBookIds,
  stampRequestsSearched,
} from './book-requests';
import type { LazyLibrarianClientBundle } from './lazylibrarian-clients';
import { llBookMismatch, llBookNamesTitle, type LlBookMismatch, type LlBookNaming } from './ll-book-check';
import {
  applyLlGoneDecision,
  decideLlGoneWant,
  emptyLlGoneTally,
  emptyLlRerequestTally,
  llSnapshotUsable,
  LlRekeyIndex,
  llRerequestOpen,
  peoplesRerequestsWaiting,
  runLlRerequests,
  type LlGoneTally,
  type LlRerequestCandidate,
  type LlRerequestTally,
  type LlSnapshot,
  type LlSnapshotRow,
} from './ll-gone';

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
  /**
   * Issue #661 — for a Kavita book row (a SERIES), the books it holds (`attrs.heldBooks`, read by
   * `readHeldBooks`); `undefined` = not read yet. Decides the anchor's identity (`pairingIdentity`).
   * Ignored for ABS rows, whose title is already one book's.
   */
  heldBooks?: readonly HeldBook[];
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

/**
 * Issue #693 — the reuse key: the full pairing title key once the series decoration is off (`gbQueryTitle`: the
 * trailing "(The Stormlight Archive, #1)", a leading "Expanse 05 - "). Unlike `normTitle` it keeps the subtitle,
 * so "Mistborn: Wax & Wayne" never reuses "Mistborn: The Final Empire"'s id, and it keeps a volume number, so
 * "Court of Thorns and Roses bk 2" never reuses book 1's.
 */
export function reuseTitleKey(title: string): string {
  return pairingTitleKey(gbQueryTitle(title));
}

// ---------------------------------------------------------------------------
// The held book (issue #661 — DESIGN-036 amendment 2026-10-04).
// ---------------------------------------------------------------------------

const ARTICLES = new Set(['the', 'a', 'an']);
const NUMBER_MARKERS = new Set(['book', 'bk', 'vol', 'volume', 'no', 'part', 'number']);
const isNumberToken = (t: string): boolean => /^\d+$/.test(t);
const wordTokens = (s: string): string[] =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
const withoutLeadingArticle = (tokens: string[]): string[] =>
  tokens.length > 1 && ARTICLES.has(tokens[0]!) ? tokens.slice(1) : tokens;

/**
 * A series reference with its numbering removed: "The Dark Artifices #3" → "dark artifices",
 * "The History of Middle-Earth, Vol. 3" → "history of middle earth". A marker word ("book", "vol", …)
 * goes only when a number follows it, so "Book of Dust, Volume 1" keeps its "book".
 */
function seriesRefKey(text: string): string {
  const tokens = withoutLeadingArticle(wordTokens(text));
  const kept = tokens.filter((t, i) => {
    if (isNumberToken(t)) return false;
    return !(NUMBER_MARKERS.has(t) && i + 1 < tokens.length && isNumberToken(tokens[i + 1]!));
  });
  return kept.join(' ');
}

/**
 * Strip the series decoration Kavita's epub titles often carry, so the held book's title names the BOOK:
 *
 * - a leading `<series> <number>` ("Tom Clancy NF [08] - SSN" in the series "Tom Clancy NF" → "SSN",
 *   "Hainish Cycle - 07 - Four Ways to Forgiveness" → "Four Ways to Forgiveness"). The number is
 *   required, so a title that merely starts with the series name ("Dune Messiah" in "Dune") is kept;
 * - a trailing bracket that names the series ("Queen of Air and Darkness (The Dark Artifices #3)" →
 *   "Queen of Air and Darkness", "The Lays of Beleriand (The History of Middle-Earth, Vol. 3)").
 *
 * Anything else is left exactly as Kavita has it, and a strip that would leave no letters is not done.
 */
export function stripSeriesDecoration(title: string, series: string): string {
  let out = title.trim();
  const seriesTokens = withoutLeadingArticle(wordTokens(series));
  if (seriesTokens.length === 0) return out;

  const prefix = new RegExp(
    `^\\s*(?:(?:the|a|an)[^a-z0-9]+)?${seriesTokens.join('[^a-z0-9]+')}[^a-z0-9]*` +
      `(?:(?:book|bk|vol|volume|no|part|number)[^a-z0-9]*)?#?\\d+(?:\\.\\d+)?(?![a-z0-9])[^a-z0-9]*`,
    'i',
  );
  const head = prefix.exec(out);
  if (head) {
    const rest = out.slice(head[0].length).trim();
    if (/[a-z]/i.test(rest)) out = rest;
  }

  const tail = /\s*[([]([^()[\]]*)[)\]]\s*$/.exec(out);
  if (tail) {
    const ref = seriesRefKey(tail[1]!);
    const seriesKey = seriesTokens.join(' ');
    const rest = out.slice(0, tail.index).trim();
    // Whole-word containment either way ("dark artifices" ⊂ "the dark artifices"), never a bare substring.
    const within = (outer: string, inner: string): boolean => ` ${outer} `.includes(` ${inner} `);
    if (ref.length > 0 && (within(seriesKey, ref) || within(ref, seriesKey)) && /[a-z]/i.test(rest)) {
      out = rest;
    }
  }
  return out;
}

/**
 * Strip an author credit joined to a Kavita epub title by a spaced dash ("Dead in the Family - Charlaine
 * Harris", "Roald Dahl - The Enormous Crocodile"): the first or last segment is dropped when it agrees with
 * the anchor's author (`authorsAgree`). A segment that does not name the author stays ("SSN - A Strategy
 * Guide to Submarine Warfare"), and so does everything when the author is unknown.
 */
export function stripAuthorDecoration(title: string, author: string | null): string {
  const who = normAuthor(author);
  if (!who) return title;
  const parts = title.split(/\s+[-\u2013\u2014]\s+/);
  if (parts.length < 2) return title;
  const names = (seg: string): boolean => authorsAgree(normAuthor(seg), who);
  if (names(parts[parts.length - 1]!)) {
    const rest = parts.slice(0, -1).join(' - ').trim();
    if (/[a-z]/i.test(rest)) return rest;
  }
  if (names(parts[0]!)) {
    const rest = parts.slice(1).join(' - ').trim();
    if (/[a-z]/i.test(rest)) return rest;
  }
  return title;
}

/**
 * What a pairing anchor IS, for the matcher and the want (issue #661):
 *
 * - `one` — the anchor holds exactly one book, and this is its identity. An ABS audiobook is always one
 *   book (its own title). A Kavita book row is a SERIES, so its identity is the one book the series holds:
 *   that book's own title (series decoration stripped), the row's author (else the book's writer), and the
 *   book's ISBN. The series name stands in only when Kavita has no title for that single book.
 * - `multi_book` — the Kavita series holds several books. One pairing want per anchor (D-02) cannot
 *   describe several books, so the anchor is not a candidate (and an unpushed want on it is parked).
 * - `no_book` — the Kavita series holds no book file.
 * - `unknown` — the mirror row has not been read for its held books yet (the books-sync backfill). Never
 *   guessed from the series name: the anchor waits for the next books-sync.
 */
export type PairingIdentity =
  | { kind: 'one'; title: string; author: string | null; isbn: string | null }
  | { kind: 'multi_book'; books: number }
  | { kind: 'no_book' }
  | { kind: 'unknown' };

export function pairingIdentity(item: PairableItem): PairingIdentity {
  if (item.mediaKind !== 'book') {
    return { kind: 'one', title: item.title, author: item.author, isbn: item.isbn ?? null };
  }
  const held = item.heldBooks;
  if (held === undefined) return { kind: 'unknown' };
  // One book per distinct title: two files of the same book (a duplicate copy) are still one book.
  const books: HeldBook[] = [];
  const byKey = new Map<string, HeldBook>();
  for (const b of held) {
    const key = b.title ? pairingTitleKey(b.title) : '';
    const seen = key ? byKey.get(key) : undefined;
    if (seen) {
      seen.isbn ??= b.isbn;
      seen.author ??= b.author;
      continue;
    }
    const copy = { ...b };
    books.push(copy);
    if (key) byKey.set(key, copy);
  }
  if (books.length === 0) return { kind: 'no_book' };
  if (books.length > 1) return { kind: 'multi_book', books: books.length };
  const book = books[0]!;
  const author = item.author && item.author.trim().length > 0 ? item.author : book.author;
  return {
    kind: 'one',
    title: book.title ? stripAuthorDecoration(stripSeriesDecoration(book.title, item.title), author) : item.title,
    author,
    isbn: book.isbn ?? item.isbn ?? null,
  };
}

/** The title + author the matcher keys an item on: the held book's for a one-book anchor, else the row's own. */
function matcherIdentity(item: PairableItem): { title: string; author: string | null } {
  const id = pairingIdentity(item);
  return id.kind === 'one' ? { title: id.title, author: id.author } : { title: item.title, author: item.author };
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
  // Issue #661 — a series whose row title already names its held book claims an audiobook before a
  // series that only matches through its held book, so two series holding the same book (a duplicate
  // file) keep the pair they had instead of trading it on sort order.
  const namedAsHeld = (b: PairableItem): boolean =>
    pairingTitleKey(matcherIdentity(b).title) === pairingTitleKey(b.title);
  const books = items
    .filter((i) => i.mediaKind === 'book')
    .sort((a, b) => Number(namedAsHeld(b)) - Number(namedAsHeld(a)) || byDeterministicOrder(a, b));
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
    // Issue #661 — a Kavita row is a series: a one-book series pairs on the book it holds, never on the
    // series name (the series "Dune" holding Heretics of Dune is not the audiobook "Dune").
    const identity = matcherIdentity(book);
    const key = pairingTitleKey(identity.title);
    if (!key) continue;
    const bookAuthor = normAuthor(identity.author);
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
  const rows = (
    await resolveDb(input.db)
      .select({
        id: booksItems.id,
        title: booksItems.title,
        sortTitle: booksItems.sortTitle,
        author: booksItems.author,
        mediaKind: booksItems.mediaKind,
        attrs: booksItems.attrs,
      })
      .from(booksItems)
      .where(isNull(booksItems.deletedAt))
  ).map(({ attrs, ...r }): PairableItem => ({ ...r, heldBooks: readHeldBooks(attrs) }));
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
    // Only for a pair that dropped IN THIS RUN (DESIGN-036 amendment 2026-10-04): an unpaired anchor
    // whose want reads `landed` because LazyLibrarian holds the format (the reconcile settles that
    // without any pair) has nothing to heal, and resetting it every run (312 a run on 2026-10-04) spent
    // the whole mint cap on wants LazyLibrarian already holds.
    const liveById = new Map(rows.map((r) => [r.id, r]));
    const pairedIds = new Set<string>();
    for (const p of fresh) {
      pairedIds.add(p.bookItemId);
      pairedIds.add(p.audioItemId);
    }
    const droppedIds = new Set<string>();
    for (const e of stale) {
      droppedIds.add(e.bookItemId);
      droppedIds.add(e.audioItemId);
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
      if (!droppedIds.has(anchor.id)) continue; // never paired this run → not a re-vanish
      // A series holding several books (or none) cannot be wanted as one book (issue #661).
      const identity = pairingIdentity(anchor);
      if (identity.kind === 'multi_book' || identity.kind === 'no_book') continue;
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
   * ADR-055 amendment (2026-09-22 — the push guard) — predicate: does LazyLibrarian ALREADY HOLD this
   * format of this book (`Open`/`Have`, or an import date / on-disk path)? Derived from the SAME
   * getAllBookStatuses read `llHasSeededBook` comes from, so the guard costs no extra LL call. When it
   * returns true the whole confined chain is suppressed for that want: `queueBook` is an unguarded
   * `UPDATE books SET Status='Wanted'` (LL api.py::_queuebook), so pushing a held format clobbers an
   * imported book back into LL's search backlog forever. Absent ⇒ never suppress (the safe default —
   * this guard may only ever remove a write, never add one).
   */
  llHoldsFormat?: (llBookId: string, format: 'ebook' | 'audiobook') => boolean;
  /**
   * Issue #644 — predicate: is a `searchBook` for this book/format still NEEDED? LazyLibrarian's `searchBook`
   * ignores `type` and searches every Wanted format of the book, so a book already searched this run (a
   * second want on the same llBookId, or the Skipped sweep after the mint) or searched within the hour by
   * another job (goodreads-sync / the collection force-search, via `last_searched_at`) must not be searched
   * again. `queueBook` is unaffected. Absent ⇒ always search (the pre-#644 behaviour).
   */
  shouldSearch?: (llBookId: string, format: 'ebook' | 'audiobook') => boolean;
  /** Called after a `searchBook` actually fired for this book/format (feeds the shared per-run coverage). */
  onSearched?: (llBookId: string, format: 'ebook' | 'audiobook') => void;
  /**
   * Issue #693 — the title LazyLibrarian holds for a book id (`BookName` + `BookSub` + `AuthorName`), from the same
   * one `getAllBooks` read as `llHasSeededBook`; `undefined` when LazyLibrarian has no such book. With it the mint
   * first checks every want's book against its anchor (`judgePairingWantBook`) and re-identifies a want pinned to
   * another volume or work, and it refuses a reused or resolved id whose book LazyLibrarian names as another one.
   * Absent ⇒ neither check runs (the degraded run changes nothing it cannot verify).
   */
  llBookOf?: (llBookId: string) => LlBookNaming | undefined;
  /**
   * Issue #700 — the push-time language guard: LazyLibrarian's own `BookLang` for a book id (`undefined` / null /
   * blank when unknown). Called before `queueBook` / `searchBook`; `refresh` is true right after an `addBook` that
   * first seated the book, when the run's snapshot cannot hold it yet. A book LazyLibrarian labels non-English is not
   * pushed, and its want is parked (`foreign_language`). Absent ⇒ no check (a degraded run changes nothing it cannot
   * verify).
   */
  llBookLanguage?: (llBookId: string, refresh: boolean) => Promise<string | null | undefined>;
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
  /**
   * ADR-055 amendment (2026-09-22 — the push guard) — wants whose missing-format chain was SUPPRESSED
   * because LazyLibrarian already holds that format. The want is still minted/refreshed (it is a real
   * attempt and the cap is consumed); only the clobbering LL write is withheld, and the next reconcile
   * settles the want to `landed` from LL's own status.
   */
  skippedHeld: number;
  /**
   * Issue #661 — Kavita anchors not yet read for their held books (the books-sync backfill): not
   * attempted, no row touched. Never guessed from the series name.
   */
  skippedUnknownHeld: number;
  /** Issue #661 — anchors holding several books or none, with no want yet: never minted. */
  skippedNotOneBook: number;
  /** Issue #661 / #700 — unpushed wants parked this run (`multi_book` / `no_book` / `foreign_language`). */
  parked: number;
  /** Issue #700 — anchors whose library language is explicitly non-English, with no want yet: never minted. */
  skippedForeign: number;
  /** Issue #700 — wants parked at the push because LazyLibrarian's own `BookLang` is non-English (nothing pushed). */
  refusedForeignBook: number;
  /**
   * Issue #693 — wants whose LazyLibrarian book was another volume or work than their anchor's book: the id was
   * cleared and the missing format set `requested` (`landed` when the anchor is paired), so the mint resolves the
   * right book. Not attempts.
   */
  reidentified: number;
  /** Issue #693 — wants whose anchor's book changed name while their id names it already: the title snapshot only. */
  retitled: number;
  /** Issue #693 — reused or resolved ids refused because LazyLibrarian holds them as another volume or work. */
  rejectedResolves: number;
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
  /** The want's title/author snapshot: the anchor's identity (the held book for a Kavita series — #661). */
  title: string;
  author: string | null;
  llBookId: string | null;
  now: Date;
}): Promise<{ row: BookRequestRow; minted: boolean }> {
  const missing = missingFormatFor(input.item.mediaKind);
  return inTransaction(input.db, async (tx) => {
    const refresh = async (existing: BookRequestRow): Promise<{ row: BookRequestRow; minted: boolean }> => {
      // Issue #693 — an id is kept only for the book it was resolved for. When the anchor's book changed (a renamed
      // audiobook, a series now holding another book) the old id names the OLD book: the Twilight series' want kept
      // Twilight's id under the title "Breaking Dawn" and read landed from Twilight's files. Take this attempt's id.
      const sameBook = pairingTitleKey(existing.title) === pairingTitleKey(input.title);
      const llBookId = sameBook ? (existing.llBookId ?? input.llBookId) : input.llBookId;
      // A want that gets an id it has never been pushed under (it had none, or its book changed) carries a
      // missing-format status left over from before (a lifted park, DESIGN-036 amendment 2026-10-04, or the old
      // book). Reset it to `requested` so this attempt pushes the chain; otherwise the want would hold the new id
      // and never reach LazyLibrarian.
      const freshIdentity = llBookId !== null && llBookId !== existing.llBookId;
      const status = statusOfFormat(existing, missing);
      // A `landed` that belonged to the old book is not this book's either.
      const reset = freshIdentity && status !== 'requested' && (status !== 'landed' || !sameBook);
      const [row] = await tx
        .update(bookRequests)
        .set({
          title: input.title,
          author: input.author,
          llBookId,
          ...(reset ? (missing === 'ebook' ? { ebookStatus: 'requested' as const } : { audioStatus: 'requested' as const }) : {}),
          updatedAt: input.now,
        })
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
        title: input.title,
        author: input.author,
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

/**
 * ADR-065 C-03 — the held format IS in the library, so a pairing want's anchor-held format sits `landed`. Three
 * July wants read `grabbed` there, which made the reconcile pick the HELD format as the one to sweep (issue #665
 * follow-up). Sets it, guarded on it not being `landed` already. Single-writer, unaudited (the pairing sync
 * class). Returns whether the row changed.
 */
export async function landPairingHeldFormat(input: {
  db?: DbClient;
  requestId: string;
  format: 'ebook' | 'audiobook';
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const column = input.format === 'ebook' ? bookRequests.ebookStatus : bookRequests.audioStatus;
  const rows = await resolveDb(input.db)
    .update(bookRequests)
    .set(input.format === 'ebook' ? { ebookStatus: 'landed', updatedAt: now } : { audioStatus: 'landed', updatedAt: now })
    .where(and(eq(bookRequests.id, input.requestId), ne(column, 'landed')))
    .returning({ id: bookRequests.id });
  return rows.length > 0;
}

/**
 * What the identity check (issue #693, DESIGN-036 amendment 2026-10-05) does with one want, judged against its
 * anchor's book (`pairingIdentity`) and the title LazyLibrarian holds for the want's id:
 *
 * - `keep` — nothing says the book is another one.
 * - `retitle` — the anchor's book changed name since the want was minted, and the want's id already names the new
 *   book (LazyLibrarian holds it under exactly that title) or the want has no id: only the title snapshot moves.
 * - `clear` — the want's book is not its anchor's book. `identity`: the anchor's book changed (a renamed audiobook,
 *   a series now holding another book) and LazyLibrarian does not hold the id under the new title, or no longer
 *   holds it at all, so the id was resolved for the old book. `volume` / `work`: the title is current, but
 *   LazyLibrarian names the book as another volume ("Court of Thorns and Roses bk 2" → "A Court of Thorns and
 *   Roses") or another work (`llBookMismatch`).
 *
 * Pure. A want whose title is current and whose id LazyLibrarian lacks is `keep`: the gone rule (#665) owns it.
 */
export type PairingWantBookVerdict =
  | { kind: 'keep' }
  | { kind: 'retitle' }
  | { kind: 'clear'; reason: 'identity' | LlBookMismatch };

export function judgePairingWantBook(input: {
  want: { title: string; llBookId: string | null };
  identity: { title: string; author: string | null };
  /** The book LazyLibrarian holds for `want.llBookId`; undefined when it holds none. */
  book: LlBookNaming | undefined;
}): PairingWantBookVerdict {
  const { want, identity, book } = input;
  const current = pairingTitleKey(want.title) === pairingTitleKey(identity.title);
  if (current) {
    if (!want.llBookId || !book) return { kind: 'keep' };
    const mismatch = llBookMismatch(identity, book);
    return mismatch ? { kind: 'clear', reason: mismatch } : { kind: 'keep' };
  }
  if (!want.llBookId || llBookNamesTitle(identity.title, book)) return { kind: 'retitle' };
  return { kind: 'clear', reason: 'identity' };
}

/**
 * Issue #693 — the single writer of the identity check (one statement, unaudited: the pairing sync-mint class),
 * guarded on the want being unchanged since it was read (same title and id, still unparked), so a concurrent writer
 * wins. Both modes write the anchor's identity as the title snapshot. `clear` also:
 *   - clears `ll_book_id` (the mint resolves the anchor's own book next: reuse, then Google Books);
 *   - sets the missing format `requested`, or `landed` when the anchor is paired (the library holds it);
 *   - sets the held format `landed` (the anchor is in the library);
 *   - resets the one re-request (#668), which belonged to the old book.
 * LazyLibrarian is not written: the old book stays as it is there (the caller logs its id).
 */
export async function reidentifyPairingWant(input: {
  db?: DbClient;
  want: Pick<BookRequestRow, 'id' | 'title' | 'llBookId'>;
  identity: { title: string; author: string | null };
  mode: 'retitle' | 'clear';
  missing: 'ebook' | 'audiobook';
  paired: boolean;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const missingStatus = input.paired ? ('landed' as const) : ('requested' as const);
  const rows = await resolveDb(input.db)
    .update(bookRequests)
    .set({
      title: input.identity.title,
      author: input.identity.author,
      ...(input.mode === 'clear'
        ? {
            llBookId: null,
            ebookStatus: input.missing === 'ebook' ? missingStatus : ('landed' as const),
            audioStatus: input.missing === 'audiobook' ? missingStatus : ('landed' as const),
            llRerequestedAt: null,
            llRerequestFailures: 0,
            llRerequestFailedAt: null,
            llRerequestAddedAt: null,
          }
        : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(bookRequests.id, input.want.id),
        eq(bookRequests.origin, 'pairing'),
        isNull(bookRequests.unroutableReason),
        eq(bookRequests.title, input.want.title),
        input.want.llBookId === null
          ? isNull(bookRequests.llBookId)
          : eq(bookRequests.llBookId, input.want.llBookId),
      ),
    )
    .returning({ id: bookRequests.id });
  return rows.length > 0;
}

/** One want the identity check changed (or, in a dry run, would change). */
export interface PairingWantBookChange {
  requestId: string;
  kind: 'retitle' | 'clear';
  /** Why a `clear`: the anchor's book changed (`identity`), or LazyLibrarian names another `volume` / `work`. */
  reason: 'identity' | LlBookMismatch | null;
  from: string;
  to: string;
  /** The id the want held, and the title LazyLibrarian holds it under (null: LazyLibrarian has no such book). */
  llBookId: string | null;
  llTitle: string | null;
  /** The missing format's status before, and after (`requested`, or `landed` for a paired anchor). */
  formerStatus: BookRequestRow['ebookStatus'];
  status: BookRequestRow['ebookStatus'];
  paired: boolean;
}

/**
 * Issue #693 (DESIGN-036 amendment 2026-10-05) — the identity check over every unparked pairing want on a live,
 * non-comic anchor that holds one book (`pairingIdentity`): `judgePairingWantBook`, then `reidentifyPairingWant`
 * for each `retitle` / `clear`. The mint runs it first, with the rows it already read (and gets them back updated
 * in place, so its candidate filter reads each want as it now is); the one-off repair runs it on its own, with
 * `dryRun` to list what it would change. `llBookOf` must come from a real, non-empty `getAllBooks` read.
 */
export async function checkPairingWantBooks(input: {
  db?: DbClient;
  llBookOf: (llBookId: string) => LlBookNaming | undefined;
  /** Live, non-comic library items (read here when absent). */
  anchors?: ReadonlyArray<PairableItem>;
  /** Item ids on either side of a pair (read here when absent). */
  pairedIds?: ReadonlySet<string>;
  /** The pairing wants (read here when absent); mutated in place to mirror each write. */
  wants?: BookRequestRow[];
  now?: Date;
  dryRun?: boolean;
  log?: { info?: (msg: string, meta?: Record<string, unknown>) => void };
}): Promise<{ reidentified: number; retitled: number; changes: PairingWantBookChange[] }> {
  const db = resolveDb(input.db);
  const now = input.now ?? new Date();
  const anchors =
    input.anchors ??
    (
      await db
        .select({
          id: booksItems.id,
          title: booksItems.title,
          sortTitle: booksItems.sortTitle,
          author: booksItems.author,
          mediaKind: booksItems.mediaKind,
          isbn: booksItems.isbn,
          attrs: booksItems.attrs,
        })
        .from(booksItems)
        .where(and(isNull(booksItems.deletedAt), ne(booksItems.mediaKind, 'comic')))
    ).map(({ attrs, ...r }): PairableItem => ({ ...r, heldBooks: readHeldBooks(attrs) }));
  let pairedIds = input.pairedIds;
  if (!pairedIds) {
    const rows = await db
      .select({ bookItemId: booksFormatPairs.bookItemId, audioItemId: booksFormatPairs.audioItemId })
      .from(booksFormatPairs);
    pairedIds = new Set(rows.flatMap((p) => [p.bookItemId, p.audioItemId]));
  }
  const wants =
    input.wants ?? (await db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing')));
  const liveById = new Map(anchors.map((i) => [i.id, i] as const));
  const changes: PairingWantBookChange[] = [];
  let reidentified = 0;
  let retitled = 0;
  for (const want of wants) {
    if (want.unroutableReason !== null) continue; // a park is its own decision (#660)
    const anchor = liveById.get(want.pairingBooksItemId!);
    if (!anchor || anchor.mediaKind === 'comic') continue; // the anchor left the library: nothing to check against
    const identity = pairingIdentity(anchor);
    if (identity.kind !== 'one') continue; // unread, several books or none: the mint's park logic owns it
    const book = want.llBookId ? input.llBookOf(want.llBookId) : undefined;
    const verdict = judgePairingWantBook({ want, identity, book });
    if (verdict.kind === 'keep') continue;
    const missing = missingFormatFor(anchor.mediaKind);
    const paired = pairedIds.has(anchor.id);
    const formerStatus = statusOfFormat(want, missing);
    const change: PairingWantBookChange = {
      requestId: want.id,
      kind: verdict.kind,
      reason: verdict.kind === 'clear' ? verdict.reason : null,
      from: want.title,
      to: identity.title,
      llBookId: want.llBookId,
      llTitle: book?.title ?? null,
      formerStatus,
      status: verdict.kind === 'clear' ? (paired ? 'landed' : 'requested') : formerStatus,
      paired,
    };
    if (input.dryRun) {
      changes.push(change);
      continue;
    }
    const done = await reidentifyPairingWant({
      db: input.db,
      want,
      identity,
      mode: verdict.kind,
      missing,
      paired,
      now,
    });
    if (!done) continue;
    changes.push(change);
    // Mirror the write on the in-memory row, so a caller holding it reads the want as it now is.
    want.title = identity.title;
    want.author = identity.author;
    want.updatedAt = now;
    if (verdict.kind === 'retitle') {
      retitled += 1;
      input.log?.info?.('pairing_want_retitled', { requestId: want.id, from: change.from, to: change.to });
      continue;
    }
    want.llBookId = null;
    want.llRerequestedAt = null;
    want.llRerequestFailures = 0;
    want.llRerequestFailedAt = null;
    want.llRerequestAddedAt = null;
    want.ebookStatus = missing === 'ebook' ? change.status : 'landed';
    want.audioStatus = missing === 'audiobook' ? change.status : 'landed';
    reidentified += 1;
    input.log?.info?.('pairing_want_reidentified', {
      requestId: want.id,
      reason: change.reason,
      from: change.from,
      to: change.to,
      // The book LazyLibrarian was handed for this want stays as it is there; its id is here for the record.
      abandonedLlBookId: change.llBookId,
      abandonedLlTitle: change.llTitle,
      formerStatus,
      paired,
    });
  }
  return { reidentified, retitled, changes };
}

/**
 * Issue #668 — the pairing leg of the one re-request (DESIGN-028 amendment 2026-10-04, the owner ruling). A pairing
 * want whose missing format was settled `missing` (its LazyLibrarian book is gone) and that was never re-requested,
 * on an anchor still in the library: if the anchor is PAIRED now the library holds the format and it lands; else
 * `runLlRerequests` hands it back to LazyLibrarian (addBook + queueBook, no search) or lands it on LazyLibrarian's
 * row for the same book when that row holds it. Oldest want first.
 */
async function rerequestGonePairingWants(input: {
  db?: DbClient;
  ll: LazyLibrarianClientBundle;
  snapshot: LlSnapshot;
  now: Date;
  pace: (index: number) => Promise<void>;
  log: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    error?: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<LlRerequestTally> {
  if (!llSnapshotUsable(input.snapshot)) return emptyLlRerequestTally();
  const snapshot = input.snapshot;
  const db = resolveDb(input.db);
  const rows = (
    await db
      .select({
        want: bookRequests,
        mediaKind: booksItems.mediaKind,
        deletedAt: booksItems.deletedAt,
        attrs: booksItems.attrs,
      })
      .from(bookRequests)
      .innerJoin(booksItems, eq(booksItems.id, bookRequests.pairingBooksItemId))
      .where(
        and(
          eq(bookRequests.origin, 'pairing'),
          llRerequestOpen(input.now),
          isNull(bookRequests.unroutableReason),
          isNotNull(bookRequests.llBookId),
          or(eq(bookRequests.ebookStatus, 'missing'), eq(bookRequests.audioStatus, 'missing')),
        ),
      )
      .orderBy(
        asc(bookRequests.llRerequestFailures),
        asc(bookRequests.createdAt),
        asc(bookRequests.id),
      )
  ).filter(
    // Issue #700 — a want on a non-English anchor is not handed back to LazyLibrarian (the F10 English-only rule).
    (r) =>
      r.deletedAt === null &&
      !snapshot.has(r.want.llBookId!) &&
      !isForeignLanguage(readItemLanguage(r.attrs)),
  );
  if (rows.length === 0) return emptyLlRerequestTally();
  const pairRows = await db
    .select({ bookItemId: booksFormatPairs.bookItemId, audioItemId: booksFormatPairs.audioItemId })
    .from(booksFormatPairs);
  const paired = new Set(pairRows.flatMap((p) => [p.bookItemId, p.audioItemId]));
  const candidates: LlRerequestCandidate[] = rows.map(({ want, mediaKind }) => {
    const format = missingFormatFor(mediaKind);
    return {
      want,
      formats: [format],
      libraryHolds: paired.has(want.pairingBooksItemId!) ? [format] : [],
    };
  });
  return runLlRerequests({
    db: input.db,
    ll: input.ll,
    candidates,
    snapshot,
    now: input.now,
    site: 'format-pairing.rerequest',
    deferAdds: await peoplesRerequestsWaiting(input.db, snapshot, input.now),
    pace: input.pace,
    log: input.log,
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
 * Issue #661 — park an UNPUSHED pairing want whose anchor does not hold exactly one book (`multi_book`,
 * `no_book`): one want per anchor cannot describe several books or none. Issue #700 — also its parking for a
 * non-English anchor or book (`foreign_language`, the F10 English-only rule). Single-writer, one tx, with the
 * precondition that it is still unparked and still unpushed (`ll_book_id` NULL or the missing format
 * `requested`), so a want LazyLibrarian is already working is never touched. Unaudited (the pairing
 * sync-mint class). Returns whether the row was parked.
 */
export async function parkPairingWant(input: {
  db?: DbClient;
  requestId: string;
  reason: 'multi_book' | 'no_book' | typeof FOREIGN_LANGUAGE_REASON;
  missing: 'ebook' | 'audiobook';
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  const missingCol = input.missing === 'ebook' ? bookRequests.ebookStatus : bookRequests.audioStatus;
  const parked = await resolveDb(input.db)
    .update(bookRequests)
    .set({ unroutableReason: input.reason, updatedAt: now })
    .where(
      and(
        eq(bookRequests.id, input.requestId),
        eq(bookRequests.origin, 'pairing'),
        isNull(bookRequests.unroutableReason),
        or(isNull(bookRequests.llBookId), eq(missingCol, 'requested')),
      ),
    )
    .returning({ id: bookRequests.id });
  return parked.length > 0;
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
  const items = (
    await db
      .select({
        id: booksItems.id,
        title: booksItems.title,
        sortTitle: booksItems.sortTitle,
        author: booksItems.author,
        mediaKind: booksItems.mediaKind,
        isbn: booksItems.isbn,
        attrs: booksItems.attrs,
        firstSeenAt: booksItems.firstSeenAt,
      })
      .from(booksItems)
      .where(and(isNull(booksItems.deletedAt), ne(booksItems.mediaKind, 'comic')))
  ).map(({ attrs, ...r }) => ({ ...r, heldBooks: readHeldBooks(attrs), language: readItemLanguage(attrs) }));
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

  // 2a. Issue #693 (DESIGN-036 amendment 2026-10-05) — every unparked want on a live anchor holding one book is
  //     checked against that book before any candidate is chosen (`checkPairingWantBooks`): a want whose
  //     LazyLibrarian book is another volume or work, or was resolved for the anchor's old book, gets its id cleared
  //     and becomes a candidate below. Not attempts: no cap, no external call. Only with LazyLibrarian's titles in
  //     hand (`llBookOf`); a degraded run checks nothing.
  const check = input.llBookOf
    ? await checkPairingWantBooks({
        db: input.db,
        llBookOf: input.llBookOf,
        anchors: items,
        pairedIds,
        wants,
        now,
        log,
      })
    : { reidentified: 0, retitled: 0, changes: [] };
  const { reidentified, retitled } = check;

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
  //    Issue #661 — every candidate is judged by its IDENTITY (pairingIdentity): a Kavita row is a
  //    series, so the want describes the one book the series holds. A series not yet read for its held
  //    books waits (skippedUnknownHeld); one holding several books or none is never a candidate
  //    (skippedNotOneBook), and an unpushed want on it is parked with that reason below.
  const identityOf = new Map(unpaired.map((i) => [i.id, pairingIdentity(i)] as const));
  const hasIsbn = (i: (typeof unpaired)[number]): boolean => {
    const id = identityOf.get(i.id);
    const isbn = id?.kind === 'one' ? id.isbn : i.isbn;
    return Boolean(isbn && isbn.trim().length > 0);
  };
  const lastTriedAt = (i: (typeof unpaired)[number]): number =>
    (wantByAnchor.get(i.id)?.updatedAt ?? i.firstSeenAt).getTime();
  const isRetryable = (w: BookRequestRow, i: (typeof unpaired)[number]): boolean =>
    w.llBookId === null || statusOfFormat(w, missingFormatFor(i.mediaKind)) === 'requested';
  let skippedUnknownHeld = 0;
  let skippedNotOneBook = 0;
  let skippedForeign = 0;
  const toPark: Array<{
    want: BookRequestRow;
    item: (typeof unpaired)[number];
    reason: 'multi_book' | 'no_book' | typeof FOREIGN_LANGUAGE_REASON;
  }> = [];
  const candidates = unpaired
    .filter((i) => {
      const w = wantByAnchor.get(i.id);
      // A PARKED want (`unroutable_reason` set, e.g. 'wrong_volume' after an omnibus repair) is never
      // re-attempted: re-resolving it would refill llBookId and hand it back to the Skipped sweep.
      if (w && w.unroutableReason !== null) return false;
      // Issue #700 — the F10 English-only rule: a foreign-language anchor is never a candidate. Its other format is
      // not wanted, so no want is minted, and an unpushed want already on it is parked. Blank/`XXX` is unknown, so
      // it stays a candidate (the push re-checks LazyLibrarian's own language).
      if (isForeignLanguage(i.language)) {
        if (!w) skippedForeign += 1;
        else if (isRetryable(w, i)) toPark.push({ want: w, item: i, reason: FOREIGN_LANGUAGE_REASON });
        return false;
      }
      const identity = identityOf.get(i.id)!;
      if (identity.kind === 'unknown') {
        if (!w || isRetryable(w, i)) skippedUnknownHeld += 1;
        return false;
      }
      if (identity.kind === 'multi_book' || identity.kind === 'no_book') {
        if (!w) skippedNotOneBook += 1;
        else if (isRetryable(w, i)) toPark.push({ want: w, item: i, reason: identity.kind });
        return false;
      }
      if (!w) return true; // fresh — never yet minted
      return isRetryable(w, i);
    })
    .sort(
      (a, b) =>
        a.firstSeenAt.getTime() - b.firstSeenAt.getTime() ||
        (hasIsbn(b) ? 1 : 0) - (hasIsbn(a) ? 1 : 0) ||
        lastTriedAt(a) - lastTriedAt(b) ||
        a.id.localeCompare(b.id),
    );

  // 4. The llBookId reuse index over ALREADY-RESOLVED requests (same work title + author
  //    agreement). Draws from BOTH goodreads shelf requests AND prior pairing wants: a GB volume id
  //    is the same identity key on either origin, so a pairing candidate whose same-work sibling
  //    (e.g. its format twin, or a shelf request) already resolved reuses that id and needs ZERO GB
  //    calls — the GB-avoidance that lets the pairing backlog keep draining on a quota-exhausted day
  //    (the 2026-07-18 shared-key starvation: LazyLibrarian drains the per-project GB quota, so every
  //    pairing want that can resolve WITHOUT a fresh GB hop is one more that mints regardless).
  //    Issue #693 — the key is `reuseTitleKey` (the full title, series decoration off), never `normTitle`: that one
  //    cuts the subtitle, so "Mistborn: Wax & Wayne" and "Mistborn: Secret History" reused "Mistborn: The Final
  //    Empire"'s id and read landed from its files. A want on an anchor that left the library is no source (its id
  //    is never re-checked), and a reused id whose book LazyLibrarian names as another one is passed over.
  const liveItemIds = new Set(items.map((i) => i.id));
  const reuseRows = await db
    .select({
      origin: bookRequests.origin,
      anchorId: bookRequests.pairingBooksItemId,
      title: bookRequests.title,
      author: bookRequests.author,
      llBookId: bookRequests.llBookId,
    })
    .from(bookRequests)
    .where(and(inArray(bookRequests.origin, ['goodreads', 'pairing']), isNotNull(bookRequests.llBookId)));
  const reuseByTitle = new Map<string, Array<{ author: string; llBookId: string }>>();
  for (const r of reuseRows) {
    if (!r.llBookId) continue;
    if (r.origin === 'pairing' && !(r.anchorId && liveItemIds.has(r.anchorId))) continue;
    const key = reuseTitleKey(r.title);
    if (!key) continue;
    const bucket = reuseByTitle.get(key) ?? [];
    bucket.push({ author: normAuthor(r.author), llBookId: r.llBookId });
    reuseByTitle.set(key, bucket);
  }
  let rejectedResolves = 0;
  /** A reused or resolved id is refused when LazyLibrarian holds that book as another volume or work. */
  const bookRefused = (identity: { title: string; author: string | null }, llBookId: string): boolean => {
    const book = input.llBookOf?.(llBookId);
    const mismatch = book ? llBookMismatch(identity, book) : null;
    if (!mismatch) return false;
    rejectedResolves += 1;
    log.info?.('pairing_resolve_rejected', {
      title: identity.title,
      llBookId,
      llTitle: book?.title ?? null,
      reason: mismatch,
    });
    return true;
  };
  const reuseLlBookId = (identity: { title: string; author: string | null }): string | null => {
    const author = normAuthor(identity.author);
    if (!author) return null;
    const bucket = reuseByTitle.get(reuseTitleKey(identity.title)) ?? [];
    for (const r of bucket) {
      if (!authorsAgree(author, r.author)) continue;
      if (!bookRefused(identity, r.llBookId)) return r.llBookId;
    }
    return null;
  };

  // 4b. Park the unpushed wants whose anchor holds several books or none (issue #661). Not attempts: no
  //     cap consumed, no external call.
  let parked = 0;
  for (const p of toPark) {
    const done = await parkPairingWant({
      db: input.db,
      requestId: p.want.id,
      reason: p.reason,
      missing: missingFormatFor(p.item.mediaKind),
      now,
    });
    if (done) {
      parked += 1;
      log.info?.(
        p.reason === FOREIGN_LANGUAGE_REASON
          ? 'format-pairing: want parked, the anchor is not English'
          : 'format-pairing: want parked, the anchor does not hold exactly one book',
        { requestId: p.want.id, title: p.item.title, reason: p.reason, language: p.item.language },
      );
    }
  }

  // 5. Attempt candidates in order, paced, until the cap of REAL attempts is spent. A candidate
  //    that would need a Google Books resolve while the breaker is open (or after it trips
  //    mid-run) is SKIPPED — no cap consumed, no upsert (updated_at is the retry-recency key and
  //    must not advance on a non-attempt), no per-item error spam (ADR-067 C-08).
  let minted = 0;
  let pushed = 0;
  let unmintable = 0;
  let skippedQuota = 0;
  let skippedBudget = 0;
  let skippedHeld = 0;
  let refusedForeignBook = 0;
  let attempted = 0;
  let paceSeq = 0;
  let quotaOpen = false;
  let budgetLogged = false;
  for (const item of candidates) {
    if (attempted >= cap) break;
    const missing = missingFormatFor(item.mediaKind);
    const identity = identityOf.get(item.id)!;
    if (identity.kind !== 'one') continue; // unreachable: the candidate filter admits only `one`
    // The want's own id was checked against this identity in 2a (an id resolved for another book was cleared there).
    // Without LazyLibrarian's titles 2a did not run, so an id is still taken only while the title it was resolved
    // under is this identity's (issue #693).
    const own = wantByAnchor.get(item.id);
    const ownLlBookId =
      own && pairingTitleKey(own.title) === pairingTitleKey(identity.title) ? own.llBookId : null;
    let llBookId = ownLlBookId ?? reuseLlBookId(identity) ?? null;
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
          consumer: 'pairing',
          gb: input.gb!,
          // Pass the anchor ISBN (PLAN-059): the resolver tries `isbn:` first — the exact leg that
          // makes the Goodreads path resolve ~99% — before falling back to the fuzzy file-title.
          // Issue #661 — the held book's title/author/ISBN for a Kavita series, never the series name.
          query: { isbn: identity.isbn, title: identity.title, author: identity.author },
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
        // Issue #693 — LazyLibrarian may already hold the resolved id under another volume's or work's title.
        if (llBookId !== null && bookRefused(identity, llBookId)) llBookId = null;
      } catch (error) {
        if (input.budget) await input.budget.spend((input.meter?.taken() ?? 0) - before);
        // Non-429 failure — today's semantics: an honest unmintable ATTEMPT (cap consumed below).
        log.error?.('format-pairing: GB resolve failed (want stays unmintable)', {
          title: identity.title,
          error: error instanceof Error ? error.message : String(error),
        });
        llBookId = null;
      }
    }

    attempted += 1;
    const { row, minted: isNew } = await upsertPairingWant({
      db: input.db,
      item,
      title: identity.title,
      author: identity.author,
      llBookId,
      now,
    });
    if (isNew) minted += 1;
    if (llBookId === null) {
      unmintable += 1;
      continue;
    }
    if (!input.ll || statusOfFormat(row, missing) !== 'requested') continue;
    // ADR-055 amendment (2026-09-22 — the push guard). LL already holding the missing format means this
    // pairing want is ALREADY satisfied on LL's side; pushing would `UPDATE books SET Status='Wanted'`
    // over an imported book and strand it in LL's daily search backlog. Suppress the whole chain — the
    // want stays minted and the run's reconcile below settles it to `landed` from LL's own status.
    if (input.llHoldsFormat?.(llBookId, missing)) {
      skippedHeld += 1;
      log.info?.('ll_push_skipped_have', {
        site: 'format-pairing.mint-push',
        requestId: row.id,
        llBookId,
        formats: [missing],
        title: identity.title,
      });
      continue;
    }
    try {
      // DESIGN-039 D-18 — addBook ONLY seats a volume LL does not already hold. When LL already has
      // it (the common case for a re-pushed want), skip addBook so LL makes ZERO Google Books calls
      // this push; queueBook + searchBook (neither hits GB) still drive the acquisition retry.
      const seatedNow = input.llHasSeededBook?.(llBookId) ?? false;
      if (!seatedNow) await input.ll.write.addBook(llBookId);
      // Issue #700 — the second language guard. The library's language field is not fully reliable (an item that
      // read `English` held German audio), so before the book is queued or searched, LazyLibrarian's own `BookLang`
      // is read (re-read after an addBook that first seated the book). Explicitly non-English ⇒ park, push nothing.
      // Blank or unknown ⇒ proceed.
      if (input.llBookLanguage) {
        const llLanguage = await input.llBookLanguage(llBookId, !seatedNow);
        if (isForeignLanguage(llLanguage)) {
          refusedForeignBook += 1;
          const done = await parkPairingWant({
            db: input.db,
            requestId: row.id,
            reason: FOREIGN_LANGUAGE_REASON,
            missing,
            now,
          });
          if (done) parked += 1;
          log.info?.('format-pairing: push refused, LazyLibrarian holds the book as non-English', {
            requestId: row.id,
            llBookId,
            title: identity.title,
            llLanguage,
          });
          continue;
        }
      }
      await input.ll.write.queueBook(llBookId, missing);
      if (input.shouldSearch?.(llBookId, missing) ?? true) {
        await input.ll.write.searchBook(llBookId, missing);
        input.onSearched?.(llBookId, missing);
        await stampRequestsSearched(input.db, [row.id], now);
      } else {
        log.info?.('ll_search_skipped_covered', {
          site: 'format-pairing.mint-push',
          requestId: row.id,
          llBookId,
          formats: [missing],
        });
      }
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
        title: identity.title,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    candidates: unpaired.length,
    attempted,
    minted,
    pushed,
    unmintable,
    skippedQuota,
    skippedBudget,
    skippedHeld,
    skippedUnknownHeld,
    skippedNotOneBook,
    parked,
    skippedForeign,
    refusedForeignBook,
    reidentified,
    retitled,
    rejectedResolves,
  };
}

// ---------------------------------------------------------------------------
// The run orchestrator (the format-pairing sync mode's body).
// ---------------------------------------------------------------------------

export interface FormatPairingReport
  extends SyncFormatPairsReport,
    MintPairingWantsReport,
    LlGoneTally,
    LlRerequestTally {
  /** Open pairing wants whose LL statuses reconciled this run. */
  reconciled: number;
  /** Pairing wants whose raw-`Skipped` missing format was re-queued + re-searched this run. */
  requeued: number;
  /** Open pairing wants whose anchor-held format did not read `landed` and was set so (ADR-065 C-03). */
  heldLanded: number;
  /**
   * ADR-055 amendment (2026-09-22 — the push guard). Widened from `MintPairingWantsReport.skippedHeld`:
   * on the run report this is the RUN TOTAL — mint-push suppressions PLUS Skipped-sweep suppressions.
   */
  skippedHeld: number;
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
  // ADR-055 amendment (2026-09-22) — the same one read now feeds a THIRD consumer: the held-format
  // push guard (`llHoldsFormat` below and the Skipped sweep). Still one LL call per run.
  let seated: Map<string, LlSnapshotRow> | null = null;
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

  // Issue #644 — ONE searchBook per book. `searchedThisRun` is the in-run coverage (mint → sweep, and two
  // wants on one llBookId); `recent` is what OTHER jobs searched within the hour (their `last_searched_at`
  // stamps — goodreads-sync, collection force-search run as separate cron jobs). A recent search only
  // covers a format LL already shows as Wanted: a format we are about to flip is always searched.
  const searchedThisRun = new Map<string, Set<'ebook' | 'audiobook'>>();
  const recent = input.ll ? await recentlySearchedLlBookIds(input.db, now) : new Set<string>();
  const shouldSearch = (llBookId: string, format: 'ebook' | 'audiobook'): boolean =>
    // Per FORMAT: a search this run covered only the formats that were queued when it fired, so a different
    // format flipped to Wanted afterwards (a second want, or the Skipped sweep) is still searched.
    !searchedThisRun.get(llBookId)?.has(format) &&
    !llRecentSearchCovers(recent, llBookId, seatedMap?.get(llBookId), [format]);
  const onSearched = (llBookId: string, format: 'ebook' | 'audiobook'): void => {
    const covered = searchedThisRun.get(llBookId) ?? new Set<'ebook' | 'audiobook'>();
    covered.add(format);
    searchedThisRun.set(llBookId, covered);
  };

  const mint = await mintPairingWants({
    ...input,
    now,
    shouldSearch,
    onSearched,
    ...(budget ? { budget } : {}),
    llHasSeededBook: seatedMap ? (id) => seatedMap.get(id) != null : undefined,
    llHoldsFormat: seatedMap
      ? (id, format) => llFormatAlreadyHeld(seatedMap.get(id), format)
      : undefined,
    // Issue #693 — only a real, non-empty read: an LL error answer parses to an empty map, which would read every
    // book as absent and clear every want whose anchor was renamed.
    llBookOf: llSnapshotUsable(seatedMap) ? (id) => seatedMap.get(id) : undefined,
    // Issue #700 — LazyLibrarian's own language for the push-time guard. A book the run's snapshot predates (first
    // seated by this run's addBook) is read from a fresh `getAllBooks`; a failed or missing read means unknown.
    llBookLanguage:
      input.ll && llSnapshotUsable(seatedMap)
        ? async (id, refresh) => {
            if (!refresh) return seatedMap.get(id)?.language ?? null;
            try {
              return (await input.ll!.read.getAllBookStatuses()).get(id)?.language ?? null;
            } catch {
              return null;
            }
          }
        : undefined,
  });

  let reconciled = 0;
  let requeued = 0;
  let sweepSkippedHeld = 0;
  let heldLanded = 0;
  const gone = emptyLlGoneTally();
  if (input.ll && seatedMap) {
    // Issue #665 (DESIGN-028 amendment 2026-10-04) — a pushed want whose id LazyLibrarian no longer has is
    // re-keyed to the row LL holds for the same book, or settled `missing`. Built from the same one snapshot;
    // an empty snapshot decides nothing. The want pushed by THIS run's mint carries a fresh
    // `last_reconciled_at`, so the grace keeps it out (the snapshot predates its addBook).
    const goneIndex = llSnapshotUsable(seatedMap) ? new LlRekeyIndex(seatedMap) : null;
    // Each open want's anchor media kind: the want's own format is the one its anchor misses, and the other one
    // sits `landed` (ADR-065 C-03). Guessing it from which status reads `landed` misread three July wants whose
    // held format read `grabbed`, so the Skipped sweep worked their HELD format (issue #665 follow-up).
    const anchorKindOf = new Map<string, BooksMediaKind>();
    // Anchors still in the library: only those hold their format, so only their wants' held format is landed.
    const anchorLive = new Set<string>();
    const open = (await db.select().from(bookRequests).where(eq(bookRequests.origin, 'pairing'))).filter(
      (w) =>
        w.llBookId !== null &&
        w.pairingBooksItemId !== null &&
        // A parked want is out of the reconcile and the Skipped sweep: re-queueing it would undo the park
        // (DESIGN-036 amendment 2026-10-03 — the omnibus repair set the bundle Skipped on purpose).
        w.unroutableReason === null &&
        (w.ebookStatus !== 'landed' || w.audioStatus !== 'landed'),
    );
    if (open.length > 0) {
      const anchors = await db
        .select({ id: booksItems.id, mediaKind: booksItems.mediaKind, deletedAt: booksItems.deletedAt })
        .from(booksItems)
        .where(inArray(booksItems.id, [...new Set(open.map((w) => w.pairingBooksItemId!))]));
      for (const a of anchors) {
        anchorKindOf.set(a.id, a.mediaKind); // the media kind never changes, so a removed anchor still names it
        if (a.deletedAt === null) anchorLive.add(a.id);
      }
    }
    for (const want of open) {
      const status = seatedMap.get(want.llBookId!);
      const anchorKind = anchorKindOf.get(want.pairingBooksItemId!);
      const missing = anchorKind
        ? missingFormatFor(anchorKind)
        : want.ebookStatus === 'landed'
          ? ('audiobook' as const)
          : ('ebook' as const);
      const heldFormat = missing === 'ebook' ? ('audiobook' as const) : ('ebook' as const);
      if (
        anchorLive.has(want.pairingBooksItemId!) &&
        (heldFormat === 'ebook' ? want.ebookStatus : want.audioStatus) !== 'landed'
      ) {
        if (await landPairingHeldFormat({ db: input.db, requestId: want.id, format: heldFormat, now })) {
          heldLanded += 1;
          if (heldFormat === 'ebook') want.ebookStatus = 'landed';
          else want.audioStatus = 'landed';
        }
      }
      if (!status) {
        if (!goneIndex) continue;
        try {
          await applyLlGoneDecision({
            db: input.db,
            requestId: want.id,
            llBookId: want.llBookId!,
            decision: decideLlGoneWant({
              want: { ...want, lastSeenAt: want.lastReconciledAt ?? want.createdAt },
              snapshot: seatedMap,
              index: goneIndex,
              now,
              formats: [missing],
            }),
            snapshot: seatedMap,
            reconcile: true,
            tally: gone,
            site: 'format-pairing.reconcile',
            now,
            log,
          });
        } catch (error) {
          log.error?.('format-pairing: gone-book settle failed', {
            requestId: want.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      // Issue #693 — a want is never landed from, nor its book re-queued on, a LazyLibrarian book that names another
      // volume or work. The mint's identity check (2a) clears such a pointer on a live anchor; this covers the rest
      // (an anchor that left the library, or one not yet read for its held books).
      const mismatch = llBookMismatch(want, status);
      if (mismatch) {
        log.info?.('ll_book_mismatch', {
          site: 'format-pairing.reconcile',
          requestId: want.id,
          llBookId: want.llBookId,
          title: want.title,
          llTitle: status.title ?? null,
          reason: mismatch,
        });
        continue;
      }
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
        // ADR-055 amendment (2026-09-22) — `Skipped` is not proof LL lacks the file: LL carries rows that
        // are Skipped yet fully imported (39 of them on that date). Re-queueing one clobbers it to
        // `Wanted`, so the sweep now consults the file/library signals before it fires.
        if (raw?.trim().toLowerCase() === 'skipped' && isForeignLanguage(status.language)) {
          // Issue #700 — never re-queue a book LazyLibrarian itself labels non-English; park the want instead
          // (a no-op once LazyLibrarian is already working it, which the park's precondition leaves alone).
          await parkPairingWant({
            db: input.db,
            requestId: want.id,
            reason: FOREIGN_LANGUAGE_REASON,
            missing,
            now,
          });
          log.info?.('format-pairing: Skipped sweep refused, LazyLibrarian holds the book as non-English', {
            requestId: want.id,
            llBookId: want.llBookId,
            llLanguage: status.language ?? null,
          });
        } else if (raw?.trim().toLowerCase() === 'skipped' && llFormatAlreadyHeld(status, missing)) {
          sweepSkippedHeld += 1;
          log.info?.('ll_push_skipped_have', {
            site: 'format-pairing.skipped-sweep',
            requestId: want.id,
            llBookId: want.llBookId,
            formats: [missing],
            ebookStatus: status.ebookStatus ?? null,
            audioStatus: status.audioStatus ?? null,
          });
        } else if (raw?.trim().toLowerCase() === 'skipped') {
          await pace(requeued + 1);
          await input.ll.write.queueBook(want.llBookId!, missing);
          if (shouldSearch(want.llBookId!, missing)) {
            await input.ll.write.searchBook(want.llBookId!, missing);
            onSearched(want.llBookId!, missing);
          } else {
            log.info?.('ll_search_skipped_covered', {
              site: 'format-pairing.skipped-sweep',
              requestId: want.id,
              llBookId: want.llBookId,
              formats: [missing],
            });
          }
          await stampRequestsSearched(input.db, [want.id], now);
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

  // Issue #668 (owner ruling 2026-10-04, "Add them all back now") — the ONE re-request of every want settled
  // `missing` because LazyLibrarian lost its book: addBook + queueBook only, never a search (LazyLibrarian's daily
  // backlog search looks for them), a held format lands instead. Last, so the run's own work is done first.
  const rerequest =
    input.ll && seatedMap
      ? await rerequestGonePairingWants({ db: input.db, ll: input.ll, snapshot: seatedMap, now, pace, log })
      : emptyLlRerequestTally();

  const report: FormatPairingReport = {
    ...pairs,
    ...mint,
    reconciled,
    requeued,
    // The run total: mint-push suppressions + Skipped-sweep suppressions (both are held-format clobbers
    // withheld), so one number answers "how many clobbering LL writes did the guard stop this run".
    skippedHeld: mint.skippedHeld + sweepSkippedHeld,
    heldLanded,
    ...gone,
    ...rerequest,
  };
  log.info?.('format-pairing run complete', { ...report });
  return report;
}
