// ADR-091 / DESIGN-050 D-04..D-06 — request validation, pure: the DCR body, redirect URIs and the loopback rule,
// the authorization request, and the token / revoke request bodies. Ported from cigar-journal
// `packages/oauth/src/provider.ts` (the validation half) and `apps/web/lib/oauth/http.ts` (client credentials),
// with DESIGN-050's rules: `state` required, a missing `scope` grants the default three, `client_name` 1–80,
// 1–5 https-or-loopback redirect URIs, and every parameter bounded. Nothing here touches a database — the
// @hnet/domain oauth writers call these before they write.
import { z } from 'zod';
import {
  CLIENT_NAME_MAX,
  CODE_CHALLENGE_PATTERN,
  DEFAULT_SCOPES,
  OAUTH_GRANT_TYPES,
  OAUTH_RESPONSE_TYPES,
  OAUTH_TOKEN_ENDPOINT_AUTH_METHODS,
  PRESENTED_SECRET_MAX_LENGTH,
  REDIRECT_URIS_MAX,
  REDIRECT_URI_MAX_LENGTH,
  SCOPE_PARAM_MAX_LENGTH,
  STATE_MAX_LENGTH,
  canonicalScopes,
  isSupportedScope,
  mcpResource,
  resourceMatches,
  type OAuthEnv,
  type OAuthGrantType,
  type OAuthResponseType,
  type OAuthScope,
  type OAuthTokenEndpointAuthMethod,
} from './config';
import {
  OAuthError,
  invalidClientMetadata,
  invalidRedirectUri,
  invalidRequest,
  invalidScope,
  invalidTarget,
  unsupportedGrantType,
} from './errors';
import { authEvent, loggableResource } from './logger';

// ---- redirect URIs (D-04, D-05 step 1) ----------------------------------------------------------------

// The three interchangeable loopback host forms. A native client listening on an ephemeral loopback port cannot
// control which literal the OS or browser ends up using (127.0.0.1, [::1] or the name "localhost"), nor which port
// it is handed — RFC 8252 §7.3 has the AS match a registered loopback redirect regardless of the port.
// `hostname` yields "[::1]" for IPv6; strip the brackets.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, ''));
}

/**
 * D-04: a redirect URI is an absolute `https://` URL, or an `http://` URL on a loopback host (127.0.0.1, [::1],
 * localhost) — never another scheme, never credentials in the URL (the consent page shows the host, and
 * `https://chatgpt.com@evil.example` would read as ChatGPT), never a fragment (RFC 6749 §3.1.2), and at most
 * {@link REDIRECT_URI_MAX_LENGTH} characters. Returns why it is refused, or null when it is valid.
 */
export function redirectUriProblem(uri: string): string | null {
  if (uri.length === 0 || uri.length > REDIRECT_URI_MAX_LENGTH) return 'has an invalid length';
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return 'is not an absolute URL';
  }
  if (u.username || u.password) return 'must not carry credentials';
  if (uri.includes('#')) return 'must not carry a fragment';
  if (u.protocol === 'https:') return u.hostname ? null : 'has no host';
  if (u.protocol === 'http:') {
    return isLoopbackHost(u.hostname) ? null : 'must be https unless it is a loopback address';
  }
  return 'must be https or a loopback http address';
}

/**
 * Does a presented redirect_uri match a registered one (D-05 step 1)? Non-loopback URIs compare exactly (byte
 * for byte) — what keeps an https callback pinned. A loopback callback follows RFC 8252 §7.3: both sides
 * loopback, same scheme, same path + query + fragment, while the port (and the loopback literal) may differ. A
 * registered loopback URI never loosens matching for a non-loopback request (both sides must be loopback), so
 * this cannot widen to an attacker-controlled host.
 */
export function redirectUriMatches(registered: string, incoming: string): boolean {
  if (registered === incoming) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(incoming);
  } catch {
    return false;
  }
  if (a.protocol === b.protocol && isLoopbackHost(a.hostname) && isLoopbackHost(b.hostname)) {
    return a.pathname === b.pathname && a.search === b.search && a.hash === b.hash;
  }
  return false;
}

// ---- DCR (RFC 7591, D-04) -----------------------------------------------------------------------------

