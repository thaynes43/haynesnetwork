// ADR-017 / DESIGN-007 D-03 — shared fetch wrapper for the Plex clients. The owner token is
// sent ONLY in the X-Plex-Token header (never in the query string) so URLs — and therefore
// error messages and logs — stay token-free. Handles both PMS reads (`/library/sections`,
// JSON) and the plex.tv v1 sharing API (XML). GET-only retries on transient gateway failures,
// mirroring @hnet/arr's ArrHttp.
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import {
  PlexError,
  PlexHttpError,
  PlexNetworkError,
  PlexParseError,
  PlexTimeoutError,
} from './errors';
import { parseXml, type XmlElement } from './xml';

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface PlexHttpOptions {
  /** The server's owner X-Plex-Token (secret; header-only). */
  token: string;
  /** X-Plex-Client-Identifier — a stable id for this app instance. */
  clientIdentifier?: string;
  /** X-Plex-Product header. */
  product?: string;
  /**
   * Per-attempt timeout: it bounds the WHOLE attempt, the response headers and its body alike (a body that stalls
   * after the headers arrived is a timeout too, DESIGN-051 D-15p). Default 30s.
   */
  timeoutMs?: number;
  /** Delay between GET retry attempts. Default 250ms (tests use 0). */
  retryDelayMs?: number;
  /**
   * Retries after the first attempt, for a GET and an idempotent write. Default GET_RETRIES (2). A caller answering
   * inside a hard deadline sizes it down (DESIGN-051 D-15ab: plex.tv's catalog lookup, whose one slow answer a
   * retry on the same endpoint would not beat, makes a single longer attempt).
   */
  getRetries?: number;
  /**
   * ADR-093 / DESIGN-052 D-02 — which HTTP statuses a retryable request retries. Default: the gateway statuses
   * 502/503/504. The Watchlist Registry reads also retry 429 and every 5xx (`registryRetryStatus`).
   */
  retryStatus?: (status: number) => boolean;
  /**
   * The wait before retry `attempt` (1-based: the wait before the second try is attempt 1). Default: `retryDelayMs`
   * every time. The Watchlist Registry reads back off 2 s times the attempt (DESIGN-052 D-02).
   */
  retryBackoffMs?: (attempt: number) => number;
  /** Injectable fetch — tests pass a stub; production uses global fetch. */
  fetchImpl?: typeof fetch;
}

/** DESIGN-052 D-02 — the Watchlist Registry's retryable statuses: 429 and every 5xx. */
export const registryRetryStatus = (status: number): boolean =>
  status === 429 || (status >= 500 && status <= 599);

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

/**
 * Reads a 2xx response's body INSIDE its attempt, while the attempt's timer is still armed (DESIGN-051 D-15p):
 * clearing the timer once the headers arrived left a stalled body bounded only by undici's 300 s body timeout.
 */
type BodyReader<T> = (response: Response) => Promise<T>;

/** A body nobody reads (a write's 2xx, PMS's empty 200): drained so the connection can be reused, never an error. */
const drain: BodyReader<void> = async (response) => {
  await response.text().catch(() => '');
};

