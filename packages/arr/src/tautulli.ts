// ADR-018 / DESIGN-008 D-04 — Tautulli read client for cross-server watch-stats harvest.
// One instance per estate server (HaynesOps / HaynesKube / HaynesTower — the addendum's
// cross-server history requirement). Tautulli auths via an `apikey` QUERY param (not a
// header) and namespaces every call under `/api/v2?cmd=…`; we reuse the shared ArrHttp
// (timeout + GET-retry + typed errors) with the key passed in the query. READ-ONLY.
import { ArrHttp } from './http';
import {
  tautulliEnvelopeSchema,
  tautulliHistoryDataSchema,
  tautulliLibrariesTableDataSchema,
  tautulliMetadataSchema,
  type TautulliHistoryRow,
  type TautulliLibrariesTableRow,
  type TautulliMetadata,
} from './schemas/tautulli';

export interface TautulliClientOptions {
  /** Tautulli origin WITHOUT the /api path, e.g. `http://tautulli.media.svc.cluster.local:8181`. */
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export interface TautulliHistoryParams {
  length?: number;
  start?: number;
  /** 'movie' | 'episode' | 'track' — narrow the history scan to a kind. */
  mediaType?: string;
}

export class TautulliClient {
  private readonly http: ArrHttp;
  /** Tautulli authenticates by an `apikey` QUERY param (not a header) — kept for the query. */
  private readonly apiKey: string;

  constructor(options: TautulliClientOptions) {
    // Base path '/api'; every call is GET 'v2' with cmd/apikey in the query → `/api/v2?…`.
    this.http = new ArrHttp({ ...options, apiBasePath: '/api' });
    this.apiKey = options.apiKey;
  }

  /** `cmd=get_history` — a page of watch history (newest first). */
  async getHistory(params: TautulliHistoryParams = {}): Promise<TautulliHistoryRow[]> {
    const { response } = await this.http.requestJson(
      'GET',
      'v2',
      tautulliEnvelopeSchema(tautulliHistoryDataSchema),
      {
        query: {
          apikey: this.apiKey,
          cmd: 'get_history',
          length: params.length ?? 200,
          start: params.start ?? 0,
          ...(params.mediaType ? { media_type: params.mediaType } : {}),
        },
      },
    );
    return response.data.data;
  }

  /**
   * `cmd=get_libraries_table` — per-library LIFETIME play/duration totals (ADR-068 /
   * DESIGN-040 D-02, the estate play scoreboard). READ-ONLY like everything here.
   */
  async getLibrariesTable(): Promise<TautulliLibrariesTableRow[]> {
    const { response } = await this.http.requestJson(
      'GET',
      'v2',
      tautulliEnvelopeSchema(tautulliLibrariesTableDataSchema),
      { query: { apikey: this.apiKey, cmd: 'get_libraries_table' } },
    );
    return response.data.data;
  }

  /** `cmd=get_metadata` — the title's external-id `guids` (the join key) + last_viewed_at. */
  async getMetadata(ratingKey: string | number): Promise<TautulliMetadata> {
    const { response } = await this.http.requestJson(
      'GET',
      'v2',
      tautulliEnvelopeSchema(tautulliMetadataSchema),
      { query: { apikey: this.apiKey, cmd: 'get_metadata', rating_key: ratingKey } },
    );
    return response.data;
  }
}
