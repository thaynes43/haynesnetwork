// ADR-091 / DESIGN-050 D-04 / D-10 — `POST /oauth/register` at the route level (@hnet/domain mocked; the real pure
// @hnet/oauth maps the errors): 201 + no-store + CORS, the registering IP from CF-Connecting-IP, the 10/hour limit
// answering 429 + Retry-After + {"error":"rate_limited"}, JSON only, bounded, and never a leaked internal.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthError } from '@hnet/oauth';

const registerClient = vi.hoisted(() => vi.fn());
const consumeRateLimit = vi.hoisted(() => vi.fn());
vi.mock('@hnet/domain', () => ({ registerClient, consumeRateLimit }));

import * as route from '../../app/oauth/register/route';

const BODY = { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector/oauth/abc'] };
const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  route.POST(
    new Request('http://0.0.0.0:3000/oauth/register', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.9',
        ...headers,
      },
      body,
    }),
  );

beforeEach(() => {
  registerClient
    .mockReset()
    .mockResolvedValue({ client_id: 'a'.repeat(32), client_id_issued_at: 1 });
  consumeRateLimit
    .mockReset()
    .mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 3600 });
});
afterEach(() => vi.restoreAllMocks());

describe('POST /oauth/register', () => {
  it('exports POST and OPTIONS only (plus the D-10 limit), on the Node runtime', () => {
    expect(Object.keys(route).sort()).toEqual([
      'OPTIONS',
      'POST',
      'REGISTER_LIMIT',
      'dynamic',
      'runtime',
    ]);
    expect(route.REGISTER_LIMIT).toEqual({ windowSeconds: 3600, max: 10 });
  });

  it('registers: 201, the body and the CF-Connecting-IP handed to the domain writer, no-store, CORS', async () => {
    const res = await post(JSON.stringify(BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ client_id: 'a'.repeat(32), client_id_issued_at: 1 });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(registerClient).toHaveBeenCalledWith({ body: BODY, registeredIp: '203.0.113.9' });
    expect(consumeRateLimit).toHaveBeenCalledWith({
      key: 'oauth:register|203.0.113.9',
      windowSeconds: 3600,
      max: 10,
    });
  });

  it('D-10: over 10 an hour ⇒ 429, Retry-After, {"error":"rate_limited"} — and nothing is registered', async () => {
    consumeRateLimit.mockResolvedValue({ allowed: false, count: 11, retryAfterSeconds: 1234 });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => void logs.push(l));
    const res = await post(JSON.stringify(BODY));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('1234');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(registerClient).not.toHaveBeenCalled();
    expect(logs).toEqual([
      '[auth] rate_limited {"route":"register","ip":"203.0.113.9","count":11}',
    ]);
  });

  it('keys the limit on CF-Connecting-IP, then X-Real-IP, then the first X-Forwarded-For hop; junk is ignored', async () => {
    await post(JSON.stringify(BODY), {
      'cf-connecting-ip': '',
      'x-real-ip': '10.0.0.7',
      'x-forwarded-for': '1.1.1.1',
    });
    expect(consumeRateLimit).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'oauth:register|10.0.0.7' }),
    );
    await post(JSON.stringify(BODY), {
      'cf-connecting-ip': '',
      'x-forwarded-for': '2001:db8::1, 10.0.0.1',
    });
    expect(consumeRateLimit).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'oauth:register|2001:db8::1' }),
    );
    await post(JSON.stringify(BODY), { 'cf-connecting-ip': 'not an ip|x' });
    expect(consumeRateLimit).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'oauth:register|unknown' }),
    );
    expect(registerClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ registeredIp: null }),
    );
  });

  it('JSON only and bounded: a form body, malformed JSON or an oversize body is 400 invalid_client_metadata', async () => {
    for (const [body, headers] of [
      ['client_name=x', { 'content-type': 'application/x-www-form-urlencoded' }],
      ['{nope', {}],
      [JSON.stringify({ ...BODY, pad: 'x'.repeat(20_000) }), {}],
    ] as const) {
      const res = await post(body, headers);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_client_metadata');
    }
    expect(registerClient).not.toHaveBeenCalled();
  });

  it('an RFC 7591 refusal from the writer is its RFC body; an unexpected failure is a generic 500', async () => {
    registerClient.mockRejectedValueOnce(
      new OAuthError('invalid_redirect_uri', 'A redirect_uri must be https'),
    );
    const refused = await post(JSON.stringify(BODY));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: 'invalid_redirect_uri',
      error_description: 'A redirect_uri must be https',
    });

    registerClient.mockRejectedValueOnce(
      new Error('connection refused at 10.0.0.3:5432 password=hunter2'),
    );
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void errors.push(a));
    const boom = await post(JSON.stringify(BODY));
    expect(boom.status).toBe(500);
    const text = await boom.text();
    expect(JSON.parse(text)).toEqual({
      error: 'server_error',
      error_description: 'Unexpected error',
    });
    expect(text).not.toContain('hunter2');
    expect(errors).toHaveLength(1);
  });

  it('answers the CORS preflight', () => {
    expect(route.OPTIONS().status).toBe(204);
  });
});
