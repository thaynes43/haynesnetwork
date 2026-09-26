// ADR-018 / DESIGN-008 D-05 — TMDB direct read client (fallback tier for metadata holes on
// tombstoned / never-listed rows). Supports the v4 read-access bearer (preferred) or the v3
// api_key query param. READ-ONLY; skip-if-unconfigured is the caller's job (resolveTmdbConfig).
// ADR-089 / DESIGN-049 (PLAN-068) adds the list reads the Watch Companion needs: recommendations (the daily
// seeds, D-17) and search/multi (the title resolver's last resort, D-13). With the v3 key the credential
// rides the query string — the typed errors redact it (DESIGN-049 D-01), so never log a raw request URL.
import { ArrHttp } from './http';
import type { TmdbConfig } from './config';
import {
  tmdbFindSchema,
  tmdbMovieSchema,
  tmdbPagedResultsSchema,
  tmdbTvSchema,
  type TmdbFind,
  type TmdbMovie,
  type TmdbPagedResults,
  type TmdbTv,
} from './schemas/tmdb';

export interface TmdbClientOptions extends TmdbConfig {
  baseUrl?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  /** GET retries after the first attempt (default 2); 0 = a single attempt (DESIGN-051, PR #580 ruling 9). */
  getRetries?: number;
  /** The per-attempt timeout covers the body too (DESIGN-051 D-15p; the MCP's searches). Default off. */
  timeoutCoversBody?: boolean;
  fetchImpl?: typeof fetch;
}

const TMDB_DEFAULT_BASE = 'https://api.themoviedb.org';

export class TmdbClient {
  private readonly http: ArrHttp;
  private readonly v3Key?: string;

  constructor(options: TmdbClientOptions) {
    // v4 bearer → Authorization header; v3 → api_key query (a dummy header keeps ArrHttp happy).
    this.http = new ArrHttp({
      baseUrl: options.baseUrl ?? TMDB_DEFAULT_BASE,
      apiBasePath: '/3',
      apiKey: options.readAccessToken ? `Bearer ${options.readAccessToken}` : 'unused',
      apiKeyHeader: options.readAccessToken ? 'Authorization' : 'X-Unused',
      timeoutMs: options.timeoutMs,
      retryDelayMs: options.retryDelayMs,
      ...(options.getRetries !== undefined ? { getRetries: options.getRetries } : {}),
      ...(options.timeoutCoversBody !== undefined ? { timeoutCoversBody: options.timeoutCoversBody } : {}),
      fetchImpl: options.fetchImpl,
    });
    this.v3Key = options.readAccessToken ? undefined : options.apiKey;
  }

  private q(extra: Record<string, string | number> = {}) {
    return this.v3Key ? { api_key: this.v3Key, ...extra } : extra;
  }

  getMovie(tmdbId: number): Promise<TmdbMovie> {
    return this.http.requestJson('GET', `movie/${tmdbId}`, tmdbMovieSchema, { query: this.q() });
  }

  getTv(tmdbId: number): Promise<TmdbTv> {
    return this.http.requestJson('GET', `tv/${tmdbId}`, tmdbTvSchema, { query: this.q() });
  }

  /** Resolve a tvdb id → TMDB tv record id (Sonarr series carry tvdbId, not tmdbId). */
  findByTvdb(tvdbId: number): Promise<TmdbFind> {
    return this.http.requestJson('GET', `find/${tvdbId}`, tmdbFindSchema, {
      query: this.q({ external_source: 'tvdb_id' }),
    });
  }

  /**
   * ADR-089 / DESIGN-049 D-17 — `GET /3/movie/{id}/recommendations`: one page (TMDB serves 20 per page) of
   * the movies TMDB recommends for a seed movie. The `watch` sync stores page one per seed, daily.
   */
  getMovieRecommendations(tmdbId: number, page = 1): Promise<TmdbPagedResults> {
    return this.http.requestJson('GET', `movie/${tmdbId}/recommendations`, tmdbPagedResultsSchema, {
      query: this.q({ page: clampPage(page) }),
    });
  }

  /** ADR-089 / DESIGN-049 D-17 — `GET /3/tv/{id}/recommendations`: the show counterpart. */
  getTvRecommendations(tmdbId: number, page = 1): Promise<TmdbPagedResults> {
    return this.http.requestJson('GET', `tv/${tmdbId}/recommendations`, tmdbPagedResultsSchema, {
      query: this.q({ page: clampPage(page) }),
    });
  }

  /**
   * DESIGN-049 D-13 — `GET /3/search/multi`: movies, shows AND people matching free text (adult results
   * excluded). The resolver accepts a hit only on an exact normalized title match and filters people out by
   * `media_type`. A blank query answers an empty page without a request.
   */
  async searchMulti(query: string, page = 1): Promise<TmdbPagedResults> {
    const trimmed = query.trim();
    if (!trimmed) return { page: 1, results: [], total_pages: 0, total_results: 0 };
    return this.http.requestJson('GET', 'search/multi', tmdbPagedResultsSchema, {
      query: this.q({ query: trimmed, page: clampPage(page), include_adult: 'false' }),
    });
  }
}

/** TMDB list pages are 1-based and capped at 500. */
function clampPage(page: number): number {
  return Math.min(Math.max(Math.trunc(Number.isFinite(page) ? page : 1), 1), 500);
}
