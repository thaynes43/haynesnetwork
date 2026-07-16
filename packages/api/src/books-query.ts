// ADR-046 / DESIGN-024 (PLAN-023) — the books Library read contract. A leaner, books-specific
// filter/sort surface over `books_items` (the *arr-shaped ledger D-09 contract does not fit books —
// no monitored/quality/resolution). Reuses the @hnet/ui filter/sort ENGINE idioms on the client, but
// its OWN wire shape here. Pure helpers so the projection + cover-url building are unit-testable.
import { z } from 'zod';
import { BOOKS_MEDIA_KINDS, type BooksItemRow, type BooksMediaKind } from '@hnet/db';

// The sort options the Books walls offer (title default; the rest are per-kind-useful). ADR-051 C-05 /
// DESIGN-026 D-05 (PLAN-029) adds 'released' — the precise ABS publishedDate (books_items.released_at),
// a peer of 'year' for the Audiobooks Release-Date sort. Kavita rows have null released_at (sort last).
// DESIGN-026 D-03 (PLAN-029 step 2) adds 'pages' — the Kavita page-count sort for Books/Comics.
// ADR-066 / DESIGN-038 D-06 (PLAN-051) adds 'position' — the drilled COLLECTION's member position
// ("List order" — the reading-order payoff); it is meaningful ONLY inside a `collection` drill, so
// the schema REFUSES it without one (the refinement below). Which wall OFFERS which key is the
// registry's call (apps/web/lib/library-view-registry.ts — authoritative per ADR-051); this array
// is the engine-side superset.
export const BOOKS_SORTS = ['title', 'author', 'added', 'year', 'released', 'duration', 'pages', 'position'] as const;
export type BooksSort = (typeof BOOKS_SORTS)[number];

// ADR-053 / DESIGN-026 D-07 (PLAN-029) — the per-user ABS read-state facet (viewer-scoped; Audiobooks
// only — Kavita read-state is DEFERRED, ADR-053 C-05). 'read' = the viewer finished it; 'unread' = no
// finished record; 'in_progress' = started-but-unfinished. Populated-value-gated (ADR-051 C-06).
export const BOOK_READ_STATES = ['read', 'unread', 'in_progress'] as const;
export type BookReadState = (typeof BOOK_READ_STATES)[number];

// ---------------------------------------------------------------------------
// DESIGN-026 D-08 (PLAN-029 step 2/6) — the per-medium facet vocabulary
// ---------------------------------------------------------------------------

/** Length buckets (audiobook duration / Kavita page count). The BOUNDARIES are the build-phase UX
 *  call DESIGN-026 D-11 defers; they live server-side so the wire keys stay stable while the bounds
 *  stay tunable. min inclusive, max exclusive. */
export const BOOK_LENGTH_BUCKETS = ['short', 'medium', 'long'] as const;
export type BookLengthBucket = (typeof BOOK_LENGTH_BUCKETS)[number];
export const BOOK_LENGTH_BOUNDS: Record<
  'duration' | 'pages',
  Record<BookLengthBucket, { min?: number; max?: number }>
> = {
  /** Audiobook runtime, whole seconds: <6 h · 6–12 h · >12 h. */
  duration: { short: { max: 21_600 }, medium: { min: 21_600, max: 43_200 }, long: { min: 43_200 } },
  /** Kavita page count: <200 · 200–400 · >400. */
  pages: { short: { max: 200 }, medium: { min: 200, max: 400 }, long: { min: 400 } },
};

/** Kavita `attrs.format` (MangaFormat) codes → the stable facet keys + user labels the Format chip
 *  offers (DESIGN-026 D-08 "epub vs cbz/cbr"). ABS rows carry no format (the facet never offers them). */
export const KAVITA_FORMATS = [
  { key: 'epub', code: 3, label: 'EPUB' },
  { key: 'archive', code: 1, label: 'CBZ/CBR' },
  { key: 'pdf', code: 4, label: 'PDF' },
  { key: 'image', code: 0, label: 'Image' },
  { key: 'unknown', code: 2, label: 'Other' },
] as const;
export type BookFormatKey = (typeof KAVITA_FORMATS)[number]['key'];
export const BOOK_FORMAT_KEYS = KAVITA_FORMATS.map((f) => f.key) as [BookFormatKey, ...BookFormatKey[]];

