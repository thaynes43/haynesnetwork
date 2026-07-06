// ADR-018 / DESIGN-008 D-05 — TheTVDB v4 read client (last-resort series-metadata fallback).
// v4 auth is a login-token flow: POST /v4/login {apikey} → a bearer token, cached on the
// client and attached to subsequent GETs. READ-ONLY; skip-if-unconfigured (resolveTvdbConfig).
import { ArrHttp } from './http';
import type { TvdbConfig } from './config';
import { tvdbLoginSchema, tvdbSeriesSchema, type TvdbSeries } from './schemas/tvdb';

export interface TvdbClientOptions extends TvdbConfig {
  baseUrl?: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

const TVDB_DEFAULT_BASE = 'https://api4.thetvdb.com';

export class TvdbClient {
  private readonly options: TvdbClientOptions;
  private token?: string;

  constructor(options: TvdbClientOptions) {
    this.options = options;
  }

  private http(token?: string): ArrHttp {
    return new ArrHttp({
      baseUrl: this.options.baseUrl ?? TVDB_DEFAULT_BASE,
      apiBasePath: '/v4',
      apiKey: token ? `Bearer ${token}` : 'unused',
      apiKeyHeader: token ? 'Authorization' : 'X-Unused',
      timeoutMs: this.options.timeoutMs,
      retryDelayMs: this.options.retryDelayMs,
      fetchImpl: this.options.fetchImpl,
    });
  }

  private async login(): Promise<string> {
    if (this.token) return this.token;
    const { data } = await this.http().requestJson('POST', 'login', tvdbLoginSchema, {
      body: { apikey: this.options.apiKey },
    });
    this.token = data.token;
    return this.token;
  }

  /** `GET /v4/series/{id}/extended` — genres / poster image / average runtime. */
  async getSeries(tvdbId: number): Promise<TvdbSeries> {
    const token = await this.login();
    return this.http(token).requestJson('GET', `series/${tvdbId}/extended`, tvdbSeriesSchema);
  }
}
