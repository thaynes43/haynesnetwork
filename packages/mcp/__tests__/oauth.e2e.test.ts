// ADR-091 / DESIGN-050 D-07 (PLAN-069 S4) — the public MCP path end to end: `authenticateOAuth` against embedded
// Postgres 16 with REAL delegated tokens (registered, consented and exchanged through the @hnet/domain writers),
// then the SDK `Client` over `StreamableHTTPClientTransport` through `handleMcpRequest` with the OAuth consumer
// source — the same fixture (a recording fake Plex, never a real server) the hop suite uses. Covers: valid /
// expired / revoked / wrong-resource / malformed bearers and the exact 401 challenge; no owner check (any user's
// token authenticates); scopes ∩ watch scopes and the 403 `insufficient_scope`; the once-a-minute stamp; the
// user-aware principal (the owner's mapped account, "isn't set up" for an unmapped or untracked user, a tracked
// household account answering from ITS history and writing Plex never); the Voice Budget and the D-06 log lines
// unchanged on this path; and the two paths kept apart (the hop token is useless at /mcp, an OAuth token is
// useless at /api/mcp).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { oauthAccessTokens, oauthClients, watchMarks, type Database } from '@hnet/db';
import {
  exchangeCode,
  getOAuthClient,
  grantConsent,
  registerClient,
  revokeToken,
  startAuthorization,
  upsertUserAccountHandles,
  upsertWatchOwner,
} from '@hnet/domain';
import {
  randomToken,
  s256Challenge,
  validateAuthorizationParams,
  type OAuthEnv,
  type TokenResponse,
} from '@hnet/oauth';
import { authenticateOAuth, type McpDeps } from '../src/index';
import { insertHouseholdWatchAccount } from '../../domain/__tests__/watch-household';
import { FakePlex, NOW, OWNER, ownerWorld, seedWorld, serveMcp, type McpHttp } from './fixture';
import { bootMigratedDb, createUser, type TestDb } from './helpers';

const ENV: OAuthEnv = { BETTER_AUTH_URL: 'https://haynesnetwork.com' };
const CHALLENGE =
  'Bearer resource_metadata="https://haynesnetwork.com/.well-known/oauth-protected-resource"';
const SCOPE_CHALLENGE =
  'Bearer error="insufficient_scope", resource_metadata="https://haynesnetwork.com/.well-known/oauth-protected-resource"';
const HOP_TOKEN = 'test-hop-token-000000000000000000000000000000000';
const HOUSE = 55501;
const NOT_SET_UP = "Watch history isn't set up for your account yet.";
const REDIRECT = 'https://chatgpt.com/connector/oauth/e2e';

let t: TestDb;
let db: Database;
let fake: FakePlex;
let http: McpHttp;
let ownerUser: string;
let kidUser: string;
let strangerUser: string;

function deps(): McpDeps {
  return {
    db,
    revalidatePlex: () => fake.clients(),
    markPlex: () => fake.clients(),
    tmdb: () => null,
    now: () => NOW,
    log: () => {},
  };
}

/** A real delegated token for `userId`: DCR → authorize → consent → code exchange, all through the writers. */
async function connect(
  userId: string,
  opts: { scope?: string; env?: OAuthEnv } = {},
): Promise<{ clientId: string; tokens: TokenResponse }> {
  const reg = await registerClient({
    db,
    body: { client_name: 'ChatGPT', redirect_uris: [REDIRECT] },
    now: NOW,
  });
  const client = (await getOAuthClient({ db, clientId: reg.client_id }))!;
  const verifier = randomToken();
  const validated = validateAuthorizationParams(
    {
      responseType: 'code',
      state: 'e2e',
      codeChallenge: s256Challenge(verifier),
      codeChallengeMethod: 'S256',
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    },
    { env: opts.env ?? ENV },
  );
  const { txnId } = await startAuthorization({
    db,
    client,
    userId,
    redirectUri: REDIRECT,
    validated,
    now: NOW,
  });
  const granted = await grantConsent({ db, txnId, userId, now: NOW });
  if (granted.status !== 'redirect') throw new Error(granted.status);
  const code = new URL(granted.redirectUrl).searchParams.get('code')!;
  const tokens = await exchangeCode({
    db,
    client,
    request: { code, codeVerifier: verifier },
    now: NOW,
  });
  return { clientId: reg.client_id, tokens };
}

