// ADR-091 / DESIGN-050 D-02 / D-07 — the public `/mcp` route at the route level. Web tests never touch a database:
// the REAL @hnet/mcp handler and the REAL pure @hnet/oauth run, with only the two @hnet/domain reads/writes the
// OAuth consumer makes (`selectBearerToken`, `touchLastUsed`) mocked. Proves: only POST is exported (405 for every
// other method), the 401 challenge without / with a bad / with a revoked or expired / with a wrong-resource bearer,
// the 403 insufficient_scope for a write tool on a read-only token, no CORS, and that the hop's /api/mcp route is
// untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const selectBearerToken = vi.hoisted(() => vi.fn());
const touchLastUsed = vi.hoisted(() => vi.fn());
vi.mock('@hnet/domain', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hnet/domain')>()),
  selectBearerToken,
  touchLastUsed,
}));

import * as route from '../../app/mcp/route';
import * as hopRoute from '../../app/api/mcp/route';

const PRM = 'resource_metadata="https://haynesnetwork.com/.well-known/oauth-protected-resource"';
/** No credential presented. */
const CHALLENGE = `Bearer ${PRM}`;
/** A bearer presented and refused. */
const INVALID = `Bearer error="invalid_token", ${PRM}`;
const ROW = {
  id: 'tok-1',
  clientId: 'a'.repeat(32),
  userId: 'user-1',
  scopes: ['watch:read', 'offline_access'],
  resource: 'https://haynesnetwork.com/mcp',
  expiresAt: new Date(Date.now() + 3_600_000),
  revokedAt: null,
  lastUsedAt: null,
  clientLastUsedAt: null,
};

const post = (body: unknown, auth?: string) =>
  route.POST(
    new Request('http://0.0.0.0:3000/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_URL', 'https://haynesnetwork.com');
  vi.stubEnv('HNET_MCP_HOP_TOKEN', 'hop-secret');
  selectBearerToken.mockReset().mockResolvedValue(ROW);
  touchLastUsed.mockReset().mockResolvedValue({ token: true, client: true });
});
afterEach(() => vi.unstubAllEnvs());

describe('POST /mcp — the public route', () => {
  it('exports ONLY POST (Next answers GET / DELETE / every other method 405), Node runtime, never cached', () => {
    expect(Object.keys(route).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(route.runtime).toBe('nodejs');
    expect(route.dynamic).toBe('force-dynamic');
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS'])
      expect(method in route, method).toBe(false);
  });

  it('no bearer ⇒ 401 with the resource_metadata challenge, before any lookup; no CORS', async () => {
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(selectBearerToken).not.toHaveBeenCalled();
  });

  it('an unknown, revoked, expired or wrong-resource bearer ⇒ 401 with error="invalid_token"', async () => {
    const refusals = [
      undefined,
      { ...ROW, revokedAt: new Date() },
      { ...ROW, expiresAt: new Date(Date.now() - 1) },
      { ...ROW, resource: 'https://staging.haynesnetwork.com/mcp' },
    ];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const row of refusals) {
      selectBearerToken.mockResolvedValueOnce(row);
      const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer tok');
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(INVALID);
    }
    expect(touchLastUsed).not.toHaveBeenCalled();
  });

  it('the hop token is not an OAuth token: 401 here', async () => {
    selectBearerToken.mockResolvedValueOnce(undefined);
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer hop-secret');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(INVALID);
    expect(selectBearerToken).toHaveBeenCalledWith({ db: undefined, token: 'hop-secret' });
  });

  it('a read-only token: tools/list is scope-filtered; a write tool is 403 insufficient_scope', async () => {
    const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer tok');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((x) => x.name)).toEqual([
      'unfinished',
      'recommend',
      'watch_status',
      'recent_history',
    ]);
    for (const name of ['mark_watched', 'dismiss', 'undo_last_change']) {
      const res = await post(
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } },
        'Bearer tok',
      );
      expect(res.status, name).toBe(403);
      // RFC 6750 §3.1: the challenge names the scope the tool needs.
      expect(res.headers.get('www-authenticate')).toBe(
        `Bearer error="insufficient_scope", scope="watch:write", ${PRM}`,
      );
    }
    expect(touchLastUsed).toHaveBeenCalledWith(
      expect.objectContaining({ tokenId: 'tok-1', clientId: 'a'.repeat(32) }),
    );
  });

  it('the hop route is untouched: /api/mcp still answers its own bearer challenge, never the OAuth one', async () => {
    const res = await hopRoute.POST(
      new Request('http://0.0.0.0:3000/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer some-oauth-token' },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(selectBearerToken).not.toHaveBeenCalled();
  });
});
