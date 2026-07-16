// ADR-046 / DESIGN-024 (PLAN-023) — the BC-03 ACL: zod schemas for the Kavita + Audiobookshelf
// wire shapes we consume. Strip mode (default): extra upstream fields are tolerated but dropped at
// the boundary, so an upstream that adds a field never breaks the client. Shapes verified live
// 2026-07-10 against Kavita 0.9.x (`/api/Series/all-v2`) and Audiobookshelf 2.35.x (`/api/libraries`).
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Kavita
// ---------------------------------------------------------------------------

/** `POST /api/Account/login` → the JWT (Bearer) + the stable per-user API key (cover query param). */
export const kavitaLoginSchema = z.object({
  token: z.string(),
  apiKey: z.string(),
});
export type KavitaLogin = z.infer<typeof kavitaLoginSchema>;

/**
 * Kavita LibraryType: 0=Manga, 1=Comic, 2=Book, 3=Images, 4=LightNovel. We serve Books (2, EBooks)
 * and Comics (1). The `type` decides which app media_kind a series maps to.
 */
export const kavitaLibrarySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  type: z.number().int(),
});
export type KavitaLibrary = z.infer<typeof kavitaLibrarySchema>;

/** One series row from `POST /api/Series/all-v2` (only the fields the ledger row needs). */
export const kavitaSeriesSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  sortName: z.string().nullable().optional(),
  originalName: z.string().nullable().optional(),
  pages: z.number().int().nullable().optional(),
  wordCount: z.number().int().nullable().optional(),
  format: z.number().int().nullable().optional(),
  libraryId: z.number().int(),
  libraryName: z.string().nullable().optional(),
  folderPath: z.string().nullable().optional(),
  lowestFolderPath: z.string().nullable().optional(),
  coverImage: z.string().nullable().optional(),
  created: z.string().nullable().optional(),
  lastChapterAddedUtc: z.string().nullable().optional(),
});
export type KavitaSeries = z.infer<typeof kavitaSeriesSchema>;

export const kavitaSeriesListSchema = z.array(kavitaSeriesSchema);

/**
 * ADR-066 / DESIGN-038 D-02 (PLAN-051 — books collections mirror) — one collection from
 * `GET /api/Collection` (AppUserCollectionDto, verified against the deployed v0.9.0.2 source).
 * Subset: identity + title + the RAW itemCount (diagnostics only — the wall count is resolved).
 * Kavita collections are UNORDERED (no member-order API) — the mirror stores `ordered=false`.
 */
export const kavitaCollectionSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  promoted: z.boolean().nullable().optional(),
  itemCount: z.number().int().nullable().optional(),
});
export type KavitaCollection = z.infer<typeof kavitaCollectionSchema>;
export const kavitaCollectionListSchema = z.array(kavitaCollectionSchema);

/**
 * DESIGN-038 D-02 — one reading list from `POST /api/ReadingList/lists` (ReadingListDto, verified
 * v0.9.0.2; the route is POST-with-query-pagination — GET 404s, live-probed 2026-07-16). Reading
 * lists carry an EXPLICIT member order (update-position API) — mirrored as ORDERED collections.
 */
export const kavitaReadingListSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  promoted: z.boolean().nullable().optional(),
  itemCount: z.number().int().nullable().optional(),
});
export type KavitaReadingList = z.infer<typeof kavitaReadingListSchema>;
export const kavitaReadingListListSchema = z.array(kavitaReadingListSchema);

/**
 * DESIGN-038 D-02/D-09 — one reading-list item from `GET /api/ReadingList/items?readingListId=`
 * (ReadingListItemDto, verified v0.9.0.2). CHAPTER-grain: `order` is the explicit list position,
 * `seriesId` the series the chapter belongs to — the mirror dedupes to series grain keeping each
 * series' EARLIEST order (ADR-066 C-05).
 */
export const kavitaReadingListItemSchema = z.object({
  id: z.number().int(),
  order: z.number().int(),
  seriesId: z.number().int(),
});
export type KavitaReadingListItem = z.infer<typeof kavitaReadingListItemSchema>;
export const kavitaReadingListItemListSchema = z.array(kavitaReadingListItemSchema);

// ---------------------------------------------------------------------------
// Audiobookshelf
// ---------------------------------------------------------------------------

/** `POST /login` → `{ user: { token, username } }` (the token is the Bearer for the API). */
export const absLoginSchema = z.object({
  user: z.object({
    token: z.string(),
    username: z.string().nullable().optional(),
  }),
});
export type AbsLogin = z.infer<typeof absLoginSchema>;

