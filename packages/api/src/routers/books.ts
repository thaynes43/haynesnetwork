// ADR-046 / DESIGN-024 (PLAN-023) — the Books Library tRPC surface. Reads the app-owned `books_items`
// ledger (synced one-way from Kavita + Audiobookshelf by the books-sync mode) for the Library
// Books/Audiobooks/Comics poster walls. Read-only; there is NO Fix/Restore/add for books (hard rule 4
// EXTENDED — the book servers are the source of truth; the app only reflects them). Every read is gated by
// `booksProcedure` (the `books` section, ships Admin-only) — server-authoritative (AC-13), never
// client-hidden only. Same gate protects the /api/books/cover proxy.
import { z } from 'zod';
import { booksItems, BOOKS_MEDIA_KINDS } from '@hnet/db';
import { and, asc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { authedProcedure, router } from '../trpc';
import { booksProcedure, effectiveSectionLevel } from '../middleware/role';
import { booksSearchInputSchema, toBooksListItem, type BooksListItem, type BooksSort } from '../books-query';

/** The ORDER BY for a sort option (id/sort_title tiebreakers keep the offset paging stable). */
function orderForSort(sort: BooksSort) {
  switch (sort) {
    case 'author':
      return [sql`${booksItems.author} ASC NULLS LAST`, asc(booksItems.sortTitle), asc(booksItems.id)];
    case 'added':
      return [
        sql`COALESCE(${booksItems.sourceAddedAt}, ${booksItems.firstSeenAt}) DESC`,
        asc(booksItems.id),
      ];
    case 'year':
      return [sql`${booksItems.year} DESC NULLS LAST`, asc(booksItems.sortTitle), asc(booksItems.id)];
    case 'duration':
      return [
        sql`${booksItems.durationSeconds} DESC NULLS LAST`,
        asc(booksItems.sortTitle),
        asc(booksItems.id),
      ];
    case 'title':
    default:
      return [asc(booksItems.sortTitle), asc(booksItems.id)];
  }
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
        conditions.push(
          sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${booksItems.genres}) AS g WHERE g = ANY(${input.genres}))`,
        );
      }

      const rows = await ctx.db
        .select()
        .from(booksItems)
        .where(and(...conditions))
        .orderBy(...orderForSort(input.sort))
        .limit(input.limit)
        .offset(input.cursor);

      return {
        items: rows.map(toBooksListItem),
        nextCursor: rows.length === input.limit ? input.cursor + input.limit : null,
      };
    }),

  /** Distinct genres for a media kind's filter chips (empty for Kavita book/comic — no genres synced). */
  filterFacets: booksProcedure
    .input(z.object({ mediaKind: z.enum(BOOKS_MEDIA_KINDS) }))
    .query(async ({ ctx, input }): Promise<{ genres: string[] }> => {
      const rows = await ctx.db
        .select({ genre: sql<string>`genre` })
        .from(
          sql`(SELECT DISTINCT jsonb_array_elements_text(${booksItems.genres}) AS genre
               FROM ${booksItems}
               WHERE ${booksItems.mediaKind} = ${input.mediaKind} AND ${booksItems.deletedAt} IS NULL) AS books_genres`,
        )
        .orderBy(sql`genre`);
      return { genres: rows.map((r) => r.genre).filter((g): g is string => typeof g === 'string') };
    }),
});
