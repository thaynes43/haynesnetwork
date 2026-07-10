// ADR-045 / DESIGN-023 — minimal fetch wrapper for the @hnet/openwebui group client. Bearer header-only,
// per-attempt timeout, GET-only retry on transient gateway failures. JSON only.
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { OwuiHttpError, OwuiNetworkError, OwuiParseError, OwuiTimeoutError } from './errors';

export interface OwuiHttpOptions {
  apiKey: string;
  timeoutMs?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OwuiRequestOptions {
  body?: unknown;
}

const GET_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 250;

const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export class OwuiHttp {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OwuiHttpOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async attempt(method: string, url: string, options: OwuiRequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const hasBody = options.body !== undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        },
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new OwuiTimeoutError(method, url, this.timeoutMs);
      throw new OwuiNetworkError(method, url, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const snippet = (await response.text().catch(() => '')).slice(0, 300);
      throw new OwuiHttpError(response.status, method, url, snippet || undefined);
    }
    return response;
  }

  async requestJson<T>(
    method: 'GET' | 'POST',
    url: string,
    schema: ZodType<T>,
    options: OwuiRequestOptions = {},
  ): Promise<T> {
    const attempts = method === 'GET' ? 1 + GET_RETRIES : 1;
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(this.retryDelayMs);
      try {
        const response = await this.attempt(method, url, options);
        let json: unknown;
        try {
          json = await response.json();
        } catch {
          throw new OwuiParseError(method, url, ['response body is not valid JSON']);
        }
        try {
          return schema.parse(json);
        } catch (error) {
          if (error instanceof ZodError) {
            throw new OwuiParseError(
              method,
              url,
              error.issues.map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`),
            );
          }
          throw error;
        }
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof OwuiTimeoutError ||
          error instanceof OwuiNetworkError ||
          (error instanceof OwuiHttpError && RETRYABLE_STATUSES.has(error.status));
        if (!retryable || i === attempts - 1) throw error;
      }
    }
    throw lastError; // unreachable
  }
}