export class PlexHttp {
  private readonly token: string;
  private readonly clientIdentifier: string;
  private readonly product: string;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly getRetries: number;
  private readonly retryStatus: (status: number) => boolean;
  private readonly retryBackoffMs: (attempt: number) => number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PlexHttpOptions) {
    this.token = options.token;
    this.clientIdentifier = options.clientIdentifier ?? DEFAULT_CLIENT_ID;
    this.product = options.product ?? DEFAULT_PRODUCT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.getRetries = Math.max(0, Math.floor(options.getRetries ?? GET_RETRIES));
    this.retryStatus = options.retryStatus ?? ((status) => RETRYABLE_STATUSES.has(status));
    const retryDelayMs = this.retryDelayMs;
    this.retryBackoffMs = options.retryBackoffMs ?? (() => retryDelayMs);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  buildUrl(base: string, query?: QueryParams): string {
    const url = new URL(base);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * One attempt: the request, then (a 2xx) its body through `read`, or (anything else) the error snippet, ALL under
   * the one per-attempt timer. An abort while the body is read is a timeout like one before the headers; any
   * other failure of the body stream is a network error (the connection dropped mid-response).
   */
  private async attempt<T>(
    method: string,
    url: string,
    options: PlexRequestOptions,
    read: BodyReader<T>,
  ): Promise<T> {
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
    try {
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
      }
      if (!response.ok) {
        // Still under the timer: a stalled error body only costs the snippet.
        const snippet = (await response.text().catch(() => '')).slice(0, 300);
        throw new PlexHttpError(response.status, method, url, snippet || undefined);
      }
      try {
        return await read(response);
      } catch (error) {
        if (controller.signal.aborted) throw new PlexTimeoutError(method, url, this.timeoutMs);
        if (error instanceof PlexError) throw error;
        throw new PlexNetworkError(method, url, { cause: error });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The request with its retry policy; `read` consumes a 2xx body inside each attempt (so the per-attempt timeout
   * covers it). The error finally thrown carries `mayStillLand` when ANY attempt may still be applied by the server
   * (DESIGN-051 D-15n): an earlier attempt that timed out can land after a later one failed cleanly.
   */
  private async send<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    base: string,
    options: PlexRequestOptions,
    /** Retry like a GET (a write that is idempotent on the server's state — see requestIdempotentPut). */
    idempotent: boolean,
    read: BodyReader<T>,
  ): Promise<T> {
    const url = this.buildUrl(base, options.query);
    const attempts = method === 'GET' || idempotent ? 1 + this.getRetries : 1;
    let lastError: unknown;
    let inFlight = false;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(this.retryBackoffMs(i));
      try {
        return await this.attempt(method, url, options, read);
      } catch (error) {
        lastError = error;
        const retryable =
          error instanceof PlexTimeoutError ||
          error instanceof PlexNetworkError || // transient DNS/connection failure
          (error instanceof PlexHttpError && this.retryStatus(error.status));
        if (!retryable || i === attempts - 1) {
          if (inFlight && error instanceof PlexError) error.mayStillLand = true;
          throw error;
        }
        if (error instanceof PlexError && error.mayStillLand) inFlight = true;
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
    const fallbackUrl = this.buildUrl(base, options.query);
    let url = fallbackUrl;
    const json = await this.send(
      method,
      base,
      { accept: 'application/json', ...options },
      false,
      async (response) => {
        url = response.url || fallbackUrl;
        const text = await response.text();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new PlexParseError(method, url, ['response body is not valid JSON']);
        }
      },
    );
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
    const fallbackUrl = this.buildUrl(base, options.query);
    let url = fallbackUrl;
    const text = await this.send(
      method,
      base,
      { accept: 'application/xml', ...options },
      false,
      (response) => {
        url = response.url || fallbackUrl;
        return response.text();
      },
    );
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
    await this.send(method, base, options, false, drain); // body may be empty or non-JSON
  }

  /**
   * DESIGN-049 D-14 (PLAN-068) — a mutation Plex exposes as a GET: `/:/scrobble` and `/:/unscrobble` (the
   * watched-state writes). `requestVoid` deliberately admits only the mutating verbs, so these get their own
   * door, used ONLY by the confined write client — a GET-shaped write must never be issued by a read path.
   *
   * RETRY CHOICE: they keep the GET retry policy (up to 3 attempts on a timeout, a network failure or a
   * 502/503/504). Both are idempotent on watched STATE: scrobbling a watched item leaves it watched (Plex may
   * bump its play count and lastViewedAt — nothing downstream reads more than `viewCount > 0`), unscrobbling
   * an unwatched item leaves it unwatched. So a retry after an ambiguous timeout can never flip an item the
   * caller did not ask about, whereas giving up on the first timeout would record a failed Watch Mark for a
   * write that very likely landed. TIME BUDGET: `timeoutMs` bounds EACH attempt, so the worst case is
   * 3 × timeoutMs + 2 × retryDelayMs with the default `getRetries` — a caller with a total budget sizes the client
   * for it (D-14's 3 s mark budget needs a per-attempt timeout of about 0.8 s or less).
   */
  async requestIdempotentGet(base: string, options: PlexRequestOptions = {}): Promise<void> {
    await this.send('GET', base, options, false, drain); // PMS answers an empty 200
  }

  /**
   * ADR-092 / DESIGN-051 D-06 (D-03 step 6, D-13) — a PUT that is idempotent on the account's state: the plex.tv
   * discover provider's `addToWatchlist` / `removeFromWatchlist` (verified live 2026-09-25: a repeat add and
   * removing an absent title both answer 200). It keeps the GET retry policy (up to 3 attempts on a timeout, a
   * network failure or a 502/503/504) — a retry after an ambiguous timeout can only re-assert the same state —
   * with the same worst case, 3 × timeoutMs + 2 × retryDelayMs (each attempt's timer covers its body too, so a
   * body that stalls after a 2xx ends at the attempt's bound, and the 2xx stands). Only the confined write client
   * uses it.
   */
  async requestIdempotentPut(base: string, options: PlexRequestOptions = {}): Promise<void> {
    await this.send('PUT', base, options, true, drain); // `{"MediaContainer":{"size":0}}`
  }
}
