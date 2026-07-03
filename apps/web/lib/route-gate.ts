// DESIGN-004 D-11 — the routing access rules as pure functions, so server layouts
// stay one-liners (`const dest = …; if (dest) redirect(dest);`) and the rules are
// unit-testable without the Next runtime. Checks are ALWAYS server-side: the client
// never sees admin markup it can't use.

export interface GateUser {
  role: string; // SessionUser.role — fail closed on anything but 'Admin' for admin routes
}

/**
 * Protected routes (`/`, and `/admin/*` with requireAdmin): anonymous → /login;
 * authed non-Admin on an admin route → / ; otherwise pass (null).
 */
export function protectedRouteRedirect(
  user: GateUser | null | undefined,
  opts: { requireAdmin?: boolean } = {},
): '/login' | '/' | null {
  if (!user) return '/login';
  if (opts.requireAdmin && user.role !== 'Admin') return '/';
  return null;
}

/** /login is public, but an existing session server-redirects home (D-11). */
export function loginRouteRedirect(user: GateUser | null | undefined): '/' | null {
  return user ? '/' : null;
}
