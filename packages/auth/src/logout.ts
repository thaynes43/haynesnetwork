/**
 * DESIGN-002 D-15 — RP-initiated logout. Clicking "Sign out" must end the Authentik
 * SSO session, not just this app's Better Auth session: otherwise Authentik's own
 * session cookie survives and the next "Log In" silently re-authenticates with no
 * login page (owner-reported bug). On sign-out we redirect the browser to the OIDC
 * issuer's `end_session_endpoint` with `post_logout_redirect_uri` (our `/login`) and,
 * when we have it, `id_token_hint` — so Authentik invalidates its session and bounces
 * back to /login.
 *
 * Graceful degradation: when the issuer's discovery document advertises NO
 * `end_session_endpoint` (the e2e stub OIDC), or OIDC is disabled, or there is no live
 * local session, we fall back to a plain local logout — /login on our own origin, the
 * pre-fix behavior. Deriving everything from `authEnv()` keeps staging + e2e working
 * without hardcoding hosts.
 *
 * Stale-hint guard (live incident 2026-07-07): we ONLY hand the browser to Authentik's
 * end-session endpoint when the account's stored `id_token` is present AND unexpired.
 * Two reasons. (1) Authentik REQUIRES a valid `id_token_hint` next to a
 * `post_logout_redirect_uri` — a hint-less end-session request with a redirect is a
 * `TokenError` error page. (2) More importantly, Authentik's SSO session is a
 * browser-close session (login `session_duration=seconds=0`) while our Better Auth
 * session lives 7 days, and the id_token is never refreshed (no refresh token is
 * stored). So a user who returns hours/days later has a live app session but a DEAD
 * Authentik session; hitting end-session then is unauthenticated, and Authentik's
 * `PolicyAccessView` bounces the browser into the *login* flow — the "log in to log
 * out" loop / broken error card the owner hit. A stale (or absent) id_token is our best
 * available proxy for "the Authentik session is probably gone", so we skip the round
 * trip and log out locally. A fresh id_token (the immediate sign-out that actually needs
 * the SSO session ended, and the e2e/normal path) still gets full RP-initiated logout.
 */
import { and, eq } from 'drizzle-orm';
import { db, account } from '@hnet/db';
import { auth, oidcEnabled } from './config';
import { authEnv, OIDC_PROVIDER_ID } from './env';

/**
 * The post-logout landing page on our own origin, derived from `BETTER_AUTH_URL`
 * (never hardcoded): production → `https://haynesnetwork.com/login`, staging →
 * `https://haynesnetwork.haynesops.com/login`, e2e → the app port's `/login`.
 * This value is both the `post_logout_redirect_uri` sent to Authentik AND the
 * local fallback target.
 */
export function postLogoutRedirectUri(baseUrl: string): string {
  return new URL('/login', baseUrl).toString();
}

export interface EndSessionParams {
  /** From the issuer's discovery doc; null/undefined ⇒ no RP-initiated logout. */
  endSessionEndpoint: string | null | undefined;
  /** Registered post-logout landing (see `postLogoutRedirectUri`). */
  postLogoutRedirectUri: string;
  /** The account's stored OIDC id_token, when present (lets Authentik skip its
   *  logout confirmation prompt). Omitted when absent. */
  idTokenHint?: string | null;
}

/**
 * Pure builder for the OIDC RP-initiated logout URL (DESIGN-002 D-15). Returns null
 * when the issuer advertises no `end_session_endpoint` — the caller then falls back to
 * a local logout. `id_token_hint` is attached only when present; without it the
 * registered `post_logout_redirect_uri` still governs where Authentik lands.
 */
export function buildEndSessionUrl(params: EndSessionParams): string | null {
  const { endSessionEndpoint, postLogoutRedirectUri: redirectUri, idTokenHint } = params;
  if (!endSessionEndpoint) return null;
  const url = new URL(endSessionEndpoint);
  url.searchParams.set('post_logout_redirect_uri', redirectUri);
  if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
  return url.toString();
}

/**
 * Read the `exp` (expiry, seconds since epoch) from an OIDC id_token WITHOUT verifying
 * its signature — this is a best-effort freshness heuristic, not a security check
 * (Authentik re-validates the hint server-side). Returns the expiry in milliseconds, or
 * null when the token is absent, malformed, or carries no numeric `exp`. Pure + exported
 * for the unit tests. Uses base64url → JSON on the payload segment only.
 */
