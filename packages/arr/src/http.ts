// DESIGN-005 D-18 — shared fetch wrapper: X-Api-Key header, per-request timeout,
// retry(2) for idempotent GETs only, typed errors (errors.ts). The API key is sent
// exclusively as a header so URLs (and therefore error messages/logs) stay key-free.
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { ArrHttpError, ArrParseError, ArrTimeoutError } from './errors';

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface ArrHttpOptions {
  /** Service origin WITHOUT the API base path, e.g. `http://sonarr.media.svc.cluster.local:8989`. */
  baseUrl: string;
  apiKey: string;
  /** Kind-specific API base path: `/api/v3` (Sonarr/Radarr) or `/api/v1` (Lidarr/Seerr). */
  apiBasePath: string;
  /** Per-attempt timeout. Default 30s. */
  timeoutMs?: number;
  /** Delay between GET retry attempts. Default 250ms (tests use 0). */
  retryDelayMs?: number;
  /** Injectable fetch — tests pass a stub; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

/** GETs are idempotent → up to 2 retries (3 attempts) on transient failures (D-18). */
const GET_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 250;

const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export class ArrHttp {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ArrHttpOptions) {
    this.base =
      options.baseUrl.replace(/\/+$/, '') + '/' + options.apiBasePath.replace(/^\/+|\/+$/g, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  buildUrl(path: string, query?: QueryParams): string {
    const url = new URL(`${this.base}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** One attempt: fetch with timeout. Throws ArrTimeoutError / ArrHttpError / network errors. */
  private async attempt(method: string, url: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          'X-Api-Key': this.apiKey,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ArrTimeoutError(method, url, this.timeoutMs);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const snippet = (await response.text().catch(() => '')).slice(0, 300);
      throw new ArrHttpError(response.status, method, url, snippet || undefined);
    }
    return response;
  }

  /** Fetch with GET-only retries on transient failures (5xx gateway statuses, timeouts, network errors). */
  async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { query?: QueryParams; body?: unknown } = {},
  ): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const attempts = method === 'GET' ? 1 + GET_RETRIES : 1;
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
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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

  /** Request where the response body is irrelevant (mark-failed, file deletes). */
  async requestVoid(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { query?: QueryParams; body?: unknown } = {},
  ): Promise<void> {
    const response = await this.request(method, path, options);
    await response.text().catch(() => ''); // drain — bodies may be empty or non-JSON
  }
}