const bearer = (token: string) =>
  new Request('http://0.0.0.0:3000/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
const at = (ms: number) => () => new Date(NOW.getTime() + ms);

async function serveOAuth(): Promise<McpHttp> {
  return serveMcp(
    deps(),
    { HNET_MCP_HOP_TOKEN: HOP_TOKEN },
    {
      path: '/mcp',
      authenticate: (req) => authenticateOAuth(req, { db, now: () => NOW, env: ENV }),
    },
  );
}

async function client(token: string) {
  const c = new Client({ name: 'vitest', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(http.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await c.connect(transport);
  return c;
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const c = await client(token);
  try {
    const r = await c.callTool({ name, arguments: args });
    const content = r.content as Array<{ type: string; text: string }>;
    expect(r.structuredContent).toBeUndefined();
    return { text: content.map((x) => x.text).join(''), isError: r.isError === true };
  } finally {
    await c.close();
  }
}

function rpc(body: unknown, headers: Record<string, string>, url = http.url, method = 'POST') {
  return fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
}

beforeAll(async () => {
  t = await bootMigratedDb();
  db = t.db;
});

afterAll(async () => {
  await http?.stop();
  await t.stop();
});

beforeEach(async () => {
  await http?.stop();
  await db.execute(
    sql`TRUNCATE oauth_audit, oauth_access_tokens, oauth_refresh_tokens, oauth_authorization_codes, oauth_authorizations, oauth_clients, user_account_map, watch_marks, watch_titles, watch_events, watch_reco_signals, watch_accounts, media_plex_matches, media_metadata, media_items, plex_libraries CASCADE`,
  );
  fake = ownerWorld();
  await seedWorld(db, fake);
  fake.calls.length = 0;
  ownerUser = (await createUser(db, { email: `owner-${Math.random()}@example.test` })).id;
  kidUser = (await createUser(db, { email: `kid-${Math.random()}@example.test` })).id;
  strangerUser = (await createUser(db, { email: `stranger-${Math.random()}@example.test` })).id;
  // ADR-053 Plex Account Map: the owner's app user → the owner's plex.tv id; the kid → a household account.
  await upsertUserAccountHandles({ db, userId: ownerUser, plexUserId: String(OWNER) });
  await upsertUserAccountHandles({ db, userId: kidUser, plexUserId: String(HOUSE) });
  await insertHouseholdWatchAccount(db, { plexAccountId: HOUSE, username: 'kid' });
  http = await serveOAuth();
});

describe('authenticateOAuth (D-07) — a hash lookup, refused when unknown, revoked, expired or bound elsewhere', () => {
  it('a valid token yields oauth:<client_id>, its watch scopes and its user — for ANY user (no owner check)', async () => {
    for (const userId of [ownerUser, strangerUser]) {
      const { clientId, tokens } = await connect(userId);
      const r = await authenticateOAuth(bearer(tokens.access_token), {
        db,
        now: at(1000),
        env: ENV,
      });
      if (!r.ok) throw new Error('expected ok');
      expect(r.consumer).toEqual({
        name: `oauth:${clientId}`,
        scopes: ['watch:read', 'watch:write'],
        userId,
      });
      expect(r.insufficientScope).toBeTypeOf('function');
    }
  });

  it('no bearer, a malformed or unknown one ⇒ 401 with the resource_metadata challenge', async () => {
    const requests = [
      new Request('http://x/mcp', { method: 'POST' }),
      new Request('http://x/mcp', { method: 'POST', headers: { authorization: 'Basic abc' } }),
      bearer('never-issued'),
      bearer(HOP_TOKEN),
    ];
    for (const req of requests) {
      const r = await authenticateOAuth(req, { db, now: at(0), env: ENV });
      if (r.ok) throw new Error('expected a refusal');
      expect(r.response.status).toBe(401);
      expect(r.response.headers.get('www-authenticate')).toBe(CHALLENGE);
      expect(await r.response.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
      });
    }
  });

  it('an expired token (1 h) and a revoked one are refused', async () => {
    const { tokens, clientId } = await connect(ownerUser);
    expect(
      (await authenticateOAuth(bearer(tokens.access_token), { db, now: at(3_599_000), env: ENV }))
        .ok,
    ).toBe(true);
    expect(
      (await authenticateOAuth(bearer(tokens.access_token), { db, now: at(3_600_000), env: ENV }))
        .ok,
    ).toBe(false);
    const client = (await getOAuthClient({ db, clientId }))!;
    await revokeToken({
      db,
      client,
      token: tokens.refresh_token!,
      now: new Date(NOW.getTime() + 1000),
    });
    const revoked = await authenticateOAuth(bearer(tokens.access_token), {
      db,
      now: at(2000),
      env: ENV,
    });
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.response.headers.get('www-authenticate')).toBe(CHALLENGE);
  });

  it('a token bound to another resource (the issuer changed) is refused, logged audience_mismatch', async () => {
    const { tokens } = await connect(ownerUser, {
      env: { BETTER_AUTH_URL: 'https://staging.haynesnetwork.com' },
    });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((l: string) => void logs.push(l));
    const r = await authenticateOAuth(bearer(tokens.access_token), { db, now: at(0), env: ENV });
    spy.mockRestore();
    expect(r.ok).toBe(false);
    expect(logs.some((l) => l.startsWith('[auth] audience_mismatch {"phase":"mcp"'))).toBe(true);
  });

  it('scopes are the token scopes ∩ the watch scopes', async () => {
    const read = await connect(ownerUser, { scope: 'watch:read' });
    const offline = await connect(ownerUser, { scope: 'offline_access' });
    const r1 = await authenticateOAuth(bearer(read.tokens.access_token), {
      db,
      now: at(0),
      env: ENV,
    });
    const r2 = await authenticateOAuth(bearer(offline.tokens.access_token), {
      db,
      now: at(0),
      env: ENV,
    });
    expect(r1.ok && r1.consumer.scopes).toEqual(['watch:read']);
    expect(r2.ok && r2.consumer.scopes).toEqual([]);
  });

  it('stamps last_used_at on the token and the client at most once a minute', async () => {
    const { tokens, clientId } = await connect(ownerUser);
    const stamps = async () => {
      const [a] = await db.select({ at: oauthAccessTokens.lastUsedAt }).from(oauthAccessTokens);
      const [c] = await db
        .select({ at: oauthClients.lastUsedAt })
        .from(oauthClients)
        .where(sql`${oauthClients.clientId} = ${clientId}`);
      return [a!.at?.getTime() ?? null, c!.at?.getTime() ?? null];
    };
    await authenticateOAuth(bearer(tokens.access_token), { db, now: at(1000), env: ENV });
    expect(await stamps()).toEqual([NOW.getTime() + 1000, NOW.getTime() + 1000]);
    await authenticateOAuth(bearer(tokens.access_token), { db, now: at(30_000), env: ENV });
    expect(await stamps()).toEqual([NOW.getTime() + 1000, NOW.getTime() + 1000]);
    await authenticateOAuth(bearer(tokens.access_token), { db, now: at(61_000), env: ENV });
    expect(await stamps()).toEqual([NOW.getTime() + 61_000, NOW.getTime() + 61_000]);
  });
});

describe('the public /mcp over HTTP (D-07) — the SDK client through handleMcpRequest + authenticateOAuth', () => {
  it('the owner connector gets the same seven tools in the same 2,712-byte list (Voice Budget unchanged)', async () => {
    const { tokens } = await connect(ownerUser);
    const res = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { authorization: `Bearer ${tokens.access_token}` },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull(); // no CORS on /mcp (D-02)
    const raw = await res.text();
    const bytes = Buffer.byteLength(raw, 'utf8');
    console.log(`[voice-budget] oauth tools/list = ${bytes} bytes`);
    expect(bytes).toBe(2_712);
    expect(
      (JSON.parse(raw) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
        (x) => x.name,
      ),
    ).toEqual([
      'unfinished',
      'recommend',
      'watch_status',
      'recent_history',
      'mark_watched',
      'dismiss',
      'undo_last_change',
    ]);
  });

  it("the owner's connector answers exactly what the hop answers, and logs one D-06 line per call as oauth:<client_id>", async () => {
    const { tokens, clientId } = await connect(ownerUser);
    const hop = await serveMcp(deps(), { HNET_MCP_HOP_TOKEN: HOP_TOKEN });
    try {
      for (const [tool, args] of [
        ['unfinished', {}],
        ['recommend', { limit: 3 }],
        ['watch_status', { title: 'Silo' }],
        ['recent_history', {}],
      ] as const) {
        const viaOAuth = await call(tokens.access_token, tool, args);
        const c = new Client({ name: 'vitest', version: '1.0.0' });
        await c.connect(
          new StreamableHTTPClientTransport(new URL(hop.url), {
            requestInit: { headers: { authorization: `Bearer ${HOP_TOKEN}` } },
          }),
        );
        const viaHop = await c.callTool({ name: tool, arguments: args });
        await c.close();
        expect(viaOAuth.text, tool).toBe(
          (viaHop.content as Array<{ text: string }>).map((x) => x.text).join(''),
        );
        expect(viaOAuth.isError).toBe(false);
        expect(viaOAuth.text.length).toBeLessThanOrEqual(1_200);
      }
    } finally {
      await hop.stop();
    }
    const lines = http.logs.filter((l) => l.startsWith('[mcp] tool_called '));
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line).toMatch(
        new RegExp(
          `^\\[mcp\\] tool_called \\{"tool":"[a-z_]+","consumer":"oauth:${clientId}","ms":\\d+,"ok":true,"chars":\\d+\\}$`,
        ),
      );
    }
    expect(http.logs.join('\n')).not.toContain('Silo'); // arguments and results are never logged
    expect(http.logs.join('\n')).not.toContain(tokens.access_token);
  });

  it("the owner's connector writes Plex as the owner; the mark records consumer oauth:<client_id> and the token's user", async () => {
    const { tokens, clientId } = await connect(ownerUser);
    const r = await call(tokens.access_token, 'mark_watched', { title: 'Silo', season: 1 });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Marked season 1 of Silo \(2023\) as watched in Plex/);
    expect(fake.writes().length).toBeGreaterThan(0);
    const [mark] = await db.select().from(watchMarks);
    expect(mark).toMatchObject({
      plexAccountId: OWNER,
      consumer: `oauth:${clientId}`,
      actorUserId: ownerUser,
      plexResult: 'written',
    });
  });

  it('a read-only token lists only the read tools; calling a write tool is HTTP 403 insufficient_scope', async () => {
    const { tokens } = await connect(ownerUser, { scope: 'watch:read offline_access' });
    const c = await client(tokens.access_token);
    expect((await c.listTools()).tools.map((x) => x.name)).toEqual([
      'unfinished',
      'recommend',
      'watch_status',
      'recent_history',
    ]);
    await c.close();
    const res = await rpc(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'mark_watched', arguments: { title: 'Silo' } },
      },
      { authorization: `Bearer ${tokens.access_token}` },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toBe(SCOPE_CHALLENGE);
    expect(await res.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Insufficient scope' },
      id: null,
    });
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(watchMarks)).toEqual([]);
    // A read tool still answers.
    expect((await call(tokens.access_token, 'recent_history')).isError).toBe(false);
  });

  it('an UNMAPPED user, one mapped to a junk or unknown id, or one whose account is not tracked: every tool answers "isn\'t set up", ok:true', async () => {
    const stranger = await connect(strangerUser);
    const junkUser = (await createUser(db, { email: `junk-${Math.random()}@example.test` })).id;
    await upsertUserAccountHandles({ db, userId: junkUser, plexUserId: 'not-a-number' });
    const junk = await connect(junkUser);
    const ghostUser = (await createUser(db, { email: `ghost-${Math.random()}@example.test` })).id;
    await upsertUserAccountHandles({ db, userId: ghostUser, plexUserId: '424242' }); // no watch_accounts row
    const ghost = await connect(ghostUser);
    // The owner, demoted by an owner change, is no longer tracked.
    const { tokens: ownerTokens } = await connect(ownerUser);
    await upsertWatchOwner({ db, account: { id: '999999', username: 'new-owner', email: null } });
    for (const token of [
      stranger.tokens.access_token,
      junk.tokens.access_token,
      ghost.tokens.access_token,
      ownerTokens.access_token,
    ]) {
      http.logs.length = 0;
      for (const [tool, args] of [
        ['unfinished', {}],
        ['recommend', {}],
        ['watch_status', { title: 'Silo' }],
        ['recent_history', {}],
        ['mark_watched', { title: 'Silo' }],
        ['dismiss', { title: 'Silo' }],
        ['undo_last_change', {}],
      ] as const) {
        const r = await call(token, tool, args);
        expect(r, tool).toEqual({ text: NOT_SET_UP, isError: false });
      }
      const lines = http.logs.filter((l) => l.startsWith('[mcp] tool_called '));
      expect(lines).toHaveLength(7);
      for (const l of lines) expect(l).toContain('"ok":true');
    }
    expect(fake.calls).toEqual([]);
    expect(await db.select().from(watchMarks)).toEqual([]);
  });

  it('a tracked household account answers from ITS OWN history and never writes Plex (history-only marks)', async () => {
    const { tokens, clientId } = await connect(kidUser);
    // The owner's plays are not the kid's.
    const recent = await call(tokens.access_token, 'recent_history');
    expect(recent.isError).toBe(false);
    expect(recent.text).not.toContain('Silo');
    const mark = await call(tokens.access_token, 'mark_watched', { title: 'Arrival' });
    expect(mark).toEqual({
      text: "Noted Arrival (2016) as watched in your history. Only the server owner's marks change Plex.",
      isError: false,
    });
    const undo = await call(tokens.access_token, 'undo_last_change');
    expect(undo.text).toBe('Undone. Arrival (2016) is no longer marked as watched.');
    expect(fake.calls).toEqual([]); // not a read, not a write, not an unscrobble
    const [row] = await db.select().from(watchMarks);
    expect(row).toMatchObject({
      plexAccountId: HOUSE,
      consumer: `oauth:${clientId}`,
      actorUserId: kidUser,
      plexResult: 'none',
      flipped: [],
    });
  });

  it('401 without a bearer (with the challenge); GET / DELETE never reach the transport', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, {});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe(CHALLENGE);
    expect((await rpc(null, {}, http.url, 'GET')).status).toBe(405);
    expect((await rpc(null, {}, http.url, 'DELETE')).status).toBe(405);
  });

  it('the shared request rules hold on this path too: 413 over 64 KB, batches refused', async () => {
    const { tokens } = await connect(ownerUser);
    const auth = { authorization: `Bearer ${tokens.access_token}` };
    expect(
      (
        await rpc(
          { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(70_000) } },
          auth,
        )
      ).status,
    ).toBe(413);
    expect((await rpc([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }], auth)).status).toBe(400);
  });

  it('the two paths stay apart: the hop token is 401 at /mcp, an OAuth token is 401 at /api/mcp', async () => {
    const atMcp = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { authorization: `Bearer ${HOP_TOKEN}` },
    );
    expect(atMcp.status).toBe(401);
    expect(atMcp.headers.get('www-authenticate')).toBe(CHALLENGE);
    const { tokens } = await connect(ownerUser);
    const hop = await serveMcp(deps(), { HNET_MCP_HOP_TOKEN: HOP_TOKEN });
    try {
      const atHop = await rpc(
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { authorization: `Bearer ${tokens.access_token}` },
        hop.url,
      );
      expect(atHop.status).toBe(401);
      expect(atHop.headers.get('www-authenticate')).toBe('Bearer'); // the hop's own challenge, unchanged
    } finally {
      await hop.stop();
    }
  });
});
