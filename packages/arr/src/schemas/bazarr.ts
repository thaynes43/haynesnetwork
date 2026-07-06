// ADR-016 / DESIGN-005 D-19 — Bazarr subtitle-state field subsets (BC-03 ACL: only the
// consumed subset enters the app; strip mode tolerates and drops the rest). Verified live
// against Bazarr 1.5.6 (2026-07-06): GET responses are camelCase and wrapped in a `{data:
// [...]}` envelope; ids map 1:1 to the *arr ids we store (radarrId == Radarr movie id;
// sonarrSeriesId == Sonarr series id; sonarrEpisodeId == Sonarr episode id).
import { z } from 'zod';

/** One entry in `missing_subtitles` — the languages Bazarr still wants for a title. */
export const bazarrMissingSubtitleSchema = z.object({
  name: z.string(), // e.g. 'English'
  code2: z.string(), // e.g. 'en'
  forced: z.boolean(),
  hi: z.boolean(), // hearing-impaired
});
export type BazarrMissingSubtitle = z.infer<typeof bazarrMissingSubtitleSchema>;

/** `GET /api/movies?radarrid[]=` element — the movie's subtitle state (D-19 pre-read). */
export const bazarrMovieSubtitleSchema = z.object({
  radarrId: z.number().int(), // == Radarr movie id (== media_items.arr_item_id for radarr)
  title: z.string(),
  missing_subtitles: z.array(bazarrMissingSubtitleSchema).default([]),
});
export type BazarrMovieSubtitle = z.infer<typeof bazarrMovieSubtitleSchema>;

/** `GET /api/episodes?episodeid[]=` element — the episode's subtitle state (D-19 pre-read). */
export const bazarrEpisodeSubtitleSchema = z.object({
  sonarrSeriesId: z.number().int(), // == Sonarr series id
  sonarrEpisodeId: z.number().int(), // == Sonarr episode id (== fix_requests.target_arr_child_id)
  season: z.number().int(),
  episode: z.number().int(),
  title: z.string(),
  missing_subtitles: z.array(bazarrMissingSubtitleSchema).default([]),
});
export type BazarrEpisodeSubtitle = z.infer<typeof bazarrEpisodeSubtitleSchema>;

/** Bazarr's `{data: [...]}` list envelope (only `data` is consumed). */
export const bazarrEnvelopeSchema = <T extends z.ZodType>(record: T) =>
  z.object({ data: z.array(record) });
