// DESIGN-004 D-11 — the routing access rules as pure functions, so server layouts
// stay one-liners (`const dest = …; if (dest) redirect(dest);`) and the rules are
// unit-testable without the Next runtime. Checks are ALWAYS server-side: the client
// never sees admin markup it can't use.
import { safeNext } from './safe-next';

export interface GateUser {
  role: { isAdmin: boolean }; // SessionUser.role — admin routes require role.isAdmin (ADR-012)
}

/**
 * Protected routes (`/`, and `/admin/*` with requireAdmin): anonymous → /login;
 * authed non-Admin on an admin route → / ; otherwise pass (null). Fails closed on a
 * missing/malformed role.
 */
export function protectedRouteRedirect(
  user: GateUser | null | undefined,
  opts: { requireAdmin?: boolean } = {},
): '/login' | '/' | null {
  if (!user) return '/login';
  if (opts.requireAdmin && !user.role?.isAdmin) return '/';
  return null;
}

/**
 * /login is public, but an existing session server-redirects home (D-11) — or, since ADR-091 / DESIGN-050 D-09,
 * to a safe `?next=` destination (a relative path only; anything else is `/`), so a signed-in user sent to /login
 * by the OAuth authorize or consent page goes straight back to it.
 */
export function loginRouteRedirect(user: GateUser | null | undefined, next?: string | null): string | null {
  return user ? safeNext(next) : null;
}
