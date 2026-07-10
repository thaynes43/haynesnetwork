// ADR-046 / DESIGN-024 (PLAN-023 — Books & Audiobooks Library ledger). Typed error taxonomy
// for the Kavita + Audiobookshelf READ clients. Mirrors the @hnet/arr taxonomy (DESIGN-005 D-18):
// credentials travel only in the Authorization header / login body and are NEVER interpolated into
// URLs or error strings. There is NO write client — @hnet/books is read-only (hard rule 4 extension:
// Kavita/ABS are the source of truth for book media; the app only syncs IN).

/** Base class — lets callers `catch (e) { if (e instanceof BooksError) … }`. */
export class BooksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** assertBooksEnv failed — names the missing variables, never their values. */
export class BooksConfigError extends BooksError {
  readonly code = 'BOOKS_CONFIG_MISSING' as const;
  constructor(readonly missing: readonly string[]) {
    super(`missing required books environment variables: ${missing.join(', ')}`);
  }
}

/** Non-2xx response from a Kavita/ABS endpoint. */
export class BooksHttpError extends BooksError {
  readonly code = 'BOOKS_HTTP_ERROR' as const;
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly bodySnippet?: string,
  ) {
    super(`${method} ${url} → HTTP ${status}${bodySnippet ? ` — ${bodySnippet}` : ''}`);
  }
}

/** A login exchange (Kavita /api/Account/login, ABS /login) failed — the token could not be minted. */
export class BooksAuthError extends BooksError {
  readonly code = 'BOOKS_AUTH_FAILED' as const;
  constructor(
    readonly server: string,
    readonly detail?: string,
  ) {
    super(`${server} authentication failed${detail ? ` — ${detail}` : ''}`);
  }
}

/** The request exceeded the client timeout (aborted). */
export class BooksTimeoutError extends BooksError {
  readonly code = 'BOOKS_TIMEOUT' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} ${url} → timed out after ${timeoutMs}ms`);
  }
}

/** A 2xx response body failed its zod schema — upstream schema drift (BC-03 ACL boundary). */
export class BooksParseError extends BooksError {
  readonly code = 'BOOKS_PARSE_ERROR' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly issues: readonly string[],
  ) {
    super(
      `${method} ${url} → response failed schema validation (upstream schema drift?): ` +
        issues.slice(0, 5).join('; '),
    );
  }
}
