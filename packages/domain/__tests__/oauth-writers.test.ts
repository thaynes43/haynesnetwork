// ADR-091 / DESIGN-050 D-03..D-08 (PLAN-069 S2) — the @hnet/domain OAuth single-writers against embedded Postgres 16:
// every write to the six OAuth tables, the four audited transitions writing their oauth_audit row in the SAME
// transaction (a blocked audit insert rolls the state change back — hard rule 6), code single use and the
// replica race, refresh rotation, family revocation on reuse (incl. the lost-race path), RFC 7009 revocation,
// Disconnect, the Connected apps read, the once-a-minute stamp, the pruner's bounds and thresholds, the shared
// rate limiter, and an [auth] log over the whole flow that never carries a credential.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  oauthAccessTokens,
  oauthAudit,
  oauthAuthorizationCodes,
  oauthAuthorizations,
  oauthClients,
  oauthRefreshTokens,
  rateLimit,
  type OAuthClientRow,
} from '@hnet/db';
import {
  OAuthError,
  hashToken,
  s256Challenge,
  validateAuthorizationParams,
  type TokenResponse,
} from '@hnet/oauth';
import {
  authenticateOAuthClient,
  consumeRateLimit,
  denyConsent,
  disconnectClient,
  exchangeCode,
  getConsentView,
  getOAuthClient,
  grantConsent,
  listConnectedApps,
  pruneExpired,
  registerClient,
  resolveAuthorizationClient,
  revokeFamilyOnReuse,
  revokeToken,
  rotateRefreshToken,
  selectBearerToken,
  startAuthorization,
  touchLastUsed,
} from '../src/index';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const ENV = { BETTER_AUTH_URL: 'https://haynesnetwork.com' };
const RESOURCE = 'https://haynesnetwork.com/mcp';
const T0 = new Date('2026-09-23T20:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const DAY = 86_400;
const REDIRECT = 'https://chatgpt.com/connector/oauth/abc123';
const CHATGPT = {
  client_name: 'ChatGPT',
  redirect_uris: [REDIRECT],
  grant_types: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_method: 'none',
};

let t: TestDb;
let alice: string;
let bob: string;
let verifierSeq = 0;

async function oauthError(p: Promise<unknown>): Promise<OAuthError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof OAuthError) return e;
    throw e;
  }
  throw new Error('expected an OAuthError');
}

async function newClient(
  body: Record<string, unknown> = CHATGPT,
  now = T0,
): Promise<OAuthClientRow> {
  const reg = await registerClient({ db: t.db, body, registeredIp: '203.0.113.9', now });
  return (await getOAuthClient({ db: t.db, clientId: reg.client_id }))!;
}

async function pendingRequest(
  client: OAuthClientRow,
  userId: string,
  opts: { scope?: string; now?: Date; redirect?: string } = {},
) {
  const verifier = `verifier-${String(++verifierSeq).padStart(4, '0')}-${'x'.repeat(40)}`;
  const validated = validateAuthorizationParams(
    {
      responseType: 'code',
      state: `state-${verifierSeq}`,
      codeChallenge: s256Challenge(verifier),
      codeChallengeMethod: 'S256',
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
      resources: [RESOURCE],
    },
    { env: ENV },
  );
  const redirectUri = opts.redirect ?? client.redirectUris[0]!;
  const { txnId } = await startAuthorization({
    db: t.db,
    client,
    userId,
    redirectUri,
    validated,
    now: opts.now ?? T0,
  });
  return { txnId, verifier, state: validated.state };
}

async function approve(
  client: OAuthClientRow,
  userId: string,
  opts: { scope?: string; now?: Date } = {},
) {
  const req = await pendingRequest(client, userId, opts);
  const outcome = await grantConsent({ db: t.db, txnId: req.txnId, userId, now: opts.now ?? T0 });
  if (outcome.status !== 'redirect') throw new Error(`consent ${outcome.status}`);
  const code = new URL(outcome.redirectUrl).searchParams.get('code')!;
  return { ...req, code, redirectUrl: outcome.redirectUrl };
}

async function connect(
  client: OAuthClientRow,
  userId: string,
  opts: { scope?: string; now?: Date } = {},
): Promise<TokenResponse> {
  const a = await approve(client, userId, opts);
  return exchangeCode({
    db: t.db,
    client,
    request: { code: a.code, codeVerifier: a.verifier },
    now: opts.now ?? T0,
  });
}

const audits = (event?: string) =>
  t.db
    .select()
    .from(oauthAudit)
    .where(event ? eq(oauthAudit.event, event as never) : sql`true`);

async function blockAudit<T>(fn: () => Promise<T>): Promise<void> {
  await t.pool.query(`
    CREATE FUNCTION test_block_oauth_audit() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'oauth audit blocked (test)'; END
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER test_block_oauth_audit BEFORE INSERT ON oauth_audit
      FOR EACH ROW EXECUTE FUNCTION test_block_oauth_audit();
  `);
  try {
    await expect(fn()).rejects.toThrow(/oauth audit blocked/);
  } finally {
    await t.pool.query(
      `DROP TRIGGER test_block_oauth_audit ON oauth_audit; DROP FUNCTION test_block_oauth_audit();`,
    );
  }
}

beforeAll(async () => {
  t = await bootMigratedDb();
});

afterAll(async () => {
  await t.stop();
});

beforeEach(async () => {
  await t.db.execute(
    sql`TRUNCATE oauth_audit, oauth_access_tokens, oauth_refresh_tokens, oauth_authorization_codes, oauth_authorizations, oauth_clients, rate_limit CASCADE`,
  );
  alice = (await createUser(t.db, { email: `alice-${Math.random()}@example.test` })).id;
  bob = (await createUser(t.db, { email: `bob-${Math.random()}@example.test` })).id;
});

afterEach(() => vi.restoreAllMocks());