// A client name is shown on the consent page and logged, so it is NFKC-normalized (compatibility forms such as
// full-width letters fold to their plain form) and refused when it holds a character that can hide or disguise
// text: controls (Cc), format characters (Cf — the bidi overrides and isolates, U+061C, zero-width U+200B–U+200D,
// U+2060, U+FEFF, the tag characters), the line and paragraph separators (Zl, Zp), private-use (Co) and unassigned
// (Cn) code points, and the Hangul fillers (letters by category, but blank on screen). Written with escapes only.
const UNSAFE_NAME_CHARS = new RegExp(
  '[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}\\p{Co}\\p{Cn}\\u115F\\u1160\\u3164\\uFFA0]',
  'u',
);

/** NFKC, then trimmed — the stored and displayed form of a client name (after the character check). */
export function normalizeClientName(name: string): string {
  return name.normalize('NFKC').trim();
}

/**
 * The D-04 registration body. Unknown RFC 7591 metadata (client_uri, logo_uri, contacts, …) is accepted and
 * ignored, as RFC 7591 §2 allows; everything stored is validated here and again by the schema CHECKs.
 */
const registrationSchema = z
  .object({
    redirect_uris: z
      .array(z.string('each redirect_uri must be a string'), 'redirect_uris must be an array')
      .min(1, 'redirect_uris is required and must be a non-empty array')
      .max(REDIRECT_URIS_MAX, `At most ${REDIRECT_URIS_MAX} redirect_uris are allowed`),
    client_name: z
      .string('client_name is required')
      // NFKC, then the character check on the UNTRIMMED text (trim() would silently drop a leading U+FEFF), then trim.
      .transform((s) => s.normalize('NFKC'))
      .refine(
        (s) => !UNSAFE_NAME_CHARS.test(s),
        'client_name contains invisible or control characters',
      )
      .transform((s) => s.trim())
      .pipe(
        z
          .string()
          .min(1, 'client_name is required')
          .max(CLIENT_NAME_MAX, `client_name is at most ${CLIENT_NAME_MAX} characters`),
      ),
    token_endpoint_auth_method: z
      .enum(OAUTH_TOKEN_ENDPOINT_AUTH_METHODS, 'Unsupported token_endpoint_auth_method')
      .optional(),
    grant_types: z.array(z.enum(OAUTH_GRANT_TYPES, 'Unsupported grant_type')).min(1).optional(),
    response_types: z
      .array(z.enum(OAUTH_RESPONSE_TYPES, 'Unsupported response_type'))
      .min(1)
      .optional(),
    scope: z
      .string('scope must be a string')
      .max(SCOPE_PARAM_MAX_LENGTH, 'scope is too long')
      .optional(),
  })
  .loose();

/** A validated, normalized RFC 7591 registration. */
export interface ClientRegistration {
  clientName: string;
  redirectUris: string[];
  authMethod: OAuthTokenEndpointAuthMethod;
  grantTypes: OAuthGrantType[];
  responseTypes: OAuthResponseType[];
  /** The registered `scope` string in canonical order, when one was sent. */
  scope: string | null;
}

/** Split a scope string on whitespace (RFC 6749 §3.3). */
export function splitScopes(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}

/**
 * D-04 — validate an RFC 7591 registration body. Errors are RFC 7591 §3.2.2 codes: `invalid_redirect_uri` for
 * a bad redirect list, `invalid_client_metadata` for everything else. Duplicate redirect URIs collapse.
 */
export function validateRegistration(body: unknown): ClientRegistration {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidClientMetadata('The registration body must be a JSON object');
  }
  const parsed = registrationSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue?.message ?? 'Invalid client metadata';
    if (issue?.path[0] === 'redirect_uris') throw invalidRedirectUri(message);
    throw invalidClientMetadata(message);
  }
  const req = parsed.data;
  for (const uri of req.redirect_uris) {
    const problem = redirectUriProblem(uri);
    if (problem) throw invalidRedirectUri(`A redirect_uri ${problem}`);
  }
  let scope: string | null = null;
  if (req.scope !== undefined && req.scope.trim() !== '') {
    const requested = splitScopes(req.scope);
    if (requested.some((s) => !isSupportedScope(s))) {
      throw invalidClientMetadata('scope names an unsupported scope');
    }
    scope = canonicalScopes(requested).join(' ');
  }
  return {
    clientName: req.client_name,
    redirectUris: [...new Set(req.redirect_uris)],
    authMethod: req.token_endpoint_auth_method ?? 'none',
    grantTypes: [...new Set(req.grant_types ?? OAUTH_GRANT_TYPES)],
    responseTypes: [...new Set(req.response_types ?? OAUTH_RESPONSE_TYPES)],
    scope,
  };
}

