// ADR-072 / DESIGN-042 D-02 (PLAN-052 PR4b) — the shared GitHub REST primitive for the haynes-ops client.
// GitHub's API is JSON under `{apiBaseUrl}/...` with Bearer auth. This wrapper sets the Authorization header
// (NEVER logged/echoed), the required `X-GitHub-Api-Version` + `Accept`, a per-attempt AbortController
// timeout, and RETRIES with BACKOFF on 5xx / network / timeout (transient → HaynesopsUnreachableError so the
// Movies/TV surface degrades honestly); a 4xx is a real client error (HaynesopsHttpError) surfaced as-is.
// `fetchImpl` is injectable so the unit tests run offline (ADR-010 — no live-API tests in CI).
import { HaynesopsHttpError, HaynesopsUnreachableError } from './errors';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 400;
const GITHUB_API_VERSION = '2022-11-28';

export interface HaynesopsHttpOptions {
  token: string;
  apiBaseUrl: string;
  timeoutMs?: number;
  retries?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface HaynesopsRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path under `{apiBaseUrl}` — e.g. `/repos/o/r/contents/x` (include any query string). */
  path: string;
  body?: unknown;
  /** When true a 404 resolves to `null` instead of throwing (a missing file/branch is a normal read). */
  allow404?: boolean;
}

export class HaynesopsHttp {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: HaynesopsHttpOptions) {
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  /** Run a request, retrying transient failures. Returns parsed JSON (or null on 204 / allowed 404). */
  async requestJson(req: HaynesopsRequest): Promise<unknown> {
    const url = `${this.apiBaseUrl}${req.path}`;
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: req.method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': GITHUB_API_VERSION,
            'User-Agent': 'haynesnetwork',
            ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (attempt < this.retries) {
          attempt += 1;
          await this.sleepImpl(this.backoffMs * attempt);
          continue;
        }
        throw new HaynesopsUnreachableError(req.method, req.path, { cause: error });
      }
      clearTimeout(timer);

      if (req.allow404 && response.status === 404) return null;

      const text = await response.text().catch(() => '');
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!response.ok) {
        if (response.status >= 500) {
          if (attempt < this.retries) {
            attempt += 1;
            await this.sleepImpl(this.backoffMs * attempt);
            continue;
          }
          throw new HaynesopsUnreachableError(req.method, req.path);
        }
        throw new HaynesopsHttpError(response.status, req.method, req.path, text.slice(0, 300) || undefined);
      }
      return parsed;
    }
  }
}
