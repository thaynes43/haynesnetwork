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
