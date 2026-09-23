// DESIGN-005 D-18 — typed error taxonomy for the *arr/Seerr HTTP clients.
// Messages never contain API keys. The *arrs, Seerr, Bazarr and Maintainerr take their key in a header,
// but Tautulli (`apikey`) and TMDB v3 (`api_key`) can only take it in the QUERY STRING, so the request URL
// these errors carry is itself a secret. DESIGN-049 D-01 (PLAN-068 S3): every constructor below stores a
// REDACTED url (`redactUrl`) and every message passes through `redactSecrets` in the base class — the
// `message`, `stack`, `url` and `bodySnippet` of an ArrError never hold a credential value.
import { redactSecrets, redactUrl } from './redact';

/** Base class — lets callers `catch (e) { if (e instanceof ArrError) … }`. */
export class ArrError extends Error {
  constructor(message: string) {
    // Defense in depth: whatever a subclass (or a future one) interpolates, the message — and therefore
    // the stack, which embeds it — is scrubbed of credential query values before it exists.
    super(redactSecrets(message));
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
  /** The request URL with every credential query value replaced by `REDACTED`. */
  readonly url: string;
  /** The first ≤300 characters of the response body, credential values redacted (servers echo URLs). */
  readonly bodySnippet?: string;
  constructor(
    readonly status: number,
    readonly method: string,
    url: string,
    bodySnippet?: string,
  ) {
    const safeUrl = redactUrl(url);
    const safeSnippet = bodySnippet === undefined ? undefined : redactSecrets(bodySnippet);
    super(`${method} ${safeUrl} → HTTP ${status}${safeSnippet ? ` — ${safeSnippet}` : ''}`);
    this.url = safeUrl;
    this.bodySnippet = safeSnippet;
  }
}

/** The request exceeded the client timeout (aborted). */
export class ArrTimeoutError extends ArrError {
  readonly code = 'ARR_TIMEOUT' as const;
  /** The request URL with every credential query value replaced by `REDACTED`. */
  readonly url: string;
  constructor(
    readonly method: string,
    url: string,
    readonly timeoutMs: number,
  ) {
    const safeUrl = redactUrl(url);
    super(`${method} ${safeUrl} → timed out after ${timeoutMs}ms`);
    this.url = safeUrl;
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
  /** The request URL with every credential query value replaced by `REDACTED`. */
  readonly url: string;
  constructor(
    readonly method: string,
    url: string,
    readonly upstreamMessage?: string,
  ) {
    const safeUrl = redactUrl(url);
    super(
      `${method} ${safeUrl} → Maintainerr reported a logical failure (code 0)` +
        `${upstreamMessage ? ` — ${upstreamMessage}` : ''}`,
    );
    this.url = safeUrl;
  }
}

/** A 2xx response body failed its zod schema — upstream schema drift (BC-03 ACL). */
export class ArrParseError extends ArrError {
  readonly code = 'ARR_PARSE_ERROR' as const;
  /** The request URL with every credential query value replaced by `REDACTED`. */
  readonly url: string;
  constructor(
    readonly method: string,
    url: string,
    readonly issues: readonly string[],
  ) {
    const safeUrl = redactUrl(url);
    super(
      `${method} ${safeUrl} → response failed schema validation (upstream schema drift?): ` +
        issues.slice(0, 5).join('; '),
    );
    this.url = safeUrl;
  }
}
