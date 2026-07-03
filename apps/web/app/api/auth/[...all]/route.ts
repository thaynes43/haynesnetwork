import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@hnet/auth';

// DESIGN-002 D-07 — Better Auth catch-all. Surface actually used (per D-04):
// POST /sign-in/oauth2 (initiation), GET /oauth2/callback/authentik (callback),
// GET /get-session, POST /sign-out.
export const runtime = 'nodejs';

export const { GET, POST } = toNextJsHandler(auth.handler);