// ---- the authorization request (D-05 step 2) ----------------------------------------------------------

export interface AuthorizationParams {
  responseType?: string;
  scope?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  /** Every `resource` parameter sent (RFC 8707 allows several; we serve exactly one resource). */
  resources?: string[];
  state?: string;
}

export interface ValidatedAuthorization {
  scopes: OAuthScope[];
  resource: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  state: string;
}

/**
 * D-05 step 2 — validate the authorization parameters: `response_type` `code`; `state` REQUIRED (stricter than the
 * port); a 43-character S256 `code_challenge` (`plain` refused); every scope one of the three, a missing or empty
 * `scope` meaning all three; `resource`, if sent, the canonical one (`invalid_target`, logged
 * `audience_mismatch`). Errors are OAuthErrors; the route renders them as the bad-request page — never a redirect to
 * the client (RFC 9700 §4.11.2: a dynamically registered redirect URI is not a trusted one).
 */
export function validateAuthorizationParams(
  params: AuthorizationParams,
  ctx: { env?: OAuthEnv; clientId?: string } = {},
): ValidatedAuthorization {
  if (params.responseType !== 'code') {
    throw new OAuthError('unsupported_response_type', 'Only response_type=code is supported');
  }
  if (!params.state) throw invalidRequest('state is required');
  if (params.state.length > STATE_MAX_LENGTH) throw invalidRequest('state is too long');
  if (!params.codeChallenge) throw invalidRequest('PKCE code_challenge is required');
  if (params.codeChallengeMethod !== 'S256') {
    throw invalidRequest('Only PKCE code_challenge_method=S256 is supported');
  }
  if (!CODE_CHALLENGE_PATTERN.test(params.codeChallenge)) {
    throw invalidRequest('code_challenge is not an S256 challenge');
  }

  let scopes: OAuthScope[] = [...DEFAULT_SCOPES];
  if (params.scope !== undefined && params.scope.trim() !== '') {
    if (params.scope.length > SCOPE_PARAM_MAX_LENGTH) throw invalidScope('scope is too long');
    const requested = splitScopes(params.scope);
    if (requested.some((s) => !isSupportedScope(s)))
      throw invalidScope('scope names an unsupported scope');
    scopes = canonicalScopes(requested);
  }

  const canonical = mcpResource(ctx.env);
  for (const resource of params.resources ?? []) {
    if (!resourceMatches(resource, canonical)) {
      authEvent('audience_mismatch', {
        phase: 'authorize',
        client_id: ctx.clientId ?? null,
        requested: loggableResource(resource),
        expected: canonical,
      });
      throw invalidTarget('Unknown resource indicator');
    }
  }

  return {
    scopes,
    resource: canonical,
    codeChallenge: params.codeChallenge,
    codeChallengeMethod: 'S256',
    state: params.state,
  };
}

// ---- token and revoke requests (D-06) -----------------------------------------------------------------

/** What the token and revoke endpoints read their parameters from (a parsed form body). */
export interface ParamSource {
  get(name: string): string | null;
  getAll(name: string): string[];
}

/** RFC 6749 §3.2: a parameter may not be sent twice. Returns the single value, or undefined when absent. */
function single(params: ParamSource, name: string): string | undefined {
  const all = params.getAll(name);
  if (all.length > 1) throw invalidRequest(`${name} was sent more than once`);
  return all[0] === undefined || all[0] === '' ? undefined : all[0];
}

export type TokenRequest =
  | {
      grantType: 'authorization_code';
      code: string;
      codeVerifier?: string;
      redirectUri?: string;
      resource?: string;
    }
  | { grantType: 'refresh_token'; refreshToken: string; scope?: string; resource?: string };

/**
 * D-06 — the token request body: `grant_type` `authorization_code` (with `code`, and the verifier, redirect and
 * resource the exchange checks) or `refresh_token` (with `refresh_token`, an optional narrowing `scope` and
 * `resource`). Anything else is `unsupported_grant_type`; a missing credential is `invalid_request`.
 */