describe('registerClient (D-04)', () => {
  it('inserts the validated client with its registering IP; a confidential secret is stored only hashed', async () => {
    const reg = await registerClient({
      db: t.db,
      body: CHATGPT,
      registeredIp: '198.51.100.7',
      now: T0,
    });
    const row = await getOAuthClient({ db: t.db, clientId: reg.client_id });
    expect(row).toMatchObject({
      clientName: 'ChatGPT',
      redirectUris: [REDIRECT],
      tokenEndpointAuthMethod: 'none',
      clientSecretHash: null,
      registeredIp: '198.51.100.7',
      lastUsedAt: null,
    });
    const conf = await registerClient({
      db: t.db,
      body: { ...CHATGPT, token_endpoint_auth_method: 'client_secret_basic' },
      now: T0,
    });
    const confRow = await getOAuthClient({ db: t.db, clientId: conf.client_id });
    expect(confRow!.clientSecretHash).toBe(hashToken(conf.client_secret!));
    await expect(
      authenticateOAuthClient({
        db: t.db,
        credentials: { clientId: conf.client_id, clientSecret: conf.client_secret },
      }),
    ).resolves.toMatchObject({ clientId: conf.client_id });
    expect(
      (
        await oauthError(
          authenticateOAuthClient({
            db: t.db,
            credentials: { clientId: conf.client_id, clientSecret: 'nope' },
          }),
        )
      ).code,
    ).toBe('invalid_client');
  });

  it('writes nothing for an invalid registration', async () => {
    expect(
      (
        await oauthError(
          registerClient({ db: t.db, body: { ...CHATGPT, client_name: 'x'.repeat(81) } }),
        )
      ).code,
    ).toBe('invalid_client_metadata');
    expect(await t.db.select().from(oauthClients)).toHaveLength(0);
  });

  it('resolveAuthorizationClient: unknown client or unregistered redirect is refused (never redirected to)', async () => {
    const client = await newClient({ ...CHATGPT, redirect_uris: ['http://127.0.0.1:1455/cb'] });
    await expect(
      resolveAuthorizationClient({
        db: t.db,
        clientId: client.clientId,
        redirectUri: 'http://localhost:9/cb',
      }),
    ).resolves.toMatchObject({ clientId: client.clientId });
    expect(
      (
        await oauthError(
          resolveAuthorizationClient({
            db: t.db,
            clientId: client.clientId,
            redirectUri: 'https://evil.example/cb',
          }),
        )
      ).code,
    ).toBe('invalid_redirect_uri');
    expect(
      (
        await oauthError(
          resolveAuthorizationClient({ db: t.db, clientId: 'f'.repeat(32), redirectUri: REDIRECT }),
        )
      ).code,
    ).toBe('invalid_client');
    expect(
      (
        await oauthError(
          resolveAuthorizationClient({ db: t.db, clientId: "x' OR 1=1 --", redirectUri: REDIRECT }),
        )
      ).code,
    ).toBe('invalid_client');
  });
});

describe('startAuthorization + getConsentView (D-05 steps 5–6)', () => {
  it('a pending request for the signed-in user, 10 minutes; the view shows the name, host and scopes', async () => {
    const client = await newClient();
    const { txnId } = await pendingRequest(client, alice, { scope: 'watch:read offline_access' });
    const [row] = await t.db
      .select()
      .from(oauthAuthorizations)
      .where(eq(oauthAuthorizations.id, txnId));
    expect(row).toMatchObject({
      userId: alice,
      clientId: client.clientId,
      resource: RESOURCE,
      scopes: ['watch:read', 'offline_access'],
    });
    expect(row!.expiresAt).toEqual(at(600));
    expect(await getConsentView({ db: t.db, txnId, userId: alice, now: at(1) })).toEqual({
      status: 'ok',
      view: {
        txnId,
        clientId: client.clientId,
        clientName: 'ChatGPT',
        redirectHost: 'chatgpt.com',
        scopes: ['watch:read', 'offline_access'],
      },
    });
  });

  it("another user's, a malformed, an unknown or an expired request never shows the consent", async () => {
    const client = await newClient();
    const { txnId } = await pendingRequest(client, alice);
    expect(await getConsentView({ db: t.db, txnId, userId: bob, now: at(1) })).toEqual({
      status: 'missing',
    });
    expect(await getConsentView({ db: t.db, txnId: 'not-a-uuid', userId: alice })).toEqual({
      status: 'missing',
    });
    expect(await getConsentView({ db: t.db, txnId: undefined, userId: alice })).toEqual({
      status: 'missing',
    });
    expect(
      await getConsentView({
        db: t.db,
        txnId: '00000000-0000-4000-8000-000000000000',
        userId: alice,
      }),
    ).toEqual({ status: 'missing' });
    expect(await getConsentView({ db: t.db, txnId, userId: alice, now: at(600) })).toEqual({
      status: 'expired',
      clientName: 'ChatGPT',
    });
  });
});

