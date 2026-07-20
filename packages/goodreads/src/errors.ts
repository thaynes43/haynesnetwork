// ADR-055 / DESIGN-028 (PLAN-044) — typed errors for the read-only Goodreads RSS + Google Books clients.
// No secrets: the Goodreads shelf RSS is PUBLIC (no key), and the optional Google Books key travels only
// as the `key` query param the http layer appends and is never echoed (errors carry a redacted URL).

export class GoodreadsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A non-2xx / network / timeout failure reading a Goodreads shelf RSS or a Google Books volume. */
export class GoodreadsHttpError extends GoodreadsError {
  readonly code = 'GOODREADS_HTTP_ERROR' as const;
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet?: string,
  ) {
    super(`GET ${url} → HTTP ${status}${bodySnippet ? ` — ${bodySnippet}` : ''}`);
  }
}

/** A network-level failure below the HTTP layer (DNS/refused/reset). Original rides as `cause`. */
export class GoodreadsNetworkError extends GoodreadsError {
  readonly code = 'GOODREADS_NETWORK_ERROR' as const;
  constructor(
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(`GET ${url} → network request failed (host unreachable, refused, or DNS)`, options);
  }
}

/** The request exceeded the client timeout (aborted). */
export class GoodreadsTimeoutError extends GoodreadsError {
  readonly code = 'GOODREADS_TIMEOUT' as const;
  constructor(
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`GET ${url} → timed out after ${timeoutMs}ms`);
  }
}

export type GoodreadsFailureKind = 'transient' | 'permanent';

/**
 * ADR-057 amend (goodreads-sync resilience) — classify a thrown Goodreads READ failure. TRANSIENT = a
 * blip that should keep the link and retry next run; PERMANENT = the profile/shelf is genuinely gone /
 * private and should surface as status='error'.
 *  - Network + timeout failures  → transient (host unreachable / CloudFront hiccup).
 *  - HTTP 429 or any 5xx (500/502/503/504…) → transient (rate-limit / upstream 5xx — the owner's 502).
 *  - Any other HTTP status (404/403/401/410/4xx) → permanent. A 404 only reaches here for a BUILT-IN
 *    shelf (absent CUSTOM shelves are already swallowed by fetchShelfTolerant), i.e. the profile went
 *    private/away — permanent, matching the existing isAbsentCustomShelfError doctrine.
 *  - An unexpected non-Goodreads throw → permanent (surface a real bug loudly, don't retry forever).
 *
 * The fetch client already surfaces everything needed to classify: getText throws GoodreadsHttpError
 * (with a readonly `status`), GoodreadsNetworkError, or GoodreadsTimeoutError — so this is a pure function
 * over those typed errors. http.ts's own retry loop already exhausts its backoff attempts on 5xx/429/
 * network before throwing, so a 'transient' classification here means the blip outlived in-request retries
 * — correctly deferred to next hour rather than flipping the link.
 */
export function classifyGoodreadsFailure(error: unknown): GoodreadsFailureKind {
  if (error instanceof GoodreadsNetworkError || error instanceof GoodreadsTimeoutError) return 'transient';
  if (error instanceof GoodreadsHttpError) {
    return error.status === 429 || (error.status >= 500 && error.status <= 599) ? 'transient' : 'permanent';
  }
  return 'permanent';
}
