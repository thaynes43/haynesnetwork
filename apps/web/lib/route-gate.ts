// DESIGN-004 D-11 — the routing access rules as pure functions, so server layouts
// stay one-liners (`const dest = …; if (dest) redirect(dest);`) and the rules are
// unit-testable without the Next runtime. Checks are ALWAYS server-side: the client
// never sees admin markup it can't use.

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

/** /login is public, but an existing session server-redirects home (D-11). */
export function loginRouteRedirect(user: GateUser | null | undefined): '/' | null {
  return user ? '/' : null;
}
