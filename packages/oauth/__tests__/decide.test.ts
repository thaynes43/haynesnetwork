// ADR-091 / DESIGN-050 D-03..D-07 — the decisions, pure: client authentication, consent (incl. the D-14 per-user
// `watch:write` line), the code exchange (single use, PKCE, redirect, resource), token pairs, refresh rotation
// (reuse, narrowing), revocation semantics, the /mcp bearer, the once-a-minute stamp, and the pruner's bounds.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CODE_TTL_SECONDS,
  OAuthError,
  REFRESH_TOKEN_TTL_SECONDS,
  assertGrantAllowed,
  checkClientCredentials,
  consentLookup,
  consentScopeLines,
  decideBearer,
  decideCodeExchange,
  decideRefresh,
  decideRevocation,
  denialRedirect,
  hashToken,
  lastUsedIsStale,
  planApproval,
  planAuthorization,
  planTokenPair,
  pruneCutoffs,
  replayedCodeFamily,
  type CodeRecord,
  type OAuthScope,
  type RefreshRecord,
  type TransactionRecord,
} from '../src/index';
import { ENV, NOW, RESOURCE, captureLogs, pkcePair, secondsAfter } from './helpers';

afterEach(() => vi.restoreAllMocks());

const CLIENT = { clientId: 'a'.repeat(32), grantTypes: ['authorization_code', 'refresh_token'] };
const OTHER = { clientId: 'b'.repeat(32), grantTypes: ['authorization_code', 'refresh_token'] };
const USER = '11111111-1111-4111-8111-111111111111';
const ALL: OAuthScope[] = ['watch:read', 'watch:write', 'offline_access'];

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof OAuthError) return e.code;
    throw e;
  }
  return 'ok';
}

describe('D-06 — client authentication', () => {
  const secret = 'confidential-secret-value-0123456789abcdefghij';
  const confidential = { clientSecretHash: hashToken(secret) };
  const pub = { clientSecretHash: null };

  it('a public client needs only its id (PKCE proves it later)', () => {
    expect(checkClientCredentials(pub, { clientId: CLIENT.clientId })).toBe(pub);
    expect(
      checkClientCredentials(pub, { clientId: CLIENT.clientId, clientSecret: 'ignored' }),
    ).toBe(pub);
  });

  it('a confidential client needs the right secret, compared as digests', () => {
    expect(
      checkClientCredentials(confidential, { clientId: CLIENT.clientId, clientSecret: secret }),
    ).toBe(confidential);
    for (const clientSecret of [undefined, '', 'wrong', `${secret}x`]) {
      expect(
        codeOf(() =>
          checkClientCredentials(confidential, { clientId: CLIENT.clientId, clientSecret }),
        ),
      ).toBe('invalid_client');
    }
  });

  it('no id or an unknown client is invalid_client (401)', () => {
    expect(codeOf(() => checkClientCredentials(pub, {}))).toBe('invalid_client');
    try {
      checkClientCredentials(undefined, { clientId: CLIENT.clientId });
    } catch (e) {
      expect((e as OAuthError).status).toBe(401);
    }
  });

  it('a client may use only the grants it registered', () => {
    expect(
      codeOf(() => assertGrantAllowed({ grantTypes: ['authorization_code'] }, 'refresh_token')),
    ).toBe('unauthorized_client');
    expect(
      codeOf(() =>
        assertGrantAllowed({ grantTypes: ['authorization_code'] }, 'authorization_code'),
      ),
    ).toBe('ok');
  });
});

