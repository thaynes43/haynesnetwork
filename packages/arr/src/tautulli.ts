// ADR-018 / DESIGN-008 D-04 — Tautulli read client for cross-server watch-stats harvest.
// One instance per estate server (HaynesOps / HaynesKube / HaynesTower — the addendum's
// cross-server history requirement). Tautulli auths via an `apikey` QUERY param (not a
// header) and namespaces every call under `/api/v2?cmd=…`; we reuse the shared ArrHttp
// (timeout + GET-retry + typed errors) with the key passed in the query. READ-ONLY.
import { z } from 'zod';
import { ArrHttpError, ArrParseError } from './errors';
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
  /**
   * ADR-088 / DESIGN-049 D-09 — one account's rows only: the plex.tv numeric user id (the Server Owner is
   * 12874060). Tautulli's `user_id` filter.
   */
  userId?: number | string;
  /**
   * Only rows from this day on, `YYYY-MM-DD` — Tautulli's `after` filter ("history after and including the
   * date", by the Tautulli server's LOCAL day; verified live 2026-09-23: `after=2099-01-01` returns 0 rows,
   * a 30-day window returns only newer rows). The watch sync's incremental window (newest stored start minus
   * 3 days — the overlap absorbs the day/time-zone granularity). A malformed date throws before any request.
   */
  after?: string;
  /**
   * Include the CURRENTLY PLAYING sessions (`include_activity`). Tautulli's default follows its "show
   * activity in the history table" setting (on by default), and a live-session row has NO `row_id` (it is
   * not in session_history yet) — so the Watch Event ingest sends `false`, and must skip any row whose
   * `row_id` is null regardless. Omitted ⇒ Tautulli's default (the household harvest's call is unchanged).
   */
  includeActivity?: boolean;
  /**
   * 0 = one row per play session (the Watch Event grain — each row has its own `row_id`); 1 = Tautulli's
   * grouped view (consecutive partial plays collapsed). Omitted ⇒ Tautulli's configured default (grouped).
   */
  grouping?: 0 | 1;
  /** Sort column, e.g. `date` / `started` (Tautulli's `order_column`). */
  orderColumn?: string;
  /** `desc` (newest first) or `asc` (Tautulli's `order_dir`). */
  orderDir?: 'asc' | 'desc';
}

const AFTER_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The HTTP-400 message Tautulli's get_metadata answers for an item Plex does not have (verified live). */
const METADATA_GONE = /unable to retrieve metadata/i;

export class TautulliClient {
  private readonly http: ArrHttp;
  /** Tautulli authenticates by an `apikey` QUERY param (not a header) — kept for the query. */
  private readonly apiKey: string;

  constructor(options: TautulliClientOptions) {
    // Base path '/api'; every call is GET 'v2' with cmd/apikey in the query → `/api/v2?…`.
    this.http = new ArrHttp({ ...options, apiBasePath: '/api' });
    this.apiKey = options.apiKey;
  }

  /**
   * `cmd=get_history` — a page of watch history (newest first unless `orderDir` says otherwise). Every
   * filter is optional and omitted from the query when unset, so the household harvest's call is unchanged.
   */
  async getHistory(params: TautulliHistoryParams = {}): Promise<TautulliHistoryRow[]> {
    if (params.after !== undefined && !AFTER_DATE.test(params.after)) {
      throw new TypeError(`TautulliClient.getHistory: after must be YYYY-MM-DD (got "${params.after}")`);
    }
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
          ...(params.userId !== undefined ? { user_id: params.userId } : {}),
          ...(params.after !== undefined ? { after: params.after } : {}),
          ...(params.grouping !== undefined ? { grouping: params.grouping } : {}),
          ...(params.includeActivity !== undefined ? { include_activity: params.includeActivity ? 1 : 0 } : {}),
          ...(params.orderColumn ? { order_column: params.orderColumn } : {}),
          ...(params.orderDir ? { order_dir: params.orderDir } : {}),
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

  /**
   * `cmd=get_metadata` — the title's Plex `guid`, external-id `guids` (the join key) + last_viewed_at.
   * Returns `null` when the item is GONE from Plex (Maintainerr deletes watched media, so a history row's
   * rating_key goes stale): current Tautulli answers HTTP 400 with the message "Unable to retrieve metadata
   * for rating_key …" (verified live 2026-09-23), older builds answered 200 with an empty `data` object — both
   * map to `null`. ONLY that message does: Tautulli answers 400 for every error result (an unknown command,
   * say), and those still throw the typed ArrHttpError, as do 5xx, timeouts and schema drift.
   *
   * Caveat for callers: Tautulli builds that message from an empty Plex answer, so it can also come back while
   * Tautulli cannot reach its Plex server — treat `null` as "gone for now", never as permanent (DESIGN-049 D-09).
   */
  async getMetadata(ratingKey: string | number): Promise<TautulliMetadata | null> {
    const query = { apikey: this.apiKey, cmd: 'get_metadata', rating_key: ratingKey };
    let data: unknown;
    try {
      ({
        response: { data },
      } = await this.http.requestJson('GET', 'v2', tautulliEnvelopeSchema(z.unknown()), { query }));
    } catch (error) {
      if (
        error instanceof ArrHttpError &&
        error.status === 400 &&
        METADATA_GONE.test(error.bodySnippet ?? '')
      ) {
        return null;
      }
      throw error;
    }
    if (isEmptyPayload(data)) return null;
    const parsed = tautulliMetadataSchema.safeParse(data);
    if (!parsed.success) {
      throw new ArrParseError(
        'GET',
        this.http.buildUrl('v2', query), // redacted by the error — the apikey never survives
        parsed.error.issues.map((i) => `response.data.${i.path.join('.')}: ${i.message}`),
      );
    }
    return parsed.data;
  }
}

/** An absent / `{}` / `[]` get_metadata `data` — Tautulli's "no such item" shape. */
function isEmptyPayload(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  return typeof data === 'object' && Object.keys(data).length === 0;
}
