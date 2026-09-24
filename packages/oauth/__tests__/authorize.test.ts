// ADR-091 / DESIGN-050 D-05 step 2 — the redirectable authorization parameters: response_type, a REQUIRED state,
// S256-only PKCE, the default scopes, and the RFC 8707 resource binding (invalid_target + audience_mismatch).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OAuthError,
  STATE_MAX_LENGTH,
  validateAuthorizationParams,
  type AuthorizationParams,
} from '../src/index';
import { ENV, RESOURCE, captureLogs, pkcePair } from './helpers';

const { challenge } = pkcePair();
const OK: AuthorizationParams = {
  responseType: 'code',
  codeChallenge: challenge,
  codeChallengeMethod: 'S256',
  state: 'xyz',
  scope: 'watch:read watch:write offline_access',
  resources: [RESOURCE],
};

function code(params: AuthorizationParams): string {
  try {
    validateAuthorizationParams(params, { env: ENV });
  } catch (e) {
    if (e instanceof OAuthError) return e.code;
    throw e;
  }
  return 'ok';
}

afterEach(() => vi.restoreAllMocks());

describe('D-05 step 2 — authorization parameters', () => {
  it('accepts the ChatGPT request and binds it to the canonical resource', () => {
    expect(validateAuthorizationParams(OK, { env: ENV })).toEqual({
      scopes: ['watch:read', 'watch:write', 'offline_access'],
      resource: RESOURCE,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      state: 'xyz',
    });
  });

  it('only response_type=code', () => {
    for (const rt of [undefined, 'token', 'code id_token', 'CODE']) {
      expect(code({ ...OK, responseType: rt })).toBe('unsupported_response_type');
    }
  });

  it('state is REQUIRED (stricter than cigar-journal) and bounded', () => {
    expect(code({ ...OK, state: undefined })).toBe('invalid_request');
    expect(code({ ...OK, state: '' })).toBe('invalid_request');
    expect(code({ ...OK, state: 's'.repeat(STATE_MAX_LENGTH) })).toBe('ok');
    expect(code({ ...OK, state: 's'.repeat(STATE_MAX_LENGTH + 1) })).toBe('invalid_request');
  });

  it('PKCE S256 only: a challenge is required, `plain` (or no method) is refused, the challenge is 43 base64url chars', () => {
    expect(code({ ...OK, codeChallenge: undefined })).toBe('invalid_request');
    expect(code({ ...OK, codeChallengeMethod: 'plain' })).toBe('invalid_request');
    expect(code({ ...OK, codeChallengeMethod: undefined })).toBe('invalid_request');
    expect(code({ ...OK, codeChallengeMethod: 's256' })).toBe('invalid_request');
    for (const bad of [
      'short',
      `${challenge}A`,
      `${challenge.slice(0, 42)}=`,
      `${challenge.slice(0, 42)}+`,
    ]) {
      expect(code({ ...OK, codeChallenge: bad }), bad).toBe('invalid_request');
    }
  });

  it('a missing or empty scope grants all three (no empty token); scopes come back canonical and de-duplicated', () => {
    const all = ['watch:read', 'watch:write', 'offline_access'];
    for (const scope of [undefined, '', '   ']) {
      expect(
        validateAuthorizationParams({ ...OK, scope }, { env: ENV }).scopes,
        String(scope),
      ).toEqual(all);
    }
    expect(
      validateAuthorizationParams(
        { ...OK, scope: 'offline_access watch:read watch:read' },
        { env: ENV },
      ).scopes,
    ).toEqual(['watch:read', 'offline_access']);
    expect(
      validateAuthorizationParams({ ...OK, scope: 'watch:read' }, { env: ENV }).scopes,
    ).toEqual(['watch:read']);
  });

  it('every scope must be one of the three', () => {
    for (const scope of ['watch:admin', 'watch:read openid', 'profile', 'x'.repeat(300)]) {
      expect(code({ ...OK, scope }), scope).toBe('invalid_scope');
    }
  });

  it('resource, if sent, must be the canonical one (trailing slash tolerated) — else invalid_target + audience_mismatch', () => {
    expect(code({ ...OK, resources: [] })).toBe('ok');
    expect(code({ ...OK, resources: undefined })).toBe('ok');
    expect(code({ ...OK, resources: [`${RESOURCE}/`] })).toBe('ok');
    const logs = captureLogs();
    for (const resources of [
      ['https://evil.example/mcp'],
      ['https://haynesnetwork.com/api/mcp'],
      [RESOURCE, 'https://evil.example/mcp'],
    ]) {
      expect(code({ ...OK, resources }), resources.join(',')).toBe('invalid_target');
    }
    expect(logs.lines.filter((l) => l.startsWith('[auth] audience_mismatch '))).toHaveLength(3);
    expect(logs.lines[0]).toContain('"phase":"authorize"');
  });
});
