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

// ---------------------------------------------------------------------------
// ADR-111 C-01 / DESIGN-055 D-10 (PLAN-077 P3) — the Seerr Issue mirror's reads (strip mode). `GET /api/v1/issue?take=
// &skip=&filter=all&sort=added` pages every issue, newest first, with its comments; `GET /api/v1/issue/{id}` reads one.
// Read live against Seerr 3.5.0 (2026-10-12): `status` is 1 open or 2 resolved; `issueType` 1 video, 2 audio,
// 3 subtitles, 4 other; `problemSeason` / `problemEpisode` are 0 for "the whole title" or "the whole season"; the issue
// carries no title (the ledger item gives it). The reporter's email crosses this boundary only to match an app user
// (DESIGN-005 D-14); the mirror never stores it. Seerr's first comment is the report's own message.
// ---------------------------------------------------------------------------

/** The reporter (or a commenter), as the mirror needs it. */
export const seerrIssueUserSchema = z.object({
  id: z.number().int(),
  email: z.string().nullish(),
  plexUsername: z.string().nullish(),
  username: z.string().nullish(),
  displayName: z.string().nullish(),
});
export type SeerrIssueUser = z.infer<typeof seerrIssueUserSchema>;

/** One comment: its id, its text and when it was written (the list omits the author; the detail read adds it). */
export const seerrIssueCommentSchema = z.object({
  id: z.number().int(),
  message: z.string().nullish(),
  createdAt: z.string(),
  user: seerrIssueUserSchema.nullish(),
});
export type SeerrIssueComment = z.infer<typeof seerrIssueCommentSchema>;

/** `GET /api/v1/issue` element and `GET /api/v1/issue/{id}` body. */
export const seerrIssueSchema = z.object({
  id: z.number().int(),
  issueType: z.number().int(),
  status: z.number().int(),
  problemSeason: z.number().int().nullish(),
  problemEpisode: z.number().int().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  media: z
    .object({
      mediaType: z.string().nullish(),
      tmdbId: z.number().int().nullish(),
      tvdbId: z.number().int().nullish(),
    })
    .nullish(),
  createdBy: seerrIssueUserSchema.nullish(),
  comments: z.array(seerrIssueCommentSchema).nullish(),
});
export type SeerrIssue = z.infer<typeof seerrIssueSchema>;

/** `GET /api/v1/issue?take=&skip=&filter=&sort=` envelope. */
export const seerrIssuePageSchema = z.object({
  pageInfo: z.object({
    pages: z.number().int(),
    pageSize: z.number().int(),
    results: z.number().int(),
    page: z.number().int(),
  }),
  results: z.array(seerrIssueSchema),
});
export type SeerrIssuePage = z.infer<typeof seerrIssuePageSchema>;

// ---------------------------------------------------------------------------
// ADR-111 C-03 / DESIGN-055 D-10 (PLAN-077 P7) — the Seerr Issue bridge. `GET /api/v1/user/{id}` reads the bridge user
// before any write (it must exist, hold MANAGE_ISSUES and not be an admin); Seerr 3.5.0's permission bits are below.
// The comment (`POST /issue/{id}/comment` with `{message}`) and the resolve (`POST /issue/{id}/resolved`, no body) both
// answer with the issue (seerrIssueSchema), read live 2026-10-13.
// ---------------------------------------------------------------------------

/** Seerr 3.5.0's permission bits the bridge checks (server/lib/permissions.ts). */
export const SEERR_PERMISSION_ADMIN = 2;
export const SEERR_PERMISSION_MANAGE_ISSUES = 1048576;

/** `GET /api/v1/user/{id}`, as the bridge needs it: the id, the permission bits, the user type and the shown name. */
export const seerrUserDetailSchema = z.object({
  id: z.number().int(),
  permissions: z.number().int(),
  userType: z.number().int().nullish(),
  displayName: z.string().nullish(),
});
export type SeerrUserDetail = z.infer<typeof seerrUserDetailSchema>;
