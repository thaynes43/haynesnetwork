// ADR-055 / DESIGN-028 (PLAN-044) — the shared fetch primitive for the LazyLibrarian client. LL exposes a
// single query-string command API: `GET {baseUrl}/api?apikey=<key>&cmd=<command>&<params>`. This wrapper
// builds that URL (apikey appended here, NEVER logged/echoed — errors carry a redacted URL), enforces a
// per-attempt AbortController timeout, and RETRIES with BACKOFF on 5xx / network / timeout — mandatory
// because Google-Books `backendFailed` bursts surface as transient 503s on keyed LL calls too (the F-10
// field lesson: "GB backendFailed bursts hit keyed calls too"). `fetchImpl` is injectable so the unit
// tests + the hermetic e2e stub run offline (ADR-010 — no live-API tests in CI).
import type { z } from 'zod';
import {
  LazyLibrarianHttpError,
  LazyLibrarianNetworkError,
  LazyLibrarianParseError,
  LazyLibrarianTimeoutError,
} from './errors';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface LazyLibrarianHttpOptions {
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

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Strip the apikey from a URL so it never lands in an error message or a log line. */
function redactUrl(url: string): string {
  return url.replace(/([?&])apikey=[^&]*/i, '$1apikey=REDACTED');
}

export class LazyLibrarianHttp {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: LazyLibrarianHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  private buildUrl(cmd: string, params: Record<string, string | number | undefined>): string {
    const query = new URLSearchParams();
    query.set('cmd', cmd);
    query.set('apikey', this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') query.set(k, String(v));
    }
    return `${this.baseUrl}/api?${query.toString()}`;
  }

  /** Run an LL command, retrying transient failures with backoff. Returns the raw response text. */
  async commandText(
    cmd: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<string> {
    const url = this.buildUrl(cmd, params);
    const redacted = redactUrl(url);
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json, text/plain, */*' },
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
          throw new LazyLibrarianTimeoutError(cmd, redacted, this.timeoutMs);
        }
        if (attempt < this.retries) {
          attempt += 1;
          await this.sleepImpl(this.backoffMs * attempt);
          continue;
        }
        throw new LazyLibrarianNetworkError(cmd, redacted, { cause: error });
      }
      clearTimeout(timer);

      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.retries) {
          attempt += 1;
          await this.sleepImpl(this.backoffMs * attempt);
          continue;
        }
        const snippet = (await response.text().catch(() => '')).slice(0, 300);
        throw new LazyLibrarianHttpError(response.status, cmd, redacted, snippet || undefined);
      }
      return response.text();
    }
  }

  /** Run an LL command and parse its JSON body through a zod schema (ZodError → LazyLibrarianParseError). */
  async commandJson<S extends z.ZodType>(
    cmd: string,
    schema: S,
    params: Record<string, string | number | undefined> = {},
  ): Promise<z.infer<S>> {
    const text = await this.commandText(cmd, params);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text;
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new LazyLibrarianParseError(
        cmd,
        redactUrl(this.buildUrl(cmd, params)),
        result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    return result.data;
  }
}
