// ADR-046 / DESIGN-024 (PLAN-023) — the shared fetch primitives for the Kavita/ABS read clients.
// Mirrors @hnet/arr's ArrHttp behaviour (per-attempt AbortController timeout, GET-only retry on
// 5xx/network, typed errors) but exposes the raw Response so a client can read a pagination header
// (Kavita returns totals in the `Pagination` header) or re-auth on 401. `fetchImpl` is injectable
// so the unit tests run offline (no live-API tests in CI — ADR-010).
import type { z } from 'zod';
import { BooksHttpError, BooksParseError, BooksTimeoutError } from './errors';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

export interface RawFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Only idempotent GETs retry; a caller doing a POST login passes retries: 0. */
  retries?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Fetch with a timeout + bounded retry, throwing typed errors on failure. Returns the raw Response
 * (2xx only — a non-2xx throws BooksHttpError after the retry budget). The body is left unread so the
 * caller can `.json()` it (through parseJson) or read a header.
 */
export async function rawFetch(url: string, options: RawFetchOptions = {}): Promise<Response> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.retries ?? (method === 'GET' ? DEFAULT_RETRIES : 0);
  const fetchImpl = options.fetchImpl ?? fetch;

  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: options.headers,
        body: options.body,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new BooksTimeoutError(method, url, timeoutMs);
      if (attempt < maxRetries) {
        attempt += 1;
        continue;
      }
      throw error;
    }
    clearTimeout(timer);

    if (!response.ok) {
      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        attempt += 1;
        continue;
      }
      const snippet = (await response.text().catch(() => '')).slice(0, 300);
      throw new BooksHttpError(response.status, method, url, snippet || undefined);
    }
    return response;
  }
}

/** Parse a 2xx JSON body through a zod schema; a ZodError becomes BooksParseError (ACL boundary). */
export async function parseJson<S extends z.ZodType>(
  response: Response,
  schema: S,
  method: string,
  url: string,
): Promise<z.infer<S>> {
  const raw = (await response.json().catch(() => undefined)) as unknown;
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new BooksParseError(
      method,
      url,
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  return result.data;
}
