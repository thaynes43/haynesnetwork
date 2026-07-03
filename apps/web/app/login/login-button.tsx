'use client';

// AC-01 / DESIGN-004 D-11 — the single sign-in affordance. No password form exists;
// authClient.signIn.oauth2 POSTs Better Auth's /sign-in/oauth2 and follows the
// Authentik authorization redirect. Failures land back on /login?error=… (the server
// page renders the alert).

import { useState } from 'react';
// The ./env subpath is dependency-free (no db/server code) — safe in a client bundle.
import { OIDC_PROVIDER_ID } from '@hnet/auth/env';
import { authClient } from '@/lib/auth-client';
import { signInErrorRedirect } from '@/lib/sign-in-error';

export function LoginButton() {
  const [pending, setPending] = useState(false);

  async function start() {
    setPending(true);
    try {
      const { error } = await authClient.signIn.oauth2({
        providerId: OIDC_PROVIDER_ID,
        callbackURL: '/',
        // Verified better-auth 1.6.23 body param (signInWithOAuth2BodySchema):
        // carried through OAuth state so failures on the POST-AUTHENTIK callback
        // (/api/auth/oauth2/callback/authentik) land back on our login page with
        // copy, instead of better-auth's bare /api/auth/error page. better-auth
        // appends its machine code as a second `error` param; /login takes the first.
        errorCallbackURL: '/login?error=callback_failed',
      });
      // Initiation failed before any redirect: 429 (rate limiter) gets its own
      // copy so the user waits instead of retrying; the rest is sso_unavailable.
      if (error) window.location.assign(signInErrorRedirect(error.status));
    } catch {
      // Network-level failure — no HTTP status to inspect.
      window.location.assign(signInErrorRedirect(null));
    }
  }

  return (
    <button
      type="button"
      className="btn primary login-btn"
      disabled={pending}
      onClick={() => void start()}
    >
      {pending ? 'Redirecting…' : 'Sign in with Plex (Authentik)'}
    </button>
  );
}
