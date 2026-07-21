// ADR-046 / DESIGN-024 (PLAN-023) — the Books Library tRPC surface. Reads the app-owned `books_items`
// ledger (synced one-way from Kavita + Audiobookshelf by the books-sync mode) for the Library
// Books/Audiobooks/Comics poster walls. Read-only; there is NO Fix/Restore/add for books (hard rule 4
// EXTENDED — the book servers are the source of truth; the app only reflects them). Every read is gated by
// `booksProcedure` (the `books` section, ships Admin-only) — server-authoritative (AC-13), never
// client-hidden only. Same gate protects the /api/books/cover proxy.
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  bookFixRequests,
  bookRequests,
  booksCollections,
  booksCollectionMembers,
  booksFormatPairs,
  booksItems,
  userBookProgress,
  users,
  BOOKS_MEDIA_KINDS,
  type BooksMediaKind,
  type BooksItemRow,
  type BookFixReason,
  type BookFixStatus,
  type BookRequestOrigin,
  type BookRequestStatus,
  type Database,
} from '@hnet/db';
import { and, asc, desc, eq, getTableColumns, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
// (ilike retired with the single-kind query — the work-grain text match is a raw union ILIKE.)
import {
  bookActionsForRole,
  getBookRequestById,
  getBookRequestDetail,
  getCollectionWantedBookRequests,
  getWantedBookRequests,
  isRequestSearchable,
  missingFormatFor,
  provenanceDisplayName,
  runBookItemForceSearch,
  runManualBookSearch,
  type WantedBookRequestView,
} from '@hnet/domain';
import {
  authedProcedure,
  mapDomainErrors,
  resolveKapowarrBundle,
  resolveLazyLibrarianBundle,
  router,
} from '../trpc';
import {
  booksOrIntegrationsProcedure,
  booksProcedure,
  effectiveSectionLevel,
} from '../middleware/role';
import { booksCoverUrlFor } from '../books-query';
import {
  BOOK_LENGTH_BOUNDS,
  KAVITA_FORMATS,
  aggregateBookGenreGroups,
  aggregateBookGroups,
  booksSearchInputSchema,
  toBooksListItem,
  wantedPrimarySortValue,
  wantedSortTitle,
  type BookLengthBucket,
  type BooksGroup,
  type BooksListItem,
  type BooksSearchInput,
  type BooksSort,
} from '../books-query';
import { absAuthorDirectory, absAuthorImageUrlFor } from '../books-author-art';

/** ADR-047 (PLAN-028) — the app-specific "Read in Kavita" / "Listen on Audiobookshelf" verb, by source. */
function booksPlayLabel(source: string): string {
  return source === 'audiobookshelf' ? 'Listen on Audiobookshelf' : 'Read in Kavita';
}

// ---------------------------------------------------------------------------
// ADR-075 (PLAN-060 Stream A) — the unified Books wall's WORK grain. One Books wall now serves
// `media_kind ∈ {book, audiobook}`; `books_format_pairs` is the COLLAPSE join (C-02): a paired
// (book, audio) duo renders as ONE card anchored on the EBOOK row (deterministic — the
// BOOKS_MEDIA_KINDS tie-break precedent), with the partner's metadata carried for facets/sorts
// (facets match the UNION, display shows the anchor's values — E-3). The anchor rule is TOTAL
// (E-2): an unpaired row (including audio-only) anchors on itself — no card ever vanishes.
// Comics are untouched (E-5): the same query shape serves them (their partner join simply never
// matches — comics never pair), so there is ONE code path, not two.
// ---------------------------------------------------------------------------

/** The paired counterpart of an anchor row (the collapse join's right side). */
const partnerItems = alias(booksItems, 'partner');

/** The wall a mediaKind input resolves to: comics stay alone; book/audiobook are ONE wall now
 *  (the old `audiobooks` wire value stays accepted — it means the same unified wall). */
function wallKindsFor(mediaKind: BooksMediaKind): BooksMediaKind[] {
  return mediaKind === 'comic' ? ['comic'] : ['book', 'audiobook'];
}

/** True when the request addresses the unified Books wall (vs Comics). */
function isUnifiedWall(mediaKind: BooksMediaKind): boolean {
  return mediaKind !== 'comic';
}

/**
 * The anchor-exclusion predicate: an audio row that is the LIVE-paired counterpart of a live book
 * row is COLLAPSED into that anchor's card and must not render its own. Total anchor rule (E-2):
 * a pair whose book side tombstoned leaves the audio row anchoring on itself.
 */
function anchorExclusion(): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM books_format_pairs cp
      JOIN books_items cb ON cb.id = cp.book_item_id AND cb.deleted_at IS NULL
     WHERE cp.audio_item_id = ${booksItems.id})`;
}

/** The drilled collection + its Libretto recipe TWINS (ADR-076 C-03 — a merged multi-target
 *  collection drills as one; solo/hand collections resolve to themselves alone). */
async function collectionSiblingIds(db: Database, collectionId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT c2.id FROM books_collections c2
     WHERE c2.id = ${collectionId}
        OR (c2.libretto_recipe_id IS NOT NULL
            AND c2.libretto_recipe_id = (SELECT c3.libretto_recipe_id FROM books_collections c3
                                          WHERE c3.id = ${collectionId}))`);
  const ids = (rows.rows ?? (rows as unknown as { id: string }[])).map((r) => r.id);
  return ids.length > 0 ? ids : [collectionId];
}

