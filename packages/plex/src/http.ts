// ADR-017 / DESIGN-007 D-03 — shared fetch wrapper for the Plex clients. The owner token is
// sent ONLY in the X-Plex-Token header (never in the query string) so URLs — and therefore
// error messages and logs — stay token-free. Handles both PMS reads (`/library/sections`,
// JSON) and the plex.tv v1 sharing API (XML). GET-only retries on transient gateway failures,
// mirroring @hnet/arr's ArrHttp.
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import { PlexHttpError, PlexNetworkError, PlexParseError, PlexTimeoutError } from './errors';
import { parseXml, type XmlElement } from './xml';

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface PlexHttpOptions {
  /** The server's owner X-Plex-Token (secret; header-only). */
  token: string;
  /** X-Plex-Client-Identifier — a stable id for this app instance. */
  clientIdentifier?: string;
  /** X-Plex-Product header. */
  product?: string;
  /** Per-attempt timeout. Default 30s. */
  timeoutMs?: number;
  /** Delay between GET retry attempts. Default 250ms (tests use 0). */
  retryDelayMs?: number;
  /** Injectable fetch — tests pass a stub; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

export interface PlexRequestOptions {
  query?: QueryParams;
  body?: unknown;
  /**
   * ADR-043 — a RAW request body sent verbatim (no JSON.stringify), for the poster-upload write
   * (`POST /library/metadata/{id}/posters` takes the image bytes as the body). When set, `contentType`
   * is required (e.g. `image/png`) and `body` is ignored. Mutually exclusive with `body`.
   */
  rawBody?: Uint8Array;
  /** Accept header. PMS reads default to JSON; the sharing API asks for XML. */
  accept?: string;
  /** When set with a body (JSON or raw), the Content-Type sent. Default application/json. */
  contentType?: string;
}

const GET_RETRIES = 2;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_CLIENT_ID = 'haynesnetwork';
const DEFAULT_PRODUCT = 'haynesnetwork';

const sleep = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

export class PlexHttp {
  private readonly token: string;
  private readonly clientIdentifier: string;
  private readonly product: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PlexHttpOptions) {
    this.token = options.token;
    this.clientIdentifier = options.clientIdentifier ?? DEFAULT_CLIENT_ID;
    this.product = options.product ?? DEFAULT_PRODUCT;
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
    options: PlexRequestOptions,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const hasRaw = options.rawBody !== undefined;
    const hasJsonBody = !hasRaw && options.body !== undefined;
    const hasBody = hasRaw || hasJsonBody;
    // A raw body (poster bytes) is sent verbatim; a JSON body is stringified. Uint8Array is a valid
    // fetch BodyInit (ArrayBufferView) but the DOM/undici union types don't narrow it cleanly — assert.
    const body: BodyInit | undefined = hasRaw
      ? (options.rawBody as unknown as BodyInit)
      : hasJsonBody
        ? JSON.stringify(options.body)
        : undefined;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          'X-Plex-Token': this.token,
          'X-Plex-Client-Identifier': this.clientIdentifier,
          'X-Plex-Product': this.product,
          Accept: options.accept ?? 'application/json',
          ...(hasBody ? { 'Content-Type': options.contentType ?? 'application/json' } : {}),
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      // An aborted fetch is our own timeout; anything else fetchImpl rejects with is a
      // network-level failure (DNS/refused/reset/TLS) — undici throws a bare `TypeError:
      // fetch failed`. Wrap it so it stays inside the PlexError taxonomy (host named, token
      // never echoed, original as `cause`) instead of escaping untyped.
      if (controller.signal.aborted) throw new PlexTimeoutError(method, url, this.timeoutMs);
      throw new PlexNetworkError(method, url, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const snippet = (await response.text().catch(() => '')).slice(0, 300);
      throw new PlexHttpError(response.status, method, url, snippet || undefined);
    }
    return response;
  }

  async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    base: string,
    options: PlexRequestOptions = {},
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
          error instanceof PlexTimeoutError ||
          error instanceof PlexNetworkError || // transient DNS/connection failure
          (error instanceof PlexHttpError && RETRYABLE_STATUSES.has(error.status));
        if (!retryable || i === attempts - 1) throw error;
      }
    }
    throw lastError; // unreachable
  }

  /** Request + parse the JSON body through `schema`; zod failures become PlexParseError. */
  async requestJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    base: string,
    schema: ZodType<T>,
    options: PlexRequestOptions = {},
  ): Promise<T> {
    const response = await this.request(method, base, { accept: 'application/json', ...options });
    const url = response.url || this.buildUrl(base, options.query);
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new PlexParseError(method, url, ['response body is not valid JSON']);
    }
    try {
      return schema.parse(json);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new PlexParseError(
          method,
          url,
          error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        );
      }
      throw error;
    }
  }

  /** Request + parse the body as XML (the plex.tv v1 sharing API). */
  async requestXml(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    base: string,
    options: PlexRequestOptions = {},
  ): Promise<XmlElement> {
    const response = await this.request(method, base, { accept: 'application/xml', ...options });
    const url = response.url || this.buildUrl(base, options.query);
    const text = await response.text().catch(() => '');
    try {
      return parseXml(text);
    } catch (error) {
      throw new PlexParseError(method, url, [
        error instanceof Error ? error.message : 'response is not valid XML',
      ]);
    }
  }

  /** Request where the response body is irrelevant (DELETE shared_server — 200/204). */
  async requestVoid(
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    base: string,
    options: PlexRequestOptions = {},
  ): Promise<void> {
    const response = await this.request(method, base, options);
    await response.text().catch(() => ''); // drain — body may be empty or non-JSON
  }
}
