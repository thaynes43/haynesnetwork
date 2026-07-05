import { describe, expect, it } from 'vitest';
import { loginRouteRedirect, protectedRouteRedirect } from '../route-gate';

const member = { role: { isAdmin: false } };
const admin = { role: { isAdmin: true } };

describe('route gating (DESIGN-004 D-11)', () => {
  it('anonymous on a protected route → /login', () => {
    expect(protectedRouteRedirect(null)).toBe('/login');
    expect(protectedRouteRedirect(undefined)).toBe('/login');
    expect(protectedRouteRedirect(null, { requireAdmin: true })).toBe('/login');
  });

  it('authed user passes the app gate', () => {
    expect(protectedRouteRedirect(member)).toBeNull();
    expect(protectedRouteRedirect(admin)).toBeNull();
  });

  it('admin routes: Member → /, Admin passes', () => {
    expect(protectedRouteRedirect(member, { requireAdmin: true })).toBe('/');
    expect(protectedRouteRedirect(admin, { requireAdmin: true })).toBeNull();
  });

  it('fails closed for admin routes when role.isAdmin is false or the role is malformed', () => {
    expect(protectedRouteRedirect({ role: { isAdmin: false } }, { requireAdmin: true })).toBe('/');
    // @ts-expect-error — a malformed user (no role object) must still fail closed.
    expect(protectedRouteRedirect({}, { requireAdmin: true })).toBe('/');
  });

  it('/login: session → /, anonymous stays', () => {
    expect(loginRouteRedirect(member)).toBe('/');
    expect(loginRouteRedirect(admin)).toBe('/');
    expect(loginRouteRedirect(null)).toBeNull();
  });
});
