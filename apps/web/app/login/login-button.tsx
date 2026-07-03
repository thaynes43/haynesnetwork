'use client';

// AC-01 / DESIGN-004 D-11 — the single sign-in affordance. No password form exists;
// authClient.signIn.oauth2 POSTs Better Auth's /sign-in/oauth2 and follows the
// Authentik authorization redirect. Failures land back on /login?error=… (the server
// page renders the alert).

import { useState } from 'react';
// The ./env subpath is dependency-free (no db/server code) — safe in a client bundle.
import { OIDC_PROVIDER_ID } from '@hnet/auth/env';
import { authClient } from '@/lib/auth-client';

export function LoginButton() {
  const [pending, setPending] = useState(false);

  async function start() {
    setPending(true);
    try {
      const { error } = await authClient.signIn.oauth2({
        providerId: OIDC_PROVIDER_ID,
        callbackURL: '/',
      });
      if (error) window.location.assign('/login?error=sso_unavailable');
    } catch {
      window.location.assign('/login?error=sso_unavailable');
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
