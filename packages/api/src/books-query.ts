// ADR-046 / DESIGN-024 (PLAN-023) — the books Library read contract. A leaner, books-specific
// filter/sort surface over `books_items` (the *arr-shaped ledger D-09 contract does not fit books —
// no monitored/quality/resolution). Reuses the @hnet/ui filter/sort ENGINE idioms on the client, but
// its OWN wire shape here. Pure helpers so the projection + cover-url building are unit-testable.
import { z } from 'zod';
import { BOOKS_MEDIA_KINDS, type BooksItemRow, type BooksMediaKind } from '@hnet/db';

// The sort options the Books walls offer (title default; the rest are per-kind-useful). ADR-051 C-05 /
// DESIGN-026 D-05 (PLAN-029) adds 'released' — the precise ABS publishedDate (books_items.released_at),
// a peer of 'year' for the Audiobooks Release-Date sort. Kavita rows have null released_at (sort last).
export const BOOKS_SORTS = ['title', 'author', 'added', 'year', 'released', 'duration'] as const;
export type BooksSort = (typeof BOOKS_SORTS)[number];

// ADR-053 / DESIGN-026 D-07 (PLAN-029) — the per-user ABS read-state facet (viewer-scoped; Audiobooks
// only — Kavita read-state is DEFERRED, ADR-053 C-05). 'read' = the viewer finished it; 'unread' = no
// finished record; 'in_progress' = started-but-unfinished. Populated-value-gated (ADR-051 C-06).
export const BOOK_READ_STATES = ['read', 'unread', 'in_progress'] as const;
export type BookReadState = (typeof BOOK_READ_STATES)[number];

export const booksSearchInputSchema = z.object({
  mediaKind: z.enum(BOOKS_MEDIA_KINDS),
  query: z.string().trim().max(200).optional(),
  genres: z.array(z.string().min(1)).max(50).optional(),
  sort: z.enum(BOOKS_SORTS).default('title'),
  /** ADR-053 / DESIGN-026 D-07 — the viewer's read-state facet (applied server-side against the
   *  session user's user_book_progress; ignored for a viewer with no ABS mapping/progress). */
  readState: z.enum(BOOK_READ_STATES).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  /** Opaque numeric offset cursor (the walls are bounded — offset paging, not keyset). */
  cursor: z.number().int().min(0).default(0),
});
export type BooksSearchInput = z.infer<typeof booksSearchInputSchema>;

/** A poster-grid row for a Books/Audiobooks/Comics wall. */
export interface BooksListItem {
  id: string;
  source: string;
  mediaKind: BooksMediaKind;
  title: string;
  author: string | null;
  narrator: string | null;
  seriesName: string | null;
  year: number | null;
  /** ADR-051 C-05 / DESIGN-026 D-05 — the precise release instant (ABS publishedDate) as ISO, or null. */
  releasedAt: string | null;
  genres: string[];
  /** The authed cover-proxy URL (ADR-019 posture), or null when the item has no cover → fallback tile. */
  posterUrl: string | null;
  deepLinkUrl: string;
  pageCount: number | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
}

/**
 * Build the authed cover-proxy URL for a row (the coverRef self-versions it, so replaced art rotates the
 * URL + its ETag). Null coverRef ⇒ null ⇒ the wall shows the KindIcon fallback tile.
 */
export function booksCoverUrlFor(source: string, externalId: string, coverRef: string | null): string | null {
  if (!coverRef) return null;
  return `/api/books/cover?source=${encodeURIComponent(source)}&id=${encodeURIComponent(externalId)}&v=${encodeURIComponent(coverRef)}`;
}

/** Project a books_items row to the wall's list-item shape (builds the cover-proxy URL). */
export function toBooksListItem(row: BooksItemRow): BooksListItem {
  return {
    id: row.id,
    source: row.source,
    mediaKind: row.mediaKind,
    title: row.title,
    author: row.author,
    narrator: row.narrator,
    seriesName: row.seriesName,
    year: row.year,
    releasedAt: row.releasedAt ? row.releasedAt.toISOString() : null,
    genres: row.genres ?? [],
    posterUrl: booksCoverUrlFor(row.source, row.externalId, row.coverRef),
    deepLinkUrl: row.deepLinkUrl,
    pageCount: row.pageCount,
    durationSeconds: row.durationSeconds,
    sizeBytes: row.sizeBytes,
  };
}