describe('D-05 — the transaction and the consent view', () => {
  const { challenge } = pkcePair();
  const validated = {
    scopes: ALL,
    resource: RESOURCE,
    codeChallenge: challenge,
    codeChallengeMethod: 'S256' as const,
    state: 'st',
  };

  it('a transaction lives 10 minutes and carries the session user and every binding', () => {
    const row = planAuthorization({
      clientId: CLIENT.clientId,
      userId: USER,
      redirectUri: 'https://c.example/cb',
      validated,
      now: NOW,
    });
    expect(row).toMatchObject({
      clientId: CLIENT.clientId,
      userId: USER,
      redirectUri: 'https://c.example/cb',
      scopes: ALL,
      resource: RESOURCE,
      state: 'st',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });
    expect(row.expiresAt).toEqual(secondsAfter(NOW, 600));
  });

  const txnRow = {
    id: '22222222-2222-4222-8222-222222222222',
    clientId: CLIENT.clientId,
    clientName: 'ChatGPT',
    userId: USER,
    redirectUri: 'https://chatgpt.com/connector/oauth/abc',
    scopes: ['offline_access', 'watch:read'] as OAuthScope[],
    expiresAt: secondsAfter(NOW, 60),
  };

  it('shows the client name, the redirect HOST and the scopes (canonical order)', () => {
    expect(consentLookup(txnRow, USER, NOW)).toEqual({
      status: 'ok',
      view: {
        txnId: txnRow.id,
        clientId: CLIENT.clientId,
        clientName: 'ChatGPT',
        redirectHost: 'chatgpt.com',
        scopes: ['watch:read', 'offline_access'],
      },
    });
    const loopback = consentLookup(
      { ...txnRow, redirectUri: 'http://127.0.0.1:1455/cb' },
      USER,
      NOW,
    );
    expect(loopback.status === 'ok' && loopback.view.redirectHost).toBe('127.0.0.1:1455');
  });

  it("another user's transaction is missing (its client name never leaks); an expired own one names the client", () => {
    expect(consentLookup(txnRow, '33333333-3333-4333-8333-333333333333', NOW)).toEqual({
      status: 'missing',
    });
    expect(consentLookup(undefined, USER, NOW)).toEqual({ status: 'missing' });
    expect(consentLookup({ ...txnRow, expiresAt: NOW }, USER, NOW)).toEqual({
      status: 'expired',
      clientName: 'ChatGPT',
    });
  });

  it('D-14 scope lines — watch:write promises Plex only to the server owner', () => {
    expect(consentScopeLines(ALL, { writesPlex: true })).toEqual([
      { scope: 'watch:read', description: 'See what you have watched, what is unfinished, and your watchlist' },
      {
        scope: 'watch:write',
        description: 'Mark titles watched or dismissed, update Plex to match, and add or remove titles on your Plex watchlist',
      },
      { scope: 'offline_access', description: 'Stay connected without signing in again' },
    ]);
    expect(consentScopeLines(['offline_access', 'watch:write'], { writesPlex: false })).toEqual([
      { scope: 'watch:write', description: 'Mark titles watched or dismissed in your history' },
      { scope: 'offline_access', description: 'Stay connected without signing in again' },
    ]);
    // DESIGN-051 D-09, D-15h: the watchlist is the owner's only, so watch:read names it only to him.
    expect(consentScopeLines(['watch:read'], { writesPlex: false })).toEqual([
      { scope: 'watch:read', description: 'See what you have watched and what is unfinished' },
    ]);
  });

  const txn: TransactionRecord = {
    id: txnRow.id,
    clientId: CLIENT.clientId,
    userId: USER,
    redirectUri: 'https://chatgpt.com/connector/oauth/abc?keep=1',
    scopes: ALL,
    resource: RESOURCE,
    state: 'st&=1',
    codeChallenge: challenge,
    codeChallengeMethod: 'S256',
    expiresAt: secondsAfter(NOW, 60),
  };

  it('Approve mints a single-use 60 s code (stored hashed) and redirects with code + state', () => {
    const plan = planApproval(txn, NOW);
    if (plan.kind !== 'grant') throw new Error('expected a grant');
    expect(plan.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(plan.row.codeHash).toBe(hashToken(plan.code));
    expect(JSON.stringify(plan.row)).not.toContain(plan.code);
    expect(plan.row.expiresAt).toEqual(secondsAfter(NOW, CODE_TTL_SECONDS));
    expect(plan.row).toMatchObject({
      clientId: CLIENT.clientId,
      userId: USER,
      scopes: ALL,
      resource: RESOURCE,
      codeChallenge: challenge,
    });
    const url = new URL(plan.redirectUrl);
    expect(url.origin + url.pathname).toBe('https://chatgpt.com/connector/oauth/abc');
    expect(url.searchParams.get('keep')).toBe('1');
    expect(url.searchParams.get('code')).toBe(plan.code);
    expect(url.searchParams.get('state')).toBe('st&=1');
  });

  it('Approve re-checks expiry; Deny redirects access_denied + state', () => {
    expect(planApproval({ ...txn, expiresAt: NOW }, NOW)).toEqual({ kind: 'expired' });
    const deny = new URL(denialRedirect(txn));
    expect(deny.searchParams.get('error')).toBe('access_denied');
    expect(deny.searchParams.get('state')).toBe('st&=1');
    expect(deny.searchParams.get('code')).toBeNull();
  });
});

describe('D-06 — the authorization_code exchange', () => {
  const { verifier, challenge } = pkcePair();
  const rec: CodeRecord = {
    id: 'c1',
    clientId: CLIENT.clientId,
    userId: USER,
    redirectUri: 'http://127.0.0.1:1455/callback/x',
    scopes: ALL,
    resource: RESOURCE,
    codeChallenge: challenge,
    expiresAt: secondsAfter(NOW, 30),
    consumedAt: null,
  };
  const req = { code: 'the-code', codeVerifier: verifier };

  it('passes a well-formed exchange and returns the grant', () => {
    expect(decideCodeExchange(rec, CLIENT, req, NOW)).toEqual({
      userId: USER,
      scopes: ALL,
      resource: RESOURCE,
    });
  });

  it('single use: a consumed code is a replay (code_replayed, never the code itself in the log)', () => {
    const logs = captureLogs();
    expect(codeOf(() => decideCodeExchange({ ...rec, consumedAt: NOW }, CLIENT, req, NOW))).toBe(
      'invalid_grant',
    );
    expect(logs.lines).toHaveLength(1);
    expect(logs.lines[0]).toMatch(
      /^\[auth\] code_replayed \{"client_id":"a{32}","code":"[0-9a-f]{6}"\}$/,
    );
    expect(logs.lines[0]).not.toContain('the-code');
  });

  it('refuses an unknown code, another client, an expired code, or an unregistered grant', () => {
    expect(codeOf(() => decideCodeExchange(undefined, CLIENT, req, NOW))).toBe('invalid_grant');
    expect(codeOf(() => decideCodeExchange(rec, OTHER, req, NOW))).toBe('invalid_grant');
    expect(codeOf(() => decideCodeExchange({ ...rec, expiresAt: NOW }, CLIENT, req, NOW))).toBe(
      'invalid_grant',
    );
    expect(
      codeOf(() => decideCodeExchange(rec, { ...CLIENT, grantTypes: ['refresh_token'] }, req, NOW)),
    ).toBe('unauthorized_client');
  });

  it('redirect_uri, if sent, must match (loopback-tolerant)', () => {
    expect(
      codeOf(() =>
        decideCodeExchange(
          rec,
          CLIENT,
          { ...req, redirectUri: 'http://localhost:9/callback/x' },
          NOW,
        ),
      ),
    ).toBe('ok');
    expect(
      codeOf(() =>
        decideCodeExchange(
          rec,
          CLIENT,
          { ...req, redirectUri: 'http://127.0.0.1:9/callback/y' },
          NOW,
        ),
      ),
    ).toBe('invalid_grant');
  });

  it('PKCE: a verifier is required, well formed (43–128 unreserved chars) and must hash to the challenge', () => {
    expect(codeOf(() => decideCodeExchange(rec, CLIENT, { code: 'c' }, NOW))).toBe('invalid_grant');
    for (const v of [
      'w'.repeat(43),
      'v'.repeat(42),
      'v'.repeat(129),
      `${'v'.repeat(42)}!`,
      challenge,
    ]) {
      expect(
        codeOf(() => decideCodeExchange(rec, CLIENT, { code: 'c', codeVerifier: v }, NOW)),
        v,
      ).toBe('invalid_grant');
    }
  });

  it('resource, if sent, must be the code resource (invalid_target + audience_mismatch)', () => {
    const logs = captureLogs();
    expect(
      codeOf(() => decideCodeExchange(rec, CLIENT, { ...req, resource: `${RESOURCE}/` }, NOW)),
    ).toBe('ok');
    expect(
      codeOf(() =>
        decideCodeExchange(rec, CLIENT, { ...req, resource: 'https://evil.example/mcp' }, NOW),
      ),
    ).toBe('invalid_target');
    expect(logs.lines.some((l) => l.startsWith('[auth] audience_mismatch {"phase":"token"'))).toBe(
      true,
    );
  });
});

describe('RFC 6749 §4.1.2 — a replayed code names the family to revoke', () => {
  it('only a consumed code with a family', () => {
    expect(replayedCodeFamily({ consumedAt: NOW, familyId: 'fam' })).toBe('fam');
    expect(replayedCodeFamily({ consumedAt: null, familyId: 'fam' })).toBeNull();
    expect(replayedCodeFamily({ consumedAt: NOW, familyId: null })).toBeNull();
    expect(replayedCodeFamily(undefined)).toBeNull();
  });
});

describe('D-03 / D-06 — token pairs', () => {
  it('offline_access ⇒ a refresh token (60 days) beside the 1 h access token, one family, hashes only', () => {
    const plan = planTokenPair({
      clientId: CLIENT.clientId,
      userId: USER,
      scopes: ALL,
      resource: RESOURCE,
      now: NOW,
    });
    expect(plan.response).toEqual({
      access_token: plan.access.token,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'watch:read watch:write offline_access',
      refresh_token: plan.refresh!.token,
    });
    expect(plan.access.row.expiresAt).toEqual(secondsAfter(NOW, ACCESS_TOKEN_TTL_SECONDS));
    expect(plan.refresh!.row.expiresAt).toEqual(secondsAfter(NOW, REFRESH_TOKEN_TTL_SECONDS));
    expect(plan.access.row.familyId).toBe(plan.familyId);
    expect(plan.refresh!.row.familyId).toBe(plan.familyId);
    expect(plan.refresh!.row.parentId).toBeNull();
    expect(plan.access.row.tokenHash).toBe(hashToken(plan.access.token));
    const rows = JSON.stringify([plan.access.row, plan.refresh!.row]);
    expect(rows).not.toContain(plan.access.token);
    expect(rows).not.toContain(plan.refresh!.token);
    expect(plan.access.token).not.toBe(plan.refresh!.token);
  });

  it('no offline_access ⇒ no refresh token at all', () => {
    const plan = planTokenPair({
      clientId: CLIENT.clientId,
      userId: USER,
      scopes: ['watch:read'],
      resource: RESOURCE,
      now: NOW,
    });
    expect(plan.refresh).toBeNull();
    expect(plan.response).not.toHaveProperty('refresh_token');
    expect(plan.response.scope).toBe('watch:read');
  });

  it('no refresh token for a client that did not register the refresh grant (it could never use one)', () => {
    const plan = planTokenPair({
      clientId: CLIENT.clientId,
      userId: USER,
      scopes: ALL,
      resource: RESOURCE,
      refreshAllowed: false,
      now: NOW,
    });
    expect(plan.refresh).toBeNull();
    expect(plan.response).not.toHaveProperty('refresh_token');
    expect(plan.response.scope).toBe('watch:read watch:write offline_access');
  });

  it('a rotation stays in its family with the spent token as parent', () => {
    const plan = planTokenPair({
      clientId: CLIENT.clientId,
      userId: USER,
      scopes: ALL,
      resource: RESOURCE,
      familyId: 'fam-1',
      parentRefreshId: 'parent-1',
      now: NOW,
    });
    expect(plan.familyId).toBe('fam-1');
    expect(plan.refresh!.row).toMatchObject({ familyId: 'fam-1', parentId: 'parent-1' });
  });
});

describe('D-06 — refresh rotation decisions', () => {
  const rec: RefreshRecord = {
    id: 'r1',
    familyId: 'fam',
    clientId: CLIENT.clientId,
    userId: USER,
    scopes: ALL,
    resource: RESOURCE,
    expiresAt: secondsAfter(NOW, 86_400),
    rotatedAt: null,
    revokedAt: null,
  };

  it('a live token rotates with its full scopes', () => {
    expect(decideRefresh(rec, CLIENT, {}, NOW)).toEqual({ kind: 'rotate', scopes: ALL });
  });

  it('a spent token is REUSE (rotated), a never-rotated revoked one is the quiet case (revoked)', () => {
    expect(decideRefresh({ ...rec, rotatedAt: NOW }, CLIENT, {}, NOW)).toEqual({
      kind: 'reuse',
      reason: 'rotated',
    });
    expect(decideRefresh({ ...rec, revokedAt: NOW }, CLIENT, {}, NOW)).toEqual({
      kind: 'reuse',
      reason: 'revoked',
    });
  });

  it('rotated AND later revoked is still reuse — a revocation must not silence the theft alert', () => {
    expect(decideRefresh({ ...rec, revokedAt: NOW, rotatedAt: NOW }, CLIENT, {}, NOW)).toEqual({
      kind: 'reuse',
      reason: 'rotated',
    });
  });

  it("another client's token, an unknown or expired one, or an unregistered grant is refused", () => {
    expect(codeOf(() => decideRefresh(rec, OTHER, {}, NOW))).toBe('invalid_grant');
    expect(codeOf(() => decideRefresh(undefined, CLIENT, {}, NOW))).toBe('invalid_grant');
    expect(codeOf(() => decideRefresh({ ...rec, expiresAt: NOW }, CLIENT, {}, NOW))).toBe(
      'invalid_grant',
    );
    expect(
      codeOf(() => decideRefresh(rec, { ...CLIENT, grantTypes: ['authorization_code'] }, {}, NOW)),
    ).toBe('unauthorized_client');
  });

  it('a refresh may narrow the scopes, never widen them', () => {
    expect(decideRefresh(rec, CLIENT, { scope: 'watch:read offline_access' }, NOW)).toEqual({
      kind: 'rotate',
      scopes: ['watch:read', 'offline_access'],
    });
    expect(decideRefresh(rec, CLIENT, { scope: '  ' }, NOW)).toEqual({
      kind: 'rotate',
      scopes: ALL,
    });
    const narrow = { ...rec, scopes: ['watch:read', 'offline_access'] as OAuthScope[] };
    expect(codeOf(() => decideRefresh(narrow, CLIENT, { scope: 'watch:write' }, NOW))).toBe(
      'invalid_scope',
    );
    expect(codeOf(() => decideRefresh(narrow, CLIENT, { scope: 'watch:read admin' }, NOW))).toBe(
      'invalid_scope',
    );
  });

  it('resource, if sent, must be the token resource', () => {
    expect(
      codeOf(() => decideRefresh(rec, CLIENT, { resource: 'https://evil.example/mcp' }, NOW)),
    ).toBe('invalid_target');
  });
});

describe('D-06 / RFC 7009 — revocation semantics', () => {
  const c = CLIENT.clientId;
  it('a refresh token revokes its family', () => {
    expect(decideRevocation({ refresh: { clientId: c, familyId: 'f' } }, c)).toEqual({
      kind: 'family',
      familyId: 'f',
      tokenKind: 'refresh',
    });
  });
  it('a family access token revokes the family; a standalone one only itself', () => {
    expect(decideRevocation({ access: { id: 'a', clientId: c, familyId: 'f' } }, c)).toEqual({
      kind: 'family',
      familyId: 'f',
      tokenKind: 'access',
    });
    expect(decideRevocation({ access: { id: 'a', clientId: c, familyId: null } }, c)).toEqual({
      kind: 'access',
      accessId: 'a',
    });
  });
  it("unknown and other clients' tokens are ignored", () => {
    expect(decideRevocation({}, c)).toEqual({ kind: 'ignore', reason: 'unknown' });
    expect(decideRevocation({ refresh: { clientId: OTHER.clientId, familyId: 'f' } }, c)).toEqual({
      kind: 'ignore',
      reason: 'foreign',
    });
    expect(
      decideRevocation({ access: { id: 'a', clientId: OTHER.clientId, familyId: null } }, c),
    ).toEqual({
      kind: 'ignore',
      reason: 'foreign',
    });
  });
});

describe('D-07 — the /mcp bearer', () => {
  const row = {
    scopes: ALL,
    resource: RESOURCE,
    expiresAt: secondsAfter(NOW, 60),
    revokedAt: null,
    clientId: CLIENT.clientId,
  };

  it('a live token bound to the canonical resource passes with its watch scopes (offline_access dropped)', () => {
    expect(decideBearer(row, { now: NOW, env: ENV })).toEqual({
      ok: true,
      scopes: ['watch:read', 'watch:write'],
    });
    expect(decideBearer({ ...row, scopes: ['watch:read'] }, { now: NOW, env: ENV })).toEqual({
      ok: true,
      scopes: ['watch:read'],
    });
    expect(decideBearer({ ...row, scopes: ['offline_access'] }, { now: NOW, env: ENV })).toEqual({
      ok: true,
      scopes: [],
    });
  });

  it('refuses unknown, revoked, expired, and another audience (the issuer changed)', () => {
    expect(decideBearer(undefined, { now: NOW, env: ENV })).toEqual({
      ok: false,
      error: 'invalid_token',
    });
    expect(decideBearer({ ...row, revokedAt: NOW }, { now: NOW, env: ENV })).toEqual({
      ok: false,
      error: 'revoked',
    });
    expect(decideBearer({ ...row, expiresAt: NOW }, { now: NOW, env: ENV })).toEqual({
      ok: false,
      error: 'expired',
    });
    const logs = captureLogs();
    expect(
      decideBearer(row, { now: NOW, env: { BETTER_AUTH_URL: 'https://staging.example' } }),
    ).toEqual({
      ok: false,
      error: 'audience_mismatch',
    });
    expect(logs.lines[0]).toMatch(/^\[auth\] audience_mismatch \{"phase":"mcp"/);
  });

  it('last_used_at is stamped at most once a minute', () => {
    expect(lastUsedIsStale(null, NOW)).toBe(true);
    expect(lastUsedIsStale(secondsAfter(NOW, -59), NOW)).toBe(false);
    expect(lastUsedIsStale(secondsAfter(NOW, -60), NOW)).toBe(true);
  });
});

describe('D-03 — the pruner thresholds', () => {
  it('200 rows per table, expired now, tokens and dormant clients after 30 days', () => {
    expect(pruneCutoffs(NOW)).toEqual({
      expiredBefore: NOW,
      retainedBefore: new Date(NOW.getTime() - 30 * 86_400_000),
      dormantBefore: new Date(NOW.getTime() - 30 * 86_400_000),
      batchSize: 200,
    });
  });
});

describe('ENV is never needed for decisions other than the resource', () => {
  it('decideBearer defaults to process.env when no env is passed', () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://haynesnetwork.com');
    expect(
      decideBearer(
        {
          scopes: ALL,
          resource: RESOURCE,
          expiresAt: secondsAfter(NOW, 1),
          revokedAt: null,
          clientId: 'x',
        },
        { now: NOW },
      ).ok,
    ).toBe(true);
    vi.unstubAllEnvs();
  });
});
