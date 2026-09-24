// ADR-091 / DESIGN-050 D-06 — `POST /oauth/revoke` (RFC 7009) at the route level (@hnet/domain mocked): 200 with an
// empty body whatever the token was (known, unknown, another client's — the domain writer decides silently);
// client authentication failures and malformed requests get the RFC 7009 §2.2.1 error body.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthError } from '@hnet/oauth';

const authenticateOAuthClient = vi.hoisted(() => vi.fn());
const revokeToken = vi.hoisted(() => vi.fn());
vi.mock('@hnet/domain', () => ({ authenticateOAuthClient, revokeToken }));

import * as route from '../../app/oauth/revoke/route';

const CLIENT = { clientId: 'a'.repeat(32) };
const post = (body: string, headers: Record<string, string> = {}) =>
  route.POST(
    new Request('http://0.0.0.0:3000/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body,
    }),
  );

beforeEach(() => {
  authenticateOAuthClient.mockReset().mockResolvedValue(CLIENT);
  revokeToken.mockReset().mockResolvedValue(undefined);
});

describe('POST /oauth/revoke', () => {
  it('exports POST and OPTIONS only', () => {
    expect(Object.keys(route).sort()).toEqual(['OPTIONS', 'POST', 'dynamic', 'runtime']);
  });

  it('200, empty body, no-store + CORS — the token handed to the domain writer', async () => {
    const res = await post(`token=tok&token_type_hint=refresh_token&client_id=${CLIENT.clientId}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(revokeToken).toHaveBeenCalledWith({ client: CLIENT, token: 'tok' });
  });

  it('unknown and foreign tokens are the writer’s silent no-ops: still 200', async () => {
    for (const token of ['never-issued', 'someone-elses']) {
      expect((await post(`token=${token}&client_id=${CLIENT.clientId}`)).status).toBe(200);
    }
  });

  it('a failed client authentication is 401 invalid_client; a missing token or a JSON body is 400', async () => {
    authenticateOAuthClient.mockRejectedValueOnce(
      new OAuthError('invalid_client', 'Unknown client', 401),
    );
    const r1 = await post('token=t&client_id=x');
    expect(r1.status).toBe(401);
    expect(((await r1.json()) as { error: string }).error).toBe('invalid_client');
    const r2 = await post(`client_id=${CLIENT.clientId}`);
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { error: string }).error).toBe('invalid_request');
    const r3 = await post('{"token":"t"}', { 'content-type': 'application/json' });
    expect(r3.status).toBe(400);
    expect(revokeToken).not.toHaveBeenCalled();
  });
});
