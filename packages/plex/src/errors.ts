// ADR-017 / DESIGN-007 — typed error taxonomy for the Plex clients. Messages never contain
// the owner token: the token travels only in the X-Plex-Token header and is never
// interpolated into URLs or error strings (mirrors the @hnet/arr assertArrEnv discipline).

/** Base class — lets callers `catch (e) { if (e instanceof PlexError) … }`. */
export class PlexError extends Error {
  /**
   * DESIGN-051 D-15n (PR #580 review) — whether the request that failed may still be applied by the server: this
   * attempt, or an earlier attempt of the same retried request (`PlexHttp` sets it on the error it finally
   * throws), was aborted by our timeout after it went out, lost its connection, or met a gateway timeout (504).
   * A caller that re-reads the server's state afterwards can then trust only a re-read showing the change, never
   * one showing the old state: the aborted attempt may land a moment later.
   */
  mayStillLand = false;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
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
    // A gateway timeout: the upstream may still be working on the request.
    this.mayStillLand = status === 504;
  }
}

/**
 * A network-level failure BELOW the HTTP layer — DNS resolution failed, the connection was
 * refused/reset, TLS failed, or the socket died — anything `fetchImpl` rejects with that is
 * NOT an aborted-timeout. Without this wrapper the raw undici `TypeError: fetch failed` (whose
 * message names neither the server nor the cause) escapes untyped and a caller that only
 * catches PlexError sees a leaked bare error. Names the host so pod logs point at the failed
 * server; the original error rides as `cause`; the token is never echoed (header-only). Live
 * defect 2026-07-06: haynestower's stale in-cluster URL surfaced here as an untyped throw.
 */
export class PlexNetworkError extends PlexError {
  readonly code = 'PLEX_NETWORK_ERROR' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(`${method} ${url} → network request failed (host unreachable, refused, or DNS)`, options);
    // Which side of sending the connection failed on is not known: the request may have gone out.
    this.mayStillLand = true;
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
    // Our own abort: the request went out, and the server may still apply it.
    this.mayStillLand = true;
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
