// ADR-091 / DESIGN-050 D-04..D-06 — OAuth protocol errors (RFC 6749 §4.1.2.1 / §5.2, RFC 7591 §3.2.2, RFC 8707
// §2), ported from cigar-journal `packages/oauth/src/errors.ts`. Thrown by the provider and mapped by the route
// adapters to the RFC status + JSON body. They speak the OAuth wire protocol to clients — distinct from the
// @hnet/domain error taxonomy. `description` is sent to the client, so it never carries a secret.

export type OAuthErrorCode =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'invalid_scope'
  | 'invalid_target' // RFC 8707 — the resource indicator is not ours
  | 'access_denied'
  | 'unsupported_response_type'
  | 'invalid_redirect_uri' // RFC 7591
  | 'invalid_client_metadata' // RFC 7591
  | 'temporarily_unavailable' // RFC 6749 §4.1.2.1 — the rate limit (D-10)
  | 'server_error';

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = 'OAuthError';
  }

  toBody(): { error: OAuthErrorCode; error_description: string } {
    return { error: this.code, error_description: this.description };
  }
}

export const invalidRequest = (d: string): OAuthError => new OAuthError('invalid_request', d);
export const invalidClient = (d: string): OAuthError => new OAuthError('invalid_client', d, 401);
export const invalidGrant = (d: string): OAuthError => new OAuthError('invalid_grant', d);
export const invalidTarget = (d: string): OAuthError => new OAuthError('invalid_target', d);
export const invalidScope = (d: string): OAuthError => new OAuthError('invalid_scope', d);
export const unsupportedGrantType = (d: string): OAuthError =>
  new OAuthError('unsupported_grant_type', d);
export const invalidRedirectUri = (d: string): OAuthError =>
  new OAuthError('invalid_redirect_uri', d);
export const invalidClientMetadata = (d: string): OAuthError =>
  new OAuthError('invalid_client_metadata', d);
export const rateLimited = (): OAuthError =>
  new OAuthError('temporarily_unavailable', 'Too many requests. Try again later.', 429);
