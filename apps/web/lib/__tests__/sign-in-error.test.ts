import { describe, expect, it } from 'vitest';
import { signInErrorRedirect } from '../sign-in-error';

describe('sign-in initiation error mapping (DESIGN-002 rate limiting & error surfaces)', () => {
  it('429 → rate_limited (the owner-hit outage: prod rate limiter on /sign-in/oauth2)', () => {
    expect(signInErrorRedirect(429)).toBe('/login?error=rate_limited');
  });

  it('server errors → sso_unavailable', () => {
    expect(signInErrorRedirect(500)).toBe('/login?error=sso_unavailable');
    expect(signInErrorRedirect(502)).toBe('/login?error=sso_unavailable');
    expect(signInErrorRedirect(400)).toBe('/login?error=sso_unavailable');
  });

  it('network failure (no HTTP status) → sso_unavailable', () => {
    expect(signInErrorRedirect(null)).toBe('/login?error=sso_unavailable');
    expect(signInErrorRedirect(undefined)).toBe('/login?error=sso_unavailable');
    expect(signInErrorRedirect()).toBe('/login?error=sso_unavailable');
  });
});
