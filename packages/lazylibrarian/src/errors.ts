// ADR-055 / DESIGN-028 (PLAN-044) — typed error taxonomy for the LazyLibrarian client. Messages never
// contain the API key: the key travels only as the `apikey` query param the http layer appends, and is
// never interpolated into an error string (mirrors the @hnet/plex / @hnet/arr discipline). The url in an
// error is the redacted command URL (apikey stripped — see http.ts redactUrl).

/** Base class — lets callers `catch (e) { if (e instanceof LazyLibrarianError) … }`. */
export class LazyLibrarianError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** assertLazyLibrarianEnv failed — names the missing variables, never their values. */
export class LazyLibrarianConfigError extends LazyLibrarianError {
  readonly code = 'LAZYLIBRARIAN_CONFIG_MISSING' as const;
  constructor(readonly missing: readonly string[]) {
    super(`missing required LazyLibrarian environment variables: ${missing.join(', ')}`);
  }
}

/** Non-2xx response from the LazyLibrarian API. */
export class LazyLibrarianHttpError extends LazyLibrarianError {
  readonly code = 'LAZYLIBRARIAN_HTTP_ERROR' as const;
  constructor(
    readonly status: number,
    readonly cmd: string,
    readonly url: string,
    readonly bodySnippet?: string,
  ) {
    super(`LazyLibrarian ${cmd} → HTTP ${status}${bodySnippet ? ` — ${bodySnippet}` : ''}`);
  }
}

/** A network-level failure below the HTTP layer (DNS/refused/reset). The original rides as `cause`. */
export class LazyLibrarianNetworkError extends LazyLibrarianError {
  readonly code = 'LAZYLIBRARIAN_NETWORK_ERROR' as const;
  constructor(
    readonly cmd: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(`LazyLibrarian ${cmd} → network request failed (host unreachable, refused, or DNS)`, options);
  }
}

/** The request exceeded the client timeout (aborted). */
export class LazyLibrarianTimeoutError extends LazyLibrarianError {
  readonly code = 'LAZYLIBRARIAN_TIMEOUT' as const;
  constructor(
    readonly cmd: string,
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`LazyLibrarian ${cmd} → timed out after ${timeoutMs}ms`);
  }
}

/** A 2xx response body failed its zod schema — upstream drift (ACL boundary). */
export class LazyLibrarianParseError extends LazyLibrarianError {
  readonly code = 'LAZYLIBRARIAN_PARSE_ERROR' as const;
  constructor(
    readonly cmd: string,
    readonly url: string,
    readonly issues: readonly string[],
  ) {
    super(
      `LazyLibrarian ${cmd} → response failed shape validation (upstream schema drift?): ` +
        issues.slice(0, 5).join('; '),
    );
  }
}
