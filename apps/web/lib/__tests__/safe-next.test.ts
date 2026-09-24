// ADR-091 / DESIGN-050 D-09 — `/login?next=` safety: only a relative path starting with `/` and not `//`, no
// backslash or control character, ≤ 2,048 characters, and inside Better Auth's relative-callback grammar; anything
// else falls back to `/`. The signed-in redirect and the failed-sign-in redirects carry it too.
import { describe, expect, it } from 'vitest';
import { NEXT_MAX_LENGTH, firstParam, loginPath, safeNext } from '../safe-next';
import { loginRouteRedirect } from '../route-gate';
import { signInErrorRedirect, withNext } from '../sign-in-error';

const AUTHORIZE =
  '/oauth/authorize?response_type=code&client_id=0123456789abcdef0123456789abcdef&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector%2Foauth%2Fabc&state=a%2Ab%7Ec+d&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&scope=watch%3Aread+watch%3Awrite+offline_access';

describe('D-09 — safeNext', () => {
  it('accepts the OAuth paths and ordinary app paths', () => {
    for (const v of [
      AUTHORIZE,
      '/oauth/consent?txn=22222222-2222-4222-8222-222222222222',
      '/',
      '/library/plex',
      '/settings/connections',
    ]) {
      expect(safeNext(v), v).toBe(v);
    }
  });

  it('falls back to / for anything that could leave the origin or break the sign-in', () => {
    for (const v of [
      undefined,
      null,
      42,
      '',
      'oauth/authorize',
      'https://evil.example/',
      '//evil.example/x',
      '/\\evil.example',
      '/%2f%2fevil.example',
      '/%5cevil.example',
      '/\tjavascript:alert(1)',
      '/x\ny',
      '/path with space',
      'javascript:alert(1)',
      `/${'a'.repeat(NEXT_MAX_LENGTH)}`,
      '/x?y="z"',
      '/x#frag',
      '/x?a=<b>',
    ]) {
      expect(safeNext(v), JSON.stringify(v)).toBe('/');
    }
    expect(safeNext(`/${'a'.repeat(NEXT_MAX_LENGTH - 1)}`)).toHaveLength(NEXT_MAX_LENGTH);
  });

  it('loginPath percent-encodes the destination once; / needs no next', () => {
    expect(loginPath(AUTHORIZE)).toBe(`/login?next=${encodeURIComponent(AUTHORIZE)}`);
    expect(new URLSearchParams(loginPath(AUTHORIZE).split('?')[1]).get('next')).toBe(AUTHORIZE);
    expect(loginPath('/')).toBe('/login');
    expect(loginPath('//evil.example')).toBe('/login');
  });

  it('firstParam takes the first of a repeated query value', () => {
    expect(firstParam(['/a', '/b'])).toBe('/a');
    expect(firstParam('/a')).toBe('/a');
    expect(firstParam(undefined)).toBeUndefined();
  });
});

describe('D-09 — the /login routes honour next', () => {
  it('a signed-in user goes to the safe next, else /', () => {
    const user = { role: { isAdmin: false } };
    expect(loginRouteRedirect(user, AUTHORIZE)).toBe(AUTHORIZE);
    expect(loginRouteRedirect(user, '//evil.example')).toBe('/');
    expect(loginRouteRedirect(user)).toBe('/');
    expect(loginRouteRedirect(null, AUTHORIZE)).toBeNull();
  });

  it('a failed sign-in keeps next on its error redirect (so a retry resumes the flow)', () => {
    expect(signInErrorRedirect(429, AUTHORIZE)).toBe(
      `/login?error=rate_limited&next=${encodeURIComponent(AUTHORIZE)}`,
    );
    expect(signInErrorRedirect(500)).toBe('/login?error=sso_unavailable');
    expect(withNext('/login?error=callback_failed', AUTHORIZE)).toBe(
      `/login?error=callback_failed&next=${encodeURIComponent(AUTHORIZE)}`,
    );
    expect(withNext('/login?error=callback_failed', '/')).toBe('/login?error=callback_failed');
    expect(withNext('/login', 'https://evil.example')).toBe('/login');
  });

  it('every error redirect with a next still fits Better Auth’s errorCallbackURL grammar', () => {
    expect(safeNext(withNext('/login?error=callback_failed', AUTHORIZE))).not.toBe('/');
  });
});

describe('D-09 — encoded slashes and backslashes, either case (pinned by the review)', () => {
  it('refuses %2F / %5C in upper and lower case — they never pass Better Auth’s grammar or ours', () => {
    for (const v of [
      '/%2F%2Fevil.example',
      '/%2f%2fevil.example',
      '/%5Cevil.example',
      '/%5cevil.example',
      '/%2F/evil.example',
      '/%5C%5Cevil.example/x',
    ]) {
      expect(safeNext(v), v).toBe('/');
    }
    // Encoded characters inside the QUERY of a real path are fine (the OAuth authorize next carries them).
    expect(safeNext('/oauth/authorize?redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcb')).toBe(
      '/oauth/authorize?redirect_uri=https%3A%2F%2Fchatgpt.com%2Fcb',
    );
  });
});
