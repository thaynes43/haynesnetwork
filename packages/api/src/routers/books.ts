// ADR-046 / DESIGN-024 (PLAN-023) — the Books Library tRPC surface. Reads the app-owned `books_items`
// ledger (synced one-way from Kavita + Audiobookshelf by the books-sync mode) for the Library
// Books/Audiobooks/Comics poster walls. Read-only; there is NO Fix/Restore/add for books (hard rule 4
// EXTENDED — the book servers are the source of truth; the app only reflects them). Every read is gated by
// `booksProcedure` (the `books` section, ships Admin-only) — server-authoritative (AC-13), never
// client-hidden only. Same gate protects the /api/books/cover proxy.
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { booksItems, userBookProgress, BOOKS_MEDIA_KINDS } from '@hnet/db';
import { and, asc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import { authedProcedure, router } from '../trpc';
import { booksProcedure, effectiveSectionLevel } from '../middleware/role';
import {
  BOOK_LENGTH_BOUNDS,
  KAVITA_FORMATS,
  aggregateBookGroups,
  booksSearchInputSchema,
  toBooksListItem,
  type BookLengthBucket,
  type BooksGroup,
  type BooksListItem,
  type BooksSearchInput,
  type BooksSort,
} from '../books-query';

/** ADR-047 (PLAN-028) — the app-specific "Read in Kavita" / "Listen on Audiobookshelf" verb, by source. */
function booksPlayLabel(source: string): string {
  return source === 'audiobookshelf' ? 'Listen on Audiobookshelf' : 'Read in Kavita';
}

/** The books detail payload (the in-app drill-in — deep-links OUT to Kavita/ABS, no *arr semantics). */
export interface BooksDetailResult {
  item: BooksListItem & { libraryName: string; lastSyncedAt: string };
  /** The app-specific deep link (books are always PRESENT — synced from the serving app). */
  play: { app: 'kavita' | 'audiobookshelf'; label: string; url: string };
}

/**
 * The ORDER BY for a sort option (id/sort_title tiebreakers keep the offset paging stable).
 * PLAN-029 (R5 "+direction"): an explicit `dir` flips the PRIMARY column; nulls stay LAST in either
 * direction (the D-09 convention) and the tiebreakers stay ascending. Absent dir = the option's
 * natural direction (A–Z for title/author, newest/most-first for the rest — the pre-029 behavior).
 */
function orderForSort(sort: BooksSort, dir?: 'asc' | 'desc') {
  const natural: Record<BooksSort, 'asc' | 'desc'> = {
    title: 'asc',
    author: 'asc',
    added: 'desc',
    year: 'desc',
    released: 'desc',
    duration: 'desc',
    pages: 'desc',
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
  items: BooksListItem[];
  /** Next offset cursor, or null when the last page was reached. */
  nextCursor: number | null;
}

export const booksRouter = router({
  /** The caller's own books-section visibility (any authed user) — for the client tab gate. */
  access: authedProcedure.query(({ ctx }) => {
    const level = effectiveSectionLevel(ctx.user.role, 'books');
    return { level, visible: level !== 'disabled' };
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
        .orderBy(...orderForSort(input.sort, input.dir))
        .limit(input.limit)
        .offset(input.cursor);

      return {
        items: rows.map(toBooksListItem),
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
      return {
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
      };
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
   * DESIGN-026 D-04 (PLAN-029 step 3) — the grouped view's aggregate cards: one card per author with
   * an item count + a bounded cover sample (stacked-cover motif). Books/Audiobooks group by Author in
   * v1 (R2); Comics' Series grouping IS the wall (a Kavita row is a series — no aggregate needed).
   * Same `booksProcedure` gate as the wall; live rows only. Bounded: the walls are ≤ a few thousand
   * rows (ADR-046), aggregated in-process from one narrow SELECT.
   */
  groups: booksProcedure
    .input(z.object({ mediaKind: z.enum(BOOKS_MEDIA_KINDS), groupBy: z.enum(['author']) }))
    .query(async ({ ctx, input }): Promise<{ groups: BooksGroup[] }> => {
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
      return { groups: aggregateBookGroups(rows) };
    }),
});
