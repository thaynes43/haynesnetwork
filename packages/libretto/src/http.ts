// ADR-070 / DESIGN-043 (PLAN-052) — the shared fetch primitive for the Libretto client. Libretto is a
// JSON REST API under `{baseUrl}/api/*` with Bearer auth (DESIGN-037 D-10/D-12). This wrapper sets the
// Authorization header (NEVER logged/echoed), enforces a per-attempt AbortController timeout, and RETRIES
// with BACKOFF on 5xx / network / timeout (transient), mapping those to LibrettoUnreachableError so the
// manager can degrade honestly (ADR-070 C-09); a 4xx is a real client error (LibrettoHttpError) surfaced
// as-is (a 400 carries per-path validation issues). `fetchImpl` is injectable so the unit tests + the
// hermetic e2e stub run offline (ADR-010 — no live-API tests in CI).
import type { z } from 'zod';
import { LibrettoHttpError, LibrettoParseError, LibrettoUnreachableError } from './errors';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 400;

export interface LibrettoHttpOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Bounded transient-failure retries (5xx/network/timeout). Default 2. */
  retries?: number;
  /** Base backoff between retries (ms); grows linearly per attempt. Default 400. */
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  /** Injectable sleep so tests don't wait real time on the backoff path. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Pull per-path issue strings out of a Libretto error body (`{ issues: [{path,message}] }`). */
function extractIssues(body: unknown): string[] | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const issues = (body as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return undefined;
  return issues.map((i) => {
    if (i != null && typeof i === 'object') {
      const path = (i as { path?: unknown }).path;
      const message = (i as { message?: unknown }).message;
      const p = Array.isArray(path) ? path.join('.') : path != null ? String(path) : '';
      return p ? `${p}: ${String(message ?? '')}` : String(message ?? JSON.stringify(i));
    }
    return String(i);
  });
}

export interface LibrettoRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path under `{baseUrl}` — e.g. `/api/recipes` (include the query string if any). */
  path: string;
  /** JSON body (POST/PUT). */
  body?: unknown;
}

export class LibrettoHttp {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: LibrettoHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? defaultSleep;
  }

  /** Run a request, retrying transient failures (5xx/network/timeout). Returns the parsed JSON (or null). */
  async requestJson(req: LibrettoRequest): Promise<unknown> {
    const url = `${this.baseUrl}${req.path}`;
    let attempt = 0;
    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: req.method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: 'application/json',
            ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        // Network failure or abort (timeout) — transient; retry then give up as UNREACHABLE.
        if (attempt < this.retries) {
          attempt += 1;
          await this.sleepImpl(this.backoffMs * attempt);
          continue;
        }
        throw new LibrettoUnreachableError(req.method, req.path, { cause: error });
      }
      clearTimeout(timer);

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
        // 5xx is transient (retry → UNREACHABLE); 4xx is a real client error surfaced as-is.
        if (response.status >= 500) {
          if (attempt < this.retries) {
            attempt += 1;
            await this.sleepImpl(this.backoffMs * attempt);
            continue;
          }
          throw new LibrettoUnreachableError(req.method, req.path);
        }
        throw new LibrettoHttpError(
          response.status,
          req.method,
          req.path,
          text.slice(0, 300) || undefined,
          extractIssues(parsed),
        );
      }
      return parsed;
    }
  }

  /** Run a request and parse its JSON body through a zod schema (ZodError → LibrettoParseError). */
  async requestParsed<S extends z.ZodType>(req: LibrettoRequest, schema: S): Promise<z.infer<S>> {
    const raw = await this.requestJson(req);
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new LibrettoParseError(
        req.method,
        req.path,
        result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }
    return result.data;
  }
}
