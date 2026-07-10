// ADR-045 / DESIGN-023 — typed error taxonomy for the Authentik directory clients. The API token
// travels ONLY in the Authorization: Bearer header and is never interpolated into URLs or error
// strings (mirrors the @hnet/plex / @hnet/arr assertEnv discipline).

/** Base class — lets callers `catch (e) { if (e instanceof AuthentikError) … }`. */
export class AuthentikError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** assertAuthentikEnv failed — names the missing variables, never their values. */
export class AuthentikConfigError extends AuthentikError {
  readonly code = 'AUTHENTIK_CONFIG_MISSING' as const;
  constructor(readonly missing: readonly string[]) {
    super(`missing required Authentik environment variables: ${missing.join(', ')}`);
  }
}

/** Non-2xx response from an Authentik API endpoint. */
export class AuthentikHttpError extends AuthentikError {
  readonly code = 'AUTHENTIK_HTTP_ERROR' as const;
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly bodySnippet?: string,
  ) {
    super(`${method} ${url} → HTTP ${status}${bodySnippet ? ` — ${bodySnippet}` : ''}`);
  }
}

/**
 * A network-level failure BELOW the HTTP layer — DNS/refused/reset/TLS — anything `fetchImpl`
 * rejects with that is NOT an aborted-timeout. Wraps undici's bare `TypeError: fetch failed`
 * (which names neither host nor cause) so it stays inside the AuthentikError taxonomy: the host
 * is named for pod logs, the original rides as `cause`, the token is never echoed (header-only).
 */
export class AuthentikNetworkError extends AuthentikError {
  readonly code = 'AUTHENTIK_NETWORK_ERROR' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(`${method} ${url} → network request failed (host unreachable, refused, or DNS)`, options);
  }
}

/** The request exceeded the client timeout (aborted). */
export class AuthentikTimeoutError extends AuthentikError {
  readonly code = 'AUTHENTIK_TIMEOUT' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} ${url} → timed out after ${timeoutMs}ms`);
  }
}

/** A 2xx response body failed its zod schema — upstream API drift. */
export class AuthentikParseError extends AuthentikError {
  readonly code = 'AUTHENTIK_PARSE_ERROR' as const;
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
