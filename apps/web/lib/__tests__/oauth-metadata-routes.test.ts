// ADR-091 / DESIGN-050 D-02 — the two discovery routes at the route level (the real, pure @hnet/oauth; no
// database). Exactly two paths each (bare and `/mcp`), public cache, CORS `*`, OPTIONS preflight, and every URL
// from BETTER_AUTH_URL even though behind the tunnel `req.url` says 0.0.0.0:3000.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as prm from '../../app/.well-known/oauth-protected-resource/[[...seg]]/route';
import * as asm from '../../app/.well-known/oauth-authorization-server/[[...seg]]/route';

const TUNNEL = 'http://0.0.0.0:3000';
const call = (mod: typeof prm, seg?: string[]) =>
  mod.GET(new Request(`${TUNNEL}/.well-known/x${seg ? `/${seg.join('/')}` : ''}`), {
    params: Promise.resolve(seg ? { seg } : {}),
  });

beforeEach(() => vi.stubEnv('BETTER_AUTH_URL', 'https://haynesnetwork.com'));
afterEach(() => vi.unstubAllEnvs());

describe.each([
  ['oauth-protected-resource', prm, 'resource', 'https://haynesnetwork.com/mcp'],
  ['oauth-authorization-server', asm, 'issuer', 'https://haynesnetwork.com'],
] as const)('/.well-known/%s', (_name, mod, key, value) => {
  it('exports only GET and OPTIONS, on the Node runtime, never statically cached', () => {
    expect(Object.keys(mod).sort()).toEqual(['GET', 'OPTIONS', 'dynamic', 'runtime']);
    expect(mod.dynamic).toBe('force-dynamic');
  });

  it('serves the document at the bare path and at /mcp — identical, public for an hour, CORS *', async () => {
    const bare = await call(mod);
    const suffixed = await call(mod, ['mcp']);
    for (const res of [bare, suffixed]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    }
    const body = (await bare.json()) as Record<string, unknown>;
    expect(await suffixed.json()).toEqual(body);
    expect(body[key]).toBe(value);
    expect(JSON.stringify(body)).not.toContain('0.0.0.0');
  });

  it('404s any other suffix (no aliases — the paths are fixed forever)', async () => {
    for (const seg of [['api'], ['mcp', 'x'], ['MCP'], ['api', 'mcp']]) {
      expect((await call(mod, seg)).status, seg.join('/')).toBe(404);
    }
  });

  it('answers the CORS preflight', () => {
    const res = mod.OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'Content-Type, Authorization, mcp-protocol-version',
    );
  });
});

describe('the metadata follows BETTER_AUTH_URL, never the request', () => {
  it('a staging issuer changes every endpoint', async () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://staging.haynesnetwork.com/');
    const doc = (await (await call(asm)).json()) as Record<string, string>;
    expect(doc.token_endpoint).toBe('https://staging.haynesnetwork.com/oauth/token');
    const prmDoc = (await (await call(prm)).json()) as Record<string, unknown>;
    expect(prmDoc.authorization_servers).toEqual(['https://staging.haynesnetwork.com']);
  });
});
