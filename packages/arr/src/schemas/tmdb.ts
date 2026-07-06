// ADR-018 / DESIGN-008 D-05 — TMDB v3/v4 detail subsets (direct fallback for metadata holes
// on tombstoned / never-listed rows, AFTER the *arr /lookup tier). BC-03 ACL: only the
// harvested fields cross the boundary.
import { z } from 'zod';

const genre = z.object({ id: z.number().int().optional(), name: z.string() });

/** `GET /3/movie/{id}` subset. */
export const tmdbMovieSchema = z.object({
  vote_average: z.number().nullish(),
  vote_count: z.number().int().nullish(),
  runtime: z.number().int().nullish(),
  genres: z.array(genre).nullish(),
  poster_path: z.string().nullish(),
  imdb_id: z.string().nullish(),
});
export type TmdbMovie = z.infer<typeof tmdbMovieSchema>;

/** `GET /3/tv/{id}` subset (episode_run_time is an array; take the first). */
export const tmdbTvSchema = z.object({
  vote_average: z.number().nullish(),
  vote_count: z.number().int().nullish(),
  episode_run_time: z.array(z.number().int()).nullish(),
  genres: z.array(genre).nullish(),
  poster_path: z.string().nullish(),
});
export type TmdbTv = z.infer<typeof tmdbTvSchema>;

/** `GET /3/find/{external_id}?external_source=tvdb_id` — resolve a tvdb id to a TMDB tv record. */
export const tmdbFindSchema = z.object({
  tv_results: z.array(z.object({ id: z.number().int() })).nullish(),
  movie_results: z.array(z.object({ id: z.number().int() })).nullish(),
});
export type TmdbFind = z.infer<typeof tmdbFindSchema>;
