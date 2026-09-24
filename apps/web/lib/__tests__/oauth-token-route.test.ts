// ADR-091 / DESIGN-050 D-06 / D-10 / D-03 — `POST /oauth/token` at the route level (@hnet/domain mocked; the real
// pure @hnet/oauth parses and maps errors): both grants dispatched, form-encoded only (JSON ⇒ 400 invalid_request),
// client auth by body or HTTP Basic (a failed Basic attempt carries a Basic challenge), the 60/minute limit (429),
// `no-store`, and the inline pruner scheduled AFTER the response — whose failure never reaches the client.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthError } from '@hnet/oauth';

const authenticateOAuthClient = vi.hoisted(() => vi.fn());
const exchangeCode = vi.hoisted(() => vi.fn());
const rotateRefreshToken = vi.hoisted(() => vi.fn());
const pruneExpired = vi.hoisted(() => vi.fn());
const consumeRateLimit = vi.hoisted(() => vi.fn());
const afterTasks = vi.hoisted(() => [] as Array<() => Promise<void> | void>);
vi.mock('@hnet/domain', () => ({
  authenticateOAuthClient,
  exchangeCode,
  rotateRefreshToken,
  pruneExpired,
  consumeRateLimit,
}));
vi.mock('next/server', () => ({ after: (fn: () => Promise<void>) => void afterTasks.push(fn) }));

import * as route from '../../app/oauth/token/route';

const CLIENT = { clientId: 'a'.repeat(32) };
const TOKENS = {
  access_token: 'at',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'watch:read',
  refresh_token: 'rt',
};
const post = (body: string, headers: Record<string, string> = {}) =>
  route.POST(
    new Request('http://0.0.0.0:3000/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'cf-connecting-ip': '198.51.100.4',
        ...headers,
      },
      body,
    }),
  );
const runAfter = async () => {
  for (const task of afterTasks.splice(0)) await task();
};

beforeEach(() => {
  afterTasks.length = 0;
  authenticateOAuthClient.mockReset().mockResolvedValue(CLIENT);
  exchangeCode.mockReset().mockResolvedValue(TOKENS);
  rotateRefreshToken.mockReset().mockResolvedValue(TOKENS);
  pruneExpired.mockReset().mockResolvedValue({});
  consumeRateLimit
    .mockReset()
    .mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 60 });
});
afterEach(() => vi.restoreAllMocks());

describe('POST /oauth/token', () => {
  it('exports POST and OPTIONS (+ the D-10 limit and the prune hook)', () => {
    expect(Object.keys(route).sort()).toEqual([
      'OPTIONS',
      'POST',
      'TOKEN_LIMIT',
      'dynamic',
      'runtime',
      'schedulePrune',
    ]);
    expect(route.TOKEN_LIMIT).toEqual({ windowSeconds: 60, max: 60 });
  });

  it('authorization_code: authenticates the client, hands the code + verifier to exchangeCode, answers no-store', async () => {
    const res = await post(
      `grant_type=authorization_code&code=c0de&code_verifier=${'v'.repeat(43)}&client_id=${CLIENT.clientId}&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcb&resource=https%3A%2F%2Fhaynesnetwork.com%2Fmcp`,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(TOKENS);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
    expect(authenticateOAuthClient).toHaveBeenCalledWith({
      credentials: { clientId: CLIENT.clientId, via: 'body' },
    });
    expect(exchangeCode).toHaveBeenCalledWith({
      client: CLIENT,
      request: {
        grantType: 'authorization_code',
        code: 'c0de',
        codeVerifier: 'v'.repeat(43),
        redirectUri: 'http://127.0.0.1:9/cb',
        resource: 'https://haynesnetwork.com/mcp',
      },
    });
    expect(rotateRefreshToken).not.toHaveBeenCalled();
  });

  it('refresh_token: rotateRefreshToken with the narrowing scope; HTTP Basic credentials are read', async () => {
    const basic = `Basic ${Buffer.from(`${CLIENT.clientId}:s3cret`).toString('base64')}`;
    const res = await post('grant_type=refresh_token&refresh_token=rt&scope=watch%3Aread', {
      authorization: basic,
    });
    expect(res.status).toBe(200);
    expect(authenticateOAuthClient).toHaveBeenCalledWith({
      credentials: { clientId: CLIENT.clientId, clientSecret: 's3cret', via: 'basic' },
    });
    expect(rotateRefreshToken).toHaveBeenCalledWith({
      client: CLIENT,
      request: { grantType: 'refresh_token', refreshToken: 'rt', scope: 'watch:read' },
    });
  });

  it('a JSON body is 400 invalid_request (never a 500), and nothing is exchanged', async () => {
    const res = await post(JSON.stringify({ grant_type: 'authorization_code', code: 'c' }), {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_request');
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('an unsupported grant is 400 unsupported_grant_type; a repeated parameter is 400 invalid_request', async () => {
    const r1 = await post(`grant_type=client_credentials&client_id=${CLIENT.clientId}`);
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error: string }).error).toBe('unsupported_grant_type');
    const r2 = await post(
      `grant_type=authorization_code&code=a&code=b&client_id=${CLIENT.clientId}`,
    );
    expect(((await r2.json()) as { error: string }).error).toBe('invalid_request');
  });

  it('the client is authenticated first: an unknown client is 401 invalid_client whatever it asked for', async () => {
    authenticateOAuthClient.mockRejectedValue(
      new OAuthError('invalid_client', 'Unknown client', 401),
    );
    const res = await post('grant_type=password&client_id=x');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
    expect(res.headers.get('www-authenticate')).toBeNull();
    const basic = await post('grant_type=refresh_token&refresh_token=r', {
      authorization: `Basic ${Buffer.from('x:y').toString('base64')}`,
    });
    expect(basic.status).toBe(401);
    expect(basic.headers.get('www-authenticate')).toBe('Basic realm="haynesnetwork"');
  });

  it('an invalid_grant from the domain is 400 with its RFC body', async () => {
    exchangeCode.mockRejectedValue(
      new OAuthError('invalid_grant', 'Authorization code already used'),
    );
    const res = await post(`grant_type=authorization_code&code=c&client_id=${CLIENT.clientId}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_grant',
      error_description: 'Authorization code already used',
    });
  });

  it('D-10: over 60 a minute ⇒ 429 + Retry-After + {"error":"rate_limited"}, keyed oauth:token|<ip>, nothing runs', async () => {
    consumeRateLimit.mockResolvedValue({ allowed: false, count: 61, retryAfterSeconds: 17 });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post('grant_type=refresh_token&refresh_token=r');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('17');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(consumeRateLimit).toHaveBeenCalledWith({
      key: 'oauth:token|198.51.100.4',
      windowSeconds: 60,
      max: 60,
    });
    expect(authenticateOAuthClient).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(0);
  });

  it('D-03: the pruner runs AFTER the response (inline, no CronJob); its failure is logged and dropped', async () => {
    const res = await post(`grant_type=authorization_code&code=c&client_id=${CLIENT.clientId}`);
    expect(res.status).toBe(200);
    expect(pruneExpired).not.toHaveBeenCalled();
    await runAfter();
    expect(pruneExpired).toHaveBeenCalledTimes(1);

    pruneExpired.mockRejectedValue(new Error('deadlock detected'));
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a));
    await post(`grant_type=authorization_code&code=c&client_id=${CLIENT.clientId}`);
    await expect(runAfter()).resolves.toBeUndefined();
    expect(errors).toEqual([['[oauth] prune failed', 'deadlock detected']]);
  });
});
