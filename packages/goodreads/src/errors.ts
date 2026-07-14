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
