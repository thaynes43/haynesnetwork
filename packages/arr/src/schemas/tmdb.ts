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

/**
 * ADR-089 / DESIGN-049 D-13 + D-17 (PLAN-068) — one result of a TMDB v3 LIST endpoint:
 * `/3/{movie|tv}/{id}/recommendations` (the daily recommendation seeds) and `/3/search/multi` (the
 * resolver's last resort for a title the owner never had). Shape verified live 2026-09-23. Movies carry
 * `title` / `release_date`, shows `name` / `first_air_date`; search/multi also returns PEOPLE
 * (`media_type: 'person'`, name only) — callers filter by `media_type`. `id` is the only required field
 * (a result without one is useless); everything else is nullish because TMDB omits fields freely and
 * sends `""` for an unknown date.
 */
export const tmdbListResultSchema = z.object({
  id: z.number().int(),
  media_type: z.string().nullish(),
  title: z.string().nullish(),
  original_title: z.string().nullish(),
  name: z.string().nullish(),
  original_name: z.string().nullish(),
  release_date: z.string().nullish(),
  first_air_date: z.string().nullish(),
  genre_ids: z.array(z.number().int()).nullish(),
  vote_average: z.number().nullish(),
  vote_count: z.number().int().nullish(),
  popularity: z.number().nullish(),
  original_language: z.string().nullish(),
  origin_country: z.array(z.string()).nullish(),
  poster_path: z.string().nullish(),
  adult: z.boolean().nullish(),
});
export type TmdbListResult = z.infer<typeof tmdbListResultSchema>;

/** A page of a TMDB list endpoint; `results` is normalized to an array (absent ⇒ `[]`). */
export const tmdbPagedResultsSchema = z.object({
  page: z.number().int().nullish(),
  results: z
    .array(tmdbListResultSchema)
    .nullish()
    .transform((results) => results ?? []),
  total_pages: z.number().int().nullish(),
  total_results: z.number().int().nullish(),
});
export type TmdbPagedResults = z.infer<typeof tmdbPagedResultsSchema>;
