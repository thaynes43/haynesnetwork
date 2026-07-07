import { NextResponse } from 'next/server';
import { auth, resolveSignOutRedirect } from '@hnet/auth';

// DESIGN-002 D-15 — RP-initiated logout. A single top-level GET navigation (from the
// TopBar "Sign out" button) that: (1) resolves the post-sign-out target WHILE the
// session is still live — the Authentik end_session_endpoint with post_logout_redirect_uri
// (+ id_token_hint) when the issuer supports it, else /login; (2) clears the local
// Better Auth session; (3) 303s the browser to that target. Ending at the Authentik
// end-session URL invalidates the SSO session, so the next "Log In" shows the login page
// instead of silently bouncing through.
//
// Cookie clearing rides the nextCookies() plugin: auth.api.signOut writes the
// session-clearing cookies into Next's request cookie store (next/headers), and Next
// applies them to the response returned below — the same proven path authClient.signOut
// used. (Appending better-auth's raw Set-Cookie strings onto the response instead drops
// their `Max-Age=0`, leaving the cookie present-but-empty rather than deleted.)
//
// A GET is safe here: the session cookie is SameSite=Lax, so a cross-site <img>/prefetch
// never carries it — resolveSignOutRedirect then sees no session and returns a plain
// /login, so the endpoint can't be used to force an SSO logout off-site. Precedence: this
// static /api/auth/logout segment wins over the [...all] Better Auth catch-all, and
// /logout is not a Better Auth route, so nothing is shadowed.
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { headers } = request;

  // Resolve BEFORE sign-out — reads the id_token from the still-live session. Never let a
  // failure 500 the sign-out: any error degrades to a plain local /login redirect.
  let target: string;
  try {
    target = await resolveSignOutRedirect(headers);
  } catch {
    target = new URL('/login', request.url).toString();
  }

  // Clear the local session; nextCookies() forwards the deletion into next/headers.
  try {
    await auth.api.signOut({ headers });
  } catch {
    // Session already gone / DB blip — the redirect to /login still holds.
  }

  return NextResponse.redirect(new URL(target, request.url), { status: 303 });
}
