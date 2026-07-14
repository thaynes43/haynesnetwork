// ADR-056 (PLAN-046 — Kapowarr comics acquisition) — the typed error taxonomy for the Kapowarr client.
// Messages NEVER contain the API key: the key travels only as the `api_key` query param the http layer
// appends, and is never interpolated into an error string (the @hnet/lazylibrarian / @hnet/plex / @hnet/arr
// discipline). The url in an error is the redacted command URL (api_key stripped — see http.ts redactUrl).

/** Base class — lets callers `catch (e) { if (e instanceof KapowarrError) … }`. */
export class KapowarrError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** assertKapowarrEnv failed — names the missing variables, never their values. */
export class KapowarrConfigError extends KapowarrError {
  readonly code = 'KAPOWARR_CONFIG_MISSING' as const;
  constructor(readonly missing: readonly string[]) {
    super(`missing required Kapowarr environment variables: ${missing.join(', ')}`);
  }
}

/** Non-2xx response from the Kapowarr API (path + status; body snippet, key-free). */
export class KapowarrHttpError extends KapowarrError {
  readonly code = 'KAPOWARR_HTTP_ERROR' as const;
  constructor(
    readonly status: number,
    readonly path: string,
    readonly url: string,
    readonly bodySnippet?: string,
  ) {
    super(`Kapowarr ${path} → HTTP ${status}${bodySnippet ? ` — ${bodySnippet}` : ''}`);
  }
}

/** A network-level failure below the HTTP layer (DNS/refused/reset). The original rides as `cause`. */
export class KapowarrNetworkError extends KapowarrError {
  readonly code = 'KAPOWARR_NETWORK_ERROR' as const;
  constructor(
    readonly path: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(`Kapowarr ${path} → network request failed (host unreachable, refused, or DNS)`, options);
  }
}

/** The request exceeded the client timeout (aborted). */
export class KapowarrTimeoutError extends KapowarrError {
  readonly code = 'KAPOWARR_TIMEOUT' as const;
  constructor(
    readonly path: string,
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`Kapowarr ${path} → timed out after ${timeoutMs}ms`);
  }
}

/**
 * A 2xx body failed its zod schema OR the Kapowarr envelope reported an `error` (its API wraps every
 * response as `{ error, result }`; a non-null `error` on a 2xx is an application-level failure — ACL boundary).
 */
export class KapowarrParseError extends KapowarrError {
  readonly code = 'KAPOWARR_PARSE_ERROR' as const;
  constructor(
    readonly path: string,
    readonly url: string,
    readonly issues: readonly string[],
  ) {
    super(
      `Kapowarr ${path} → response failed shape validation (upstream schema drift / API error?): ` +
        issues.slice(0, 5).join('; '),
    );
  }
}
