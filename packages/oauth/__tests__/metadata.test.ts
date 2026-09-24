// ADR-091 / DESIGN-050 D-02 — the two discovery documents, exactly as published (clients cache them forever, C-12),
// and the issuer rule: BETTER_AUTH_URL (trimmed), never the request.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ISSUER,
  authorizationServerMetadata,
  issuerOrigin,
  mcpResource,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  resourceMatches,
} from '../src/index';
import { ENV } from './helpers';

describe('D-02 — authorization-server metadata (RFC 8414)', () => {
  it('is exactly the D-02 document', () => {
    expect(authorizationServerMetadata(ENV)).toEqual({
      issuer: 'https://haynesnetwork.com',
      authorization_endpoint: 'https://haynesnetwork.com/oauth/authorize',
      token_endpoint: 'https://haynesnetwork.com/oauth/token',
      registration_endpoint: 'https://haynesnetwork.com/oauth/register',
      revocation_endpoint: 'https://haynesnetwork.com/oauth/revoke',
      scopes_supported: ['watch:read', 'watch:write', 'offline_access'],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none'],
      revocation_endpoint_auth_methods_supported: [
        'client_secret_post',
        'client_secret_basic',
        'none',
      ],
      code_challenge_methods_supported: ['S256'],
    });
  });

  it('never advertises plain PKCE, implicit/password/client_credentials grants or OIDC', () => {
    const json = JSON.stringify(authorizationServerMetadata(ENV));
    expect(json).not.toMatch(/"plain"|implicit|password|client_credentials|openid|userinfo|jwks/);
  });
});

describe('D-02 — protected-resource metadata (RFC 9728)', () => {
  it('is exactly the D-02 document', () => {
    expect(protectedResourceMetadata(ENV)).toEqual({
      resource: 'https://haynesnetwork.com/mcp',
      authorization_servers: ['https://haynesnetwork.com'],
      scopes_supported: ['watch:read', 'watch:write', 'offline_access'],
      bearer_methods_supported: ['header'],
      resource_name: 'haynesnetwork Watch history',
    });
  });

  it('points the /mcp challenge at the bare metadata path', () => {
    expect(protectedResourceMetadataUrl(ENV)).toBe(
      'https://haynesnetwork.com/.well-known/oauth-protected-resource',
    );
  });
});

describe('the issuer — BETTER_AUTH_URL, trimmed, never the request', () => {
  it('trims whitespace, trailing slashes and any path to the origin', () => {
    for (const raw of [
      'https://haynesnetwork.com',
      ' https://haynesnetwork.com/ ',
      'https://haynesnetwork.com///',
      'https://haynesnetwork.com/some/path?x=1',
    ]) {
      expect(issuerOrigin({ BETTER_AUTH_URL: raw }), raw).toBe('https://haynesnetwork.com');
    }
    expect(mcpResource({ BETTER_AUTH_URL: 'http://localhost:3000/' })).toBe(
      'http://localhost:3000/mcp',
    );
  });

  it('falls back to the same default @hnet/auth uses when unset, and fails loudly on a bad value', () => {
    expect(issuerOrigin({})).toBe(DEFAULT_ISSUER);
    expect(DEFAULT_ISSUER).toBe('http://localhost:3000');
    expect(issuerOrigin({ BETTER_AUTH_URL: '   ' })).toBe(DEFAULT_ISSUER);
    expect(() => issuerOrigin({ BETTER_AUTH_URL: 'haynesnetwork.com' })).toThrow(/absolute URL/);
    expect(() => issuerOrigin({ BETTER_AUTH_URL: 'ftp://haynesnetwork.com' })).toThrow(/http\(s\)/);
  });

  it('the metadata functions take no request at all (the tunnel hands req.url = 0.0.0.0:3000)', () => {
    expect(authorizationServerMetadata.length).toBeLessThanOrEqual(1);
    expect(protectedResourceMetadata.length).toBeLessThanOrEqual(1);
    const doc = JSON.stringify(
      authorizationServerMetadata({ BETTER_AUTH_URL: 'https://staging.example' }),
    );
    expect(doc).not.toContain('0.0.0.0');
    expect(doc).toContain('https://staging.example/oauth/token');
  });

  it('compares resource identifiers trailing-slash-insensitively and nothing else', () => {
    expect(resourceMatches('https://haynesnetwork.com/mcp', 'https://haynesnetwork.com/mcp/')).toBe(
      true,
    );
    expect(resourceMatches('https://haynesnetwork.com/mcp', 'https://haynesnetwork.com/MCP')).toBe(
      false,
    );
    expect(resourceMatches('https://haynesnetwork.com/mcp', 'https://evil.example/mcp')).toBe(
      false,
    );
    expect(
      resourceMatches('https://haynesnetwork.com/mcp', 'https://haynesnetwork.com/api/mcp'),
    ).toBe(false);
  });
});
