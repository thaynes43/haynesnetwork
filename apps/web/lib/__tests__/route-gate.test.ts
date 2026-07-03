import { describe, expect, it } from 'vitest';
import { loginRouteRedirect, protectedRouteRedirect } from '../route-gate';

const member = { role: 'Member' };
const admin = { role: 'Admin' };

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

  it('fails closed on unknown roles for admin routes', () => {
    expect(protectedRouteRedirect({ role: 'superuser' }, { requireAdmin: true })).toBe('/');
    expect(protectedRouteRedirect({ role: '' }, { requireAdmin: true })).toBe('/');
  });

  it('/login: session → /, anonymous stays', () => {
    expect(loginRouteRedirect(member)).toBe('/');
    expect(loginRouteRedirect(admin)).toBe('/');
    expect(loginRouteRedirect(null)).toBeNull();
  });
});
