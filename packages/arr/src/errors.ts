// DESIGN-005 D-18 — typed error taxonomy for the *arr/Seerr HTTP clients.
// Messages never contain API keys: keys travel only in the X-Api-Key header and are
// never interpolated into URLs or error strings.

/** Base class — lets callers `catch (e) { if (e instanceof ArrError) … }`. */
export class ArrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** assertArrEnv failed — names the missing variables, never their values. */
export class ArrConfigError extends ArrError {
  readonly code = 'ARR_CONFIG_MISSING' as const;
  constructor(readonly missing: readonly string[]) {
    super(`missing required *arr environment variables: ${missing.join(', ')}`);
  }
}

/** Non-2xx response from an *arr/Seerr endpoint. */
export class ArrHttpError extends ArrError {
  readonly code = 'ARR_HTTP_ERROR' as const;
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly bodySnippet?: string,
  ) {
    super(
      `${method} ${url} → HTTP ${status}${bodySnippet ? ` — ${bodySnippet}` : ''}`,
    );
  }
}

/** The request exceeded the client timeout (aborted). */
export class ArrTimeoutError extends ArrError {
  readonly code = 'ARR_TIMEOUT' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} ${url} → timed out after ${timeoutMs}ms`);
  }
}

/**
 * ADR-023 (P1a): a Maintainerr WRITE returned an OK HTTP status (201/200) but its `ReturnStatus`/
 * `BasicResponseDto` body reported a LOGICAL failure (`code === 0` — e.g. `setExclusion` →
 * `{ code:0, message:'Failed - no metadata' }`). Without this, HTTP-status-only `requestVoid` reads
 * `code:0` as success → phantom exclusions/guardian protection + phantom `trash_excluded` events.
 * Reported like a non-2xx so the domain fails CLOSED (guardMaintainerrCall maps every ArrError →
 * MaintainerrUpstreamError → BAD_GATEWAY). The upstream `message`/`result` (a fixed status string,
 * never a secret — keys travel only in the x-api-key header) is included for diagnostics.
 */
export class MaintainerrWriteFailedError extends ArrError {
  readonly code = 'MAINTAINERR_WRITE_FAILED' as const;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly upstreamMessage?: string,
  ) {
    super(
      `${method} ${url} → Maintainerr reported a logical failure (code 0)` +
        `${upstreamMessage ? ` — ${upstreamMessage}` : ''}`,
    );
  }
}

/** A 2xx response body failed its zod schema — upstream schema drift (BC-03 ACL). */
export class ArrParseError extends ArrError {
  readonly code = 'ARR_PARSE_ERROR' as const;
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
