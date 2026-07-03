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
