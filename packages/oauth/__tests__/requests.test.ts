// ADR-091 / DESIGN-050 D-06 — the token and revoke request bodies, client credentials (body or HTTP Basic, one
// channel only) and the bearer header — pure parsing with bounded inputs and no repeated parameters.
import { describe, expect, it } from 'vitest';
import {
  OAuthError,
  PRESENTED_SECRET_MAX_LENGTH,
  isClientId,
  isUuid,
  parseBearer,
  parseClientCredentials,
  parseRevokeRequest,
  parseTokenRequest,
} from '../src/index';

const form = (s: string) => new URLSearchParams(s);
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof OAuthError) return e.code;
    throw e;
  }
  return 'ok';
}
const basic = (id: string, secret: string) =>
  `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

describe('D-06 — the token request', () => {
  it('parses an authorization_code request', () => {
    expect(
      parseTokenRequest(
        form(
          'grant_type=authorization_code&code=abc&code_verifier=v&redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb&resource=https%3A%2F%2Fh%2Fmcp',
        ),
      ),
    ).toEqual({
      grantType: 'authorization_code',
      code: 'abc',
      codeVerifier: 'v',
      redirectUri: 'http://127.0.0.1/cb',
      resource: 'https://h/mcp',
    });
    expect(parseTokenRequest(form('grant_type=authorization_code&code=abc'))).toEqual({
      grantType: 'authorization_code',
      code: 'abc',
    });
  });

  it('parses a refresh_token request (with an optional narrowing scope)', () => {
    expect(
      parseTokenRequest(form('grant_type=refresh_token&refresh_token=r&scope=watch%3Aread')),
    ).toEqual({
      grantType: 'refresh_token',
      refreshToken: 'r',
      scope: 'watch:read',
    });
  });

  it('refuses a missing credential, an unknown grant, a repeated parameter, and an oversize value', () => {
    expect(codeOf(() => parseTokenRequest(form('grant_type=authorization_code')))).toBe(
      'invalid_request',
    );
    expect(codeOf(() => parseTokenRequest(form('grant_type=refresh_token')))).toBe(
      'invalid_request',
    );
    expect(codeOf(() => parseTokenRequest(form('')))).toBe('unsupported_grant_type');
    for (const g of [
      'client_credentials',
      'password',
      'implicit',
      'urn:ietf:params:oauth:grant-type:device_code',
    ]) {
      expect(
        codeOf(() => parseTokenRequest(form(`grant_type=${encodeURIComponent(g)}`))),
        g,
      ).toBe('unsupported_grant_type');
    }
    expect(
      codeOf(() => parseTokenRequest(form('grant_type=authorization_code&code=a&code=b'))),
    ).toBe('invalid_request');
    expect(
      codeOf(() =>
        parseTokenRequest(
          form('grant_type=refresh_token&grant_type=authorization_code&refresh_token=r'),
        ),
      ),
    ).toBe('invalid_request');
    expect(
      codeOf(() =>
        parseTokenRequest(
          form(`grant_type=authorization_code&code=${'c'.repeat(PRESENTED_SECRET_MAX_LENGTH + 1)}`),
        ),
      ),
    ).toBe('invalid_request');
  });
});

describe('D-06 — the revoke request', () => {
  it('needs exactly one bounded token', () => {
    expect(parseRevokeRequest(form('token=t&token_type_hint=refresh_token'))).toEqual({
      token: 't',
    });
    expect(codeOf(() => parseRevokeRequest(form('')))).toBe('invalid_request');
    expect(codeOf(() => parseRevokeRequest(form('token=a&token=b')))).toBe('invalid_request');
    expect(
      codeOf(() =>
        parseRevokeRequest(form(`token=${'t'.repeat(PRESENTED_SECRET_MAX_LENGTH + 1)}`)),
      ),
    ).toBe('invalid_request');
  });
});

describe('D-06 — client credentials (body or HTTP Basic)', () => {
  const ID = 'a'.repeat(32);
  it('reads client_id (+ secret) from the body', () => {
    expect(parseClientCredentials(null, form(`client_id=${ID}`))).toEqual({
      clientId: ID,
      via: 'body',
    });
    expect(parseClientCredentials(null, form(`client_id=${ID}&client_secret=s`))).toEqual({
      clientId: ID,
      clientSecret: 's',
      via: 'body',
    });
  });

  it('reads HTTP Basic, form-urlencoded before base64 (RFC 6749 §2.3.1)', () => {
    expect(parseClientCredentials(basic(ID, 'p:w d%'), form(''))).toEqual({
      clientId: ID,
      clientSecret: 'p:w d%',
      via: 'basic',
    });
    expect(parseClientCredentials(basic(ID, 's'), form(`client_id=${ID}`))).toMatchObject({
      via: 'basic',
    });
  });

  it('one channel only: Basic plus a body secret, or a mismatched body id, is refused', () => {
    expect(codeOf(() => parseClientCredentials(basic(ID, 's'), form('client_secret=s')))).toBe(
      'invalid_request',
    );
    expect(
      codeOf(() => parseClientCredentials(basic(ID, 's'), form(`client_id=${'b'.repeat(32)}`))),
    ).toBe('invalid_request');
    expect(
      codeOf(() =>
        parseClientCredentials(`Basic ${Buffer.from('nocolon').toString('base64')}`, form('')),
      ),
    ).toBe('invalid_request');
  });

  it('neither channel ⇒ no credentials (the client check then answers invalid_client)', () => {
    expect(parseClientCredentials(null, form(''))).toEqual({ via: 'none' });
    expect(parseClientCredentials('Bearer x', form(''))).toEqual({ via: 'none' });
  });
});

describe('D-07 — the bearer header and id shapes', () => {
  it('parses `Bearer <token>` (case-insensitive scheme), bounded; anything else is null', () => {
    expect(parseBearer('Bearer abc')).toBe('abc');
    expect(parseBearer('bearer   abc  ')).toBe('abc');
    for (const h of [
      null,
      '',
      'Bearer',
      'Bearer ',
      'Basic abc',
      'abc',
      'Bearer a b',
      `Bearer ${'t'.repeat(513)}`,
    ]) {
      expect(parseBearer(h), String(h)).toBeNull();
    }
  });

  it('transaction ids are UUIDs and client ids 32 lowercase hex', () => {
    expect(isUuid('22222222-2222-4222-8222-222222222222')).toBe(true);
    for (const s of ['', 'x', "1' OR 1=1", '22222222-2222-4222-8222-22222222222'])
      expect(isUuid(s), s).toBe(false);
    expect(isClientId('a'.repeat(32))).toBe(true);
    for (const s of ['A'.repeat(32), 'a'.repeat(31), 'g'.repeat(32)])
      expect(isClientId(s), s).toBe(false);
  });
});
