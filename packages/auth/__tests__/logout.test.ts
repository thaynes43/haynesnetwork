import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildEndSessionUrl,
  fetchEndSessionEndpoint,
  idTokenExpMs,
  isFreshIdToken,
  parseEndSessionEndpoint,
  postLogoutRedirectUri,
} from '../src/logout';

/** Build a syntactically-valid (unsigned) JWT with the given payload for the pure
 *  exp/freshness helpers — signature is irrelevant here (Authentik re-validates). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.signature`;
}

// DESIGN-002 D-15 — RP-initiated logout URL construction. These are the pure/mockable
// halves (the db + live-session orchestration in resolveSignOutRedirect is covered by
// the e2e sign-out spec).

describe('postLogoutRedirectUri (DESIGN-002 D-15)', () => {
  it('derives /login on the BETTER_AUTH_URL origin (production)', () => {
    expect(postLogoutRedirectUri('https://haynesnetwork.com')).toBe(
      'https://haynesnetwork.com/login',
    );
  });

  it('derives /login for staging + local (never hardcoded)', () => {
    expect(postLogoutRedirectUri('https://haynesnetwork.haynesops.com')).toBe(
      'https://haynesnetwork.haynesops.com/login',
    );
    expect(postLogoutRedirectUri('http://localhost:3100')).toBe('http://localhost:3100/login');
  });

  it('ignores a trailing slash / stray path on the base URL', () => {
    expect(postLogoutRedirectUri('https://haynesnetwork.com/')).toBe(
      'https://haynesnetwork.com/login',
    );
  });
});

describe('buildEndSessionUrl (DESIGN-002 D-15)', () => {
  const endSessionEndpoint =
    'https://authentik.haynesnetwork.com/application/o/haynesnetwork/end-session/';
  const redirectUri = 'https://haynesnetwork.com/login';

  it('returns null when the issuer advertises no end_session_endpoint (stub OIDC)', () => {
    expect(
      buildEndSessionUrl({ endSessionEndpoint: null, postLogoutRedirectUri: redirectUri }),
    ).toBeNull();
    expect(
      buildEndSessionUrl({ endSessionEndpoint: undefined, postLogoutRedirectUri: redirectUri }),
    ).toBeNull();
    expect(
      buildEndSessionUrl({ endSessionEndpoint: '', postLogoutRedirectUri: redirectUri }),
    ).toBeNull();
  });

  it('builds the end-session URL with an encoded post_logout_redirect_uri and no hint', () => {
    const url = buildEndSessionUrl({
      endSessionEndpoint,
      postLogoutRedirectUri: redirectUri,
    });
    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(endSessionEndpoint);
    expect(parsed.searchParams.get('post_logout_redirect_uri')).toBe(redirectUri);
    expect(parsed.searchParams.has('id_token_hint')).toBe(false);
    // The redirect URI must be percent-encoded in the raw query string.
    expect(url).toContain('post_logout_redirect_uri=https%3A%2F%2Fhaynesnetwork.com%2Flogin');
  });

  it('attaches id_token_hint when present (lets Authentik skip its confirm)', () => {
    const url = buildEndSessionUrl({
      endSessionEndpoint,
      postLogoutRedirectUri: redirectUri,
      idTokenHint: 'header.payload.sig',
    });
    const parsed = new URL(url!);
    expect(parsed.searchParams.get('id_token_hint')).toBe('header.payload.sig');
    expect(parsed.searchParams.get('post_logout_redirect_uri')).toBe(redirectUri);
  });

  it('omits id_token_hint for null/empty hint values', () => {
    for (const idTokenHint of [null, undefined, '']) {
      const url = buildEndSessionUrl({
        endSessionEndpoint,
        postLogoutRedirectUri: redirectUri,
        idTokenHint,
      });
      expect(new URL(url!).searchParams.has('id_token_hint')).toBe(false);
    }
  });
});

describe('idTokenExpMs (DESIGN-002 D-15 — stale-hint guard)', () => {
  it('reads exp (seconds) and returns it in milliseconds', () => {
    expect(idTokenExpMs(fakeJwt({ exp: 1783445949 }))).toBe(1783445949 * 1000);
  });

  it('returns null for absent / malformed / exp-less tokens', () => {
    expect(idTokenExpMs(null)).toBeNull();
    expect(idTokenExpMs(undefined)).toBeNull();
    expect(idTokenExpMs('')).toBeNull();
    expect(idTokenExpMs('not-a-jwt')).toBeNull(); // no '.' segments
    expect(idTokenExpMs('only.two')).toBeNull(); // payload segment isn't valid JSON
    expect(idTokenExpMs(fakeJwt({ sub: 'x' }))).toBeNull(); // no exp claim
    expect(idTokenExpMs(fakeJwt({ exp: 'soon' }))).toBeNull(); // non-numeric exp
  });
});

describe('isFreshIdToken (DESIGN-002 D-15 — stale-hint guard)', () => {
  // The 2026-07-07 incident: token issued 16:39Z, exp 17:39Z, sign-out at 19:22Z.
  const expZ = Date.parse('2026-07-07T17:39:09Z');
  const tokenExpAt1739 = fakeJwt({ exp: Math.floor(expZ / 1000), sub: 'owner' });

  it('is false once the id_token has expired (the owner sign-out at 19:22Z)', () => {
    expect(isFreshIdToken(tokenExpAt1739, Date.parse('2026-07-07T19:22:45Z'))).toBe(false);
  });

  it('is true while the id_token is still valid (an immediate sign-out / e2e path)', () => {
    expect(isFreshIdToken(tokenExpAt1739, Date.parse('2026-07-07T17:00:00Z'))).toBe(true);
  });

  it('is false for an absent or unparseable hint (no id_token stored)', () => {
    const now = Date.parse('2026-07-07T17:00:00Z');
    expect(isFreshIdToken(null, now)).toBe(false);
    expect(isFreshIdToken(undefined, now)).toBe(false);
    expect(isFreshIdToken('garbage', now)).toBe(false);
    expect(isFreshIdToken(fakeJwt({ sub: 'no-exp' }), now)).toBe(false);
  });

  it('honours a negative skew tolerance for clock drift at the boundary', () => {
    const now = Date.parse('2026-07-07T17:39:14Z'); // 5s past expiry
    expect(isFreshIdToken(tokenExpAt1739, now)).toBe(false); // no skew → expired
    expect(isFreshIdToken(tokenExpAt1739, now, 10_000)).toBe(true); // 10s skew → still fresh
  });
});

describe('parseEndSessionEndpoint (DESIGN-002 D-15)', () => {
  it('reads a non-empty end_session_endpoint from a discovery doc', () => {
    expect(
      parseEndSessionEndpoint({
        issuer: 'https://authentik.haynesnetwork.com/application/o/haynesnetwork/',
        end_session_endpoint:
          'https://authentik.haynesnetwork.com/application/o/haynesnetwork/end-session/',
      }),
    ).toBe('https://authentik.haynesnetwork.com/application/o/haynesnetwork/end-session/');
  });

  it('returns null when the field is absent (stub OIDC discovery)', () => {
    expect(
      parseEndSessionEndpoint({ issuer: 'http://127.0.0.1:9', token_endpoint: 'x' }),
    ).toBeNull();
  });

  it('returns null for non-string / empty / non-object inputs', () => {
    expect(parseEndSessionEndpoint({ end_session_endpoint: '' })).toBeNull();
    expect(parseEndSessionEndpoint({ end_session_endpoint: 42 })).toBeNull();
    expect(parseEndSessionEndpoint(null)).toBeNull();
    expect(parseEndSessionEndpoint('nope')).toBeNull();
  });
});

describe('fetchEndSessionEndpoint (DESIGN-002 D-15)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the endpoint when discovery advertises one', async () => {
    // Distinct URL per test — the module-level cache is keyed by discovery URL.
    const discoveryUrl = 'https://issuer.example/with-endsession/.well-known/openid-configuration';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ end_session_endpoint: 'https://issuer.example/o/end-session/' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    expect(await fetchEndSessionEndpoint(discoveryUrl)).toBe(
      'https://issuer.example/o/end-session/',
    );

    // Second call inside the TTL is served from cache (no extra fetch).
    expect(await fetchEndSessionEndpoint(discoveryUrl)).toBe(
      'https://issuer.example/o/end-session/',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when discovery omits end_session_endpoint (stub OIDC path)', async () => {
    const discoveryUrl = 'https://issuer.example/no-endsession/.well-known/openid-configuration';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token_endpoint: 'https://issuer.example/o/token/' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await fetchEndSessionEndpoint(discoveryUrl)).toBeNull();
  });

  it('degrades to null when the discovery fetch fails (broken sign-out avoided)', async () => {
    const discoveryUrl = 'https://issuer.example/boom/.well-known/openid-configuration';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    expect(await fetchEndSessionEndpoint(discoveryUrl)).toBeNull();
  });
});
