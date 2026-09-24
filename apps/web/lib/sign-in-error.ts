import { safeNext } from './safe-next';

/**
 * Sign-in error taxonomy (DESIGN-002 "Rate limiting & error surfaces").
 *
 * Maps a failed OAuth *initiation* (POST /api/auth/sign-in/oauth2) to the
 * /login?error=… redirect the login page renders copy for:
 *
 * - 429 → rate_limited: better-auth's rate limiter (production-only) said no —
 *   distinct copy so the user waits instead of hammering the button.
 * - anything else (5xx, network failure → no status) → sso_unavailable.
 *
 * Callback failures (after Authentik) never come through here — they arrive via
 * better-auth's errorCallbackURL / onAPIError.errorURL as ?error=callback_failed.
 */
export function signInErrorRedirect(status?: number | null, next?: string | null): string {
  const base = status === 429 ? '/login?error=rate_limited' : '/login?error=sso_unavailable';
  return withNext(base, next);
}

/**
 * ADR-091 / DESIGN-050 D-09 — keep a safe `next` across a failed sign-in, so retrying from the error still lands
 * the user back where they started (the OAuth consent flow). `/` (the default) is never appended.
 */
export function withNext(path: string, next?: string | null): string {
  const safe = safeNext(next);
  return safe === '/' ? path : `${path}${path.includes('?') ? '&' : '?'}next=${encodeURIComponent(safe)}`;
}
