// ADR-017 / DESIGN-007 — typed error taxonomy for the Plex clients. Messages never contain
// the owner token: the token travels only in the X-Plex-Token header and is never
// interpolated into URLs or error strings (mirrors the @hnet/arr assertArrEnv discipline).

/** Base class — lets callers `catch (e) { if (e instanceof PlexError) … }`. */
export class PlexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** assertPlexEnv failed — names the missing variables, never their values. */
export class PlexConfigError extends PlexError {
  readonly code = 'PLEX_CONFIG_MISSING' as const;
  constructor(readonly missing: readonly string[]) {
    super(`missing required Plex environment variables: ${missing.join(', ')}`);
  }
}

/** Non-2xx response from a PMS or plex.tv endpoint. */
export class PlexHttpError extends PlexError {
  readonly code = 'PLEX_HTTP_ERROR' as const;
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly bodySnippet?: string,
  ) {
    super(`${method} ${url} → HTTP ${status}${bodySnippet ? ` — ${bodySnippet}` : ''}`);
  }
}

/** The request exceeded the client timeout (aborted). */
export class PlexTimeoutError extends PlexError {
  readonly code = 'PLEX_TIMEOUT' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} ${url} → timed out after ${timeoutMs}ms`);
  }
}

/** A 2xx response body failed its zod schema / XML shape — upstream drift (BC-04 ACL). */
export class PlexParseError extends PlexError {
  readonly code = 'PLEX_PARSE_ERROR' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly issues: readonly string[],
  ) {
    super(
      `${method} ${url} → response failed shape validation (upstream schema drift?): ` +
        issues.slice(0, 5).join('; '),
    );
  }
}
