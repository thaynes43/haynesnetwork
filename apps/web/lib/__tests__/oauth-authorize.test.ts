// ADR-091 / DESIGN-050 D-05 steps 1–5 / D-10 — the authorization endpoint's gate, branch by branch (@hnet/auth and
// @hnet/domain mocked; the real pure @hnet/oauth validates): the rate limit and an untrusted client or redirect
// render the bad-request page and NEVER redirect; no session ⇒ `${issuer}/login?next=<this request>` before any
// parameter is judged; a parameter error renders the bad-request page too — NOTHING redirects an error to the client
// (RFC 9700 §4.11.2, D-15 #24/#25); ANY signed-in user (no owner gate) ⇒ a transaction and the consent page. Plus the
// page adapter itself (redirect vs the D-14 card).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OAuthError, s256Challenge } from '@hnet/oauth';
import { RedirectSignal, elements } from './oauth-helpers';

const getServerSession = vi.hoisted(() => vi.fn());
const resolveAuthorizationClient = vi.hoisted(() => vi.fn());
const startAuthorization = vi.hoisted(() => vi.fn());
const consumeRateLimit = vi.hoisted(() => vi.fn());
const headersFn = vi.hoisted(() => vi.fn());
vi.mock('@hnet/auth', () => ({ getServerSession }));
vi.mock('@hnet/domain', () => ({
  resolveAuthorizationClient,
  startAuthorization,
  consumeRateLimit,
}));
vi.mock('next/headers', () => ({ headers: headersFn }));
vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new RedirectSignal(location);
  },
}));

import { authorizeNext, handleAuthorize } from '../oauth/authorize';
import { safeNext } from '../safe-next';
import AuthorizePage, { toSearchParams } from '../../app/oauth/authorize/page';
import { BadRequestCard } from '../../app/oauth/oauth-message';

const ISSUER = 'https://haynesnetwork.com';
const ENV = { BETTER_AUTH_URL: ISSUER };
const CLIENT = {
  clientId: 'a'.repeat(32),
  redirectUris: ['https://chatgpt.com/connector/oauth/abc'],
};
const CHALLENGE = s256Challenge('v'.repeat(43));
const USER = { id: 'user-2', email: 'kid@example.test' };

function request(overrides: Record<string, string | string[] | null> = {}): URLSearchParams {
  const base: Record<string, string | string[] | null> = {
    response_type: 'code',
    client_id: CLIENT.clientId,
    redirect_uri: CLIENT.redirectUris[0]!,
    state: 'st-1',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'watch:read watch:write offline_access',
    resource: `${ISSUER}/mcp`,
    ...overrides,
  };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(base)) {
    if (v === null) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  return q;
}

const run = (
  query: URLSearchParams,
  headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.5' },
) => handleAuthorize({ query, headers: new Headers(headers), env: ENV });

let logs: string[];
beforeEach(() => {
  getServerSession.mockReset().mockResolvedValue({ user: USER });
  resolveAuthorizationClient.mockReset().mockImplementation(async ({ clientId, redirectUri }) => {
    if (clientId !== CLIENT.clientId) throw new OAuthError('invalid_client', 'Unknown client', 401);
    if (redirectUri !== CLIENT.redirectUris[0])
      throw new OAuthError('invalid_redirect_uri', 'no match');
    return CLIENT;
  });
  startAuthorization
    .mockReset()
    .mockResolvedValue({ txnId: '22222222-2222-4222-8222-222222222222' });
  consumeRateLimit
    .mockReset()
    .mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 60 });
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((l: string) => void logs.push(l));
});
afterEach(() => vi.restoreAllMocks());

