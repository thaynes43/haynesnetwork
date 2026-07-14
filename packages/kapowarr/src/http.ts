// ADR-056 (PLAN-046) — the shared fetch primitive for the Kapowarr client. Kapowarr exposes a REST API at
// `{baseUrl}/api/<path>` with `api_key` as a query param on EVERY method (GET/POST/PUT — verified live: the
// `@auth` decorator reads `api_key` from the query string regardless of method). Every response is wrapped in
// an envelope `{ error, result }`; a non-null `error` on a 2xx is an application failure. This wrapper builds
// the URL (api_key appended here, NEVER logged/echoed — errors carry a redacted URL), enforces a per-attempt
// AbortController timeout, RETRIES with BACKOFF on 5xx / network / timeout, and unwraps the envelope.
// `fetchImpl` is injectable so the unit tests + the hermetic e2e stub run offline (ADR-010 — no live-API
// tests in CI).
import type { z } from 'zod';
import {
  KapowarrHttpError,
  KapowarrNetworkError,
  KapowarrParseError,
  KapowarrTimeoutError,
} from './errors';
import { kapowarrEnvelopeSchema } from './schemas';

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface KapowarrHttpOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Bounded transient-failure retries (5xx/429/network/timeout). Default 3. */
  retries?: number;
  /** Base backoff between retries (ms); grows linearly per attempt. Default 500. */
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable sleep so tests don't wait real time on the backoff path. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Strip the api_key from a URL so it never lands in an error message or a log line. */
function redactUrl(url: string): string {
  return url.replace(/([?&])api_key=[^&]*/i, '$1api_key=REDACTED');
}

export class KapowarrHttp {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: KapowarrHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  private buildUrl(path: string, params: Record<string, string | number | undefined>): string {
    const query = new URLSearchParams();
    query.set('api_key', this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') query.set(k, String(v));
    }
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}/api${cleanPath}?${query.toString()}`;
  }

  /** Run a request, retrying transient failures with backoff. Returns the raw Response (2xx only). */
  private async request(
    method: HttpMethod,
    path: string,
    params: Record<string, string | number | undefined>,
    body: unknown | undefined,
  ): Promise<{ text: string; url: string }> {
    const url = this.buildUrl(path, params);
    const redacted = redactUrl(url);
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            Accept: 'application/json',
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          if (attempt < this.retries) {
            attempt += 1;
            await this.sleepImpl(this.backoffMs * attempt);
            continue;
          }
          throw new KapowarrTimeoutError(path, redacted, this.timeoutMs);
        }
        if (attempt < this.retries) {
          attempt += 1;
          await this.sleepImpl(this.backoffMs * attempt);
          continue;
        }
        throw new KapowarrNetworkError(path, redacted, { cause: error });
      }
      clearTimeout(timer);

      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.retries) {
          attempt += 1;
          await this.sleepImpl(this.backoffMs * attempt);
          continue;
        }
        const snippet = (await response.text().catch(() => '')).slice(0, 300);
        throw new KapowarrHttpError(response.status, path, redacted, snippet || undefined);
      }
      return { text: await response.text(), url: redacted };
    }
  }

  /**
   * Run a request and parse the Kapowarr envelope's `result` through a zod schema. A non-null `error` on a
   * 2xx (or a schema mismatch) throws KapowarrParseError. Some endpoints (e.g. the task submit, volume edit)
   * return `result: null` — pass `z.null()` or a nullable schema.
   */
  async json<S extends z.ZodType>(
    method: HttpMethod,
    path: string,
    schema: S,
    params: Record<string, string | number | undefined> = {},
    body?: unknown,
  ): Promise<z.infer<S>> {
    const { text, url } = await this.request(method, path, params, body);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new KapowarrParseError(path, url, ['response was not valid JSON']);
    }
    const envelope = kapowarrEnvelopeSchema.safeParse(raw);
    if (!envelope.success) {
      throw new KapowarrParseError(
        path,
        url,
        envelope.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    if (envelope.data.error != null) {
      throw new KapowarrParseError(path, url, [`API error: ${String(envelope.data.error)}`]);
    }
    const result = schema.safeParse(envelope.data.result);
    if (!result.success) {
      throw new KapowarrParseError(
        path,
        url,
        result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    return result.data;
  }
}