export const booksSearchInputSchema = z
  .object({
  mediaKind: z.enum(BOOKS_MEDIA_KINDS),
  query: z.string().trim().max(200).optional(),
  /** ADR-066 / DESIGN-038 D-06 (PLAN-051) — narrow the wall to one mirrored books collection's
   *  resolved members (the `?group=<id>` drill; the books_collections row uuid — key, not name). */
  collection: z.uuid().optional(),
  genres: z.array(z.string().min(1)).max(50).optional(),
  // DESIGN-026 D-08 (PLAN-029 step 2) — the per-medium facets. Same chip semantics as the ledger
  // engine: same-field OR, cross-field AND. Which wall OFFERS which facet is the registry's call.
  authors: z.array(z.string().min(1)).max(50).optional(),
  narrators: z.array(z.string().min(1)).max(50).optional(),
  series: z.array(z.string().min(1)).max(50).optional(),
  languages: z.array(z.string().min(1)).max(50).optional(),
  formats: z.array(z.enum(BOOK_FORMAT_KEYS)).max(KAVITA_FORMATS.length).optional(),
  /** Length buckets — OR-ed ranges over duration_seconds (audiobook) / page_count (book/comic). */
  lengths: z.array(z.enum(BOOK_LENGTH_BUCKETS)).max(BOOK_LENGTH_BUCKETS.length).optional(),
  /** DESIGN-026 D-09 — the A–Z jump: page to the first item at this letter (applied to the active
   *  A–Z sort's column; meaningful only for the asc title/author sorts — the client gates it). */
  letter: z.string().regex(/^[a-z]$/).optional(),
  sort: z.enum(BOOKS_SORTS).default('title'),
  /** PLAN-029 (R5 "+direction") — flips the primary sort column; absent = the sort's natural
   *  direction (A–Z for title/author, newest/most-first for the rest). Nulls stay LAST either way. */
  dir: z.enum(['asc', 'desc']).optional(),
  /** ADR-053 / DESIGN-026 D-07 — the viewer's read-state facet (applied server-side against the
   *  session user's user_book_progress; ignored for a viewer with no ABS mapping/progress). */
  readState: z.enum(BOOK_READ_STATES).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  /** Opaque numeric offset cursor (the walls are bounded — offset paging, not keyset). */
  cursor: z.number().int().min(0).default(0),
  })
  // D-06 — the position sort is a drilled-collection concern only (member position is undefined
  // outside a collection); the wire refuses the combination rather than silently mis-sorting.
  .refine((v) => v.sort !== 'position' || v.collection !== undefined, {
    message: "sort 'position' requires a collection",
    path: ['sort'],
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

// ---------------------------------------------------------------------------
// DESIGN-026 D-04 (PLAN-029 step 3) — the group-view aggregate
// ---------------------------------------------------------------------------

/** One aggregate card of a grouped wall: the group key/label, its member count, and a bounded
 *  cover sample for the stacked-cover motif (art density is the build's D-11 call — 3). */
export interface BooksGroup {
  /** The raw grouping value (drill-in filter key — `?group=<key>`). */
  key: string;
  label: string;
  count: number;
  /** Up to `maxCovers` member cover-proxy URLs, in the wall's A–Z order. */
  coverUrls: string[];
  /**
   * DESIGN-026 D-04 amendment (group-card art) — the dimension's OWN portrait when a real source
   * holds one (v1: the ABS author photo via /api/books/author-image), else null → the card keeps
   * the stacked-cover fan. Populated-value-gated server-side (ADR-051 C-06): attached only when
   * the source actually has the image — a card never renders a broken slot.
   */
  imageUrl: string | null;
}

/** The slice of a books_items row the group aggregate needs. */
export interface BooksGroupSourceRow {
  author: string | null;
  sortTitle: string;
  source: string;
  externalId: string;
  coverRef: string | null;
}

/**
 * Aggregate a wall's live rows into author group cards (pure — the router feeds it one bounded
 * SELECT; the books walls are ≤ a few thousand rows, ADR-046). Rows with a NULL key are SKIPPED
 * (live-verified ≤4% on the author-grouped walls — they stay reachable via the flat view; an
 * "Unknown" pseudo-group would need an unfilterable sentinel key). Groups come back label-A–Z;
 * the client may re-sort by count.
 */
export function aggregateBookGroups(rows: BooksGroupSourceRow[], maxCovers = 3): BooksGroup[] {
  const groups = new Map<string, { count: number; coverUrls: string[] }>();
  const sorted = [...rows].sort((a, b) => a.sortTitle.localeCompare(b.sortTitle));
  for (const row of sorted) {
    const key = row.author?.trim();
    if (!key) continue;
    const group = groups.get(key) ?? { count: 0, coverUrls: [] };
    group.count += 1;
    if (group.coverUrls.length < maxCovers) {
      const cover = booksCoverUrlFor(row.source, row.externalId, row.coverRef);
      if (cover !== null) group.coverUrls.push(cover);
    }
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, g]) => ({ key, label: key, count: g.count, coverUrls: g.coverUrls, imageUrl: null }));
}

/**
 * DESIGN-026 D-04 amendment — the GENRE aggregate (the first abstract grouping dimension). A row
 * carries an ARRAY of genres, so it counts once per genre it wears; rows with no genres are
 * SKIPPED (reachable via the flat wall — same rule as the null-author skip). No cover sample and
 * no portrait: an abstract dimension renders the designed GLYPH tile client-side (never fake art —
 * the owner's group-card-art ruling), so the server ships label + count only. Label-A–Z out.
 */
export function aggregateBookGenreGroups(rows: Array<{ genres: string[] | null }>): BooksGroup[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const raw of row.genres ?? []) {
      const genre = raw.trim();
      if (genre === '') continue;
      counts.set(genre, (counts.get(genre) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, label: key, count, coverUrls: [], imageUrl: null }));
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
