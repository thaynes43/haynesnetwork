// ADR-091 / DESIGN-050 D-02 / D-03 / D-04 / D-14 — the authorization server's configuration. The issuer and
// the protected resource both derive from BETTER_AUTH_URL — the one origin the app (and Better Auth) already
// trusts — and NEVER from the request: behind the Cloudflare Tunnel `req.url` carries the pod's listen address
// (0.0.0.0:3000), which no browser can follow. Ported from cigar-journal `packages/oauth/src/config.ts` with the
// haynesnetwork scopes, the D-14 copy and the D-04 / D-10 input bounds.
//
// D-01: this package is PURE — zod at runtime and nothing else (no database, no drizzle, no @hnet/domain, no
// Better Auth, no MCP SDK). The closed vocabularies below mirror the @hnet/db `enums.ts` const arrays the schema
// CHECKs are built from; `__tests__/parity.test.ts` fails on any drift.

/** D-02 / ADR-091 C-05: exactly these three scopes, advertised in both metadata documents. */
export const OAUTH_SCOPES = ['watch:read', 'watch:write', 'offline_access'] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** D-02 / D-04: public PKCE clients register `none`; confidential clients post a secret or use HTTP Basic. */
export const OAUTH_TOKEN_ENDPOINT_AUTH_METHODS = [
  'none',
  'client_secret_post',
  'client_secret_basic',
] as const;
export type OAuthTokenEndpointAuthMethod = (typeof OAUTH_TOKEN_ENDPOINT_AUTH_METHODS)[number];

/** D-04: a registration may narrow the grants to a subset, never widen them. */
export const OAUTH_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
export type OAuthGrantType = (typeof OAUTH_GRANT_TYPES)[number];

/** D-04: the authorization-code flow only. */
export const OAUTH_RESPONSE_TYPES = ['code'] as const;
export type OAuthResponseType = (typeof OAUTH_RESPONSE_TYPES)[number];

/** D-05: PKCE S256 only — `plain` is refused (OAuth 2.1). */
export const OAUTH_CODE_CHALLENGE_METHODS = ['S256'] as const;
export type OAuthCodeChallengeMethod = (typeof OAUTH_CODE_CHALLENGE_METHODS)[number];

/** The MCP scopes a delegated token can carry into `/mcp` (offline_access only gates refresh issuance). */
export const WATCH_SCOPES = ['watch:read', 'watch:write'] as const;
export type WatchScope = (typeof WATCH_SCOPES)[number];

/** Environment the configuration reads (defaults to `process.env`; tests pass their own). */
export type OAuthEnv = Record<string, string | undefined>;

/** D-03: access tokens live one hour. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
/** D-03: refresh tokens live 60 days, re-issued on every rotation. */
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 60;
/** D-03: a consent transaction must be decided within 10 minutes. */
export const AUTHORIZATION_TTL_SECONDS = 10 * 60;
/** D-03: authorization codes are exchanged within a minute, once. */
export const CODE_TTL_SECONDS = 60;

/** D-02 / ADR-091 C-05: exactly the three scopes, from the one const array the schema CHECKs are built on. */
export const SUPPORTED_SCOPES: readonly OAuthScope[] = OAUTH_SCOPES;
/** D-05 step 2: a request without `scope` gets all three, so no client ends up with an empty token. */
export const DEFAULT_SCOPES: readonly OAuthScope[] = OAUTH_SCOPES;

/**
 * D-14 — one consent line per requested scope (normative copy). `watch:write` has two forms: Plex write-back is
 * owner-only (ADR-091 C-04), so the line promises a Plex change only to the server owner. ADR-092 C-11 /
 * DESIGN-051 D-09 (as ruled in the PLAN-071 design review): both scopes name the owner's Plex watchlist, which
 * `watchlist` reads and `set_watchlist` changes; the `other` form is unchanged (a non-owner cannot change one).
 */
export const SCOPE_DESCRIPTIONS = {
  'watch:read': 'See what you have watched, what is unfinished, and your watchlist',
  'watch:write': {
    owner: 'Mark titles watched or dismissed, update Plex to match, and add or remove titles on your Plex watchlist',
    other: 'Mark titles watched or dismissed in your history',
  },
  offline_access: 'Stay connected without signing in again',
} as const;

