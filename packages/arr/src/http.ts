// DESIGN-005 D-18 — shared fetch wrapper: X-Api-Key header, per-request timeout,
// retry(2) for idempotent GETs only, typed errors (errors.ts). The *arr key is sent as a header,
// but two callers must put theirs in the QUERY (Tautulli `apikey`, TMDB v3 `api_key`), so a request
// URL here can carry a credential: the typed errors redact it at construction (DESIGN-049 D-01) —
// never log or rethrow a raw URL from this module.
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { ArrHttpError, ArrParseError, ArrTimeoutError } from './errors';
import { redactSecrets } from './redact';

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface ArrHttpOptions {
  /** Service origin WITHOUT the API base path, e.g. `http://sonarr.media.svc.cluster.local:8989`. */
  baseUrl: string;
  apiKey: string;
  /** Kind-specific API base path: `/api/v3` (Sonarr/Radarr), `/api/v1` (Lidarr/Seerr), `/api` (Bazarr). */
  apiBasePath: string;
  /**
   * The header the API key is sent in. Defaults to `X-Api-Key` (the *arr/Seerr casing);
   * Bazarr wants the exact casing `X-API-KEY` (ADR-016 / D-19), passed here.
   */
  apiKeyHeader?: string;
  /** Per-attempt timeout. Default 30s. */
  timeoutMs?: number;
  /** Delay between GET retry attempts. Default 250ms (tests use 0). */
  retryDelayMs?: number;
  /**
   * GET retries after the first attempt. Default GET_RETRIES (2). A caller answering inside a hard deadline sizes
   * it down (DESIGN-051: `set_watchlist`'s TMDB fallback makes a single attempt, PR #580 ruling 9).
   */
  getRetries?: number;
  /**
   * Keep each attempt's timer armed until its body has been read (DESIGN-051 D-15p). Off by default: the syncs read
   * list bodies that may stream for longer than their per-attempt timeout. A caller answering inside a hard deadline
   * (the MCP's TMDB searches) turns it on, so a body that stalls after the headers ends at the attempt's bound
   * instead of undici's 300 s body timeout.
   */
  timeoutCoversBody?: boolean;
  /** Injectable fetch — tests pass a stub; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

/** GETs are idempotent → up to 2 retries (3 attempts) on transient failures (D-18). */
const GET_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
/** Statuses a Response may not carry a body with (the buffered copy of `timeoutCoversBody`). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 250;

const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export class ArrHttp {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly apiKeyHeader: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly getRetries: number;
  private readonly timeoutCoversBody: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ArrHttpOptions) {
    this.base =
      options.baseUrl.replace(/\/+$/, '') + '/' + options.apiBasePath.replace(/^\/+|\/+$/g, '');
    this.apiKey = options.apiKey;
    this.apiKeyHeader = options.apiKeyHeader ?? 'X-Api-Key';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.getRetries = Math.max(0, Math.floor(options.getRetries ?? GET_RETRIES));
    this.timeoutCoversBody = options.timeoutCoversBody ?? false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  buildUrl(path: string, query?: QueryParams): string {
    const url = new URL(`${this.base}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * One attempt: fetch with timeout. Throws ArrTimeoutError / ArrHttpError / network errors. The error snippet is
   * read under the timer; with `timeoutCoversBody` a 2xx body is too (buffered, then handed back as a new Response).
   */
  private async attempt(method: string, url: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            [this.apiKeyHeader]: this.apiKey,
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new ArrTimeoutError(method, url, this.timeoutMs);
        throw error;
      }
      if (!response.ok) {
        // Redact BEFORE cutting the snippet: a limit that lands inside a credential value would otherwise
        // leave a prefix of it the patterns can no longer recognise.
        const text = await response.text().catch(() => '');
        const snippet = redactSecrets(text.slice(0, 4000)).slice(0, 300);
        throw new ArrHttpError(response.status, method, url, snippet || undefined);
      }
      if (!this.timeoutCoversBody) return response;
      try {
        const bytes = await response.arrayBuffer();
        const empty = NULL_BODY_STATUSES.has(response.status);
        return new Response(empty ? null : bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new ArrTimeoutError(method, url, this.timeoutMs);
        throw error; // the connection dropped mid-body: a network error (retried like one)
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetch with GET-only retries on transient failures (5xx gateway statuses, timeouts, network errors). */
  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: { query?: QueryParams; body?: unknown } = {},
  ): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const attempts = method === 'GET' ? 1 + this.getRetries : 1;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(this.retryDelayMs);
      try {
        return await this.attempt(method, url, options.body);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof ArrTimeoutError ||
          (error instanceof ArrHttpError && RETRYABLE_STATUSES.has(error.status)) ||
          (!(error instanceof ArrHttpError) && !(error instanceof ArrTimeoutError)); // network error
        if (!retryable || i === attempts - 1) throw error;
      }
    }
    throw lastError; // unreachable — loop always returns or throws
  }

  /** Request + parse the JSON body through `schema`; zod failures become ArrParseError. */
  async requestJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    schema: ZodType<T>,
    options: { query?: QueryParams; body?: unknown } = {},
  ): Promise<T> {
    const response = await this.request(method, path, options);
    const url = response.url || this.buildUrl(path, options.query);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ArrParseError(method, url, ['response body is not valid JSON']);
    }
    try {
      return schema.parse(json);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ArrParseError(
          method,
          url,
          error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
        );
      }
      throw error;
    }
  }

  /** Request where the response body is irrelevant (mark-failed, file deletes, Bazarr search). */
  async requestVoid(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    options: { query?: QueryParams; body?: unknown } = {},
  ): Promise<void> {
    const response = await this.request(method, path, options);
    await response.text().catch(() => ''); // drain — bodies may be empty or non-JSON
  }
}
