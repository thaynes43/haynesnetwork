// ADR-091 / DESIGN-050 D-04 — RFC 7591 registration: validation, the caps (client_name 1–80, 1–5 redirect URIs),
// https-or-loopback redirects, the auth-method / grant / response / scope rules, and the minted client.
import { describe, expect, it } from 'vitest';
import {
  CLIENT_NAME_MAX,
  OAuthError,
  REDIRECT_URI_MAX_LENGTH,
  hashToken,
  planClientRegistration,
  redirectUriProblem,
  validateRegistration,
} from '../src/index';
import { NOW } from './helpers';

const CHATGPT = {
  client_name: 'ChatGPT',
  redirect_uris: ['https://chatgpt.com/connector/oauth/abc123'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  scope: 'watch:read watch:write offline_access',
};

function refused(body: unknown): OAuthError {
  try {
    validateRegistration(body);
  } catch (error) {
    if (error instanceof OAuthError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('D-04 — what a registration accepts', () => {
  it("accepts ChatGPT's real registration and normalizes it", () => {
    expect(validateRegistration(CHATGPT)).toEqual({
      clientName: 'ChatGPT',
      redirectUris: ['https://chatgpt.com/connector/oauth/abc123'],
      authMethod: 'none',
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      scope: 'watch:read watch:write offline_access',
    });
  });

  it("accepts Claude Code's and Codex's loopback shapes (127.0.0.1, [::1], localhost; any port)", () => {
    for (const uri of [
      'http://localhost:53682/callback',
      'http://127.0.0.1:1455/callback/Zq9',
      'http://[::1]:8080/cb',
      'http://127.0.0.1/cb',
    ]) {
      expect(
        validateRegistration({ client_name: 'Codex', redirect_uris: [uri] }).redirectUris,
        uri,
      ).toEqual([uri]);
    }
  });

  it('defaults: auth method none, both grants, code, no scope; unknown RFC 7591 metadata is ignored', () => {
    const reg = validateRegistration({
      client_name: 'Claude Code (hnet)',
      redirect_uris: ['http://localhost:3334/callback'],
      client_uri: 'https://claude.ai',
      logo_uri: 'https://claude.ai/logo.png',
      contacts: ['x@example.com'],
    });
    expect(reg).toMatchObject({
      authMethod: 'none',
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      scope: null,
    });
    expect(reg).not.toHaveProperty('client_uri');
  });

  it('trims client_name; collapses duplicate redirect URIs; canonicalizes the scope order', () => {
    const reg = validateRegistration({
      client_name: '  ChatGPT  ',
      redirect_uris: ['https://a.example/cb', 'https://a.example/cb'],
      scope: 'offline_access watch:read watch:read',
    });
    expect(reg.clientName).toBe('ChatGPT');
    expect(reg.redirectUris).toEqual(['https://a.example/cb']);
    expect(reg.scope).toBe('watch:read offline_access');
  });

  it('accepts every token_endpoint_auth_method in D-02, and a subset of grants', () => {
    for (const m of ['none', 'client_secret_post', 'client_secret_basic']) {
      expect(validateRegistration({ ...CHATGPT, token_endpoint_auth_method: m }).authMethod).toBe(
        m,
      );
    }
    expect(
      validateRegistration({ ...CHATGPT, grant_types: ['authorization_code'] }).grantTypes,
    ).toEqual(['authorization_code']);
  });
});

describe('D-04 — the caps and refusals (RFC 7591 §3.2.2 error codes)', () => {
  it(`client_name is required, 1–${CLIENT_NAME_MAX} characters, and free of control / bidi characters`, () => {
    expect(
      validateRegistration({ ...CHATGPT, client_name: 'x'.repeat(80) }).clientName,
    ).toHaveLength(80);
    for (const name of [
      undefined,
      '',
      '   ',
      'x'.repeat(81),
      42,
      'Chat\nGPT',
      'Chat\u0000GPT',
      'TPG‮tahC',
    ]) {
      const e = refused({ ...CHATGPT, client_name: name });
      expect(e.code, JSON.stringify(name)).toBe('invalid_client_metadata');
      expect(e.status).toBe(400);
    }
  });

  it('1–5 redirect URIs', () => {
    const uris = (n: number) => Array.from({ length: n }, (_, i) => `https://a.example/cb${i}`);
    expect(validateRegistration({ ...CHATGPT, redirect_uris: uris(5) }).redirectUris).toHaveLength(
      5,
    );
    for (const list of [uris(6), [], undefined, 'https://a.example/cb', [42]]) {
      expect(refused({ ...CHATGPT, redirect_uris: list }).code, JSON.stringify(list)).toBe(
        'invalid_redirect_uri',
      );
    }
  });

  it('every redirect URI is https or loopback http — no other scheme, host, credentials or fragment', () => {
    for (const uri of [
      'http://chatgpt.com/cb', // http off loopback
      'http://192.168.1.10/cb',
      'http://127.0.0.2/cb',
      'http://localhost.evil.example/cb',
      'cursor://callback',
      'javascript:alert(1)',
      'data:text/html,hi',
      'file:///etc/passwd',
      '/relative/cb',
      'https://chatgpt.com@evil.example/cb', // reads as ChatGPT on a consent page
      'https://user:pass@a.example/cb',
      'https://a.example/cb#frag',
      `https://a.example/${'x'.repeat(REDIRECT_URI_MAX_LENGTH)}`,
    ]) {
      expect(redirectUriProblem(uri), uri).not.toBeNull();
      expect(refused({ ...CHATGPT, redirect_uris: [uri] }).code, uri).toBe('invalid_redirect_uri');
    }
  });

  it('refuses an unsupported auth method, grant, response type or scope', () => {
    expect(refused({ ...CHATGPT, token_endpoint_auth_method: 'private_key_jwt' }).code).toBe(
      'invalid_client_metadata',
    );
    expect(refused({ ...CHATGPT, grant_types: ['client_credentials'] }).code).toBe(
      'invalid_client_metadata',
    );
    expect(refused({ ...CHATGPT, grant_types: ['implicit'] }).code).toBe('invalid_client_metadata');
    expect(refused({ ...CHATGPT, grant_types: [] }).code).toBe('invalid_client_metadata');
    expect(refused({ ...CHATGPT, response_types: ['token'] }).code).toBe('invalid_client_metadata');
    expect(refused({ ...CHATGPT, scope: 'watch:read admin' }).code).toBe('invalid_client_metadata');
    expect(refused({ ...CHATGPT, scope: 'x'.repeat(300) }).code).toBe('invalid_client_metadata');
  });

  it('refuses a body that is not a JSON object', () => {
    for (const body of [null, 'x', 42, [CHATGPT]]) {
      expect(refused(body).code).toBe('invalid_client_metadata');
    }
  });
});

describe('D-04 — the minted client', () => {
  it('a public client gets a 32-hex id and NO secret; the response echoes the metadata', () => {
    const plan = planClientRegistration(validateRegistration(CHATGPT), {
      now: NOW,
      registeredIp: '203.0.113.9',
    });
    expect(plan.row.clientId).toMatch(/^[0-9a-f]{32}$/);
    expect(plan.row.clientSecretHash).toBeNull();
    expect(plan.row.registeredIp).toBe('203.0.113.9');
    expect(plan.response).toEqual({
      client_id: plan.row.clientId,
      client_id_issued_at: Math.floor(NOW.getTime() / 1000),
      client_name: 'ChatGPT',
      redirect_uris: ['https://chatgpt.com/connector/oauth/abc123'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'watch:read watch:write offline_access',
    });
    expect(plan.response).not.toHaveProperty('client_secret');
  });

  it('a confidential client gets its secret exactly once, stored only as SHA-256', () => {
    for (const method of ['client_secret_post', 'client_secret_basic'] as const) {
      const plan = planClientRegistration(
        validateRegistration({ ...CHATGPT, token_endpoint_auth_method: method }),
        { now: NOW },
      );
      const secret = plan.response.client_secret!;
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
      expect(plan.row.clientSecretHash).toBe(hashToken(secret));
      expect(JSON.stringify(plan.row)).not.toContain(secret);
    }
  });

  it('ids and secrets never repeat; the registering IP is capped at 64 characters', () => {
    const reg = validateRegistration({
      ...CHATGPT,
      token_endpoint_auth_method: 'client_secret_post',
    });
    const a = planClientRegistration(reg, { now: NOW, registeredIp: 'x'.repeat(100) });
    const b = planClientRegistration(reg, { now: NOW });
    expect(a.row.clientId).not.toBe(b.row.clientId);
    expect(a.response.client_secret).not.toBe(b.response.client_secret);
    expect(a.row.registeredIp).toHaveLength(64);
    expect(b.row.registeredIp).toBeNull();
  });
});
