// ADR-046 / DESIGN-024 (PLAN-023) — the Books Library tRPC surface. Reads the app-owned `books_items`
// ledger (synced one-way from Kavita + Audiobookshelf by the books-sync mode) for the Library
// Books/Audiobooks/Comics poster walls. Read-only; there is NO Fix/Restore/add for books (hard rule 4
// EXTENDED — the book servers are the source of truth; the app only reflects them). Every read is gated by
// `booksProcedure` (the `books` section, ships Admin-only) — server-authoritative (AC-13), never
// client-hidden only. Same gate protects the /api/books/cover proxy.
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  bookRequests,
  booksCollections,
  booksCollectionMembers,
  booksFormatPairs,
  booksItems,
  userBookProgress,
  BOOKS_MEDIA_KINDS,
  type BooksMediaKind,
  type BooksItemRow,
  type BookRequestStatus,
  type Database,
} from '@hnet/db';
import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  bookActionsForRole,
  getBookRequestById,
  getBookRequestDetail,
  getWantedBookRequests,
  isRequestSearchable,
  missingFormatFor,
  runManualBookSearch,
} from '@hnet/domain';
import { authedProcedure, mapDomainErrors, resolveLazyLibrarianBundle, router } from '../trpc';
import { booksOrIntegrationsProcedure, booksProcedure, effectiveSectionLevel } from '../middleware/role';
import { booksCoverUrlFor } from '../books-query';
import {
  BOOK_LENGTH_BOUNDS,
  KAVITA_FORMATS,
  aggregateBookGenreGroups,
  aggregateBookGroups,
  booksSearchInputSchema,
  toBooksListItem,
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

/** ADR-065 / DESIGN-036 D-09 — a title's format-pairing state on the detail page. Null for a comic. */
export interface BooksPairingState {
  /** Present when the title is PAIRED — the counterpart format's OWN deep link (the second button). */
  pairedPlay: { app: 'kavita' | 'audiobookshelf'; label: string; url: string } | null;
  /** The absent format when UNPAIRED (a book lacks the audiobook; an audiobook lacks the ebook). */
  missingFormat: 'ebook' | 'audiobook' | null;
  /** The minted pairing want for the missing format, when the paced backfill has reached this title. */
  want: { requestId: string; status: BookRequestStatus; searchable: boolean } | null;
}

/** The books detail payload (the in-app drill-in — deep-links OUT to Kavita/ABS, no *arr semantics). */
export interface BooksDetailResult {
  /** ADR-062 — the caller may fire a books Fix (admin or fix_book grant). */
  canFix: boolean;
  item: BooksListItem & { libraryName: string; lastSyncedAt: string };
  /** The app-specific deep link (books are always PRESENT — synced from the serving app). */
  play: { app: 'kavita' | 'audiobookshelf'; label: string; url: string };
  /** ADR-065 — the format-pairing state (dual buttons / the missing format's affordance). Null = comic. */
  pairing: BooksPairingState | null;
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
function orderForSort(sort: BooksSort, dir?: 'asc' | 'desc', collection?: string) {
  const natural: Record<BooksSort, 'asc' | 'desc'> = {
    title: 'asc',
    author: 'asc',
    added: 'desc',
    year: 'desc',
    released: 'desc',
    duration: 'desc',
    pages: 'desc',
    position: 'asc',
  };
  const d = sql.raw((dir ?? natural[sort]).toUpperCase());
  switch (sort) {
    case 'author':
      return [sql`${booksItems.author} ${d} NULLS LAST`, asc(booksItems.sortTitle), asc(booksItems.id)];
    case 'added':
      return [
        sql`COALESCE(${booksItems.sourceAddedAt}, ${booksItems.firstSeenAt}) ${d}`,
        asc(booksItems.id),
      ];
    case 'year':
      return [sql`${booksItems.year} ${d} NULLS LAST`, asc(booksItems.sortTitle), asc(booksItems.id)];
    case 'released':
      // ADR-051 C-05 / DESIGN-026 D-05 — Date Released (ABS publishedDate). Kavita rows (null) sort last.
      return [
        sql`${booksItems.releasedAt} ${d} NULLS LAST`,
        asc(booksItems.sortTitle),
        asc(booksItems.id),
      ];
    case 'duration':
      return [
        sql`${booksItems.durationSeconds} ${d} NULLS LAST`,
        asc(booksItems.sortTitle),
        asc(booksItems.id),
      ];
    case 'pages':
      // DESIGN-026 D-03 (PLAN-029 step 2) — the Kavita page-count sort (Books/Comics).
      return [
        sql`${booksItems.pageCount} ${d} NULLS LAST`,
        asc(booksItems.sortTitle),
        asc(booksItems.id),
      ];
    case 'position':
      // DESIGN-038 D-06 — the drilled collection's member position ("List order"). A correlated
      // subquery against the ONE drilled collection (the same rows the EXISTS predicate admits, so
      // NULLS LAST is a formality). Never offered outside a drill (registry + schema refinement).
      return [
        sql`(SELECT bcm.position FROM books_collection_members bcm
              WHERE bcm.collection_id = ${collection ?? null}
                AND bcm.books_item_id = ${booksItems.id}) ${d} NULLS LAST`,
        asc(booksItems.sortTitle),
        asc(booksItems.id),
      ];
    case 'title':
    default:
      return [sql`${booksItems.sortTitle} ${d}`, asc(booksItems.id)];
  }
}

/**
 * DESIGN-026 D-08 (PLAN-029 step 2) — the per-medium facet predicates + the D-09 letter jump,
 * shared by search. Same chip semantics as the ledger engine: same-field OR, cross-field AND.
 */
function facetConditions(input: BooksSearchInput) {
  const conditions = [];
  if (input.authors && input.authors.length > 0) {
    conditions.push(sql`${booksItems.author} IN (${sql.join(input.authors.map((a) => sql`${a}`), sql`, `)})`);
  }
  if (input.narrators && input.narrators.length > 0) {
    conditions.push(
      sql`${booksItems.narrator} IN (${sql.join(input.narrators.map((n) => sql`${n}`), sql`, `)})`,
    );
  }
  if (input.series && input.series.length > 0) {
    conditions.push(
      sql`${booksItems.seriesName} IN (${sql.join(input.series.map((s) => sql`${s}`), sql`, `)})`,
    );
  }
  if (input.languages && input.languages.length > 0) {
    conditions.push(
      sql`${booksItems.attrs} ->> 'language' IN (${sql.join(input.languages.map((l) => sql`${l}`), sql`, `)})`,
    );
  }
  if (input.formats && input.formats.length > 0) {
    const codes = KAVITA_FORMATS.filter((f) => input.formats!.includes(f.key)).map((f) => f.code);
    conditions.push(
      sql`(${booksItems.attrs} ->> 'format')::int IN (${sql.join(codes.map((c) => sql`${c}`), sql`, `)})`,
    );
  }
  if (input.lengths && input.lengths.length > 0) {
    // OR-ed bucket ranges over the medium's length column (D-11 boundaries live in BOOK_LENGTH_BOUNDS).
    const col = input.mediaKind === 'audiobook' ? booksItems.durationSeconds : booksItems.pageCount;
    const bounds = BOOK_LENGTH_BOUNDS[input.mediaKind === 'audiobook' ? 'duration' : 'pages'];
    const ranges = input.lengths.map((bucket: BookLengthBucket) => {
      const b = bounds[bucket];
      if (b.min !== undefined && b.max !== undefined) return sql`(${col} >= ${b.min} AND ${col} < ${b.max})`;
      if (b.min !== undefined) return sql`${col} >= ${b.min}`;
      return sql`${col} < ${b.max!}`;
    });
    conditions.push(sql`(${sql.join(ranges, sql` OR `)})`);
  }
  if (input.letter) {
    // DESIGN-026 D-09 — the A–Z jump pages to the first item at the letter by narrowing the active
    // A–Z sort's column (author for the author sort, sort_title otherwise). asc-only by contract.
    const col = input.sort === 'author' ? booksItems.author : booksItems.sortTitle;
    conditions.push(sql`LOWER(${col}) >= ${input.letter}`);
  }
  return conditions;
}

export interface BooksSearchResult {
  /** ADR-065 — `formatCoverage` feeds the wall's coverage badge (null for a comic — no pairing). */
  items: Array<BooksListItem & { formatCoverage: BooksFormatCoverage | null }>;
  /** Next offset cursor, or null when the last page was reached. */
  nextCursor: number | null;
}

/** ADR-057 (PLAN-045) — which request FORMAT composes a wall's Wanted overlay. */
const WALL_FORMAT: Record<BooksMediaKind, 'ebook' | 'audiobook' | 'comic'> = {
  book: 'ebook',
  audiobook: 'audiobook',
  comic: 'comic',
};

/** ADR-066 / DESIGN-038 D-05 — the group card's cover-fan sample bound (the PLAN-037 idiom). */
const BOOKS_COLLECTION_COVER_SAMPLE = 4;

/**
 * DESIGN-038 D-05 — the wall-mapping tie order: a collection whose resolved live members split
 * evenly between kinds maps to the FIRST kind here (book → comic → audiobook; in practice ties are
 * the mixed-Kavita-list case — ABS collections are all-audiobook).
 */
const WALL_MAPPING_TIE_ORDER: readonly BooksMediaKind[] = ['book', 'comic', 'audiobook'];

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
}

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
      const views = await getWantedBookRequests({ db: ctx.db, format: WALL_FORMAT[input.mediaKind] });
      const viewerHasIntegrations = effectiveSectionLevel(ctx.user.role, 'integrations') !== 'disabled';
      return {
        items: views.map((v) => {
          const owns = v.integrationUserId !== null && v.integrationUserId === ctx.user.id;
          // ADR-065 C-05 — a pairing (system) want has no owner: its search rides the books gate this
          // resolver already passed; the Goodreads-sub-section deep link stays goodreads-only.
          const isPairing = v.origin === 'pairing';
          return {
            requestId: v.requestId,
            /** ADR-065 — 'pairing' rows are the estate's format wants (attributed "Format pairing"). */
            origin: v.origin,
            title: v.title,
            author: v.author,
            shelf: v.shelf,
            shelvedAt: v.shelvedAt ? v.shelvedAt.toISOString() : null,
            /** The WALL format's own status (requested | wanted | grabbed | missing — never landed here). */
            status: v.status,
            isComic: v.isComic,
            // PLAN-048 / ADR-059 D-03 (#272 residual) — the activity wall-badge join keys: a book/audiobook
            // want joins the live in-flight read by its LL/GB book id; a comic want by its Kapowarr volume id.
            // The wall passes `inFlightFor(wall, key)` from `activity.wallStages` so a want that is actively
            // being acquired wears the live stage badge (searching / downloading % / importing).
            llBookId: v.llBookId,
            kapowarrVolumeId: v.kapowarrVolumeId,
            /** A parked comic (no Kapowarr route yet) — the honest "waiting on a ComicVine match" note. */
            parked: v.isComic && v.unroutableReason === 'comic',
            requestedBy: v.requestedBy,
            canSearch: isPairing
              ? isRequestSearchable(v)
              : owns && viewerHasIntegrations && isRequestSearchable(v),
            canOpenRequest: !isPairing && owns && viewerHasIntegrations,
          };
        }),
      };
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
      if (!view) throw new TRPCError({ code: 'NOT_FOUND', message: `Request ${input.requestId} not found` });
      const owns = view.integrationUserId !== null && view.integrationUserId === ctx.user.id;
      const viewerHasIntegrations = effectiveSectionLevel(ctx.user.role, 'integrations') !== 'disabled';
      // ADR-065 C-05 — a pairing want has no owner: its per-format search is BOOKS-gated (the estate's
      // want belongs to everyone the books walls belong to); goodreads wants keep owner + integrations.
      const canSearch =
        view.origin === 'pairing'
          ? effectiveSectionLevel(ctx.user.role, 'books') !== 'disabled'
          : owns && viewerHasIntegrations;
      const requestSearchable = isRequestSearchable(view);

      // Per-format status ROWS (the *arr per-grain idiom): a comic is the single Kapowarr leg; a
      // book/audiobook want carries BOTH LazyLibrarian legs. `searchable` = the viewer may fire it AND
      // that format is still acquirable (whole-request searchable AND this format hasn't landed).
      const formats: Array<{ format: 'ebook' | 'audiobook' | 'comic'; status: BookRequestStatus; searchable: boolean }> =
        view.isComic
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

  /** One media kind's wall (poster-grid rows), filtered + sorted, offset-paginated. Live rows only. */
  search: booksProcedure
    .input(booksSearchInputSchema)
    .query(async ({ ctx, input }): Promise<BooksSearchResult> => {
      const conditions = [eq(booksItems.mediaKind, input.mediaKind), isNull(booksItems.deletedAt)];
      if (input.query && input.query.length > 0) {
        const like = `%${input.query}%`;
        const match = or(ilike(booksItems.title, like), ilike(booksItems.author, like));
        if (match) conditions.push(match);
      }
      if (input.genres && input.genres.length > 0) {
        // PLAN-029 fix — the shipped `g = ANY(${array})` form was latently broken (node-postgres
        // binds the JS array as a non-array parameter → 22P02 the first time the genre chips got
        // UI). Use the ledger engine's jsonb `?|` overlap idiom (same-field OR) instead.
        conditions.push(
          sql`${booksItems.genres} ?| ARRAY[${sql.join(input.genres.map((g) => sql`${g}`), sql`, `)}]::text[]`,
        );
      }
      // DESIGN-026 D-08/D-09 (PLAN-029) — author/narrator/series/language/format/length facets + the
      // A–Z letter jump (same-field OR, cross-field AND — the shared chip semantics).
      conditions.push(...facetConditions(input));
      // ADR-066 / DESIGN-038 D-06 (PLAN-051) — the drilled COLLECTION narrowing: one EXISTS
      // predicate over the mirror's resolved members, so the drilled wall inherits every other
      // filter/sort/pager (and the books gate) unchanged.
      if (input.collection) {
        conditions.push(
          sql`EXISTS (SELECT 1 FROM ${booksCollectionMembers} bcm
                WHERE bcm.collection_id = ${input.collection}
                  AND bcm.books_item_id = ${booksItems.id})`,
        );
      }
      // ADR-053 / DESIGN-026 D-07 — the per-user ABS read-state facet (viewer-scoped, Audiobooks only;
      // Kavita rows simply never carry user_book_progress). Bound to the SESSION user (never the wire).
      if (input.readState) {
        const viewer = sql`${ctx.user.id}::uuid`;
        if (input.readState === 'read') {
          conditions.push(
            sql`EXISTS (SELECT 1 FROM ${userBookProgress} ubp WHERE ubp.books_item_id = ${booksItems.id} AND ubp.app_user_id = ${viewer} AND ubp.is_finished = true)`,
          );
        } else if (input.readState === 'in_progress') {
          conditions.push(
            sql`EXISTS (SELECT 1 FROM ${userBookProgress} ubp WHERE ubp.books_item_id = ${booksItems.id} AND ubp.app_user_id = ${viewer} AND ubp.in_progress = true)`,
          );
        } else {
          conditions.push(
            sql`NOT EXISTS (SELECT 1 FROM ${userBookProgress} ubp WHERE ubp.books_item_id = ${booksItems.id} AND ubp.app_user_id = ${viewer} AND ubp.is_finished = true)`,
          );
        }
      }

      const rows = await ctx.db
        .select()
        .from(booksItems)
        .where(and(...conditions))
        .orderBy(...orderForSort(input.sort, input.dir, input.collection))
        .limit(input.limit)
        .offset(input.cursor);

      // ADR-065 / DESIGN-036 D-09 — the page's format-coverage lookup: one bounded read over the pair
      // cache for THIS page's ids (≤ limit rows). Comics never pair — their coverage stays null.
      const pairedIds = new Set<string>();
      if (input.mediaKind !== 'comic' && rows.length > 0) {
        const sideColumn =
          input.mediaKind === 'book' ? booksFormatPairs.bookItemId : booksFormatPairs.audioItemId;
        const pairRows = await ctx.db
          .select({ id: sideColumn })
          .from(booksFormatPairs)
          .where(
            inArray(
              sideColumn,
              rows.map((r) => r.id),
            ),
          );
        for (const p of pairRows) pairedIds.add(p.id);
      }
      const coverageFor = (row: BooksItemRow): BooksFormatCoverage | null => {
        if (row.mediaKind === 'comic') return null;
        if (pairedIds.has(row.id)) return 'both';
        return row.mediaKind === 'book' ? 'ebook' : 'audio';
      };

      return {
        items: rows.map((row) => ({ ...toBooksListItem(row), formatCoverage: coverageFor(row) })),
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
      // ADR-062 (PLAN-041) — may THIS caller fire a Fix? Server-computed so the button is never a
      // client-side guess (Admin-only until the owner's Q-01 all-roles flip).
      const canFix =
        ctx.user.role.isAdmin ||
        (await bookActionsForRole({ db: ctx.db, roleId: ctx.user.role.id })).includes('fix_book');
      // ADR-065 / DESIGN-036 D-09 — the pairing state: paired ⇒ the counterpart's own deep link (the
      // second consume button); unpaired ⇒ the missing format + its pairing want. Comics carry none.
      const pairing = await resolvePairingState(ctx.db, row);
      return {
        canFix,
        item: {
          ...toBooksListItem(row),
          libraryName: row.libraryName,
          lastSyncedAt: row.lastSeenAt.toISOString(),
        },
        play: {
          app: row.source === 'audiobookshelf' ? 'audiobookshelf' : 'kavita',
          label: booksPlayLabel(row.source),
          url: row.deepLinkUrl,
        },
        pairing,
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
      if (request.origin !== 'pairing') {
        // Not this surface's want — goodreads requests keep the owner-gated integrations.search.
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
   * Distinct facet values for a media kind's chip bar (DESIGN-026 D-08 — the shipped genres DISTINCT,
   * now joined by author/narrator/series/language/format). Every list is populated-value-gated by
   * construction (ADR-051 C-06): an empty medium simply returns [] and the client renders no chip —
   * e.g. Kavita book/comic genres/narrators, ABS formats.
   */
  filterFacets: booksProcedure
    .input(z.object({ mediaKind: z.enum(BOOKS_MEDIA_KINDS) }))
    .query(
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
      }> => {
        const live = sql`${booksItems.mediaKind} = ${input.mediaKind} AND ${booksItems.deletedAt} IS NULL`;
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
          (formatCodes.rows ?? (formatCodes as unknown as { value: number }[])).map((r) => Number(r.value)),
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
      if (input.groupBy === 'genre') {
        const rows = await ctx.db
          .select({ genres: booksItems.genres })
          .from(booksItems)
          .where(and(eq(booksItems.mediaKind, input.mediaKind), isNull(booksItems.deletedAt)));
        return { groups: aggregateBookGenreGroups(rows) };
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
        .where(and(eq(booksItems.mediaKind, input.mediaKind), isNull(booksItems.deletedAt)));
      let groups = aggregateBookGroups(rows);
      if (input.mediaKind === 'audiobook') {
        // ABS author portraits (D-04 art): a real photo where ABS holds one, the fan elsewhere.
        // Kavita walls skip the lookup — live-verified 2026-07-13: Kavita person images are
        // effectively a Kavita+ feature (0 of 1156 people carry one), the honest gap stands.
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
  collectionGroups: booksProcedure
    .input(z.object({ mediaKind: z.enum(BOOKS_MEDIA_KINDS) }))
    .query(async ({ ctx, input }): Promise<{ groups: BooksCollectionGroup[] }> => {
      const rows = await ctx.db
        .select({
          id: booksCollections.id,
          title: booksCollections.title,
          ordered: booksCollections.ordered,
          memberKind: booksItems.mediaKind,
          source: booksItems.source,
          externalId: booksItems.externalId,
          coverRef: booksItems.coverRef,
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
      interface Agg {
        label: string;
        ordered: boolean;
        counts: Record<BooksMediaKind, number>;
        coverUrls: Record<BooksMediaKind, string[]>;
      }
      const byCollection = new Map<string, Agg>();
      for (const row of rows) {
        const agg =
          byCollection.get(row.id) ??
          byCollection
            .set(row.id, {
              label: row.title,
              ordered: row.ordered,
              counts: { book: 0, comic: 0, audiobook: 0 },
              coverUrls: { book: [], comic: [], audiobook: [] },
            })
            .get(row.id)!;
        agg.counts[row.memberKind] += 1;
        const covers = agg.coverUrls[row.memberKind];
        if (covers.length < BOOKS_COLLECTION_COVER_SAMPLE) {
          const cover = booksCoverUrlFor(row.source, row.externalId, row.coverRef);
          if (cover !== null) covers.push(cover);
        }
      }
      const groups: BooksCollectionGroup[] = [];
      for (const [key, agg] of byCollection) {
        // The wall-mapping MAJORITY rule (D-05): the kind with the most resolved live members
        // wins; ties break in WALL_MAPPING_TIE_ORDER. Cards surface on exactly ONE wall.
        let majority: BooksMediaKind = WALL_MAPPING_TIE_ORDER[0]!;
        for (const kind of WALL_MAPPING_TIE_ORDER) {
          if (agg.counts[kind] > agg.counts[majority]) majority = kind;
        }
        if (majority !== input.mediaKind) continue;
        const count = agg.counts[input.mediaKind];
        if (count === 0) continue; // nothing this wall could show — no card
        groups.push({
          key,
          label: agg.label,
          count,
          coverUrls: agg.coverUrls[input.mediaKind],
          imageUrl: null,
          ordered: agg.ordered,
        });
      }
      groups.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
      return { groups };
    }),
});