export const absLibrarySchema = z.object({
  id: z.string(),
  name: z.string(),
  mediaType: z.string().nullable().optional(),
});
export type AbsLibrary = z.infer<typeof absLibrarySchema>;

export const absLibrariesSchema = z.object({
  libraries: z.array(absLibrarySchema),
});

/** One library item from `GET /api/libraries/{id}/items` (book media type). */
export const absItemSchema = z.object({
  id: z.string(),
  libraryId: z.string().nullable().optional(),
  addedAt: z.number().nullable().optional(),
  updatedAt: z.number().nullable().optional(),
  media: z
    .object({
      metadata: z
        .object({
          title: z.string().nullable().optional(),
          titleIgnorePrefix: z.string().nullable().optional(),
          subtitle: z.string().nullable().optional(),
          authorName: z.string().nullable().optional(),
          narratorName: z.string().nullable().optional(),
          seriesName: z.string().nullable().optional(),
          genres: z.array(z.string()).nullable().optional(),
          publishedYear: z.union([z.string(), z.number()]).nullable().optional(),
          // ADR-051 C-05 / DESIGN-026 D-05 (PLAN-029 — Date Released) — the precise publish date ABS
          // carries alongside the January-1 `publishedYear` (e.g. "2020-05-01" or an ISO instant). The
          // books-sync normalizes it to books_items.released_at (Audiobooks Release-Date sort/facet).
          publishedDate: z.string().nullable().optional(),
          language: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
      numTracks: z.number().int().nullable().optional(),
      numChapters: z.number().int().nullable().optional(),
      duration: z.number().nullable().optional(),
      size: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type AbsItem = z.infer<typeof absItemSchema>;

export const absItemsPageSchema = z.object({
  results: z.array(absItemSchema),
  total: z.number().int().nullable().optional(),
  page: z.number().int().nullable().optional(),
});
export type AbsItemsPage = z.infer<typeof absItemsPageSchema>;

/**
 * ADR-066 / DESIGN-038 D-02 (PLAN-051) — one collection from `GET /api/collections` (verified
 * against the deployed ABS v2.35.1 source: `toOldJSONExpanded`). The `books` array is the expanded
 * library items returned **`collectionBook.order ASC`** (verified in
 * `Collection.getOldCollectionsJsonExpanded`) — the array order IS the curated order, so ABS
 * collections mirror as ORDERED. We consume only each book's library-item `id` (the
 * books_items.external_id join key for ABS rows).
 */
export const absCollectionSchema = z.object({
  id: z.string(),
  libraryId: z.string().nullable().optional(),
  name: z.string(),
  books: z.array(z.object({ id: z.string() })).nullable().optional(),
});
export type AbsCollection = z.infer<typeof absCollectionSchema>;

export const absCollectionsResponseSchema = z.object({
  collections: z.array(absCollectionSchema),
});

/**
 * DESIGN-026 D-04 amendment (group-card art) — one author from `GET /api/libraries/{id}/authors`.
 * `imagePath` is non-null ONLY when ABS holds a photo for the author (Audnexus-backed — filled by
 * ABS's own author match); the app treats it as the populated-value gate for author-portrait cards.
 * `updatedAt` (ms) rotates when the photo/description changes — the art URL's cache-busting version.
 */
export const absAuthorSchema = z.object({
  id: z.string(),
  name: z.string(),
  imagePath: z.string().nullable().optional(),
  updatedAt: z.number().nullable().optional(),
});
export type AbsAuthor = z.infer<typeof absAuthorSchema>;

export const absAuthorsResponseSchema = z.object({
  authors: z.array(absAuthorSchema),
});

/**
 * ADR-053 / DESIGN-026 D-07 (PLAN-029 — per-user read-state) — one `mediaProgress[]` entry from
 * `GET /api/users/{id}` (ADMIN/service-token readable for ANY user). The join key to books_items is
 * `libraryItemId` (= books_items.external_id for ABS rows). `progress` is a 0..1 fraction;
 * `isFinished` marks a completed listen. Subset — the many other progress fields are dropped.
 */
export const absMediaProgressSchema = z.object({
  libraryItemId: z.string().nullable().optional(),
  progress: z.number().nullable().optional(),
  isFinished: z.boolean().nullable().optional(),
});
export type AbsMediaProgress = z.infer<typeof absMediaProgressSchema>;

/** `GET /api/users/{id}` (admin) → the user with their per-item `mediaProgress[]`. Subset. */
export const absUserSchema = z.object({
  id: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  mediaProgress: z.array(absMediaProgressSchema).nullable().optional(),
});
export type AbsUser = z.infer<typeof absUserSchema>;