/** SQL id-list literal for the sibling set (uuids from our own query — bound as params). */
function idList(ids: string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

/** ADR-065 / DESIGN-036 D-09 — a title's format-pairing state on the detail page. Null for a comic. */
export interface BooksPairingState {
  /** Present when the title is PAIRED — the counterpart format's OWN deep link (the second button). */
  pairedPlay: { app: 'kavita' | 'audiobookshelf'; label: string; url: string } | null;
  /** The absent format when UNPAIRED (a book lacks the audiobook; an audiobook lacks the ebook). */
  missingFormat: 'ebook' | 'audiobook' | null;
  /** The minted pairing want for the missing format, when the paced backfill has reached this title. */
  want: { requestId: string; status: BookRequestStatus; searchable: boolean } | null;
}

/**
 * DESIGN-025 D-08 (detail-page parity) — the enriched detail item: the wall row plus the About/Details
 * enrichment (summary, publisher, language, isbn, fileCount, a format label, the added instant) and the
 * provenance the Details section shows. Every enrichment field is nullable — the UI collapses an empty
 * About/Details row exactly like the movie page (never a fabricated blank).
 */
export type BooksDetailItem = BooksListItem & {
  libraryName: string;
  lastSyncedAt: string;
  summary: string | null;
  publisher: string | null;
  language: string | null;
  isbn: string | null;
  fileCount: number | null;
  /** A plain format label: Kavita EPUB/CBZ-CBR/PDF (from attrs.format), ABS "Audiobook". Null when unknown. */
  formatLabel: string | null;
  /** When the serving app first had this item (source_added_at) as ISO, or null. */
  addedAt: string | null;
};

/** DESIGN-025 D-08 — a mirrored books-collection chip (links to the wall's collection drill). */
export interface BooksCollectionChip {
  /** books_collections row uuid — the `?group=` drill key (stable app-side). */
  id: string;
  title: string;
}

/** DESIGN-025 D-08 / DESIGN-033 — one book Fix in the item's audited fix trail (the movie-History idiom). */
export interface BookFixHistoryEntry {
  id: string;
  status: BookFixStatus;
  reason: BookFixReason;
  reasonText: string | null;
  requesterDisplayName: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** DESIGN-025 D-08 — one linked request's lifecycle (how the title was wanted / landed). */
export interface BookRequestHistoryEntry {
  id: string;
  origin: BookRequestOrigin;
  ebookStatus: BookRequestStatus;
  audioStatus: BookRequestStatus;
  comicStatus: BookRequestStatus | null;
  lastSearchedAt: string | null;
  createdAt: string;
}

/** The books detail payload (the in-app drill-in — deep-links OUT to Kavita/ABS, no *arr semantics). */
export interface BooksDetailResult {
  /** ADR-062 — the caller may fire a books Fix (admin or fix_book grant). */
  canFix: boolean;
  /** ADR-071 — the caller may fire a books Force Search (admin or force_search_book grant). On-disk
   *  books are the only detail surface, so on-disk ⇒ Fix + Force Search when granted. */
  canForceSearch: boolean;
  item: BooksDetailItem;
  /** The app-specific deep link (books are always PRESENT — synced from the serving app). */
  play: { app: 'kavita' | 'audiobookshelf'; label: string; url: string };
  /** ADR-065 — the format-pairing state (dual buttons / the missing format's affordance). Null = comic. */
  pairing: BooksPairingState | null;
  /** DESIGN-025 D-08 — the mirrored books-collections this title belongs to (About chips). */
  collections: BooksCollectionChip[];
  /** DESIGN-025 D-08 / DESIGN-033 — the audited book-Fix trail for this item (newest first). */
  fixes: BookFixHistoryEntry[];
  /** DESIGN-025 D-08 — the linked request lifecycle rows (newest first). */
  requests: BookRequestHistoryEntry[];
}

/** DESIGN-025 D-08 — a plain, kind-aware format label for the Details "Format" row. */
export function bookFormatLabel(row: BooksItemRow): string | null {
  if (row.source === 'audiobookshelf') return 'Audiobook';
  const code = (row.attrs as Record<string, unknown> | null)?.format;
  if (typeof code !== 'number') return null;
  return KAVITA_FORMATS.find((f) => f.code === code)?.label ?? null;
}

/** ADR-065 / DESIGN-036 D-09 — the wall's format-coverage signal ('both' wears "Ebook + Audio"). */
export type BooksFormatCoverage = 'both' | 'ebook' | 'audio';

/**
 * Resolve one non-comic row's pairing state (DESIGN-036 D-09): a pair row ⇒ the counterpart's own
 * deep link; unpaired ⇒ the missing format + its pairing want (when the paced backfill minted one).
 * `searchable` = the want has an LL identity and the format has not landed — the books-gated
 * `searchPairingWant` is the action it arms (the caller already passed the books gate).
 */
async function resolvePairingState(
  db: Database,
  row: BooksItemRow,
): Promise<BooksPairingState | null> {
  if (row.mediaKind === 'comic') return null;
  const sideColumn =
    row.mediaKind === 'book' ? booksFormatPairs.bookItemId : booksFormatPairs.audioItemId;
  const [pair] = await db.select().from(booksFormatPairs).where(eq(sideColumn, row.id));
  if (pair) {
    const otherId = row.mediaKind === 'book' ? pair.audioItemId : pair.bookItemId;
    const [other] = await db
      .select()
      .from(booksItems)
      .where(and(eq(booksItems.id, otherId), isNull(booksItems.deletedAt)));
    if (other) {
      return {
        pairedPlay: {
          app: other.source === 'audiobookshelf' ? 'audiobookshelf' : 'kavita',
          label: booksPlayLabel(other.source),
          url: other.deepLinkUrl,
        },
        missingFormat: null,
        want: null,
      };
    }
    // The counterpart tombstoned since the last pair rebuild — honest unpaired until the next run.
  }
  const missingFormat = missingFormatFor(row.mediaKind);
  const [want] = await db
    .select()
    .from(bookRequests)
    .where(eq(bookRequests.pairingBooksItemId, row.id));
  if (!want) return { pairedPlay: null, missingFormat, want: null };
  const status = missingFormat === 'ebook' ? want.ebookStatus : want.audioStatus;
  return {
    pairedPlay: null,
    missingFormat,
    want: {
      requestId: want.id,
      status,
      searchable: want.llBookId !== null && status !== 'landed',
    },
  };
}

/**
 * The ORDER BY for a sort option (id/sort_title tiebreakers keep the offset paging stable).
 * PLAN-029 (R5 "+direction"): an explicit `dir` flips the PRIMARY column; nulls stay LAST in either
 * direction (the D-09 convention) and the tiebreakers stay ascending. Absent dir = the option's
 * natural direction (A–Z for title/author, newest/most-first for the rest — the pre-029 behavior).
 * ADR-066 / DESIGN-038 D-06 (PLAN-051): 'position' orders a DRILLED collection by member position
 * (reading order — asc natural); the schema refinement guarantees `collection` is present.
 */
const BOOKS_SORT_NATURAL_DIR: Record<BooksSort, 'asc' | 'desc'> = {
  title: 'asc',
  author: 'asc',
  added: 'desc',
  year: 'desc',
  released: 'desc',
  duration: 'desc',
  pages: 'desc',
  position: 'asc',
};

/**
 * ADR-075 C-02/C-09 (PLAN-060) — the WORK-grain primary sort expressions. Display uses the
 * anchor's values (E-3), so title/author/added sort the anchor; the data-gated metrics take the
 * WORK's value via COALESCE(anchor, partner): duration is the audio side wherever it lives
 * (Length sorts audio-carrying works), year/released fall back to the partner where the anchor
 * lacks them; pages stays the anchor's ebook-side count. NULLS LAST either way (C-09 — honest
 * partial sorts, no fabricated cross-format metric). On the Comics wall the partner join never
 * matches, so every COALESCE degrades to the anchor column — one expression set, both walls.
 */
function workSortExpr(sort: Exclude<BooksSort, 'position'>): SQL {
  switch (sort) {
    case 'author':
      return sql`${booksItems.author}`;
    case 'added':
      return sql`COALESCE(${booksItems.sourceAddedAt}, ${booksItems.firstSeenAt})`;
    case 'year':
      return sql`COALESCE(${booksItems.year}, ${partnerItems.year})`;
    case 'released':
      return sql`COALESCE(${booksItems.releasedAt}, ${partnerItems.releasedAt})`;
    case 'duration':
      return sql`COALESCE(${booksItems.durationSeconds}, ${partnerItems.durationSeconds})`;
    case 'pages':
      return sql`${booksItems.pageCount}`;
    case 'title':
    default:
      return sql`${booksItems.sortTitle}`;
  }
}

/** The drilled work's member position: MIN across the sibling collections AND the pair's two rows
 *  (both twins carry the same builder order — ADR-076 C-03; a paired work dedupes to its position). */
function positionExpr(siblingIds: string[]): SQL {
  return sql`(SELECT MIN(bcm.position) FROM books_collection_members bcm
        WHERE bcm.collection_id IN (${idList(siblingIds)})
          AND (bcm.books_item_id = ${booksItems.id} OR bcm.books_item_id = ${partnerItems.id}))`;
}

function orderForSort(sort: BooksSort, dir?: 'asc' | 'desc', siblingIds?: string[]) {
  const d = sql.raw((dir ?? BOOKS_SORT_NATURAL_DIR[sort]).toUpperCase());
  if (sort === 'position') {
    // DESIGN-038 D-06 — the drilled collection's member position ("List order"). Never offered
    // outside a drill (registry + schema refinement), so siblingIds is always present here.
    return [
      sql`${positionExpr(siblingIds ?? [])} ${d} NULLS LAST`,
      asc(booksItems.sortTitle),
      asc(booksItems.id),
    ];
  }
  if (sort === 'title') return [sql`${workSortExpr(sort)} ${d}`, asc(booksItems.id)];
  // PLAN-056 — sort_title tiebreak: a bulk sync stamps many rows with one transaction instant, so
  // same-instant ties are REAL — break them alphabetically, exactly like the composed union path
  // (COMPOSED_SORT_KEYS), so the two paths never disagree.
  const nulls = sort === 'added' ? sql.raw('') : sql.raw(' NULLS LAST');
  return [
    sql`${workSortExpr(sort)} ${d}${nulls}`,
    asc(booksItems.sortTitle),
    asc(booksItems.id),
  ];
}

/** One OR-ed bucket-range predicate over a length column (D-11 boundaries in BOOK_LENGTH_BOUNDS). */
function bucketRanges(
  col: SQL,
  kind: 'duration' | 'pages',
  buckets: readonly BookLengthBucket[],
): SQL {
  const bounds = BOOK_LENGTH_BOUNDS[kind];
  const ranges = buckets.map((bucket) => {
    const b = bounds[bucket];
    if (b.min !== undefined && b.max !== undefined)
      return sql`(${col} >= ${b.min} AND ${col} < ${b.max})`;
    if (b.min !== undefined) return sql`${col} >= ${b.min}`;
    return sql`${col} < ${b.max!}`;
  });
  return sql`(${sql.join(ranges, sql` OR `)})`;
}

/** Same-field OR over an anchor column and (work grain, E-3) its partner counterpart. */
function unionIn(anchorCol: SQL, partnerCol: SQL, values: readonly string[]): SQL {
  const list = sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
  return sql`(${anchorCol} IN (${list}) OR ${partnerCol} IN (${list}))`;
}

/**
 * DESIGN-026 D-08 (PLAN-029 step 2) — the facet predicates + the D-09 letter jump, shared by
 * search. Same chip semantics as the ledger engine: same-field OR, cross-field AND.
 * ADR-075 C-04 / E-3 (PLAN-060) — WORK grain: every facet matches the UNION of the anchor and its
 * paired partner (the partner join never matches on the Comics wall, so these degrade to the old
 * anchor-only predicates there). Pages/File stay anchor-side (ebook-carried data); the Length
 * (duration) facet reads the work's audio side via COALESCE.
 */
function facetConditions(input: BooksSearchInput) {
  const conditions = [];
  if (input.authors && input.authors.length > 0) {
    conditions.push(unionIn(sql`${booksItems.author}`, sql`${partnerItems.author}`, input.authors));
  }
  if (input.narrators && input.narrators.length > 0) {
    conditions.push(
      unionIn(sql`${booksItems.narrator}`, sql`${partnerItems.narrator}`, input.narrators),
    );
  }
  if (input.series && input.series.length > 0) {
    conditions.push(
      unionIn(sql`${booksItems.seriesName}`, sql`${partnerItems.seriesName}`, input.series),
    );
  }
  if (input.languages && input.languages.length > 0) {
    conditions.push(
      unionIn(
        sql`${booksItems.attrs} ->> 'language'`,
        sql`${partnerItems.attrs} ->> 'language'`,
        input.languages,
      ),
    );
  }
  if (input.formats && input.formats.length > 0) {
    const codes = KAVITA_FORMATS.filter((f) => input.formats!.includes(f.key)).map((f) => f.code);
    conditions.push(
      sql`(${booksItems.attrs} ->> 'format')::int IN (${sql.join(
        codes.map((c) => sql`${c}`),
        sql`, `,
      )})`,
    );
  }
  if (input.lengths && input.lengths.length > 0) {
    // The Pages buckets — the anchor's ebook-side page count (audio-only anchors have none).
    conditions.push(bucketRanges(sql`${booksItems.pageCount}`, 'pages', input.lengths));
  }
  if (input.durations && input.durations.length > 0) {
    // The Length buckets — the WORK's audio side, wherever it lives (anchor or partner).
    conditions.push(
      bucketRanges(
        sql`COALESCE(${booksItems.durationSeconds}, ${partnerItems.durationSeconds})`,
        'duration',
        input.durations,
      ),
    );
  }
  if (input.letter) {
    // DESIGN-026 D-09 — the A–Z jump pages to the first item at the letter by narrowing the active
    // A–Z sort's column (author for the author sort, sort_title otherwise). asc-only by contract.
    const col = input.sort === 'author' ? booksItems.author : booksItems.sortTitle;
    conditions.push(sql`LOWER(${col}) >= ${input.letter}`);
  }
  return conditions;
}

/** ADR-075 C-05 — the anchor's ACTIVE missing-format pairing want (the coverage badge's want
 *  state). Book anchors want audio; audio anchors want the ebook; landed = no active want. */
function activePairingWantExists(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM book_requests pr
     WHERE pr.origin = 'pairing'
       AND pr.pairing_books_item_id = ${booksItems.id}
       AND CASE WHEN ${booksItems.mediaKind} = 'book'
                THEN pr.audio_status ELSE pr.ebook_status END <> 'landed')`;
}

/**
 * One composed Library-Wanted wire item (ADR-057 / DESIGN-029). Per-viewer affordances are computed
 * SERVER-side, never client-guessed: `canSearch` (the force-search button) and `canOpenRequest`
 * (the deep-link into the Goodreads sub-section) require the viewer to OWN the request's
 * integration AND hold the `integrations` section — exactly what `integrations.search` enforces.
 * ADR-065 C-05 — a pairing (system) want has no owner: its search rides the books gate the calling
 * resolver already passed; the Goodreads-sub-section deep link stays goodreads-only.
 */
export interface BooksWantedItem {
  requestId: string;
  /** ADR-065 — 'pairing' rows are the estate's format wants (attributed "Format pairing"). */
  origin: BookRequestOrigin;
  title: string;
  author: string | null;
  shelf: string;
  shelvedAt: string | null;
  /** The WALL format's own status (requested | wanted | grabbed | missing — never landed here). */
  status: BookRequestStatus;
  isComic: boolean;
  // PLAN-048 / ADR-059 D-03 — the activity wall-badge join keys: a book/audiobook want joins the
  // live in-flight read by its LL/GB book id; a comic want by its Kapowarr volume id.
  llBookId: string | null;
  kapowarrVolumeId: string | null;
  /** A parked comic (no Kapowarr route yet) — the honest "waiting on a ComicVine match" note. */
  parked: boolean;
  requestedBy: string[];
  canSearch: boolean;
  canOpenRequest: boolean;
}

/** Map a wanted view to its wire item for one viewer (shared by `books.wanted` + `books.search`). */
function toWantedWireItem(
  v: WantedBookRequestView,
  viewer: { id: string; hasIntegrations: boolean; isAdmin: boolean },
): BooksWantedItem {
  // An ADMIN may force-search ANY user's want (owner directive 2026-07-18 — the owner couldn't
  // force-search another household member's shelf). owns = the viewer shelved it; admins bypass that
  // ownership on the force-search button only (canOpenRequest stays owner-scoped — the Goodreads
  // deep link is into the OWNER's sub-section). The mutation already admits admins-on-behalf and
  // audits actor=admin/subject=requester, so this is a UI-gating fix, not a new capability.
  const owns = v.integrationUserId !== null && v.integrationUserId === viewer.id;
  const canActOnWant = owns || viewer.isAdmin;
  // ADR-065 C-05 / DESIGN-038 D-13 — a SYSTEM want (pairing OR collection) has no owner: its force-search
  // rides the books gate the calling resolver already passed (no ownership / integrations-section check);
  // the Goodreads deep link stays goodreads-only (no owner ⇒ no sub-section to open).
  const isSystemWant = v.origin === 'pairing' || v.origin === 'collection';
  return {
    requestId: v.requestId,
    origin: v.origin,
    title: v.title,
    author: v.author,
    shelf: v.shelf,
    shelvedAt: v.shelvedAt ? v.shelvedAt.toISOString() : null,
    status: v.status,
    isComic: v.isComic,
    llBookId: v.llBookId,
    kapowarrVolumeId: v.kapowarrVolumeId,
    parked: v.isComic && v.unroutableReason === 'comic',
    requestedBy: v.requestedBy,
    canSearch: isSystemWant
      ? isRequestSearchable(v)
      : canActOnWant && viewer.hasIntegrations && isRequestSearchable(v),
    canOpenRequest: !isSystemWant && owns && viewer.hasIntegrations,
  };
}

/**
 * PLAN-056 / DESIGN-029 amendment 3 — one entry of the composed wall stream: an on-disk library
 * row or a wanted overlay row, discriminated by `kind` (the client renders BookCard vs WantedCard).
 */
export type BooksSearchEntry =
  | ({ kind: 'item' } & BooksListItem & {
        /** ADR-065 — feeds the wall's coverage badge (null for a comic — no pairing). */
        formatCoverage: BooksFormatCoverage | null;
        /**
         * ADR-075 C-05 — the anchor's ACTIVE missing-format pairing want, carried ON the card
         * (standalone pairing tiles retired): the coverage badge wears the wanted / in-flight
         * state and the live wall-stage poll joins by llBookId. Null = no open pairing want.
         */
        missingFormatWant: {
          format: 'ebook' | 'audiobook';
          status: BookRequestStatus;
          llBookId: string | null;
        } | null;
      })
  | ({ kind: 'wanted' } & BooksWantedItem);

export interface BooksSearchResult {
  items: BooksSearchEntry[];
  /** Next offset cursor, or null when the last page was reached. */
  nextCursor: number | null;
}

/** ADR-057 (PLAN-045) — which request FORMAT composes a wall's Wanted overlay. ADR-075: the
 *  unified Books wall composes at WORK grain (either book format open); Comics stay per-format. */
const WALL_FORMAT: Record<BooksMediaKind, 'work' | 'comic'> = {
  book: 'work',
  audiobook: 'work',
  comic: 'comic',
};

/** The one refinement a want CAN answer: the text query (title/author substring — the same rule
 *  the client applied before PLAN-056 moved the composition server-side). */
function filterWantedByQuery(
  views: WantedBookRequestView[],
  query: string | undefined,
): WantedBookRequestView[] {
  const q = query?.trim().toLowerCase();
  if (q === undefined || q === '') return views;
  return views.filter((v) => `${v.title} ${v.author ?? ''}`.toLowerCase().includes(q));
}

/**
 * PLAN-056 — the composed union's per-sort PRIMARY key: the item-side SQL expression (exactly the
 * orderForSort primary column), the SQL type the wanted VALUES bind casts to, and whether the sort
 * carries the sort_title tiebreak (mirroring orderForSort so a facet toggle never reshuffles
 * equal-keyed items). 'position' never composes — a want is not a collection member.
 */
const COMPOSED_SORT_KEYS: Record<
  Exclude<BooksSort, 'position'>,
  { itemExpr: () => SQL; cast: 'text' | 'timestamptz' | 'integer'; titleTiebreak: boolean }
> = {
  // itemExprs are the WORK-grain workSortExpr set (ADR-075 — the composed union and the plain
  // path must never disagree). titleTiebreak everywhere but title — requests minted in one sync
  // share a created_at (transaction now()), exactly like a bulk-synced item batch shares
  // first_seen_at: alphabetical within the tie, not uuid.
  title: { itemExpr: () => workSortExpr('title'), cast: 'text', titleTiebreak: false },
  author: { itemExpr: () => workSortExpr('author'), cast: 'text', titleTiebreak: true },
  added: { itemExpr: () => workSortExpr('added'), cast: 'timestamptz', titleTiebreak: true },
  year: { itemExpr: () => workSortExpr('year'), cast: 'integer', titleTiebreak: true },
  released: { itemExpr: () => workSortExpr('released'), cast: 'timestamptz', titleTiebreak: true },
  duration: { itemExpr: () => workSortExpr('duration'), cast: 'integer', titleTiebreak: true },
  pages: { itemExpr: () => workSortExpr('pages'), cast: 'integer', titleTiebreak: true },
};

// PLAN-060 — the old in-process wanted-only sorter retired with the tile-only 'only' page: the
// unified wall's 'only' state spans both want forms (tiles + want-carrying cards), so it pages
// through the SAME composed union as 'all' (wantedPrimarySortValue still keys the VALUES bind).

/** The flat partner-column extension every work-grain page read selects (nullable at runtime —
 *  the LEFT JOIN misses for unpaired anchors and always on the Comics wall). */
const WORK_PARTNER_COLUMNS = {
  partnerId: partnerItems.id,
  partnerNarrator: partnerItems.narrator,
  partnerSeriesName: partnerItems.seriesName,
  partnerYear: partnerItems.year,
  partnerReleasedAt: partnerItems.releasedAt,
  partnerDurationSeconds: partnerItems.durationSeconds,
  partnerSizeBytes: partnerItems.sizeBytes,
};

/** A page row at WORK grain: the anchor's full row + the collapsed partner's carried metadata. */
type WorkRow = BooksItemRow & {
  partnerId: string | null;
  partnerNarrator: string | null;
  partnerSeriesName: string | null;
  partnerYear: number | null;
  partnerReleasedAt: Date | null;
  partnerDurationSeconds: number | null;
  partnerSizeBytes: number | null;
};

/**
 * ADR-075 C-02 / E-3 — project a work row to the wall's list item: the ANCHOR's display values,
 * with the audio-side metrics the anchor lacks carried from the collapsed partner (narrator,
 * series, duration, release date, year, size) so the work card and its facets/sorts agree.
 */
function toWorkListItem(row: WorkRow): BooksListItem {
  const base = toBooksListItem(row);
  if (row.partnerId === null) return base;
  return {
    ...base,
    narrator: base.narrator ?? row.partnerNarrator,
    seriesName: base.seriesName ?? row.partnerSeriesName,
    year: base.year ?? row.partnerYear,
    releasedAt:
      base.releasedAt ?? (row.partnerReleasedAt ? row.partnerReleasedAt.toISOString() : null),
    durationSeconds: base.durationSeconds ?? row.partnerDurationSeconds,
    sizeBytes: base.sizeBytes ?? row.partnerSizeBytes,
  };
}

/** The wire decoration of one work row: coverage + the active missing-format pairing want. */
interface WorkDecoration {
  coverage: BooksFormatCoverage | null;
  want: { format: 'ebook' | 'audiobook'; status: BookRequestStatus; llBookId: string | null } | null;
}

/**
 * ADR-065 / DESIGN-036 D-09 + ADR-075 C-05 — the page's coverage + want-state lookup: coverage
 * falls straight out of the collapse join (a carried partner = 'both'); the UNPAIRED anchors get
 * one bounded read over their pairing wants so the coverage badge can wear the missing format's
 * wanted / in-flight state. Comics never pair — both stay null.
 */
async function workDecorations(
  db: Database,
  rows: Array<Pick<WorkRow, 'id' | 'mediaKind' | 'partnerId'>>,
): Promise<(row: Pick<WorkRow, 'id' | 'mediaKind' | 'partnerId'>) => WorkDecoration> {
  const unpairedIds = rows
    .filter((r) => r.mediaKind !== 'comic' && r.partnerId === null)
    .map((r) => r.id);
  const wantByAnchor = new Map<
    string,
    { ebookStatus: BookRequestStatus; audioStatus: BookRequestStatus; llBookId: string | null }
  >();
  if (unpairedIds.length > 0) {
    const wants = await db
      .select({
        anchorId: bookRequests.pairingBooksItemId,
        ebookStatus: bookRequests.ebookStatus,
        audioStatus: bookRequests.audioStatus,
        llBookId: bookRequests.llBookId,
      })
      .from(bookRequests)
      .where(
        and(
          eq(bookRequests.origin, 'pairing'),
          inArray(bookRequests.pairingBooksItemId, unpairedIds),
        ),
      );
    for (const w of wants) {
      if (w.anchorId !== null) {
        wantByAnchor.set(w.anchorId, {
          ebookStatus: w.ebookStatus,
          audioStatus: w.audioStatus,
          llBookId: w.llBookId,
        });
      }
    }
  }
  return (row): WorkDecoration => {
    if (row.mediaKind === 'comic') return { coverage: null, want: null };
    if (row.partnerId !== null) return { coverage: 'both', want: null };
    const coverage: BooksFormatCoverage = row.mediaKind === 'book' ? 'ebook' : 'audio';
    const missingFormat: 'ebook' | 'audiobook' =
      row.mediaKind === 'book' ? 'audiobook' : 'ebook';
    const want = wantByAnchor.get(row.id);
    const status = want
      ? missingFormat === 'audiobook'
        ? want.audioStatus
        : want.ebookStatus
      : null;
    return {
      coverage,
      // landed = inert (the format arrived; the pair forms on the next pairing run) — no state.
      want:
        want && status !== null && status !== 'landed'
          ? { format: missingFormat, status, llBookId: want.llBookId }
          : null,
    };
  };
}

/** The work-grain FROM joins for the composed raw-SQL path (the query-builder path builds the
 *  same shape via .leftJoin — the two must stay twins). */
function workJoins(): SQL {
  return sql`
      LEFT JOIN ${booksFormatPairs} ON ${booksFormatPairs.bookItemId} = ${booksItems.id}
      LEFT JOIN books_items "partner"
        ON ${partnerItems.id} = ${booksFormatPairs.audioItemId}
       AND ${partnerItems.deletedAt} IS NULL`;
}

/** ADR-066 / DESIGN-038 D-05 — the group card's cover-fan sample bound (the PLAN-037 idiom). */
const BOOKS_COLLECTION_COVER_SAMPLE = 4;

// DESIGN-038 D-05 amendment 2026-07-20 (ADR-076 C-04) — the old three-way majority tie order
// retired with the Audiobooks wall: the mapping is now a COMIC PARTITION (majority comic ⇒ the
// Comics wall, otherwise the unified Books wall; ties go to Books) applied inline below.

/** One Collections group card on a book wall (the GroupCard contract + the D-06 ordered flag). */
export interface BooksCollectionGroup {
  /** The books_collections row uuid (the `?group=` drill key — stable, key-not-name). */
  key: string;
  label: string;
  /** Resolved live members of the WALL's kind (never the raw source item_count — R-217). */
  count: number;
  /** Up to 4 member cover-proxy URLs, in member-position order (the cover-fan art). */
  coverUrls: string[];
  /** Always null — a collection has no portrait source; the cover fan is the art. */
  imageUrl: null;
  /** Whether the SOURCE carries an explicit member order — drives the drill's position sort. */
  ordered: boolean;
  /**
   * PROVENANCE badge (owner directive 2026-07-16) — the display name of the software that created
   * the collection ("Libretto" / "Kavita" / "Audiobookshelf"), or null when unknown (no badge).
   * Resolved server-side from books_collections.created_by via provenanceDisplayName.
   */
  provenance: string | null;
  /** DESIGN-038 D-12 — the collection's OPEN, free-form owner category (T-186 model), or null when
   *  it carries none (no chip; shows only under "All"). Drives the dynamic category chip row. */
  category: string | null;
  /**
   * DESIGN-043 D-01/D-09 amend (2026-07-18) — the Libretto recipe id that MANAGES this collection, or
   * null for a hand-made collection with no recipe. The Library wall drill header uses it to deep-link
   * to `/collections?tab=<mediaType>&edit=<recipeId>` (no link when null — nothing to edit there).
   */
  librettoRecipeId: string | null;
}

/** DESIGN-038 D-12 — the books category chip row's counts, keyed by the DISTINCT categories actually
 *  present among a wall's cards (only non-null categories appear; the client orders them
 *  hint-list-then-alphabetical). Mirrors `ledger.LedgerCollectionCategoryCounts`. */
export type BooksCollectionCategoryCounts = Record<string, number>;

export const booksRouter = router({
  /** The caller's own books-section visibility (any authed user) — for the client tab gate. */
  access: authedProcedure.query(({ ctx }) => {
    const level = effectiveSectionLevel(ctx.user.role, 'books');
    return { level, visible: level !== 'disabled' };
  }),

  /**
   * ADR-057 (PLAN-045 step 4) — the Library-Wanted COMPOSITION: household Wanted tiles for one book wall,
   * composed from the `book_requests` ledger (the *arr monitored-but-missing idiom for books; the
   * books_items mirror stays PURE, ADR-046). Gated by the BOOKS section like the wall it rides (owner
   * ruling Q-01 — household visibility wherever the Books walls are granted; the tRPC layer is the
   * server-authoritative gate). Per-viewer affordances are computed HERE, never client-guessed:
   * `canSearch` (the force-search button) and `canOpenRequest` (the deep-link into the Goodreads
   * sub-section) require the viewer to OWN the request's integration AND hold the `integrations`
   * section — exactly what `integrations.search` enforces server-side.
   */
  wanted: booksProcedure
    .input(z.object({ mediaKind: z.enum(BOOKS_MEDIA_KINDS) }))
    .query(async ({ ctx, input }) => {
      const views = await getWantedBookRequests({
        db: ctx.db,
        format: WALL_FORMAT[input.mediaKind],
      });
      const viewer = {
        id: ctx.user.id,
        hasIntegrations: effectiveSectionLevel(ctx.user.role, 'integrations') !== 'disabled',
        isAdmin: ctx.user.role.isAdmin, // admins may force-search ANY user's want (2026-07-18)
      };
      return { items: views.map((v) => toWantedWireItem(v, viewer)) };
    }),

  /**
   * ADR-057 amendment (PLAN-047 — the Wanted DETAIL page) — one request's FULL detail for
   * `/library/books/wanted/[requestId]`, the Movies/TV parity page the Library-Wanted + Goodreads-items
   * cards now click through to. Gated by `booksOrIntegrationsProcedure` — reachable by whoever can see the
   * card that links to it (books-section for the household Library-Wanted cards; integrations for the
   * Goodreads items wall), server-authoritative. The per-format `searchable` affordance stays owner-scoped
   * (OWN the integration AND hold `integrations`, exactly what `integrations.search` enforces) — a
   * books-only viewer sees the status rows but no Force-Search button, and the action itself FORBIDs them.
   */
  wantedDetail: booksOrIntegrationsProcedure
    .input(z.object({ requestId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      const view = await getBookRequestDetail({ db: ctx.db, requestId: input.requestId });
      if (!view)
        throw new TRPCError({ code: 'NOT_FOUND', message: `Request ${input.requestId} not found` });
      const owns = view.integrationUserId !== null && view.integrationUserId === ctx.user.id;
      const viewerHasIntegrations =
        effectiveSectionLevel(ctx.user.role, 'integrations') !== 'disabled';
      // ADR-065 C-05 / DESIGN-038 D-13 — a SYSTEM want (pairing OR collection) has no owner: its per-format
      // search is BOOKS-gated (the estate's want belongs to everyone the books walls belong to); goodreads
      // wants keep owner + integrations. Owner directive 2026-07-18 — an ADMIN may force-search ANY user's
      // want (bypasses `owns`); the mutation already admits admins-on-behalf and audits actor/subject.
      const canSearch =
        view.origin === 'pairing' || view.origin === 'collection'
          ? effectiveSectionLevel(ctx.user.role, 'books') !== 'disabled'
          : (owns || ctx.user.role.isAdmin) && viewerHasIntegrations;
      const requestSearchable = isRequestSearchable(view);

      // Per-format status ROWS (the *arr per-grain idiom): a comic is the single Kapowarr leg; a
      // book/audiobook want carries BOTH LazyLibrarian legs. `searchable` = the viewer may fire it AND
      // that format is still acquirable (whole-request searchable AND this format hasn't landed).
      const formats: Array<{
        format: 'ebook' | 'audiobook' | 'comic';
        status: BookRequestStatus;
        searchable: boolean;
      }> = view.isComic
        ? [
            {
              format: 'comic',
              status: view.comicStatus ?? 'requested',
              searchable: canSearch && requestSearchable,
            },
          ]
        : [
            {
              format: 'ebook',
              status: view.ebookStatus,
              searchable: canSearch && requestSearchable && view.ebookStatus !== 'landed',
            },
            {
              format: 'audiobook',
              status: view.audioStatus,
              searchable: canSearch && requestSearchable && view.audioStatus !== 'landed',
            },
          ];

      return {
        requestId: view.requestId,
        /** ADR-065 — the client dispatches the right search mutation on this ('pairing' ⇒ books-gated). */
        origin: view.origin,
        title: view.title,
        author: view.author,
        shelf: view.shelf,
        shelvedAt: view.shelvedAt ? view.shelvedAt.toISOString() : null,
        requestedBy: view.requestedBy,
        isComic: view.isComic,
        /** The poster GLYPH kind — 'book' covers both LL legs; 'comic' for the Kapowarr leg. */
        mediaKind: view.isComic ? ('comic' as const) : ('book' as const),
        /** The cover-proxy art when the want is matched into the library; null ⇒ the designed glyph tile. */
        posterUrl: view.matched
          ? booksCoverUrlFor(view.matched.source, view.matched.externalId, view.matched.coverRef)
          : null,
        /** Present ⇒ the want is already in the library (the "View in library" link target). */
        matchedBooksItemId: view.matchedBooksItemId,
        /** A parked comic (no Kapowarr route yet) — the honest "waiting on a ComicVine match" note. */
        parked: view.isComic && view.unroutableReason === 'comic',
        lastSearchedAt: view.lastSearchedAt ? view.lastSearchedAt.toISOString() : null,
        /** The viewer-level force-search gate (owner + integrations section) — per-format detail below. */
        canSearch,
        // PLAN-048 / ADR-059 D-10 — the live in-flight join keys: the detail polls `activity.itemStatus` per
        // format (`books:ll:<llBookId>:<format>` / `kapowarr:<volumeId>`) so firing a re-search shows the
        // format MOVE (searching → downloading → importing) exactly like the Fix dialog.
        llBookId: view.llBookId,
        kapowarrVolumeId: view.kapowarrVolumeId,
        formats,
      };
    }),

  /**
   * One media kind's wall (poster-grid rows), filtered + sorted, offset-paginated. Live library
   * rows PLUS, per the three-state `wanted` input (PLAN-056 / DESIGN-029 amendment 3), the
   * composed household Wanted overlay:
   *   • 'all' (default) — wanted rows JOIN the stream and participate HONESTLY in the active sort
   *     (real keys where a want has them — wantedPrimarySortValue documents the mapping; a want is
   *     never pinned to the top);
   *   • 'only' — the wanted rows alone, in the active sort;
   *   • 'hide' — library rows only (the wanted rows are excluded HERE, never client-hidden).
   * The D-09 honesty rule is enforced server-side too: a want answers only the text query — any
   * other refinement (facet chips, A–Z letter, read-state, a collection drill) excludes wants from
   * the 'all' stream ('only' keeps its query-narrowed list: the caller asked for exactly the wants).
   */
  search: booksProcedure
    .input(booksSearchInputSchema)
    .query(async ({ ctx, input }): Promise<BooksSearchResult> => {
      const viewer = {
        id: ctx.user.id,
        hasIntegrations: effectiveSectionLevel(ctx.user.role, 'integrations') !== 'disabled',
        isAdmin: ctx.user.role.isAdmin, // admins may force-search ANY user's want (2026-07-18)
      };
      const kinds = wallKindsFor(input.mediaKind);
      const unified = isUnifiedWall(input.mediaKind);
      // DESIGN-038 D-13 — a COLLECTION drill composes the COLLECTION's OWN wanted members (its missing
      // members, origin='collection'), not the household overlay: held tiles + Wanted tiles side by side.
      const isCollectionDrill = input.collection !== undefined;
      // ADR-076 C-03 — a merged multi-target collection drills as ONE: the predicate + position
      // sort span the drilled row's recipe TWINS (solo collections resolve to themselves).
      const siblingIds = isCollectionDrill
        ? await collectionSiblingIds(ctx.db, input.collection!)
        : undefined;
      // Refinements a synthetic want cannot answer (the D-09 rule, now server-authoritative). NOTE: the
      // collection drill itself is NOT a narrowing here (D-13 — the wants ARE the collection's missing
      // members); any OTHER facet inside the drill still excludes want TILES (a want can't answer a
      // genre chip). The Format seg is availability semantics (ADR-075 C-03) — a want holds neither
      // format yet, so a non-All seg narrows the tiles away too.
      const narrowed =
        (input.genres?.length ?? 0) > 0 ||
        (input.authors?.length ?? 0) > 0 ||
        (input.narrators?.length ?? 0) > 0 ||
        (input.series?.length ?? 0) > 0 ||
        (input.languages?.length ?? 0) > 0 ||
        (input.formats?.length ?? 0) > 0 ||
        (input.lengths?.length ?? 0) > 0 ||
        (input.durations?.length ?? 0) > 0 ||
        (unified && input.format !== 'all') ||
        input.readState !== undefined ||
        input.letter !== undefined;
      // Which wants become TILES. ADR-075 C-05 — on the unified wall a PAIRING want's anchor work
      // ALREADY renders as a library card (its coverage badge carries the want), so pairing views
      // never compose as standalone tiles; goodreads-origin wants (no library anchor) keep theirs.
      // A collection drill composes the collection's OWN wants (both twins, deduped — ADR-076 C-05).
      // Position sort composes ONLY on a collection drill (a want has no member position).
      const composeWanted =
        (input.sort !== 'position' || isCollectionDrill) &&
        (input.wanted === 'only' || input.wanted === 'all') &&
        !narrowed;
      const wantedViews = composeWanted
        ? filterWantedByQuery(
            isCollectionDrill
              ? await getCollectionWantedBookRequests({
                  db: ctx.db,
                  collectionId: input.collection!,
                })
              : (
                  await getWantedBookRequests({ db: ctx.db, format: WALL_FORMAT[input.mediaKind] })
                ).filter((v) => !unified || v.origin !== 'pairing'),
            input.query,
          )
        : [];

      const conditions = [
        kinds.length === 1
          ? eq(booksItems.mediaKind, kinds[0]!)
          : inArray(booksItems.mediaKind, kinds),
        isNull(booksItems.deletedAt),
        // ADR-075 C-02 — collapse: a live-paired audio row folds into its ebook anchor's card.
        anchorExclusion(),
      ];
      if (input.query && input.query.length > 0) {
        // The text query matches the WORK: anchor or carried partner, title or author (E-3 union).
        const like = `%${input.query}%`;
        conditions.push(
          sql`(${booksItems.title} ILIKE ${like} OR ${booksItems.author} ILIKE ${like}
             OR ${partnerItems.title} ILIKE ${like} OR ${partnerItems.author} ILIKE ${like})`,
        );
      }
      if (input.genres && input.genres.length > 0) {
        // PLAN-029 fix — the ledger engine's jsonb `?|` overlap idiom (same-field OR); work grain
        // matches the UNION of the pair's genre arrays (E-3).
        const arr = sql`ARRAY[${sql.join(
          input.genres.map((g) => sql`${g}`),
          sql`, `,
        )}]::text[]`;
        conditions.push(sql`(${booksItems.genres} ?| ${arr} OR ${partnerItems.genres} ?| ${arr})`);
      }
      // DESIGN-026 D-08/D-09 (PLAN-029) — author/narrator/series/language/format/length facets + the
      // A–Z letter jump (same-field OR, cross-field AND — the shared chip semantics; union-matched).
      conditions.push(...facetConditions(input));
      // ADR-075 C-03 — the three-state Format seg, availability semantics: 'ebook' = works holding
      // an ebook side (the anchor rule makes those exactly the book-anchored works); 'audiobook' =
      // works holding audio (audio-only anchors + paired anchors carrying a partner).
      if (unified && input.format !== 'all') {
        conditions.push(
          input.format === 'ebook'
            ? sql`${booksItems.mediaKind} = 'book'`
            : sql`(${booksItems.mediaKind} = 'audiobook' OR ${partnerItems.id} IS NOT NULL)`,
        );
      }
      // ADR-066 / DESIGN-038 D-06 (PLAN-051) — the drilled COLLECTION narrowing: one EXISTS
      // predicate over the mirror's resolved members (the drilled row + its recipe twins, at WORK
      // grain — anchor or partner membership), so the drilled wall inherits every other
      // filter/sort/pager (and the books gate) unchanged.
      if (siblingIds) {
        conditions.push(
          sql`EXISTS (SELECT 1 FROM ${booksCollectionMembers} bcm
                WHERE bcm.collection_id IN (${idList(siblingIds)})
                  AND (bcm.books_item_id = ${booksItems.id}
                       OR bcm.books_item_id = ${partnerItems.id}))`,
        );
      }
      // ADR-053 / DESIGN-026 D-07 — the per-user ABS read-state facet (viewer-scoped; data-gated to
      // audio-carrying works — Kavita rows never carry user_book_progress, so on the unified wall
      // the progress row may sit on the collapsed PARTNER: match either side of the work. Bound to
      // the SESSION user (never the wire).
      if (input.readState) {
        const viewerId = sql`${ctx.user.id}::uuid`;
        const side = sql`(ubp.books_item_id = ${booksItems.id} OR ubp.books_item_id = ${partnerItems.id})`;
        if (input.readState === 'read') {
          conditions.push(
            sql`EXISTS (SELECT 1 FROM ${userBookProgress} ubp WHERE ${side} AND ubp.app_user_id = ${viewerId} AND ubp.is_finished = true)`,
          );
        } else if (input.readState === 'in_progress') {
          conditions.push(
            sql`EXISTS (SELECT 1 FROM ${userBookProgress} ubp WHERE ${side} AND ubp.app_user_id = ${viewerId} AND ubp.in_progress = true)`,
          );
        } else {
          conditions.push(
            sql`NOT EXISTS (SELECT 1 FROM ${userBookProgress} ubp WHERE ${side} AND ubp.app_user_id = ${viewerId} AND ubp.is_finished = true)`,
          );
        }
      }
      // ADR-075 C-05 / R-213 — the Wanted seg filters over BOTH forms on the unified wall: 'only'
      // = the wanted set (goodreads tiles + cards carrying an active missing-format want); 'hide'
      // = its EXACT negation (cards with no active want, no tiles) — the 2026-07-18 partition
      // grammar, server-side. On the Comics wall no card carries a pairing want, so these degrade
      // to the old tile-only semantics.
      if (input.wanted === 'only') conditions.push(activePairingWantExists());
      if (input.wanted === 'hide') conditions.push(sql`NOT ${activePairingWantExists()}`);

      // PLAN-056 / DESIGN-029 amendment 3 — the COMPOSED page (live want TILES to weave): one
      // UNION of the item query and the (bounded) wanted list as a VALUES bind, each side carrying
      // the SAME per-sort key columns, ordered + paged by Postgres — so a wanted card lands exactly
      // where the active sort says (the offset cursor counts composed entries).
      if (wantedViews.length > 0) {
        // DESIGN-038 D-13 — on a collection drill the 'position' sort composes too: held members carry
        // their member position, wanted members have NONE (NULL ⇒ NULLS LAST ⇒ after the held reading
        // order). Off-drill, position never composes (guarded above); every other sort uses its item-side
        // key expression with the want's own primary value.
        const isPositionDrill = input.sort === 'position';
        const key =
          input.sort === 'position'
            ? {
                itemExpr: () => positionExpr(siblingIds ?? []),
                cast: 'integer' as const,
                titleTiebreak: true,
              }
            : COMPOSED_SORT_KEYS[input.sort];
        const castRaw = sql.raw(key.cast);
        const values = sql.join(
          wantedViews.map(
            (v) =>
              sql`(${v.requestId}::uuid, ${isPositionDrill ? sql`NULL` : sql`${wantedPrimarySortValue(v, input.sort)}`}::${castRaw}, ${wantedSortTitle(v.title)}::text)`,
          ),
          sql`, `,
        );
        const dirWord = sql.raw((input.dir ?? BOOKS_SORT_NATURAL_DIR[input.sort]).toUpperCase());
        const tiebreak = key.titleTiebreak ? sql.raw(', sk2 ASC') : sql.raw('');
        const composed = await ctx.db.execute<{ kind: 'item' | 'wanted'; id: string }>(sql`
          SELECT kind, id FROM (
            SELECT 'item' AS kind, ${booksItems.id} AS id,
                   ${key.itemExpr()} AS sk1, ${booksItems.sortTitle} AS sk2
              FROM ${booksItems}${workJoins()}
             WHERE ${and(...conditions)}
            UNION ALL
            SELECT 'wanted' AS kind, w.id, w.sk1, w.sk2
              FROM (VALUES ${values}) AS w(id, sk1, sk2)
          ) AS u
          ORDER BY sk1 ${dirWord} NULLS LAST${tiebreak}, id ASC
          LIMIT ${input.limit} OFFSET ${input.cursor}
        `);
        const refs =
          composed.rows ?? (composed as unknown as Array<{ kind: 'item' | 'wanted'; id: string }>);
        const itemIds = refs.filter((r) => r.kind === 'item').map((r) => r.id);
        const itemRows =
          itemIds.length > 0
            ? ((await ctx.db
                .select({ ...getTableColumns(booksItems), ...WORK_PARTNER_COLUMNS })
                .from(booksItems)
                .leftJoin(booksFormatPairs, eq(booksFormatPairs.bookItemId, booksItems.id))
                .leftJoin(
                  partnerItems,
                  and(
                    eq(partnerItems.id, booksFormatPairs.audioItemId),
                    isNull(partnerItems.deletedAt),
                  ),
                )
                .where(inArray(booksItems.id, itemIds))) as unknown as WorkRow[])
            : [];
        const itemById = new Map(itemRows.map((r) => [r.id, r]));
        const decorate = await workDecorations(ctx.db, itemRows);
        const wantedById = new Map(wantedViews.map((v) => [v.requestId, v]));
        return {
          items: refs.map((r): BooksSearchEntry => {
            if (r.kind === 'item') {
              const row = itemById.get(r.id)!;
              const deco = decorate(row);
              return {
                kind: 'item',
                ...toWorkListItem(row),
                formatCoverage: deco.coverage,
                missingFormatWant: deco.want,
              };
            }
            return { kind: 'wanted', ...toWantedWireItem(wantedById.get(r.id)!, viewer) };
          }),
          nextCursor: refs.length === input.limit ? input.cursor + input.limit : null,
        };
      }

      const rows = (await ctx.db
        .select({ ...getTableColumns(booksItems), ...WORK_PARTNER_COLUMNS })
        .from(booksItems)
        .leftJoin(booksFormatPairs, eq(booksFormatPairs.bookItemId, booksItems.id))
        .leftJoin(
          partnerItems,
          and(eq(partnerItems.id, booksFormatPairs.audioItemId), isNull(partnerItems.deletedAt)),
        )
        .where(and(...conditions))
        .orderBy(...orderForSort(input.sort, input.dir, siblingIds))
        .limit(input.limit)
        .offset(input.cursor)) as unknown as WorkRow[];

      const decorate = await workDecorations(ctx.db, rows);
      return {
        items: rows.map((row): BooksSearchEntry => {
          const deco = decorate(row);
          return {
            kind: 'item',
            ...toWorkListItem(row),
            formatCoverage: deco.coverage,
            missingFormatWant: deco.want,
          };
        }),
        nextCursor: rows.length === input.limit ? input.cursor + input.limit : null,
      };
    }),

  /**
   * ADR-047 (PLAN-028) — one book/audiobook/comic's detail (the in-app drill-in the poster now opens; books
   * previously jumped straight out). Gated by `booksProcedure` (the `books` section — books gating is
   * unchanged). Deep-links OUT to Kavita/ABS as the primary action; no Fix/Force-Search (books have no *arr
   * semantics, ADR-046). Live rows only — a tombstoned/absent id is NOT_FOUND.
   */
  detail: booksProcedure
    .input(z.object({ id: z.uuid() }))
    .query(async ({ ctx, input }): Promise<BooksDetailResult> => {
      const [row] = await ctx.db
        .select()
        .from(booksItems)
        .where(and(eq(booksItems.id, input.id), isNull(booksItems.deletedAt)));
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Book ${input.id} not found` });
      }
      // ADR-062 / ADR-071 — may THIS caller fire a Fix / Force Search? Server-computed off the ONE
      // role-grant helper (never a client guess): admin implies both; otherwise the fine-grained
      // `fix_book` / `force_search_book` grants (the owner opens each per role via /admin → roles —
      // THE FLIP). One grant read, both flags derived.
      const grantedActions = ctx.user.role.isAdmin
        ? null
        : new Set(await bookActionsForRole({ db: ctx.db, roleId: ctx.user.role.id }));
      const canFix = ctx.user.role.isAdmin || grantedActions!.has('fix_book');
      const canForceSearch = ctx.user.role.isAdmin || grantedActions!.has('force_search_book');
      // ADR-065 / DESIGN-036 D-09 — the pairing state: paired ⇒ the counterpart's own deep link (the
      // second consume button); unpaired ⇒ the missing format + its pairing want. Comics carry none.
      const pairing = await resolvePairingState(ctx.db, row);

      // DESIGN-025 D-08 — the About "Collections" chips: the mirrored books-collections this title is a
      // live member of (reusing the ADR-066 membership the walls read). A chip links to the wall's
      // collection drill (`?group=<books_collections.id>`), matching the movie collections-chip behavior.
      const collectionRows = await ctx.db
        .select({ id: booksCollections.id, title: booksCollections.title })
        .from(booksCollectionMembers)
        .innerJoin(booksCollections, eq(booksCollections.id, booksCollectionMembers.collectionId))
        .where(eq(booksCollectionMembers.booksItemId, row.id))
        .orderBy(asc(booksCollections.title));

      // DESIGN-025 D-08 / DESIGN-033 — the History: this item's OWN records. The audited book-Fix trail
      // (book_fix_requests) + the linked request lifecycle (book_requests — the want that landed / pairs
      // this title). Newest first, the movie-History idiom. Real owner-visible value (fixes ran today).
      const fixRows = await ctx.db
        .select({
          id: bookFixRequests.id,
          status: bookFixRequests.status,
          reason: bookFixRequests.reason,
          reasonText: bookFixRequests.reasonText,
          createdAt: bookFixRequests.createdAt,
          completedAt: bookFixRequests.completedAt,
          requesterDisplayName: users.displayName,
        })
        .from(bookFixRequests)
        .leftJoin(users, eq(users.id, bookFixRequests.requesterId))
        .where(eq(bookFixRequests.booksItemId, row.id))
        .orderBy(desc(bookFixRequests.createdAt));

      const requestRows = await ctx.db
        .select({
          id: bookRequests.id,
          origin: bookRequests.origin,
          ebookStatus: bookRequests.ebookStatus,
          audioStatus: bookRequests.audioStatus,
          comicStatus: bookRequests.comicStatus,
          lastSearchedAt: bookRequests.lastSearchedAt,
          createdAt: bookRequests.createdAt,
        })
        .from(bookRequests)
        .where(
          or(
            eq(bookRequests.matchedBooksItemId, row.id),
            eq(bookRequests.pairingBooksItemId, row.id),
          ),
        )
        .orderBy(desc(bookRequests.createdAt));

      return {
        canFix,
        canForceSearch,
        item: {
          ...toBooksListItem(row),
          libraryName: row.libraryName,
          lastSyncedAt: row.lastSeenAt.toISOString(),
          summary: row.summary,
          publisher: row.publisher,
          language:
            ((row.attrs as Record<string, unknown> | null)?.language as string | null) ?? null,
          isbn: row.isbn,
          fileCount: row.fileCount,
          formatLabel: bookFormatLabel(row),
          addedAt: row.sourceAddedAt ? row.sourceAddedAt.toISOString() : null,
        },
        play: {
          app: row.source === 'audiobookshelf' ? 'audiobookshelf' : 'kavita',
          label: booksPlayLabel(row.source),
          url: row.deepLinkUrl,
        },
        pairing,
        collections: collectionRows,
        fixes: fixRows.map((f) => ({
          id: f.id,
          status: f.status,
          reason: f.reason,
          reasonText: f.reasonText,
          requesterDisplayName: f.requesterDisplayName ?? null,
          createdAt: f.createdAt.toISOString(),
          completedAt: f.completedAt ? f.completedAt.toISOString() : null,
        })),
        requests: requestRows.map((r) => ({
          id: r.id,
          origin: r.origin,
          ebookStatus: r.ebookStatus,
          audioStatus: r.audioStatus,
          comicStatus: r.comicStatus ?? null,
          lastSearchedAt: r.lastSearchedAt ? r.lastSearchedAt.toISOString() : null,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    }),

  /**
   * ADR-065 C-05 / DESIGN-036 D-08 — the BOOKS-gated force-search for a PAIRING want. A system want
   * has no owner, so the ADR-057 ownership gate cannot apply: whoever the books walls belong to may
   * nudge the estate's own want (server-authoritative `booksProcedure`, ≥ read_only). Audited exactly
   * like every manual search (`request_book_search` via recordManualSearch — the actor is the caller),
   * then the confined LL searchBook fires for the not-yet-landed format (the held `landed` format
   * narrows itself out). A GOODREADS want is FORBIDDEN here — it keeps `integrations.search` and its
   * ownership semantics untouched.
   */
  searchPairingWant: booksProcedure
    .input(z.object({ requestId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const request = await getBookRequestById({ db: ctx.db, id: input.requestId });
      if (!request) throw new TRPCError({ code: 'NOT_FOUND' });
      // ADR-065 C-05 / DESIGN-038 D-13 — the books-gated force-search surface for OWNERLESS system wants:
      // pairing (estate format wants) AND collection (a collection's missing members). A goodreads want is
      // FORBIDDEN here — it keeps `integrations.search` and its ownership semantics untouched.
      if (request.origin !== 'pairing' && request.origin !== 'collection') {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }
      return mapDomainErrors(async () => {
        const result = await runManualBookSearch({
          db: ctx.db,
          requestId: input.requestId,
          userId: ctx.user.id,
          actorId: ctx.user.id,
          ll: resolveLazyLibrarianBundle(ctx),
        });
        return { target: 'lazylibrarian' as const, ...result };
      });
    }),

  /**
   * ADR-071 (media-action UX) — the books FORCE SEARCH: a one-click quick re-search of an on-disk
   * title (re-grab a fresh/better copy), the books leg of the unified Fix + Force Search vocabulary.
   * DISTINCT from Fix (the reasoned, durable book_fix_request repair): it leaves NO durable row and
   * takes no reason. Grant-gated server-side — admin OR the role's `force_search_book` grant (the
   * ratified rule that SUPERSEDES the #375 owns||isAdmin stopgap for the books force-search surface;
   * on-disk books are the only detail surface, so on-disk ⇒ Fix + Force Search when granted). Reuses
   * the confined LL / Kapowarr acquisition writes; an outage ⇒ BAD_GATEWAY after the audit.
   */
  forceSearch: booksProcedure
    .input(z.object({ booksItemId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const allowed =
        ctx.user.role.isAdmin ||
        (await bookActionsForRole({ db: ctx.db, roleId: ctx.user.role.id })).includes(
          'force_search_book',
        );
      if (!allowed) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You do not have permission to Force Search books.',
        });
      }
      return mapDomainErrors(() =>
        runBookItemForceSearch({
          db: ctx.db,
          booksItemId: input.booksItemId,
          requesterId: ctx.user.id,
          ll: resolveLazyLibrarianBundle(ctx),
          kapowarr: resolveKapowarrBundle(ctx),
        }),
      );
    }),

  /**
   * Distinct facet values for a media kind's chip bar (DESIGN-026 D-08 — the shipped genres DISTINCT,
   * now joined by author/narrator/series/language/format). Every list is populated-value-gated by
   * construction (ADR-051 C-06): an empty medium simply returns [] and the client renders no chip —
   * e.g. Kavita book/comic genres/narrators, ABS formats.
   */
  filterFacets: booksProcedure.input(z.object({ mediaKind: z.enum(BOOKS_MEDIA_KINDS) })).query(
    async ({
      ctx,
      input,
    }): Promise<{
      genres: string[];
      authors: string[];
      narrators: string[];
      series: string[];
      languages: string[];
      formats: Array<{ key: string; label: string }>;
      /** ADR-075 C-04 — the unified wall's data-gates: whether any live work carries an ebook /
       *  audio side (Pages+File gate on hasEbook; Length/Narrator/Series/Language/Read on hasAudio). */
      hasEbook: boolean;
      hasAudio: boolean;
    }> => {
      // ADR-075 C-04 — the unified wall's facet VALUES span BOTH kinds (collapsed audio rows
      // included: their narrator/genres ride the work card as carried partner metadata, so their
      // values must be offerable). Comics stay single-kind.
      const kinds = wallKindsFor(input.mediaKind);
      const kindList = sql.join(
        kinds.map((k) => sql`${k}`),
        sql`, `,
      );
      const live = sql`${booksItems.mediaKind} IN (${kindList}) AND ${booksItems.deletedAt} IS NULL`;
      const genreRows = await ctx.db
        .select({ genre: sql<string>`genre` })
        .from(
          sql`(SELECT DISTINCT jsonb_array_elements_text(${booksItems.genres}) AS genre
               FROM ${booksItems}
               WHERE ${live}) AS books_genres`,
        )
        .orderBy(sql`genre`);
      const distinctCol = async (col: SQL): Promise<string[]> => {
        const rows = await ctx.db.execute<{ value: string }>(
          sql`SELECT DISTINCT ${col} AS value FROM ${booksItems}
                 WHERE ${live} AND ${col} IS NOT NULL AND ${col} <> ''
                 ORDER BY value ASC`,
        );
        return (rows.rows ?? (rows as unknown as { value: string }[])).map((r) => r.value);
      };
      const formatCodes = await ctx.db.execute<{ value: number }>(
        sql`SELECT DISTINCT (${booksItems.attrs} ->> 'format')::int AS value FROM ${booksItems}
               WHERE ${live} AND ${booksItems.attrs} ? 'format'`,
      );
      const codes = new Set(
        (formatCodes.rows ?? (formatCodes as unknown as { value: number }[])).map((r) =>
          Number(r.value),
        ),
      );
      // ADR-075 C-04 — the format-side presence gates (one cheap read; comics report their own
      // kind honestly — the registry never gates a Comics facet on these).
      const sideRows = await ctx.db.execute<{ media_kind: string }>(
        sql`SELECT DISTINCT ${booksItems.mediaKind} AS media_kind FROM ${booksItems} WHERE ${live}`,
      );
      const sides = new Set(
        (sideRows.rows ?? (sideRows as unknown as { media_kind: string }[])).map(
          (r) => r.media_kind,
        ),
      );
      return {
        genres: genreRows.map((r) => r.genre).filter((g): g is string => typeof g === 'string'),
        authors: await distinctCol(sql`${booksItems.author}`),
        narrators: await distinctCol(sql`${booksItems.narrator}`),
        series: await distinctCol(sql`${booksItems.seriesName}`),
        languages: await distinctCol(sql`${booksItems.attrs} ->> 'language'`),
        // KAVITA_FORMATS order (not code order) so the chip lists epub/archive first.
        formats: KAVITA_FORMATS.filter((f) => codes.has(f.code)).map((f) => ({
          key: f.key,
          label: f.label,
        })),
        hasEbook: sides.has('book') || sides.has('comic'),
        hasAudio: sides.has('audiobook'),
      };
    },
  ),

  /**
   * DESIGN-026 D-04 (PLAN-029 step 3, art amended by the group-card-art pass) — the grouped view's
   * aggregate cards: one card per author with an item count + a bounded cover sample (stacked-cover
   * motif), or one card per GENRE (label + count; the client renders the designed glyph tile — the
   * first abstract grouping dimension). Books/Audiobooks group by Author (R2); Audiobooks also
   * offers Genre; Comics' Series grouping IS the wall (a Kavita row is a series — no aggregate).
   *
   * Author cards on the ABS wall additionally carry the author's PORTRAIT URL when ABS holds a
   * photo (the in-process author directory — populated-value-gated, ADR-051 C-06; directory
   * unavailable ⇒ null ⇒ the fan). Same `booksProcedure` gate as the wall; live rows only.
   * Bounded: the walls are ≤ a few thousand rows (ADR-046), aggregated in-process from one narrow
   * SELECT.
   */
  groups: booksProcedure
    .input(z.object({ mediaKind: z.enum(BOOKS_MEDIA_KINDS), groupBy: z.enum(['author', 'genre']) }))
    .query(async ({ ctx, input }): Promise<{ groups: BooksGroup[] }> => {
      // ADR-075 C-02 (PLAN-060) — WORK-grain aggregation: the unified Books wall counts anchors
      // (a paired duo counts ONCE — the collapsed audio row is excluded exactly as on the wall);
      // Comics degrade to the old single-kind read (the exclusion never matches a comic).
      const kinds = wallKindsFor(input.mediaKind);
      const live = and(
        kinds.length === 1
          ? eq(booksItems.mediaKind, kinds[0]!)
          : inArray(booksItems.mediaKind, kinds),
        isNull(booksItems.deletedAt),
        anchorExclusion(),
      );
      if (input.groupBy === 'genre') {
        // A work's genres are the UNION of the pair's arrays (E-3) — a genre either side carries
        // counts the work once.
        const rows = (await ctx.db
          .select({ genres: booksItems.genres, partnerGenres: partnerItems.genres })
          .from(booksItems)
          .leftJoin(booksFormatPairs, eq(booksFormatPairs.bookItemId, booksItems.id))
          .leftJoin(
            partnerItems,
            and(eq(partnerItems.id, booksFormatPairs.audioItemId), isNull(partnerItems.deletedAt)),
          )
          .where(live)) as unknown as Array<{
          genres: string[] | null;
          partnerGenres: string[] | null;
        }>;
        return {
          groups: aggregateBookGenreGroups(
            rows.map((r) => ({
              genres: [...new Set([...(r.genres ?? []), ...(r.partnerGenres ?? [])])],
            })),
          ),
        };
      }
      const rows = await ctx.db
        .select({
          author: booksItems.author,
          sortTitle: booksItems.sortTitle,
          source: booksItems.source,
          externalId: booksItems.externalId,
          coverRef: booksItems.coverRef,
        })
        .from(booksItems)
        .where(live);
      let groups = aggregateBookGroups(rows);
      if (isUnifiedWall(input.mediaKind)) {
        // ABS author portraits (D-04 art): a real photo where ABS holds one, the fan elsewhere —
        // now on the unified wall (its authors span both sources; a Kavita-only author simply has
        // no ABS portrait and keeps the fan). Comics skip the lookup — live-verified 2026-07-13:
        // Kavita person images are effectively a Kavita+ feature (0 of 1156 people carry one).
        const directory = await absAuthorDirectory();
        groups = groups.map((g) => ({ ...g, imageUrl: absAuthorImageUrlFor(directory, g.label) }));
      }
      return { groups };
    }),

  /**
   * ADR-066 / DESIGN-038 D-05 (PLAN-051) — the books Collections group listing: one card per
   * mirrored collection WHOSE MAJORITY of resolved live members is this wall's kind (the
   * wall-mapping rule, R-217 — ties break book → comic → audiobook; a collection surfaces on
   * exactly ONE wall). The card count and cover fan are the WALL's kind only — exactly what the
   * `?group=` drill will show; the raw source `item_count` is never the wire count. Members
   * resolve `books_collection_members.books_item_id` → live `books_items` rows (an unresolved raw
   * ref is invisible here — the walls are books_items walls, ADR-066 C-06). Same server-
   * authoritative `booksProcedure` gate as the wall the cards ride (D-10). One bounded query,
   * in-process aggregation (the books.groups shape); cards come back label-A–Z and the client
   * re-sorts by the grouped level's registry keys (label | count).
   */
  collectionGroups: booksProcedure.input(z.object({ mediaKind: z.enum(BOOKS_MEDIA_KINDS) })).query(
    async ({
      ctx,
      input,
    }): Promise<{
      groups: BooksCollectionGroup[];
      categoryCounts: BooksCollectionCategoryCounts;
      /** ADR-071 owner ruling 2026-07-19 — may the caller fire the on-demand collection Force Search
       *  ("Search Missing")? SAME gate as the books detail + the /collections rows (admin OR the role's
       *  `force_search_book` grant). The drill header + grid badge render only when true; the mutation
       *  is FORBIDDEN server-side regardless. */
      canForceSearch: boolean;
    }> => {
      const canForceSearch =
        ctx.user.role.isAdmin ||
        (await bookActionsForRole({ db: ctx.db, roleId: ctx.user.role.id })).includes(
          'force_search_book',
        );
      const rows = await ctx.db
        .select({
          id: booksCollections.id,
          title: booksCollections.title,
          ordered: booksCollections.ordered,
          createdBy: booksCollections.createdBy,
          category: booksCollections.category,
          librettoRecipeId: booksCollections.librettoRecipeId,
          collectionSource: booksCollections.source,
          memberKind: booksItems.mediaKind,
          source: booksItems.source,
          externalId: booksItems.externalId,
          coverRef: booksItems.coverRef,
          position: booksCollectionMembers.position,
          // ADR-075 C-02 / ADR-076 C-03 — the member's WORK anchor: a live-paired AUDIO member
          // collapses onto its ebook row's id; everything else anchors on itself (E-2 totality).
          anchorId: sql<string>`COALESCE(
            (SELECT cb.id FROM books_format_pairs cp
               JOIN books_items cb ON cb.id = cp.book_item_id AND cb.deleted_at IS NULL
              WHERE cp.audio_item_id = ${booksItems.id}),
            ${booksItems.id})`,
        })
        .from(booksCollections)
        .innerJoin(
          booksCollectionMembers,
          eq(booksCollectionMembers.collectionId, booksCollections.id),
        )
        // Resolved LIVE members only (the inner join drops null resolutions by construction).
        .innerJoin(booksItems, eq(booksItems.id, booksCollectionMembers.booksItemId))
        .where(isNull(booksItems.deletedAt))
        .orderBy(
          asc(booksCollections.title),
          asc(booksCollections.id),
          asc(booksCollectionMembers.position),
        );
      // ADR-076 C-03 — the MERGE key: mirror rows sharing a non-null libretto_recipe_id are ONE
      // collection (Libretto materialized one recipe into both servers); markerless/hand rows
      // merge nothing (the app never fabricates a link — mirror honesty, E-6).
      interface Rep {
        id: string;
        title: string;
        ordered: boolean;
        createdBy: string | null;
        category: string | null;
        collectionSource: string;
      }
      interface Agg {
        rep: Rep;
        librettoRecipeId: string | null;
        /** Distinct non-comic WORK anchors (count = distinct works — C-03). */
        workIds: Set<string>;
        comicIds: Set<string>;
        /** Work-grain cover candidates (deduped on anchor; kept in position order). */
        workCovers: Array<{ anchorId: string; position: number | null; url: string | null }>;
        comicCovers: Array<{ position: number | null; url: string | null }>;
      }
      const byMergeKey = new Map<string, Agg>();
      // The representative twin: the kavita-source row wins (the ebook-anchor tie-break
      // precedent), then the smaller uuid — deterministic under twin flips.
      const repWins = (a: Rep, b: Rep): boolean => {
        const rank = (r: Rep) => (r.collectionSource === 'kavita' ? 0 : 1);
        return rank(a) < rank(b) || (rank(a) === rank(b) && a.id < b.id);
      };
      for (const row of rows) {
        const mergeKey =
          row.librettoRecipeId !== null ? `recipe:${row.librettoRecipeId}` : `solo:${row.id}`;
        const rep: Rep = {
          id: row.id,
          title: row.title,
          ordered: row.ordered,
          createdBy: row.createdBy,
          category: row.category,
          collectionSource: row.collectionSource,
        };
        const agg =
          byMergeKey.get(mergeKey) ??
          byMergeKey
            .set(mergeKey, {
              rep,
              librettoRecipeId: row.librettoRecipeId,
              workIds: new Set<string>(),
              comicIds: new Set<string>(),
              workCovers: [],
              comicCovers: [],
            })
            .get(mergeKey)!;
        if (repWins(rep, agg.rep)) agg.rep = rep;
        const url = booksCoverUrlFor(row.source, row.externalId, row.coverRef);
        if (row.memberKind === 'comic') {
          agg.comicIds.add(row.anchorId);
          agg.comicCovers.push({ position: row.position, url });
        } else if (!agg.workIds.has(row.anchorId)) {
          // Members union at WORK grain: a paired work held by both twins counts ONCE and keeps
          // its first (position-ordered) cover — both twins carry the same builder order (C-03).
          agg.workIds.add(row.anchorId);
          agg.workCovers.push({ anchorId: row.anchorId, position: row.position, url });
        }
      }
      const coverSample = (
        covers: Array<{ position: number | null; url: string | null }>,
      ): string[] => {
        const sorted = [...covers].sort(
          (a, b) => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER),
        );
        const urls: string[] = [];
        for (const c of sorted) {
          if (urls.length >= BOOKS_COLLECTION_COVER_SAMPLE) break;
          if (c.url !== null) urls.push(c.url);
        }
        return urls;
      };
      const groups: BooksCollectionGroup[] = [];
      for (const agg of byMergeKey.values()) {
        // ADR-076 C-04 — the wall-mapping rule is now a COMIC PARTITION: majority-comic resolved
        // live members ⇒ the Comics wall; otherwise the unified Books wall; ties go to Books.
        const comicMajority = agg.comicIds.size > agg.workIds.size;
        const wall: BooksMediaKind = comicMajority ? 'comic' : 'book';
        const wantedWall: BooksMediaKind = input.mediaKind === 'comic' ? 'comic' : 'book';
        if (wall !== wantedWall) continue;
        const count = comicMajority ? agg.comicIds.size : agg.workIds.size;
        if (count === 0) continue; // nothing this wall could show — no card
        groups.push({
          key: agg.rep.id,
          label: agg.rep.title,
          count,
          coverUrls: coverSample(comicMajority ? agg.comicCovers : agg.workCovers),
          imageUrl: null,
          ordered: agg.rep.ordered,
          provenance: provenanceDisplayName(agg.rep.createdBy),
          category: agg.rep.category,
          librettoRecipeId: agg.librettoRecipeId,
        });
      }
      groups.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
      // DESIGN-038 D-12 — the chip row's counts over THIS wall's cards, per DISTINCT present category
      // (only non-null appears; an uncategorized collection contributes no chip). The counts cover
      // only cards this gated wall shows, so no chip can leak a hidden card. This read is
      // multi-purpose (cards + drill header + the selector's populated gate), so it stays UNFILTERED
      // and stable — the `?ctype=` card filter is applied CLIENT-SIDE (the books-browser) off these
      // counts, unlike the single-purpose movies `ledger.collectionGroups` which filters server-side.
      const categoryCounts: BooksCollectionCategoryCounts = {};
      for (const g of groups) {
        if (g.category === null) continue;
        categoryCounts[g.category] = (categoryCounts[g.category] ?? 0) + 1;
      }
      return { groups, categoryCounts, canForceSearch };
    },
  ),
});