describe('grantConsent / denyConsent (D-05 step 7) — one transaction with the audit row', () => {
  it('Approve deletes the request, inserts a hashed 60 s code, writes consent_granted, redirects code + state', async () => {
    const client = await newClient();
    const { txnId, state } = await pendingRequest(client, alice);
    const out = await grantConsent({ db: t.db, txnId, userId: alice, now: at(5) });
    if (out.status !== 'redirect') throw new Error(out.status);
    const url = new URL(out.redirectUrl);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe(state);
    const code = url.searchParams.get('code')!;
    expect(await t.db.select().from(oauthAuthorizations)).toHaveLength(0);
    const [codeRow] = await t.db.select().from(oauthAuthorizationCodes);
    expect(codeRow).toMatchObject({
      codeHash: hashToken(code),
      userId: alice,
      clientId: client.clientId,
      consumedAt: null,
    });
    expect(codeRow!.expiresAt).toEqual(at(65));
    const [audit] = await audits('consent_granted');
    expect(audit).toMatchObject({
      userId: alice,
      clientId: client.clientId,
      familyId: null,
      details: {
        client_name: 'ChatGPT',
        redirect_host: 'chatgpt.com',
        scopes: ['watch:read', 'watch:write', 'offline_access'],
      },
    });
    expect(JSON.stringify(audit)).not.toContain(code);
    // Decided once: a second Approve (a double click, another replica) finds nothing.
    expect(await grantConsent({ db: t.db, txnId, userId: alice, now: at(6) })).toEqual({
      status: 'missing',
    });
    expect(await audits()).toHaveLength(1);
  });

  it("an expired request issues nothing (and stays for the pruner); another user's request is untouched", async () => {
    const client = await newClient();
    const { txnId } = await pendingRequest(client, alice);
    expect(await grantConsent({ db: t.db, txnId, userId: bob, now: at(1) })).toEqual({
      status: 'missing',
    });
    expect(await grantConsent({ db: t.db, txnId, userId: alice, now: at(600) })).toEqual({
      status: 'expired',
      clientName: 'ChatGPT',
    });
    expect(await denyConsent({ db: t.db, txnId, userId: alice, now: at(600) })).toEqual({
      status: 'expired',
      clientName: 'ChatGPT',
    });
    expect(await t.db.select().from(oauthAuthorizations)).toHaveLength(1);
    expect(await t.db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
    expect(await audits()).toHaveLength(0);
  });

  it('two racing Approves on one request: exactly one code', async () => {
    const client = await newClient();
    const { txnId } = await pendingRequest(client, alice);
    const results = await Promise.all([
      grantConsent({ db: t.db, txnId, userId: alice, now: at(1) }),
      grantConsent({ db: t.db, txnId, userId: alice, now: at(1) }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['missing', 'redirect']);
    expect(await t.db.select().from(oauthAuthorizationCodes)).toHaveLength(1);
    expect(await audits('consent_granted')).toHaveLength(1);
  });

  it('Deny deletes the request, writes consent_denied and redirects access_denied + state (no code)', async () => {
    const client = await newClient();
    const { txnId, state } = await pendingRequest(client, alice);
    const out = await denyConsent({ db: t.db, txnId, userId: alice, now: at(2) });
    if (out.status !== 'redirect') throw new Error(out.status);
    const url = new URL(out.redirectUrl);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('code')).toBeNull();
    expect(await t.db.select().from(oauthAuthorizations)).toHaveLength(0);
    expect(await t.db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
    expect(await audits('consent_denied')).toMatchObject([
      { userId: alice, clientId: client.clientId },
    ]);
  });

  it('a failed audit insert rolls the whole decision back (hard rule 6)', async () => {
    const client = await newClient();
    const { txnId } = await pendingRequest(client, alice);
    await blockAudit(() => grantConsent({ db: t.db, txnId, userId: alice, now: at(1) }));
    await blockAudit(() => denyConsent({ db: t.db, txnId, userId: alice, now: at(1) }));
    expect(await t.db.select().from(oauthAuthorizations)).toHaveLength(1); // the request survived
    expect(await t.db.select().from(oauthAuthorizationCodes)).toHaveLength(0); // no code landed
  });
});

describe('exchangeCode (D-06 authorization_code)', () => {
  it('issues a 1 h access token and a 60-day refresh token in one new family; stores only hashes', async () => {
    const client = await newClient();
    const a = await approve(client, alice);
    const tokens = await exchangeCode({
      db: t.db,
      client,
      request: {
        code: a.code,
        codeVerifier: a.verifier,
        redirectUri: REDIRECT,
        resource: RESOURCE,
      },
      now: at(10),
    });
    expect(tokens).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'watch:read watch:write offline_access',
    });
    const [access] = await t.db.select().from(oauthAccessTokens);
    const [refresh] = await t.db.select().from(oauthRefreshTokens);
    expect(access).toMatchObject({
      tokenHash: hashToken(tokens.access_token),
      userId: alice,
      resource: RESOURCE,
      revokedAt: null,
    });
    expect(refresh).toMatchObject({
      tokenHash: hashToken(tokens.refresh_token!),
      familyId: access!.familyId,
      parentId: null,
    });
    expect(access!.expiresAt).toEqual(at(10 + 3600));
    expect(refresh!.expiresAt).toEqual(at(10 + 60 * DAY));
    const [code] = await t.db.select().from(oauthAuthorizationCodes);
    expect(code!.consumedAt).toEqual(at(10));
  });

  it('without offline_access there is no refresh token', async () => {
    const client = await newClient();
    const tokens = await connect(client, alice, { scope: 'watch:read' });
    expect(tokens.refresh_token).toBeUndefined();
    expect(await t.db.select().from(oauthRefreshTokens)).toHaveLength(0);
  });

  it('a client that registered only the authorization_code grant gets no refresh token, even with offline_access', async () => {
    const client = await newClient({ ...CHATGPT, grant_types: ['authorization_code'] });
    const tokens = await connect(client, alice);
    expect(tokens.scope).toBe('watch:read watch:write offline_access');
    expect(tokens.refresh_token).toBeUndefined();
    expect(await t.db.select().from(oauthRefreshTokens)).toHaveLength(0);
  });

  it('a code is single use: a replay answers invalid_grant (logged code_replayed) and issues nothing', async () => {
    const client = await newClient();
    const a = await approve(client, alice);
    await exchangeCode({
      db: t.db,
      client,
      request: { code: a.code, codeVerifier: a.verifier },
      now: at(1),
    });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    expect(
      (
        await oauthError(
          exchangeCode({
            db: t.db,
            client,
            request: { code: a.code, codeVerifier: a.verifier },
            now: at(2),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(logs.some((l) => l.startsWith('[auth] code_replayed '))).toBe(true);
    // Nothing new was issued, and (RFC 6749 §4.1.2) every token the code's exchange issued is revoked, audited.
    const access = await t.db.select().from(oauthAccessTokens);
    expect(access).toHaveLength(1);
    expect(access[0]!.revokedAt).toEqual(at(2));
    for (const r of await t.db.select().from(oauthRefreshTokens))
      expect(r.revokedAt).toEqual(at(2));
    const [code] = await t.db.select().from(oauthAuthorizationCodes);
    expect(code!.familyId).toBe(access[0]!.familyId);
    expect(await audits('family_revoked_on_reuse')).toMatchObject([
      {
        userId: alice,
        clientId: client.clientId,
        familyId: access[0]!.familyId,
        details: { reason: 'code_replayed', refresh_revoked: 1, access_revoked: 1 },
      },
    ]);
  });

  it('two replicas exchanging the same code at once: exactly one pair is issued — and, the code being replayed, revoked', async () => {
    const client = await newClient();
    const a = await approve(client, alice);
    const settled = await Promise.allSettled([
      exchangeCode({
        db: t.db,
        client,
        request: { code: a.code, codeVerifier: a.verifier },
        now: at(1),
      }),
      exchangeCode({
        db: t.db,
        client,
        request: { code: a.code, codeVerifier: a.verifier },
        now: at(1),
      }),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect((rejected.reason as OAuthError).code).toBe('invalid_grant');
    const access = await t.db.select().from(oauthAccessTokens);
    expect(access).toHaveLength(1);
    // Strict RFC 6749 §4.1.2: two presentations of one code — the winner's family is revoked too.
    expect(access[0]!.revokedAt).not.toBeNull();
    expect(await audits('family_revoked_on_reuse')).toMatchObject([
      { details: { reason: 'code_replayed' } },
    ]);
  });

  it('a wrong verifier, another client, an expired code, or a mismatched redirect issues nothing', async () => {
    const client = await newClient();
    const other = await newClient();
    const a = await approve(client, alice);
    expect(
      (
        await oauthError(
          exchangeCode({
            db: t.db,
            client,
            request: { code: a.code, codeVerifier: `${a.verifier}x` },
            now: at(1),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(
      (
        await oauthError(
          exchangeCode({
            db: t.db,
            client: other,
            request: { code: a.code, codeVerifier: a.verifier },
            now: at(1),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(
      (
        await oauthError(
          exchangeCode({
            db: t.db,
            client,
            request: {
              code: a.code,
              codeVerifier: a.verifier,
              redirectUri: 'https://chatgpt.com/other',
            },
            now: at(1),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(
      (
        await oauthError(
          exchangeCode({
            db: t.db,
            client,
            request: { code: a.code, codeVerifier: a.verifier },
            now: at(61),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(await t.db.select().from(oauthAccessTokens)).toHaveLength(0);
    // None of the refusals consumed the code (it simply expires).
    const [code] = await t.db.select().from(oauthAuthorizationCodes);
    expect(code!.consumedAt).toBeNull();
  });
});

describe('rotateRefreshToken + revokeFamilyOnReuse (D-06 refresh_token)', () => {
  it('rotation: a new pair in the same family, the old refresh spent (parent link); the old access token still works', async () => {
    const client = await newClient();
    const first = await connect(client, alice);
    const second = await rotateRefreshToken({
      db: t.db,
      client,
      request: { refreshToken: first.refresh_token! },
      now: at(100),
    });
    expect(second.refresh_token).toBeDefined();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const refreshes = await t.db.select().from(oauthRefreshTokens);
    const old = refreshes.find((r) => r.tokenHash === hashToken(first.refresh_token!))!;
    const fresh = refreshes.find((r) => r.tokenHash === hashToken(second.refresh_token!))!;
    expect(old.rotatedAt).toEqual(at(100));
    expect(fresh).toMatchObject({
      familyId: old.familyId,
      parentId: old.id,
      rotatedAt: null,
      revokedAt: null,
    });
    expect(fresh.expiresAt).toEqual(at(100 + 60 * DAY)); // re-issued on rotation
    const oldAccess = await selectBearerToken({ db: t.db, token: first.access_token });
    expect(oauthRevokedAt(oldAccess)).toBeNull();
  });

  it('REUSE of a spent token revokes the whole family (refresh + access) with a family_revoked_on_reuse audit row', async () => {
    const client = await newClient();
    const first = await connect(client, alice);
    const second = await rotateRefreshToken({
      db: t.db,
      client,
      request: { refreshToken: first.refresh_token! },
      now: at(100),
    });
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    expect(
      (
        await oauthError(
          rotateRefreshToken({
            db: t.db,
            client,
            request: { refreshToken: first.refresh_token! },
            now: at(200),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    for (const r of await t.db.select().from(oauthRefreshTokens))
      expect(r.revokedAt).not.toBeNull();
    for (const a of await t.db.select().from(oauthAccessTokens)) expect(a.revokedAt).not.toBeNull();
    const [audit] = await audits('family_revoked_on_reuse');
    expect(audit).toMatchObject({
      userId: alice,
      clientId: client.clientId,
      details: { reason: 'rotated', refresh_revoked: 2, access_revoked: 2 },
    });
    expect(audit!.familyId).toBeTruthy();
    expect(logs.some((l) => l.startsWith('[auth] refresh_reuse_detected '))).toBe(true);
    // The thief's AND the victim's newest tokens are dead: the family is gone.
    expect(
      (
        await oauthError(
          rotateRefreshToken({
            db: t.db,
            client,
            request: { refreshToken: second.refresh_token! },
            now: at(300),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    // That second refusal is a REVOKED token presented after the response — quiet: no second audit row, no page.
    expect(await audits('family_revoked_on_reuse')).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith('[auth] refresh_reuse_detected '))).toHaveLength(1);
    expect(logs.filter((l) => l.startsWith('[auth] refresh_rejected '))).toHaveLength(1);
  });

  it('replaying the spent token again after the response is still reuse (it was rotated, not revoked by a person)', async () => {
    const client = await newClient();
    const first = await connect(client, alice);
    await rotateRefreshToken({
      db: t.db,
      client,
      request: { refreshToken: first.refresh_token! },
      now: at(10),
    });
    for (const s of [20, 30]) {
      await oauthError(
        rotateRefreshToken({
          db: t.db,
          client,
          request: { refreshToken: first.refresh_token! },
          now: at(s),
        }),
      );
    }
    // rotated_at stays set, so the second replay — of a token that is now also revoked — is STILL reuse: a
    // revocation never silences the theft alert.
    const rows = await audits('family_revoked_on_reuse');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.details as { reason: string }).reason)).toEqual([
      'rotated',
      'rotated',
    ]);
  });

  it('a REVOKED refresh token presented again (after Disconnect or a client revoke) is refused quietly — no audit, no page', async () => {
    const client = await newClient();
    const mine = await connect(client, alice);
    const theirs = await connect(client, bob);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
    await revokeToken({ db: t.db, client, token: mine.refresh_token!, now: at(5) });
    const refused = await oauthError(
      rotateRefreshToken({
        db: t.db,
        client,
        request: { refreshToken: mine.refresh_token! },
        now: at(6),
      }),
    );
    expect(refused).toMatchObject({
      code: 'invalid_grant',
      description: 'Refresh token was revoked',
    });
    const again = await connect(client, alice);
    await disconnectClient({ db: t.db, clientId: client.clientId, userId: alice, now: at(7) });
    expect(
      (
        await oauthError(
          rotateRefreshToken({
            db: t.db,
            client,
            request: { refreshToken: again.refresh_token! },
            now: at(8),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(await audits('family_revoked_on_reuse')).toEqual([]);
    expect(logs.filter((l) => l.startsWith('[auth] refresh_reuse_detected '))).toEqual([]);
    const rejected = logs.filter((l) => l.startsWith('[auth] refresh_rejected '));
    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toMatch(/"reason":"revoked"/);
    // Another user's family is untouched.
    await expect(
      rotateRefreshToken({
        db: t.db,
        client,
        request: { refreshToken: theirs.refresh_token! },
        now: at(9),
      }),
    ).resolves.toMatchObject({ token_type: 'Bearer' });
  });

  it('a revocation racing a rotation catches the child the rotation just committed (Disconnect and RFC 7009)', async () => {
    for (const revoker of ['disconnect', 'revoke'] as const) {
      const client = await newClient();
      const tokens = await connect(client, alice);
      const [parent] = await t.db
        .select()
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.tokenHash, hashToken(tokens.refresh_token!)));
      // T1 — a rotation on another replica, mid-flight: it holds the parent's row lock and has inserted its child.
      const rotation = await t.pool.connect();
      try {
        await rotation.query('BEGIN');
        await rotation.query(`UPDATE oauth_refresh_tokens SET rotated_at = now() WHERE id = $1`, [
          parent!.id,
        ]);
        const childHash = hashToken(`child-${revoker}`);
        await rotation.query(
          `INSERT INTO oauth_refresh_tokens (token_hash, family_id, parent_id, client_id, user_id, scopes, resource, expires_at)
           VALUES ($1, $2, $3, $4, $5, '["watch:read","offline_access"]'::jsonb, $6, now() + interval '60 days')`,
          [childHash, parent!.familyId, parent!.id, client.clientId, alice, RESOURCE],
        );
        await rotation.query(
          `INSERT INTO oauth_access_tokens (token_hash, family_id, client_id, user_id, scopes, resource, expires_at)
           VALUES ($1, $2, $3, $4, '["watch:read"]'::jsonb, $5, now() + interval '1 hour')`,
          [
            hashToken(`child-access-${revoker}`),
            parent!.familyId,
            client.clientId,
            alice,
            RESOURCE,
          ],
        );
        // T2 — the revocation blocks on the parent's lock…
        const revoking =
          revoker === 'disconnect'
            ? disconnectClient({ db: t.db, clientId: client.clientId, userId: alice, now: at(5) })
            : revokeToken({ db: t.db, client, token: tokens.refresh_token!, now: at(5) });
        await new Promise((r) => setTimeout(r, 150));
        // …until T1 commits.
        await rotation.query('COMMIT');
        await revoking;
        const family = await t.db
          .select()
          .from(oauthRefreshTokens)
          .where(eq(oauthRefreshTokens.familyId, parent!.familyId));
        expect(
          family.map((r) => r.revokedAt !== null),
          revoker,
        ).toEqual([true, true]);
        const access = await t.db
          .select()
          .from(oauthAccessTokens)
          .where(eq(oauthAccessTokens.familyId, parent!.familyId));
        expect(
          access.every((a) => a.revokedAt !== null),
          revoker,
        ).toBe(true);
      } finally {
        rotation.release();
      }
    }
  });

  it('two replicas rotating the same token at once: one wins, the loser is reuse and the family is revoked', async () => {
    const client = await newClient();
    const first = await connect(client, alice);
    const settled = await Promise.allSettled([
      rotateRefreshToken({
        db: t.db,
        client,
        request: { refreshToken: first.refresh_token! },
        now: at(50),
      }),
      rotateRefreshToken({
        db: t.db,
        client,
        request: { refreshToken: first.refresh_token! },
        now: at(50),
      }),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);
    const [audit] = await audits('family_revoked_on_reuse');
    expect(['race', 'rotated']).toContain((audit!.details as { reason: string }).reason);
    for (const r of await t.db.select().from(oauthRefreshTokens))
      expect(r.revokedAt).not.toBeNull();
  });

  it('a refresh may narrow the scopes; another client, an expired or unknown token is refused', async () => {
    const client = await newClient();
    const other = await newClient();
    const first = await connect(client, alice);
    const narrowed = await rotateRefreshToken({
      db: t.db,
      client,
      request: { refreshToken: first.refresh_token!, scope: 'watch:read offline_access' },
      now: at(10),
    });
    expect(narrowed.scope).toBe('watch:read offline_access');
    expect(
      (
        await oauthError(
          rotateRefreshToken({
            db: t.db,
            client,
            request: { refreshToken: narrowed.refresh_token!, scope: 'watch:write' },
            now: at(11),
          }),
        )
      ).code,
    ).toBe('invalid_scope');
    expect(
      (
        await oauthError(
          rotateRefreshToken({
            db: t.db,
            client: other,
            request: { refreshToken: narrowed.refresh_token! },
            now: at(12),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(
      (
        await oauthError(
          rotateRefreshToken({
            db: t.db,
            client,
            request: { refreshToken: narrowed.refresh_token! },
            now: at(10 + 61 * DAY),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(
      (
        await oauthError(
          rotateRefreshToken({
            db: t.db,
            client,
            request: { refreshToken: 'unknown' },
            now: at(13),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(await audits('family_revoked_on_reuse')).toHaveLength(0); // none of those is reuse
  });

  it('revokeFamilyOnReuse is atomic with its audit row (hard rule 6)', async () => {
    const client = await newClient();
    await connect(client, alice);
    const [refresh] = await t.db.select().from(oauthRefreshTokens);
    await blockAudit(() =>
      revokeFamilyOnReuse({
        db: t.db,
        familyId: refresh!.familyId,
        clientId: client.clientId,
        userId: alice,
        reason: 'rotated',
        now: at(1),
      }),
    );
    for (const r of await t.db.select().from(oauthRefreshTokens)) expect(r.revokedAt).toBeNull();
    for (const a of await t.db.select().from(oauthAccessTokens)) expect(a.revokedAt).toBeNull();
  });
});

function oauthRevokedAt(row: { revokedAt: Date | null } | undefined): Date | null {
  if (!row) throw new Error('no token');
  return row.revokedAt;
}

describe('revokeToken (D-06 / RFC 7009)', () => {
  it('a refresh token revokes its family; a family access token revokes its family', async () => {
    const client = await newClient();
    const one = await connect(client, alice);
    await revokeToken({ db: t.db, client, token: one.refresh_token!, now: at(3) });
    expect(oauthRevokedAt(await selectBearerToken({ db: t.db, token: one.access_token }))).toEqual(
      at(3),
    );
    const two = await connect(client, alice);
    await revokeToken({ db: t.db, client, token: two.access_token, now: at(4) });
    const [r2] = await t.db
      .select()
      .from(oauthRefreshTokens)
      .where(eq(oauthRefreshTokens.tokenHash, hashToken(two.refresh_token!)));
    expect(r2!.revokedAt).toEqual(at(4));
    expect(await audits()).toHaveLength(2); // the two consents — client revocation is not audited
  });

  it("unknown tokens and another client's tokens are ignored silently", async () => {
    const client = await newClient();
    const other = await newClient();
    const tokens = await connect(client, alice);
    await revokeToken({ db: t.db, client: other, token: tokens.refresh_token!, now: at(1) });
    await revokeToken({ db: t.db, client: other, token: tokens.access_token, now: at(1) });
    await revokeToken({ db: t.db, client, token: 'never-issued', now: at(1) });
    expect(
      oauthRevokedAt(await selectBearerToken({ db: t.db, token: tokens.access_token })),
    ).toBeNull();
  });
});

describe('disconnectClient + listConnectedApps (D-08)', () => {
  it('shows the host the user CONSENTED to, not the first registered URI (newest consent wins)', async () => {
    const client = await newClient({
      ...CHATGPT,
      redirect_uris: [
        'https://first.example/cb',
        'https://second.example/cb',
        'http://127.0.0.1:1/cb',
      ],
    });
    await connect(client, alice, { now: at(0) }); // consents through the first URI (the helper's default)
    const viaSecond = await pendingRequest(client, alice, {
      now: at(10),
      redirect: 'https://second.example/cb',
    });
    const granted = await grantConsent({
      db: t.db,
      txnId: viaSecond.txnId,
      userId: alice,
      now: at(10),
    });
    if (granted.status !== 'redirect') throw new Error(granted.status);
    const [row] = await listConnectedApps({ db: t.db, userId: alice, now: at(20) });
    expect(row!.redirectHost).toBe('second.example');
    // Bob never consented through the audit trail (a legacy row): the first registered URI is the fallback.
    await connect(client, bob, { now: at(30) });
    await t.db.execute(sql`DELETE FROM oauth_audit WHERE user_id = ${bob}`);
    const [bobs] = await listConnectedApps({ db: t.db, userId: bob, now: at(40) });
    expect(bobs!.redirectHost).toBe('first.example');
  });

  it('lists one row per live (client, user) connection with host, dates, last use and scope union', async () => {
    const chatgpt = await newClient();
    const codex = await newClient({
      client_name: 'Codex',
      redirect_uris: ['http://127.0.0.1:1455/callback/x'],
    });
    const tokens = await connect(chatgpt, alice, { now: at(0) });
    await connect(codex, alice, { scope: 'watch:read', now: at(60) });
    await connect(chatgpt, bob, { now: at(120) });
    const bearer = await selectBearerToken({ db: t.db, token: tokens.access_token });
    await touchLastUsed({
      db: t.db,
      tokenId: bearer!.id,
      clientId: chatgpt.clientId,
      tokenLastUsedAt: null,
      clientLastUsedAt: null,
      now: at(300),
    });

    const mine = await listConnectedApps({ db: t.db, userId: alice, now: at(400) });
    expect(
      mine.map((r) => [r.clientName, r.redirectHost, r.scopes, r.lastUsedAt, r.connectedAt]),
    ).toEqual([
      ['Codex', '127.0.0.1:1455', ['watch:read'], null, at(60)],
      ['ChatGPT', 'chatgpt.com', ['watch:read', 'watch:write', 'offline_access'], at(300), at(0)],
    ]);
    expect(mine.every((r) => r.userId === alice)).toBe(true);
    const everyone = await listConnectedApps({ db: t.db, userId: null, now: at(400) });
    expect(everyone).toHaveLength(3);
    expect(new Set(everyone.map((r) => r.userId))).toEqual(new Set([alice, bob]));
    // A live refresh family keeps a connection listed after its access token expired; the rotation keeps its start date.
    const later = await listConnectedApps({ db: t.db, userId: alice, now: at(2 * 3600) });
    expect(later.find((r) => r.clientName === 'ChatGPT')?.connectedAt).toEqual(at(0));
    expect(later.find((r) => r.clientName === 'Codex')).toBeUndefined(); // access-only, expired
  });

  it('Disconnect revokes every token of that client for that user only, expires pending state, audits once', async () => {
    const client = await newClient();
    const a1 = await connect(client, alice);
    await connect(client, alice); // a second family
    const b1 = await connect(client, bob);
    const pending = await pendingRequest(client, alice);
    const unexchanged = await approve(client, alice);

    const out = await disconnectClient({
      db: t.db,
      clientId: client.clientId,
      userId: alice,
      actorUserId: alice,
      now: at(30),
    });
    expect(out).toEqual({ changed: true, refreshRevoked: 2, accessRevoked: 2 });
    expect(oauthRevokedAt(await selectBearerToken({ db: t.db, token: a1.access_token }))).toEqual(
      at(30),
    );
    expect(
      oauthRevokedAt(await selectBearerToken({ db: t.db, token: b1.access_token })),
    ).toBeNull(); // Bob's stays
    expect(
      await getConsentView({ db: t.db, txnId: pending.txnId, userId: alice, now: at(31) }),
    ).toEqual({ status: 'expired', clientName: 'ChatGPT' });
    expect(
      (
        await oauthError(
          exchangeCode({
            db: t.db,
            client,
            request: { code: unexchanged.code, codeVerifier: unexchanged.verifier },
            // A replica whose clock is BEHIND the one that disconnected still sees the code as expired.
            now: at(29),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    const [audit] = await audits('client_disconnected');
    expect(audit).toMatchObject({
      userId: alice,
      clientId: client.clientId,
      details: {
        client_name: 'ChatGPT',
        redirect_host: 'chatgpt.com',
        refresh_revoked: 2,
        access_revoked: 2,
        requests_expired: 1,
        codes_expired: 1,
      },
    });
    expect(audit!.details).not.toHaveProperty('actor_user_id');
    expect(await listConnectedApps({ db: t.db, userId: alice, now: at(32) })).toEqual([]);
    expect(await listConnectedApps({ db: t.db, userId: bob, now: at(32) })).toHaveLength(1);

    // Idempotent: nothing left to revoke ⇒ no second audit row.
    expect(
      await disconnectClient({ db: t.db, clientId: client.clientId, userId: alice, now: at(40) }),
    ).toEqual({ changed: false, refreshRevoked: 0, accessRevoked: 0 });
    expect(await audits('client_disconnected')).toHaveLength(1);
  });

  it("an admin disconnecting another user's app is recorded as the actor; the audit is atomic", async () => {
    const client = await newClient();
    await connect(client, bob);
    await blockAudit(() =>
      disconnectClient({
        db: t.db,
        clientId: client.clientId,
        userId: bob,
        actorUserId: alice,
        now: at(1),
      }),
    );
    expect(await listConnectedApps({ db: t.db, userId: bob, now: at(2) })).toHaveLength(1); // rolled back
    await disconnectClient({
      db: t.db,
      clientId: client.clientId,
      userId: bob,
      actorUserId: alice,
      now: at(3),
    });
    expect(await audits('client_disconnected')).toMatchObject([
      { userId: bob, details: { actor_user_id: alice } },
    ]);
  });
});

describe('selectBearerToken + touchLastUsed (D-07)', () => {
  it('looks a bearer up by hash joined to its user and client; unknown ⇒ undefined', async () => {
    const client = await newClient();
    const tokens = await connect(client, alice);
    expect(await selectBearerToken({ db: t.db, token: tokens.access_token })).toMatchObject({
      clientId: client.clientId,
      userId: alice,
      resource: RESOURCE,
      scopes: ['watch:read', 'watch:write', 'offline_access'],
      revokedAt: null,
      lastUsedAt: null,
      clientLastUsedAt: null,
    });
    expect(await selectBearerToken({ db: t.db, token: 'nope' })).toBeUndefined();
    expect(await selectBearerToken({ db: t.db, token: tokens.refresh_token! })).toBeUndefined(); // a refresh token is not a bearer
  });

  it('stamps token and client at most once a minute', async () => {
    const client = await newClient();
    const tokens = await connect(client, alice);
    const read = async () => (await selectBearerToken({ db: t.db, token: tokens.access_token }))!;
    const touch = async (s: number) => {
      const r = await read();
      return touchLastUsed({
        db: t.db,
        tokenId: r.id,
        clientId: r.clientId,
        tokenLastUsedAt: r.lastUsedAt,
        clientLastUsedAt: r.clientLastUsedAt,
        now: at(s),
      });
    };
    expect(await touch(10)).toEqual({ token: true, client: true });
    expect(await touch(30)).toEqual({ token: false, client: false });
    expect(await touch(69)).toEqual({ token: false, client: false });
    expect(await touch(70)).toEqual({ token: true, client: true });
    expect((await read()).lastUsedAt).toEqual(at(70));
    // A stale in-memory value cannot double-write: the UPDATE re-checks the stored stamp.
    const r = await read();
    expect(
      await touchLastUsed({
        db: t.db,
        tokenId: r.id,
        clientId: r.clientId,
        tokenLastUsedAt: null,
        clientLastUsedAt: null,
        now: at(80),
      }),
    ).toEqual({ token: false, client: false });
  });
});

describe('pruneExpired (D-03) — bounded, thresholded', () => {
  it('deletes at most 200 rows per table per call; a backlog drains over calls', async () => {
    const client = await newClient();
    // 250 abandoned consent requests (10 minutes each).
    for (let i = 0; i < 250; i++) await pendingRequest(client, alice, { now: T0 });
    const first = await pruneExpired({ db: t.db, now: at(601) });
    expect(first.authorizations).toBe(200);
    expect(await t.db.select().from(oauthAuthorizations)).toHaveLength(50);
    const second = await pruneExpired({ db: t.db, now: at(601) });
    expect(second.authorizations).toBe(50);
    expect(await t.db.select().from(oauthAuthorizations)).toHaveLength(0);
  });

  it('expired transactions and codes go at once; live ones stay', async () => {
    const client = await newClient();
    await pendingRequest(client, alice, { now: T0 });
    await approve(client, alice, { now: T0 }); // an unexchanged code (60 s)
    const live = await pendingRequest(client, alice, { now: at(500) });
    const report = await pruneExpired({ db: t.db, now: at(601) });
    expect(report).toMatchObject({ authorizations: 1, codes: 1 });
    expect((await t.db.select().from(oauthAuthorizations)).map((r) => r.id)).toEqual([live.txnId]);
  });

  it('tokens are kept until 30 days after they expired or were revoked (a late replay is still reuse)', async () => {
    const client = await newClient();
    const tokens = await connect(client, alice, { now: T0 });
    await rotateRefreshToken({
      db: t.db,
      client,
      request: { refreshToken: tokens.refresh_token! },
      now: at(60),
    });
    // Access tokens expire at +1 h: kept at +29 days, gone after +30 days + 1 h.
    expect((await pruneExpired({ db: t.db, now: at(3600 + 29 * DAY) })).accessTokens).toBe(0);
    expect((await pruneExpired({ db: t.db, now: at(3660 + 30 * DAY + 1) })).accessTokens).toBe(2);
    // The spent (rotated) refresh token is still there, so replaying it still revokes the family.
    expect(await t.db.select().from(oauthRefreshTokens)).toHaveLength(2);
    expect(
      (
        await oauthError(
          rotateRefreshToken({
            db: t.db,
            client,
            request: { refreshToken: tokens.refresh_token! },
            now: at(31 * DAY),
          }),
        )
      ).code,
    ).toBe('invalid_grant');
    expect(await audits('family_revoked_on_reuse')).toHaveLength(1);
    // Revoked at +31 days ⇒ deleted after +61 days (the parent link of the newer token is set NULL).
    expect((await pruneExpired({ db: t.db, now: at(60 * DAY) })).refreshTokens).toBe(0);
    expect((await pruneExpired({ db: t.db, now: at(62 * DAY) })).refreshTokens).toBe(2);
  });

  it('dormant DCR clients (older than 30 days, NEVER used, no token or request) are deleted; the audit trail survives them', async () => {
    const dormant = await newClient(CHATGPT, T0);
    const connected = await newClient(CHATGPT, T0);
    const young = await newClient(CHATGPT, at(20 * DAY));
    await connect(connected, alice, { now: at(29 * DAY) });
    const auditBefore = await audits();
    const report = await pruneExpired({ db: t.db, now: at(31 * DAY) });
    expect(report.clients).toBe(1);
    const left = (await t.db.select().from(oauthClients)).map((c) => c.clientId).sort();
    expect(left).toEqual([connected.clientId, young.clientId].sort());
    expect(left).not.toContain(dormant.clientId);
    expect(await audits()).toHaveLength(auditBefore.length); // oauth_audit.client_id has no FK: nothing cascaded
  });

  it('a client that was EVER used survives even with no rows left (ChatGPT reuses its client to reconnect)', async () => {
    const client = await newClient(CHATGPT, T0);
    const tokens = await connect(client, alice, { now: T0 });
    const bearer = (await selectBearerToken({ db: t.db, token: tokens.access_token }))!;
    await touchLastUsed({
      db: t.db,
      tokenId: bearer.id,
      clientId: client.clientId,
      tokenLastUsedAt: null,
      clientLastUsedAt: null,
      now: at(60),
    });
    // Months later: every token, code and request has long been pruned…
    for (let i = 0; i < 3; i++) await pruneExpired({ db: t.db, now: at(200 * DAY) });
    expect(await t.db.select().from(oauthAccessTokens)).toHaveLength(0);
    expect(await t.db.select().from(oauthRefreshTokens)).toHaveLength(0);
    expect(await t.db.select().from(oauthAuthorizationCodes)).toHaveLength(0);
    // …but the client stays, so the connector can re-authorize with it.
    expect((await t.db.select().from(oauthClients)).map((c) => c.clientId)).toEqual([
      client.clientId,
    ]);
    await expect(connect(client, alice, { now: at(200 * DAY) })).resolves.toMatchObject({
      token_type: 'Bearer',
    });
  });

  it('expired oauth: rate-limit buckets go; live ones and Better Auth buckets stay', async () => {
    await consumeRateLimit({
      db: t.db,
      key: 'oauth:register|198.51.100.1',
      windowSeconds: 60,
      max: 10,
      now: T0,
    });
    await consumeRateLimit({
      db: t.db,
      key: 'oauth:token|198.51.100.1',
      windowSeconds: 3600,
      max: 60,
      now: T0,
    });
    await t.db.insert(rateLimit).values({
      key: '198.51.100.1|/sign-in/oauth2',
      count: 1,
      lastRequest: T0.getTime() - 999_999,
    });
    const report = await pruneExpired({ db: t.db, now: at(61) });
    expect(report.rateLimitBuckets).toBe(1);
    expect((await t.db.select().from(rateLimit)).map((r) => r.key).sort()).toEqual([
      '198.51.100.1|/sign-in/oauth2',
      'oauth:token|198.51.100.1',
    ]);
  });
});

describe('consumeRateLimit (D-10) — one shared fixed window across replicas', () => {
  it('allows max per window, then refuses with Retry-After until the window ends', async () => {
    const key = 'oauth:register|203.0.113.1';
    for (let i = 1; i <= 10; i++) {
      expect(
        await consumeRateLimit({ db: t.db, key, windowSeconds: 3600, max: 10, now: at(i) }),
      ).toMatchObject({ allowed: true, count: i });
    }
    const refused = await consumeRateLimit({
      db: t.db,
      key,
      windowSeconds: 3600,
      max: 10,
      now: at(600),
    });
    expect(refused).toEqual({ allowed: false, count: 11, retryAfterSeconds: 3601 - 600 });
    // Other IPs have their own bucket.
    expect(
      (
        await consumeRateLimit({
          db: t.db,
          key: 'oauth:register|203.0.113.2',
          windowSeconds: 3600,
          max: 10,
          now: at(600),
        })
      ).allowed,
    ).toBe(true);
    // The window ends an hour after it opened; the next request opens a fresh one.
    expect(
      await consumeRateLimit({ db: t.db, key, windowSeconds: 3600, max: 10, now: at(3601) }),
    ).toMatchObject({ allowed: true, count: 1 });
  });

  it('concurrent requests count exactly once each (the upsert is atomic)', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        consumeRateLimit({
          db: t.db,
          key: 'oauth:token|203.0.113.3',
          windowSeconds: 60,
          max: 10,
          now: T0,
        }),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.map((r) => r.count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
  });

  it("keeps a live bucket's last_request in the future, so Better Auth's 60 s pruner cannot reset it", async () => {
    await consumeRateLimit({
      db: t.db,
      key: 'oauth:register|203.0.113.4',
      windowSeconds: 3600,
      max: 10,
      now: T0,
    });
    const [row] = await t.db
      .select()
      .from(rateLimit)
      .where(and(eq(rateLimit.key, 'oauth:register|203.0.113.4')));
    expect(row!.lastRequest).toBe(T0.getTime() + 3_600_000);
  });
});

describe('D-06 — the [auth] log over a whole flow never carries a credential', () => {
  it('register → authorize → consent → exchange → refresh → reuse → revoke → deny: no token, code, secret or verifier', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(
      (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
    );
    const secrets: string[] = [];
    const conf = await registerClient({
      db: t.db,
      body: { ...CHATGPT, token_endpoint_auth_method: 'client_secret_post' },
      now: T0,
    });
    secrets.push(conf.client_secret!);
    const client = (await getOAuthClient({ db: t.db, clientId: conf.client_id }))!;
    const a = await approve(client, alice);
    secrets.push(a.code, a.verifier, s256Challenge(a.verifier));
    const first = await exchangeCode({
      db: t.db,
      client,
      request: { code: a.code, codeVerifier: a.verifier },
      now: at(1),
    });
    secrets.push(first.access_token, first.refresh_token!);
    const second = await rotateRefreshToken({
      db: t.db,
      client,
      request: { refreshToken: first.refresh_token! },
      now: at(3),
    });
    secrets.push(second.access_token, second.refresh_token!);
    await revokeToken({ db: t.db, client, token: second.access_token, now: at(4) });
    await oauthError(
      rotateRefreshToken({
        db: t.db,
        client,
        request: { refreshToken: second.refresh_token! },
        now: at(5),
      }),
    );
    await oauthError(
      rotateRefreshToken({
        db: t.db,
        client,
        request: { refreshToken: first.refresh_token! },
        now: at(5),
      }),
    );
    await oauthError(
      exchangeCode({
        db: t.db,
        client,
        request: { code: a.code, codeVerifier: a.verifier },
        now: at(6),
      }),
    );
    const d = await pendingRequest(client, alice);
    secrets.push(d.verifier);
    await denyConsent({ db: t.db, txnId: d.txnId, userId: alice, now: at(6) });

    const events = lines.map((l) => /^\[auth\] ([a-z_]+) \{.*\}$/.exec(l)?.[1]);
    expect(events).not.toContain(undefined);
    for (const e of [
      'client_registered',
      'authorize_started',
      'consent_granted',
      'token_issued',
      'code_replayed',
      'token_refreshed',
      'refresh_reuse_detected',
      'refresh_rejected',
      'token_revoked',
      'consent_denied',
    ]) {
      expect(events, e).toContain(e);
    }
    const all = lines.join('\n');
    for (const s of secrets) expect(all).not.toContain(s);
    expect(all).not.toMatch(/[A-Za-z0-9_-]{43}/);
    // And nothing credential-shaped is at rest either: every stored value is a 64-hex digest.
    const stored = JSON.stringify([
      await t.db.select().from(oauthAccessTokens),
      await t.db.select().from(oauthRefreshTokens),
      await t.db.select().from(oauthAuthorizationCodes),
      await t.db.select().from(oauthClients),
      await t.db.select().from(oauthAudit),
    ]);
    for (const s of secrets.filter(
      (x) => x !== s256Challenge(a.verifier) && !x.startsWith('verifier-'),
    )) {
      expect(stored).not.toContain(s);
    }
  });
});
