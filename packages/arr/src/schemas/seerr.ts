// DESIGN-005 D-02 — Jellyseerr 3.3 v1 field subsets (strip mode). Attribution source
// only: `GET /request` (paged), `GET /status`, `GET /settings/main` (identity probe).
import { z } from 'zod';

/** `GET /status`. */
export const seerrStatusSchema = z.object({
  version: z.string(),
});
export type SeerrStatus = z.infer<typeof seerrStatusSchema>;

/** `GET /settings/main` — identity probe (D-03). The apiKey field is stripped. */
export const seerrMainSettingsSchema = z.object({
  applicationTitle: z.string(),
  applicationUrl: z.string().optional(),
});
export type SeerrMainSettings = z.infer<typeof seerrMainSettingsSchema>;

/** Requester subset for attribution (D-14: email join, plexUsername as suggestion). */
export const seerrRequestedBySchema = z.object({
  id: z.number().int(),
  email: z.string().nullish(),
  plexUsername: z.string().nullish(),
  plexId: z.number().int().nullish(),
  displayName: z.string().nullish(),
});

/** `GET /request` element — exactly the D-02 attribution contract. */
export const seerrRequestSchema = z.object({
  id: z.number().int(),
  type: z.enum(['movie', 'tv']),
  status: z.number().int(),
  createdAt: z.string(),
  media: z.object({
    tmdbId: z.number().int().nullish(),
    tvdbId: z.number().int().nullish(),
    mediaType: z.string(),
    status: z.number().int(),
  }),
  requestedBy: seerrRequestedBySchema,
});
export type SeerrRequest = z.infer<typeof seerrRequestSchema>;

/** `GET /request?take=&skip=&sort=added` envelope. */
export const seerrRequestPageSchema = z.object({
  pageInfo: z.object({
    pages: z.number().int(),
    pageSize: z.number().int(),
    results: z.number().int(),
    page: z.number().int(),
  }),
  results: z.array(seerrRequestSchema),
});
export type SeerrRequestPage = z.infer<typeof seerrRequestPageSchema>;

// ---------------------------------------------------------------------------
// ADR-093 / DESIGN-052 D-02 (PLAN-072) — the Watchlist Registry's Seerr reads (strip mode; nothing but ids crosses
// this boundary). `GET /api/v1/user?take=&skip=` pages the users; `GET /api/v1/user/{id}/watchlist?page=` answers a
// user's Plex watchlist read with THAT USER's own stored token (Seerr 3.4.1). The content rules (Seerr answers a
// failed plex.tv read as HTTP 200 with an empty list) live in ../seerr-watchlist.ts, not here.
// ---------------------------------------------------------------------------

/** One Seerr user, as the registry needs it: its id, its plex.tv account id and its type (1 = Plex, 2 = local). */
export const seerrUserSummarySchema = z.object({
  id: z.number().int(),
  plexId: z
    .union([z.number().int(), z.string()])
    .nullish()
    .transform((v) =>
      v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim(),
    ),
  userType: z.number().int().nullish(),
});
export type SeerrUserSummary = z.infer<typeof seerrUserSummarySchema>;

/** `GET /api/v1/user?take=&skip=` envelope. */
export const seerrUserPageSchema = z.object({
  pageInfo: z.object({
    pages: z.number().int(),
    pageSize: z.number().int(),
    results: z.number().int(),
    page: z.number().int(),
  }),
  results: z.array(seerrUserSummarySchema),
});
export type SeerrUserPage = z.infer<typeof seerrUserPageSchema>;

/**
 * `GET /api/v1/user/{id}/watchlist?page=` (20 per page): `{page, totalPages, totalResults, results[{id, ratingKey,
 * title, mediaType, tmdbId}]}`. `ratingKey` is the plex.tv discover id; `mediaType` is `movie` or `tv`. Item fields are
 * validated by the content rules (a bad one fails the read), so they are `unknown` here.
 */
export const seerrWatchlistPageSchema = z.object({
  page: z.number().int(),
  totalPages: z.number().int(),
  totalResults: z.number().int(),
  results: z.array(
    z.object({ ratingKey: z.unknown(), mediaType: z.unknown(), tmdbId: z.unknown() }).passthrough(),
  ),
});
export type SeerrWatchlistPage = z.infer<typeof seerrWatchlistPageSchema>;
