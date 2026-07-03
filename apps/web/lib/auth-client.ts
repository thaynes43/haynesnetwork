// DESIGN-002 D-04 / DESIGN-004 D-11 — the Better Auth React client. genericOAuth is
// the only sign-in surface (Authentik OIDC, CLAUDE.md hard rule 5): signIn.oauth2
// POSTs /api/auth/sign-in/oauth2 and redirects to the returned authorization URL.
// Base URL is same-origin (the catch-all route at /api/auth), so no config needed.
import { createAuthClient } from 'better-auth/react';
import { genericOAuthClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [genericOAuthClient()],
});
