// ADR-045 / DESIGN-023 — shared fetch wrapper for the Authentik clients. The API token is sent ONLY in
// the Authorization: Bearer header (never in the query string) so URLs — and therefore error messages
// and logs — stay token-free. JSON only (Authentik's REST API). GET-only retries on transient gateway
// failures, mirroring @hnet/plex's PlexHttp / @hnet/arr's ArrHttp.
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import {
  AuthentikHttpError,
  AuthentikNetworkError,
  AuthentikParseError,
  AuthentikTimeoutError,
} from './errors';

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface AuthentikHttpOptions {
  /** The service-account API token (secret; header-only). */
  token: string;
  /** Per-attempt timeout. Default 30s. */
  timeoutMs?: number;
  /** Delay between GET retry attempts. Default 250ms (tests use 0). */
  retryDelayMs?: number;
  /** Injectable fetch — tests pass a stub; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

export interface AuthentikRequestOptions {
  query?: QueryParams;
  body?: unknown;
}

const GET_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 250;
// Cloudflare fronting the public host bans Python's default UA (error 1010, OPS-001). We always talk to
// the in-cluster Service (no edge), but send a browser-y UA regardless so a public-host fallback works.
const USER_AGENT = 'curl/8.5.0';

const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export class AuthentikHttp {
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AuthentikHttpOptions) {
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  buildUrl(base: string, query?: QueryParams): string {
    const url = new URL(base);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async attempt(
    method: string,
    url: string,
    options: AuthentikRequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const hasBody = options.body !== undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new AuthentikTimeoutError(method, url, this.timeoutMs);
      throw new AuthentikNetworkError(method, url, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const snippet = (await response.text().catch(() => '')).slice(0, 300);
      throw new AuthentikHttpError(response.status, method, url, snippet || undefined);
    }
    return response;
  }

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    base: string,
    options: AuthentikRequestOptions = {},
  ): Promise<Response> {
    const url = this.buildUrl(base, options.query);
    const attempts = method === 'GET' ? 1 + GET_RETRIES : 1;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(this.retryDelayMs);
      try {
        return await this.attempt(method, url, options);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof AuthentikTimeoutError ||
          error instanceof AuthentikNetworkError ||
          (error instanceof AuthentikHttpError && RETRYABLE_STATUSES.has(error.status));
        if (!retryable || i === attempts - 1) throw error;
      }
    }
    throw lastError; // unreachable
  }

  /** Request + parse the JSON body through `schema`; zod failures become AuthentikParseError. */
  async requestJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    base: string,
    schema: ZodType<T>,
    options: AuthentikRequestOptions = {},
  ): Promise<T> {
    const response = await this.request(method, base, options);
    const url = response.url || this.buildUrl(base, options.query);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new AuthentikParseError(method, url, ['response body is not valid JSON']);
    }
    try {
      return schema.parse(json);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new AuthentikParseError(
          method,
          url,
          error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        );
      }
      throw error;
    }
  }

  /** Request where the response body is irrelevant (add_user/remove_user — 204). */
  async requestVoid(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    base: string,
    options: AuthentikRequestOptions = {},
  ): Promise<void> {
    const response = await this.request(method, base, options);
    await response.text().catch(() => ''); // drain — body may be empty
  }
}
