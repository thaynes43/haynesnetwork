// ADR-069 / DESIGN-042 (PLAN-052) — typed error taxonomy for the Libretto client. Messages never
// contain the API key: the key travels only as the `Authorization: Bearer` header the http layer sets,
// and is never interpolated into an error string (mirrors the @hnet/lazylibrarian / @hnet/plex / @hnet/arr
// discipline). A UI that catches LibrettoUnreachableError renders the honest "Libretto is unreachable"
// state (ADR-069 C-09) — a network/timeout/5xx is unreachable, a 4xx is a real client error surfaced as-is.

/** Base class — lets callers `catch (e) { if (e instanceof LibrettoError) … }`. */
export class LibrettoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** assertLibrettoEnv failed — names the missing variables, never their values. */
export class LibrettoConfigError extends LibrettoError {
  readonly code = 'LIBRETTO_CONFIG_MISSING' as const;
  constructor(readonly missing: readonly string[]) {
    super(`missing required Libretto environment variables: ${missing.join(', ')}`);
  }
}

/**
 * The Libretto host could not be reached (network refused/DNS/reset, a timeout, or a 5xx after retries).
 * The manager degrades to its honest `unreachable` state on this (ADR-069 C-09) — it never crashes.
 */
export class LibrettoUnreachableError extends LibrettoError {
  readonly code = 'LIBRETTO_UNREACHABLE' as const;
  constructor(
    readonly method: string,
    readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(`Libretto ${method} ${path} → host unreachable (network, timeout, or 5xx after retries)`, options);
  }
}

/**
 * A non-2xx client response (4xx) from the Libretto API — a real error the caller must see (a 400 on
 * PUT /api/recipes/:id carries per-path validation issues; a 404 is a missing recipe/run). The body
 * snippet rides along (never the auth header). Distinct from LibrettoUnreachableError (5xx/network).
 */
export class LibrettoHttpError extends LibrettoError {
  readonly code = 'LIBRETTO_HTTP_ERROR' as const;
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly bodySnippet?: string,
    /** Per-path validation issues parsed from a 400 body when present (upsertRecipe strictObject). */
    readonly issues?: readonly string[],
  ) {
    super(`Libretto ${method} ${path} → HTTP ${status}${bodySnippet ? ` — ${bodySnippet}` : ''}`);
  }
}

/** A 2xx body failed its zod schema — upstream drift (the ACL boundary). */
export class LibrettoParseError extends LibrettoError {
  readonly code = 'LIBRETTO_PARSE_ERROR' as const;
  constructor(
    readonly method: string,
    readonly path: string,
    readonly issues: readonly string[],
  ) {
    super(
      `Libretto ${method} ${path} → response failed shape validation (upstream schema drift?): ` +
        issues.slice(0, 5).join('; '),
    );
  }
}
