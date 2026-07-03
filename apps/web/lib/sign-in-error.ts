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
export function signInErrorRedirect(status?: number | null): string {
  return status === 429 ? '/login?error=rate_limited' : '/login?error=sso_unavailable';
}
