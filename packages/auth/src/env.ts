/**
 * DESIGN-002 D-08 — the auth environment contract, in one place. `authEnv()` is the
 * non-throwing typed reader used by config.ts (the app must still boot without OIDC
 * creds — CI builds, unit tests); `assertAuthEnv()` is the startup validator for
 * deployed environments and throws listing every missing required variable at once.
 */

export const DEFAULT_OIDC_DISCOVERY_URL =
  'https://authentik.haynesnetwork.com/application/o/haynesnetwork/.well-known/openid-configuration';

export const OIDC_PROVIDER_ID = 'authentik';

/** Dev-only cookie-signing fallback (donor constant); assertAuthEnv refuses it. */
export const DEV_FALLBACK_SECRET = 'dev-only-not-for-prod-not-for-prod';

export interface AuthEnv {
  /** Canonical origin; the OIDC redirect URI is derived from it (DESIGN-002 D-04). */
  baseUrl: string;
  /**
   * The full Better Auth `trustedOrigins` allowlist: the canonical `baseUrl`
   * origin plus every extra origin from `TRUSTED_ORIGINS` (e.g. `www` at the
   * public apex), de-duplicated. Behind the Cloudflare Tunnel the app is reachable
   * at both `haynesnetwork.com` and `www.haynesnetwork.com`; a sign-in initiated
   * from the non-baseURL origin is rejected by Better Auth's origin/CSRF check
   * unless that origin is trusted. Sourced from env so the list isn't hardcoded
   * (staging keeps working because its own baseUrl is always trusted).
   */
  trustedOrigins: string[];
  /** Session-cookie signing secret (BETTER_AUTH_SECRET, dev fallback when unset). */
  secret: string;
  /** True when both OIDC_CLIENT_ID and OIDC_CLIENT_SECRET are present. */
  oidcEnabled: boolean;
  oidcClientId: string | undefined;
  oidcClientSecret: string | undefined;
  oidcDiscoveryUrl: string;
  /** Parsed BOOTSTRAP_ADMIN_EMAILS — trimmed, lowercased, empties dropped (D-05). */
  bootstrapAdminEmails: string[];
}

/**
 * Parse the comma-separated BOOTSTRAP_ADMIN_EMAILS allowlist: trim whitespace,
 * lowercase (matching is case-insensitive, R-02), drop empty segments. Unset/empty
 * input yields [] — the bootstrap hook then no-ops (DESIGN-002 D-08).
 */
export function parseBootstrapAdminEmails(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Normalize a URL string to its origin (scheme + host [+ port], no path or
 * trailing slash — the exact form Better Auth's origin check compares against:
 * `pattern === getOrigin(url)`). Returns null for anything that isn't a parseable
 * absolute URL, so a malformed entry is dropped rather than silently never matching.
 */
function toOriginOrNull(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Parse the comma-separated TRUSTED_ORIGINS list into normalized origins: trim
 * whitespace, drop empty segments, normalize each to its origin, and drop any
 * entry that isn't a valid absolute URL. Unset/empty input yields [].
 */
export function parseTrustedOrigins(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .map(toOriginOrNull)
    .filter((o): o is string => o !== null);
}

/**
 * Resolve the complete Better Auth `trustedOrigins` allowlist: the `baseUrl`
 * origin first, then every extra origin from TRUSTED_ORIGINS, de-duplicated.
 * Better Auth trusts `baseUrl` implicitly too, but we include it so the resolved
 * allowlist is explicit and unit-testable (DESIGN-002 D-08). The public cutover
 * sets TRUSTED_ORIGINS to the `www` apex (and optionally the staging host); on
 * staging TRUSTED_ORIGINS can stay unset because that env's baseUrl is the
 * trusted origin. Never broadened beyond apex/www/staging (auth is sensitive).
 */
export function resolveTrustedOrigins(baseUrl: string, raw: string | undefined): string[] {
  const origins: string[] = [];
  const base = toOriginOrNull(baseUrl);
  if (base) origins.push(base);
  origins.push(...parseTrustedOrigins(raw));
  return [...new Set(origins)];
}

/** Typed, non-throwing read of the DESIGN-002 D-08 environment contract. */
export function authEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv {
  const oidcClientId = env.OIDC_CLIENT_ID;
  const oidcClientSecret = env.OIDC_CLIENT_SECRET;
  const baseUrl = env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  return {
    baseUrl,
    trustedOrigins: resolveTrustedOrigins(baseUrl, env.TRUSTED_ORIGINS),
    secret: env.BETTER_AUTH_SECRET ?? DEV_FALLBACK_SECRET,
    // App still boots without OIDC creds (CI builds, unit tests); the login page
    // renders a config-error state instead of a sign-in button when disabled.
    oidcEnabled: Boolean(oidcClientId && oidcClientSecret),
    oidcClientId,
    oidcClientSecret,
    oidcDiscoveryUrl: env.OIDC_DISCOVERY_URL ?? DEFAULT_OIDC_DISCOVERY_URL,
    bootstrapAdminEmails: parseBootstrapAdminEmails(env.BOOTSTRAP_ADMIN_EMAILS),
  };
}

/** Variables a deployed environment must set (DESIGN-002 D-08 "Required" column). */
const REQUIRED_AT_RUNTIME = [
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'BOOTSTRAP_ADMIN_EMAILS',
] as const;

/**
 * Startup validator for deployed environments: throws one error naming every missing
 * required variable (and a BETTER_AUTH_SECRET left on the dev fallback). Call this
 * from server bootstrap (e.g. Next.js instrumentation) — NOT at module load, so
 * `next build` and tests keep working without secrets.
 */
export function assertAuthEnv(env: NodeJS.ProcessEnv = process.env): AuthEnv {
  const missing = REQUIRED_AT_RUNTIME.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(
      `@hnet/auth: missing required environment variables: ${missing.join(', ')} ` +
        '(see DESIGN-002 D-08 for the contract)',
    );
  }
  if (env.BETTER_AUTH_SECRET === DEV_FALLBACK_SECRET) {
    throw new Error(
      '@hnet/auth: BETTER_AUTH_SECRET is the dev fallback constant — generate a real ' +
        'secret (openssl rand -base64 32) per DESIGN-002 D-08',
    );
  }
  return authEnv(env);
}
