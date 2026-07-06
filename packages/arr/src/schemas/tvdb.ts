// ADR-018 / DESIGN-008 D-05 — TheTVDB v4 subsets (last-resort fallback for series metadata
// holes). TVDB wraps payloads in `{ status, data }`; its `score` is a popularity metric (not a
// 0-10 rating), so we harvest genres / poster image / runtime only.
import { z } from 'zod';

export const tvdbLoginSchema = z.object({
  status: z.string(),
  data: z.object({ token: z.string() }),
});

export const tvdbSeriesSchema = z.object({
  status: z.string(),
  data: z.object({
    image: z.string().nullish(),
    averageRuntime: z.number().int().nullish(),
    genres: z.array(z.object({ name: z.string() })).nullish(),
  }),
});
export type TvdbSeries = z.infer<typeof tvdbSeriesSchema>;