export function idTokenExpMs(idToken: string | null | undefined): number | null {
  if (!idToken) return null;
  const payloadSegment = idToken.split('.')[1];
  if (!payloadSegment) return null;
  try {
    const payloadJson = Buffer.from(payloadSegment, 'base64url').toString('utf8');
    const exp = (JSON.parse(payloadJson) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * True when `idToken` is present, parseable, and not yet expired (with a small negative
 * `skewMs` tolerance for clock drift). This gates RP-initiated logout: only a fresh
 * id_token is handed to Authentik as an `id_token_hint`. An absent / malformed / expired
 * token returns false so the caller degrades to a local logout (see the module doc —
 * the stale-hint guard for the 2026-07-07 sign-out incident). Pure + exported for tests.
 */
export function isFreshIdToken(
  idToken: string | null | undefined,
  nowMs: number = Date.now(),
  skewMs: number = 0,
): boolean {
  const expMs = idTokenExpMs(idToken);
  return expMs !== null && expMs > nowMs - skewMs;
}

/**
 * Pure extractor for `end_session_endpoint` from a parsed OIDC discovery document.
 * Returns null when the field is absent or not a non-empty string (the stub OIDC
 * case), so the caller degrades to a local logout.
 */
export function parseEndSessionEndpoint(discovery: unknown): string | null {
  if (discovery && typeof discovery === 'object') {
    const value = (discovery as Record<string, unknown>).end_session_endpoint;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

interface DiscoveryCacheEntry {
  endSessionEndpoint: string | null;
  fetchedAt: number;
}

const DISCOVERY_TTL_MS = 5 * 60 * 1000; // re-read the discovery doc at most every 5 min
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/**
 * Read `end_session_endpoint` from the OIDC discovery document, cached per discovery
 * URL for a few minutes (sign-out shouldn't fetch discovery every time). Returns null
 * when the endpoint is absent OR the fetch fails — a discovery hiccup degrades to a
 * local logout rather than a broken sign-out. Exported for the unit tests.
 */
export async function fetchEndSessionEndpoint(discoveryUrl: string): Promise<string | null> {
  const cached = discoveryCache.get(discoveryUrl);
  if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) {
    return cached.endSessionEndpoint;
  }
  let endSessionEndpoint: string | null = null;
  try {
    const res = await fetch(discoveryUrl, { headers: { accept: 'application/json' } });
    if (res.ok) endSessionEndpoint = parseEndSessionEndpoint(await res.json());
  } catch {
    endSessionEndpoint = null;
  }
  discoveryCache.set(discoveryUrl, { endSessionEndpoint, fetchedAt: Date.now() });
  return endSessionEndpoint;
}

/** The stored OIDC id_token for a user's Authentik account, or null. Best-effort:
 *  a read failure degrades to no hint (Authentik falls back to its confirm/session). */
async function getIdTokenHintForUser(userId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ idToken: account.idToken })
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, OIDC_PROVIDER_ID)))
      .limit(1);
    return row?.idToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve where the browser goes after clicking Sign out (DESIGN-002 D-15). When OIDC
 * is enabled, a live local session exists, and the issuer advertises an
 * `end_session_endpoint`, this is the RP-initiated logout URL (so the Authentik SSO
 * session ends); otherwise it is the local `/login`.
 *
 * MUST be called while the session is still live (before the sign-out that clears it)
 * so `id_token_hint` can be read from the account row. Requiring a live session also
 * keeps the GET logout route inert for requests that don't carry our SameSite=Lax
 * session cookie — a cross-site `<img>`/prefetch can't drive an SSO logout.
 */
export async function resolveSignOutRedirect(headers: Headers): Promise<string> {
  const env = authEnv();
  const localLogin = postLogoutRedirectUri(env.baseUrl);
  if (!oidcEnabled) return localLogin;

  const session = await auth.api.getSession({ headers });
  if (!session) return localLogin;

  const endSessionEndpoint = await fetchEndSessionEndpoint(env.oidcDiscoveryUrl);
  if (!endSessionEndpoint) return localLogin;

  // Stale-hint guard (see module doc): RP-initiated logout only when we hold a fresh,
  // unexpired id_token to present as the hint. Otherwise the Authentik SSO session is
  // almost certainly already gone (browser-close session; the id_token is never
  // refreshed), and routing to end-session would bounce the browser into the login flow
  // — the owner-reported "log in to log out" error card. Degrade to a local logout.
  const idTokenHint = await getIdTokenHintForUser(session.user.id);
  if (!isFreshIdToken(idTokenHint)) return localLogin;

  return (
    buildEndSessionUrl({
      endSessionEndpoint,
      postLogoutRedirectUri: localLogin,
      idTokenHint,
    }) ?? localLogin
  );
}
