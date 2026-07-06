// ADR-018 / DESIGN-008 D-05 — TMDB direct read client (fallback tier for metadata holes on
// tombstoned / never-listed rows). Supports the v4 read-access bearer (preferred) or the v3
// api_key query param. READ-ONLY; skip-if-unconfigured is the caller's job (resolveTmdbConfig).
import { ArrHttp } from './http';
import type { TmdbConfig } from './config';
import {
  tmdbFindSchema,
  tmdbMovieSchema,
  tmdbTvSchema,
  type TmdbFind,
  type TmdbMovie,
  type TmdbTv,
} from './schemas/tmdb';

export interface TmdbClientOptions extends TmdbConfig {
  baseUrl?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
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
}