export function parseTokenRequest(params: ParamSource): TokenRequest {
  const grantType = single(params, 'grant_type');
  const bounded = (name: string, max = PRESENTED_SECRET_MAX_LENGTH): string | undefined => {
    const v = single(params, name);
    if (v !== undefined && v.length > max) throw invalidRequest(`${name} is too long`);
    return v;
  };
  if (grantType === 'authorization_code') {
    const code = bounded('code');
    if (!code) throw invalidRequest('code is required');
    const codeVerifier = bounded('code_verifier');
    const redirectUri = bounded('redirect_uri', REDIRECT_URI_MAX_LENGTH);
    const resource = bounded('resource', REDIRECT_URI_MAX_LENGTH);
    return {
      grantType,
      code,
      ...(codeVerifier !== undefined ? { codeVerifier } : {}),
      ...(redirectUri !== undefined ? { redirectUri } : {}),
      ...(resource !== undefined ? { resource } : {}),
    };
  }
  if (grantType === 'refresh_token') {
    const refreshToken = bounded('refresh_token');
    if (!refreshToken) throw invalidRequest('refresh_token is required');
    const scope = bounded('scope', SCOPE_PARAM_MAX_LENGTH);
    const resource = bounded('resource', REDIRECT_URI_MAX_LENGTH);
    return {
      grantType,
      refreshToken,
      ...(scope !== undefined ? { scope } : {}),
      ...(resource !== undefined ? { resource } : {}),
    };
  }
  throw unsupportedGrantType(grantType ? 'Unsupported grant_type' : 'grant_type is required');
}

/** D-06 / RFC 7009 — the revoke request: the `token` (and an ignored `token_type_hint`). */
export function parseRevokeRequest(params: ParamSource): { token: string } {
  const token = single(params, 'token');
  if (!token) throw invalidRequest('token is required');
  if (token.length > PRESENTED_SECRET_MAX_LENGTH) throw invalidRequest('token is too long');
  return { token };
}

export interface ClientCredentials {
  clientId?: string;
  clientSecret?: string;
  /** Which RFC 6749 §2.3.1 channel carried them (the 401 of a Basic attempt carries a Basic challenge). */
  via: 'basic' | 'body' | 'none';
}

/**
 * D-06 — client credentials from HTTP Basic or the body. A client may use one channel only (RFC 6749 §2.3.1),
 * so Basic plus a body `client_secret` is refused; a body `client_id` alongside Basic must name the same client.
 * Basic's id and secret are form-urlencoded before base64 (RFC 6749 §2.3.1), so both are decoded.
 */
export function parseClientCredentials(
  authorization: string | null,
  params: ParamSource,
): ClientCredentials {
  const bodyId = single(params, 'client_id');
  const bodySecret = single(params, 'client_secret');
  const header = authorization?.trim() ?? '';
  const m = /^basic\s+([A-Za-z0-9+/=_-]+)$/i.exec(header);
  if (m) {
    const decoded = Buffer.from(m[1] ?? '', 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) throw invalidRequest('Malformed HTTP Basic credentials');
    let clientId: string;
    let clientSecret: string;
    try {
      clientId = decodeURIComponent(decoded.slice(0, idx).replace(/\+/g, ' '));
      clientSecret = decodeURIComponent(decoded.slice(idx + 1).replace(/\+/g, ' '));
    } catch {
      throw invalidRequest('Malformed HTTP Basic credentials');
    }
    if (bodySecret !== undefined) throw invalidRequest('Use one client authentication method');
    if (bodyId !== undefined && bodyId !== clientId)
      throw invalidRequest('client_id does not match');
    return { clientId, clientSecret, via: 'basic' };
  }
  if (bodyId !== undefined) {
    return {
      clientId: bodyId,
      ...(bodySecret !== undefined ? { clientSecret: bodySecret } : {}),
      via: 'body',
    };
  }
  return { via: 'none' };
}

/** The bearer credential of an `Authorization: Bearer <token>` header, or null. */
export function parseBearer(authorization: string | null): string | null {
  const m = /^bearer\s+(\S+)$/i.exec(authorization?.trim() ?? '');
  const token = m?.[1] ?? '';
  return token.length > 0 && token.length <= PRESENTED_SECRET_MAX_LENGTH ? token : null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A well-formed transaction id (D-05 step 6): anything else is never looked up. */
export const isUuid = (s: string): boolean => UUID_PATTERN.test(s);

/** A DCR client id is 32 lowercase hex characters; anything else can never match a row. */
export const isClientId = (s: string): boolean => /^[0-9a-f]{32}$/.test(s);