/** D-14 — the Connected apps scope chips (normative copy). */
export const SCOPE_CHIPS: Readonly<Record<OAuthScope, string>> = {
  'watch:read': 'Read history',
  'watch:write': 'Mark titles',
  offline_access: 'Stays connected',
};

// ---------------------------------------------------------------------------------------------------
// D-04 / D-10 — bounded inputs. The registration caps (name, redirect-URI count) are also schema CHECKs; the
// others keep any one parameter from carrying an unbounded string into a query, a log line or a redirect.

/** D-04: `client_name` is 1–80 characters. */
export const CLIENT_NAME_MAX = 80;
/** D-04: 1–5 redirect URIs per client. */
export const REDIRECT_URIS_MAX = 5;
/** One redirect URI (ChatGPT's is ~60 characters; the loopback forms are shorter). */
export const REDIRECT_URI_MAX_LENGTH = 1024;
/** `state` is opaque to us and echoed back; clients send 32–64 characters. */
export const STATE_MAX_LENGTH = 1024;
/** A `scope` parameter or registration string (the three scopes together are 43 characters). */
export const SCOPE_PARAM_MAX_LENGTH = 256;
/** A code, token or client secret presented back to us (ours are 43 characters). */
export const PRESENTED_SECRET_MAX_LENGTH = 512;
/** RFC 7636 §4.2: an S256 challenge is BASE64URL(SHA-256) — exactly 43 characters. */
export const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** RFC 7636 §4.1: a verifier is 43–128 unreserved characters. */
export const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;

// ---------------------------------------------------------------------------------------------------
// D-03 — inline pruning.

/** Rows deleted per table per `/oauth/token` call, at most. */
export const PRUNE_BATCH_SIZE = 200;
/** Tokens expired or revoked more than this long ago are deleted. */
export const PRUNE_RETENTION_DAYS = 30;
/** A DCR client older than this that owns no token and no transaction is deleted. */
export const DORMANT_CLIENT_DAYS = 30;

/** D-07: `last_used_at` (token and client) is stamped at most once a minute. */
export const LAST_USED_RESOLUTION_MS = 60_000;

/** What `@hnet/auth` falls back to when BETTER_AUTH_URL is unset (dev, tests) — the issuer agrees with it. */
export const DEFAULT_ISSUER = 'http://localhost:3000';

/**
 * The issuer: the origin of BETTER_AUTH_URL (trimmed; a trailing slash or path is dropped). Throws on a value
 * that is not an absolute http(s) URL — a misconfigured issuer must fail loudly, never be guessed from the
 * request.
 */
export function issuerOrigin(env: OAuthEnv = process.env): string {
  const raw = env.BETTER_AUTH_URL?.trim() || DEFAULT_ISSUER;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('BETTER_AUTH_URL is not an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('BETTER_AUTH_URL must be an http(s) URL');
  }
  return url.origin;
}

/** The canonical protected resource (RFC 8707 audience): `<issuer>/mcp`. */
export function mcpResource(env: OAuthEnv = process.env): string {
  return `${issuerOrigin(env)}/mcp`;
}

/** The RFC 9728 metadata URL the `/mcp` 401 challenge points at. */
export function protectedResourceMetadataUrl(env: OAuthEnv = process.env): string {
  return `${issuerOrigin(env)}/.well-known/oauth-protected-resource`;
}

/** Trailing-slash-insensitive comparison of two resource identifiers (the port's rule). */
export function resourceMatches(a: string, b: string): boolean {
  const norm = (s: string): string => s.replace(/\/+$/, '');
  return norm(a) === norm(b);
}

export function isSupportedScope(scope: string): scope is OAuthScope {
  return (SUPPORTED_SCOPES as readonly string[]).includes(scope);
}

/** A scope set in the canonical (advertised) order, de-duplicated. */
export function canonicalScopes(scopes: Iterable<string>): OAuthScope[] {
  const set = new Set(scopes);
  return SUPPORTED_SCOPES.filter((s) => set.has(s));
}