describe('D-05 — the authorize gate', () => {
  it('ANY signed-in user (no owner gate) ⇒ a transaction for THAT user ⇒ the consent page, on the issuer', async () => {
    const out = await run(request());
    expect(out).toEqual({
      kind: 'redirect',
      location: `${ISSUER}/oauth/consent?txn=22222222-2222-4222-8222-222222222222`,
    });
    expect(startAuthorization).toHaveBeenCalledWith({
      client: CLIENT,
      userId: 'user-2',
      redirectUri: CLIENT.redirectUris[0],
      validated: {
        scopes: ['watch:read', 'watch:write', 'offline_access'],
        resource: `${ISSUER}/mcp`,
        codeChallenge: CHALLENGE,
        codeChallengeMethod: 'S256',
        state: 'st-1',
      },
    });
  });

  it('no session ⇒ /login?next=<this exact request>, which /login accepts back unchanged', async () => {
    getServerSession.mockResolvedValue(null);
    const q = request({ state: 'a*b~c d' });
    const out = await run(q);
    if (out.kind !== 'redirect') throw new Error('expected a redirect');
    const url = new URL(out.location);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/login`);
    const next = url.searchParams.get('next')!;
    expect(next).toBe(authorizeNext(q));
    expect(safeNext(next)).toBe(next); // survives D-09 and Better Auth's callbackURL grammar
    expect(new URLSearchParams(next.split('?')[1]).get('state')).toBe('a*b~c d');
    expect(startAuthorization).not.toHaveBeenCalled();
  });

  it('a request too long to survive the sign-in round trip gets the bad-request page (signed out: never the client)', async () => {
    getServerSession.mockResolvedValue(null);
    // Within every parameter cap, but `!` percent-encodes to three characters: the next would exceed 2,048.
    expect(await run(request({ state: '!'.repeat(1000) }))).toEqual({ kind: 'bad_request' });
    expect(logs.at(-1)).toBe(
      `[auth] authorize_rejected {"reason":"request_too_long","client_id":"${CLIENT.clientId}"}`,
    );
  });

  it('D-15 #24 — signed OUT, a parameter error (e.g. plain PKCE) goes to OUR login, never to the client', async () => {
    getServerSession.mockResolvedValue(null);
    const q = request({ code_challenge_method: 'plain' });
    const out = await run(q);
    if (out.kind !== 'redirect') throw new Error('expected a redirect');
    const url = new URL(out.location);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/login`);
    expect(url.searchParams.get('next')).toBe(authorizeNext(q));
    expect(out.location).not.toContain('chatgpt.com/connector');
    expect(startAuthorization).not.toHaveBeenCalled();
    // …and so does every other parameter error: an open registration cannot turn authorize into a redirector.
    for (const over of [
      { response_type: 'token' },
      { response_type: null },
      { code_challenge: null },
      { code_challenge_method: null },
      { state: null },
      { scope: 'watch:admin' },
      { resource: 'https://evil.example/mcp' },
      { scope: ['watch:read', 'watch:write'] },
    ] as Array<Record<string, string | string[] | null>>) {
      const r = await run(request(over));
      if (r.kind !== 'redirect') throw new Error(`expected a redirect for ${JSON.stringify(over)}`);
      expect(new URL(r.location).origin, JSON.stringify(over)).toBe(ISSUER);
      expect(new URL(r.location).pathname, JSON.stringify(over)).toBe('/login');
    }
    expect(logs.filter((l) => l.startsWith('[auth] authorize_rejected '))).toEqual([]);
  });

  it('D-15 #25 — signed IN, the same plain-PKCE request renders the bad-request page: no redirect to the client', async () => {
    expect(await run(request({ code_challenge_method: 'plain' }))).toEqual({ kind: 'bad_request' });
    expect(logs.at(-1)).toBe(
      `[auth] authorize_rejected {"reason":"invalid_request","client_id":"${CLIENT.clientId}"}`,
    );
    expect(startAuthorization).not.toHaveBeenCalled();
  });

  it('an unknown client or an unregistered redirect renders the bad-request page — never a redirect', async () => {
    for (const q of [
      request({ client_id: 'f'.repeat(32) }),
      request({ client_id: null }),
      request({ redirect_uri: 'https://evil.example/cb' }),
      request({ redirect_uri: null }),
      request({ client_id: [CLIENT.clientId, CLIENT.clientId] }),
      request({ redirect_uri: [CLIENT.redirectUris[0]!, 'https://evil.example/cb'] }),
    ]) {
      expect(await run(q)).toEqual({ kind: 'bad_request' });
    }
    expect(startAuthorization).not.toHaveBeenCalled();
    expect(logs.filter((l) => l.startsWith('[auth] authorize_rejected '))).toHaveLength(6);
  });

  it('never logs an untrusted client_id verbatim (unbounded query input)', async () => {
    await run(request({ client_id: `${'x'.repeat(5000)}<script>` }));
    await run(request({ client_id: 'f'.repeat(32) }));
    const rejected = logs.filter((l) => l.startsWith('[auth] authorize_rejected '));
    expect(rejected[0]).toBe(
      '[auth] authorize_rejected {"reason":"invalid_client","client_id":"malformed"}',
    );
    expect(rejected[1]).toBe(
      `[auth] authorize_rejected {"reason":"invalid_client","client_id":"${'f'.repeat(32)}"}`,
    );
  });

  it('every parameter error renders the bad-request page for a signed-in user — the client is never redirected to', async () => {
    const cases: Array<[Record<string, string | string[] | null>, string]> = [
      [{ response_type: 'token' }, 'unsupported_response_type'],
      [{ response_type: null }, 'unsupported_response_type'],
      [{ code_challenge_method: 'plain' }, 'invalid_request'],
      [{ code_challenge_method: null }, 'invalid_request'],
      [{ code_challenge: null }, 'invalid_request'],
      [{ code_challenge: 'short' }, 'invalid_request'],
      [{ state: null }, 'invalid_request'],
      [{ scope: 'watch:admin' }, 'invalid_scope'],
      [{ resource: 'https://evil.example/mcp' }, 'invalid_target'],
      [{ scope: ['watch:read', 'watch:write'] }, 'invalid_request'],
      [{ state: ['a', 'b'] }, 'invalid_request'],
    ];
    for (const [over, code] of cases) {
      logs.length = 0;
      expect(await run(request(over)), JSON.stringify(over)).toEqual({ kind: 'bad_request' });
      expect(logs.at(-1), JSON.stringify(over)).toBe(
        `[auth] authorize_rejected {"reason":"${code}","client_id":"${CLIENT.clientId}"}`,
      );
    }
    expect(startAuthorization).not.toHaveBeenCalled();
  });

  it('a missing scope grants all three', async () => {
    await run(request({ scope: null }));
    expect(startAuthorization.mock.calls[0]![0].validated.scopes).toEqual([
      'watch:read',
      'watch:write',
      'offline_access',
    ]);
  });

  it('D-10: over 30 a minute per client IP ⇒ the bad-request page, rate_limited logged, nothing else runs', async () => {
    consumeRateLimit.mockResolvedValue({ allowed: false, count: 31, retryAfterSeconds: 40 });
    expect(await run(request())).toEqual({ kind: 'bad_request' });
    expect(consumeRateLimit).toHaveBeenCalledWith({
      key: 'oauth:authorize|203.0.113.5',
      windowSeconds: 60,
      max: 30,
    });
    expect(resolveAuthorizationClient).not.toHaveBeenCalled();
    expect(logs).toEqual([
      '[auth] rate_limited {"route":"authorize","ip":"203.0.113.5","count":31}',
    ]);
  });
});

describe('the /oauth/authorize page adapter', () => {
  it('redirects (server-side) for every redirect outcome', async () => {
    headersFn.mockResolvedValue(new Headers());
    vi.stubEnv('BETTER_AUTH_URL', ISSUER);
    const search = Object.fromEntries(request().entries());
    await expect(AuthorizePage({ searchParams: Promise.resolve(search) })).rejects.toMatchObject({
      location: `${ISSUER}/oauth/consent?txn=22222222-2222-4222-8222-222222222222`,
    });
    vi.unstubAllEnvs();
  });

  it('renders the D-14 bad-request card in place for an untrusted client', async () => {
    headersFn.mockResolvedValue(new Headers());
    const page = await AuthorizePage({ searchParams: Promise.resolve({ client_id: 'nope' }) });
    expect(elements(page).some((e) => e.type === BadRequestCard)).toBe(true);
  });

  it('keeps repeated query keys (so a repeat is refused, RFC 6749 §3.1)', () => {
    expect(toSearchParams({ a: ['1', '2'], b: '3', c: undefined }).toString()).toBe('a=1&a=2&b=3');
  });
});
