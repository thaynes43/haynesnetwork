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

  const idTokenHint = await getIdTokenHintForUser(session.user.id);
  return (
    buildEndSessionUrl({
      endSessionEndpoint,
      postLogoutRedirectUri: localLogin,
      idTokenHint,
    }) ?? localLogin
  );
}
