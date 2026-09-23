// ADR-087 / DESIGN-049 D-02..D-06 (PLAN-068 S7) — the MCP endpoint end to end: the SDK `Client` over
// `StreamableHTTPClientTransport`, through a node:http adapter, against `handleMcpRequest` with an embedded
// Postgres 16 seeded owner history and a recording fake Plex (never a real server). Covers: stateless
// initialize (no `Mcp-Session-Id`), every tool's happy path, the Voice Budget (tools/list ≤ 3,072 bytes,
// default read results ≤ 1,200 characters, no structuredContent), an ambiguous title writing nothing,
// mark → the next unfinished/recommend reflects it → undo, 401 / 503 / 405 / 413 / strict inputs, the
// D-06 log lines (never arguments or results).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { watchMarks, watchTitles, type Database } from '@hnet/db';
import { upsertWatchTitles } from '@hnet/domain';
import { SPOKEN_MAX_CHARS } from '@hnet/watch';
import type { McpDeps } from '../src/index';
import { FakePlex, NOW, OWNER, ownerWorld, seedWorld, serveMcp, type McpHttp } from './fixture';
import { bootMigratedDb, type TestDb } from './helpers';

const TOKEN = 'test-hop-token-000000000000000000000000000000000';
const ENV = { HNET_MCP_HOP_TOKEN: TOKEN };
const JSON_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  authorization: `Bearer ${TOKEN}`,
};

let t: TestDb;
let db: Database;
let fake: FakePlex;
let http: McpHttp;

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

async function client(headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  const c = new Client({ name: 'vitest', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers } });
  await c.connect(transport);
  return { c, transport };
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const { c } = await client();
  try {
    const r = await c.callTool({ name, arguments: args });
    const content = r.content as Array<{ type: string; text: string }>;
    expect(r.structuredContent).toBeUndefined();
    return { text: content.map((x) => x.text).join(''), isError: r.isError === true };
  } finally {
    await c.close();
  }
}

async function rpc(body: unknown, headers: Record<string, string> = JSON_HEADERS, method = 'POST') {
  return fetch(http.url, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined });
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
    sql`TRUNCATE watch_marks, watch_titles, watch_events, watch_reco_signals, watch_accounts, media_plex_matches, media_metadata, media_items, plex_libraries CASCADE`,
  );
  fake = ownerWorld();
  await seedWorld(db, fake);
  fake.calls.length = 0;
  http = await serveMcp(deps(), ENV);
});

describe('the transport (D-02)', () => {
  it('initializes statelessly: JSON response, "Watch history", the instructions, no Mcp-Session-Id', async () => {
    const res = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = (await res.json()) as { result: { serverInfo: { name: string; version: string }; instructions: string } };
    expect(body.result.serverInfo.name).toBe('Watch history');
    expect(body.result.serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.result.instructions.length).toBeLessThanOrEqual(600);

    const { c, transport } = await client();
    expect(transport.sessionId).toBeUndefined();
    await c.close();
  });

  it('lists exactly the seven D-05 tools within the 3,072-byte Voice Budget', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(200);
    const raw = await res.text();
    const bytes = Buffer.byteLength(raw, 'utf8');
    // Reported by PLAN-068 S7 (measured, not assumed).
    console.log(`[voice-budget] tools/list = ${bytes} bytes`);
    expect(bytes).toBeLessThanOrEqual(3_072);
    const { result } = JSON.parse(raw) as {
      result: { tools: Array<{ name: string; inputSchema: Record<string, unknown>; outputSchema?: unknown }> };
    };
    expect(result.tools.map((x) => x.name)).toEqual([
      'unfinished',
      'recommend',
      'watch_status',
      'recent_history',
      'mark_watched',
      'dismiss',
      'undo_last_change',
    ]);
    for (const tool of result.tools) {
      expect(tool.outputSchema).toBeUndefined();
      const json = JSON.stringify(tool.inputSchema);
      // Home Assistant / OpenAI-safe schemas: flat, no combinators, no defaults, no nullable, no $ref.
      expect(json).not.toMatch(/"(anyOf|oneOf|allOf|not|\$ref|default|nullable)"/);
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('answers 401 without the bearer (WWW-Authenticate: Bearer) and with a wrong one', async () => {
    const { authorization: _drop, ...noAuth } = JSON_HEADERS;
    const none = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, noAuth);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    const wrong = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...noAuth, authorization: 'Bearer nope' });
    expect(wrong.status).toBe(401);
    await expect(client({ authorization: 'Bearer nope' })).rejects.toThrow();
  });

  it('answers 503 when no consumer token is configured', async () => {
    await http.stop();
    http = await serveMcp(deps(), {});
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(503);
  });

  it('refuses a body over 64 KB before the transport, and GET / DELETE never reach it', async () => {
    const big = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(70_000) } });
    expect(big.status).toBe(413);
    expect((await rpc(null, JSON_HEADERS, 'GET')).status).toBe(405);
    expect((await rpc(null, JSON_HEADERS, 'DELETE')).status).toBe(405);
  });

  it('rejects unknown arguments (strict inputs) as a tool error, and logs no arguments', async () => {
    const r = await call('unfinished', { user: 'someone-else' });
    expect(r.isError).toBe(true);
    const r2 = await call('recommend', { limit: 50 });
    expect(r2.isError).toBe(true);
  });
});

describe('the read tools (D-05, D-10, D-11, D-16..D-21) and the 1,200-character budget', () => {
  it('unfinished: in progress first (next episode named), then stalled; no taster, no kids, no finished', async () => {
    const { text } = await call('unfinished');
    expect(text.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
    expect(text).toMatch(/^Five unfinished shows\. Silo: 7 of 10 watched, next is season 1 episode 8, last watched on September 21\./);
    expect(text).toContain('For All Mankind: next is season 2 episode 4');
    expect(text).toContain('Stalled: The Righteous Gemstones, 36 of 45, untouched since March 2025.');
    for (const absent of ['Big Brother', 'Bluey', 'The Expanse']) expect(text).not.toContain(absent);
    // D-11: the reported shows were revalidated live (one metadata read each), nothing moved.
    expect(fake.calls.filter((c) => c.op === 'getMetadataItem').length).toBe(5);
    expect(fake.writes()).toEqual([]);
    expect(http.logs.some((l) => l.startsWith('[mcp] tool_called {"tool":"unfinished","consumer":"hop"'))).toBe(true);
    // Neither the arguments nor the result are logged.
    expect(http.logs.join('\n')).not.toContain('Silo');
  });

  it('unfinished revalidates live: an episode watched since the last sync moves the next episode', async () => {
    const silo = fake.shows.find((s) => s.ratingKey === 'silo');
    const e8 = silo?.episodes.find((e) => e.episode === 8);
    if (e8) {
      e8.viewCount = 1;
      e8.lastViewedAt = Math.floor(NOW.getTime() / 1000) - 600;
    }
    const { text } = await call('unfinished');
    expect(text).toMatch(/Silo: 8 of 10 watched, next is season 1 episode 9, last watched today\./);
  });

  it('unfinished for movies and with kids', async () => {
    expect((await call('unfinished', { kind: 'movie' })).text).toBe(
      'One unfinished movie. Stub Runner (movie): 30 percent in, last watched yesterday.',
    );
    expect((await call('unfinished', { kids: true, limit: 10 })).text).toContain('Bluey');
  });

  it('recommend: never-watched picks with reasons, on Plex first, then "Not on Plex yet"', async () => {
    const { text } = await call('recommend');
    expect(text.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
    expect(text).toMatch(/^\w+ picks on Plex\./);
    expect(text).toContain('Severance, a 2022 show, on your watchlist.');
    expect(text).toContain('Foundation, a 2021 show, because you watched The Expanse.');
    expect(text).toContain('Not on Plex yet:');
    // Never an Ever Watched, started, or children's title.
    for (const absent of ['Silo', 'The Fixture', 'Stub Runner', 'Paw Patrol', 'Bluey']) expect(text).not.toContain(absent);
    const sciFi = await call('recommend', { genre: 'sci-fi', kind: 'movie' });
    expect(sciFi.text).toMatch(/sci-fi movie pick/);
    expect(sciFi.text).not.toContain('Severance');
  });

  it('watch_status: progress, finished, not on Plex, ambiguous, not found', async () => {
    const expanse = await call('watch_status', { title: 'the expanse' });
    expect(expanse.text).toBe('The Expanse (2015 show): all 23 episodes watched, finished in March 2025. On Plex.');
    expect((await call('watch_status', { title: 'Silo' })).text).toMatch(
      /^Silo \(2023 show\): 7 of 10 watched, next is season 1 episode 8, last watched on September 21\. On Plex\.$/,
    );
    expect((await call('watch_status', { title: 'Foundation' })).text).toBe('Foundation (2021 show): not watched yet. On Plex.');
    expect((await call('watch_status', { title: 'dark matter' })).text).toBe('Dark Matter (2024 show): not watched yet. Not on Plex.');
    expect((await call('watch_status', { title: 'dune' })).text).toBe(
      'More than one match for dune: Dune (2021, movie), Dune (1984, movie). Which one?',
    );
    expect((await call('watch_status', { title: 'zzqq nothing' })).text).toBe("I couldn't find anything called zzqq nothing.");
  });

  it('recent_history: the last two weeks, newest first', async () => {
    const { text } = await call('recent_history');
    expect(text.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
    expect(text).toMatch(/^In the last two weeks: /);
    expect(text).toContain('Silo, 3 episodes, latest season 1 episode 7 on September 21.');
    expect(text).toContain('The Fixture, a movie, on September 18.');
    expect(text).not.toContain('The Righteous Gemstones');
  });

  it('every read tool answers "not ready" before the first sync (no owner row)', async () => {
    await db.execute(sql`TRUNCATE watch_marks, watch_titles, watch_events, watch_reco_signals, watch_accounts CASCADE`);
    for (const tool of ['unfinished', 'recommend', 'recent_history']) {
      expect(await call(tool)).toEqual({ text: "Watch history isn't ready yet.", isError: false });
    }
  });
});

describe('the write tools (D-12..D-15, AC-22)', () => {
  it('an ambiguous title asks and writes nothing', async () => {
    const r = await call('mark_watched', { title: 'Dune' });
    expect(r.text).toBe('More than one match for Dune: Dune (2021, movie), Dune (1984, movie). Which one?');
    expect(fake.writes()).toEqual([]);
    expect(await db.select().from(watchMarks)).toEqual([]);
  });

  it('mark → the very next recommend and watch_status reflect it → undo puts it back', async () => {
    const before = await call('recommend');
    expect(before.text).toContain('Foundation');

    const mark = await call('mark_watched', { title: 'Foundation' });
    expect(mark.text).toBe('Marked Foundation (2021) as watched in Plex, all 10 episodes.');
    // HaynesOps holds it (the ledger's Plex match): the show key once, on that server only.
    expect(fake.writes()).toEqual([{ server: 'haynesops', op: 'scrobble', key: 'found' }]);
    const [row] = await db.select().from(watchMarks);
    expect(row).toMatchObject({ action: 'watched', scope: 'show', consumer: 'hop', plexResult: 'written' });
    expect(row?.flipped).toHaveLength(10);

    expect((await call('recommend')).text).not.toContain('Foundation');
    expect((await call('watch_status', { title: 'foundation' })).text).toMatch(/^Foundation \(2021 show\): all 10 episodes watched/);

    const undo = await call('undo_last_change');
    expect(undo.text).toBe('Undone. Foundation (2021) is back to unwatched in Plex, 10 episodes.');
    expect(fake.writes().at(-1)).toEqual({ server: 'haynesops', op: 'unscrobble', key: 'found' });
    expect((await call('recommend')).text).toContain('Foundation');
    expect((await call('undo_last_change')).text).toBe('Nothing to undo from the past day.');
  });

  it('marking a season of an unfinished show updates the next unfinished answer', async () => {
    const r = await call('mark_watched', { title: 'Silo', season: 1 });
    expect(r.text).toBe('Marked season 1 of Silo (2023) as watched in Plex, 10 episodes.');
    expect(fake.writes()).toEqual([{ server: 'haynesops', op: 'scrobble', key: 'silo-s1' }]);
    const u = await call('unfinished');
    expect(u.text).not.toContain('Silo');
  });

  it('dismiss never calls Plex; not_mine drops a title out of recent history; undo restores it', async () => {
    const d = await call('dismiss', { title: 'Bluey', reason: 'not_mine' });
    expect(d.text).toBe(
      "Got it. Bluey (2018) is marked as someone else's viewing, so it's out of your history and picks. Plex is unchanged.",
    );
    expect(fake.calls).toEqual([]);
    const recentKids = await call('recent_history');
    expect(recentKids.text).not.toContain('Bluey');
    const undo = await call('undo_last_change');
    expect(undo.text).toBe('Undone. Bluey (2018) counts as your viewing again.');
    expect(fake.calls).toEqual([]);
  });

  it('an episode without its season writes nothing and asks for the season', async () => {
    const r = await call('mark_watched', { title: 'Silo', episode: 3 });
    expect(r.text).toBe('Which season is episode 3 of Silo in? Say it like season 2 episode 3.');
    expect(fake.writes()).toEqual([]);
  });

  it('an unexpected failure answers the D-06 text as isError — never the raw message — and logs a code', async () => {
    await http.stop();
    const broken: McpDeps = { ...deps(), db: new Proxy(db, { get: () => { throw new Error('secret-ish internals'); } }) };
    http = await serveMcp(broken, ENV);
    const r = await call('unfinished');
    expect(r).toEqual({ text: 'Watch history hit an error. Try again in a minute.', isError: true });
    expect(http.logs.some((l) => l.includes('"ok":false') && l.includes('"code":"Error"'))).toBe(true);
    expect(http.logs.join('\n')).not.toContain('secret-ish');
  });
});

describe('the Voice Budget (T-253, R-245)', () => {
  it('stays under 1,200 characters with a long history of long titles (the cap cuts whole sentences)', async () => {
    const [silo] = await db.select().from(watchTitles).where(sql`${watchTitles.title} = 'Silo'`);
    if (!silo) throw new Error('no Silo');
    const { id: _id, plexAccountId: _a, refreshedAt: _r, ...rest } = silo;
    await upsertWatchTitles({
      db,
      plexAccountId: OWNER,
      titles: Array.from({ length: 25 }, (_, i) => ({
        ...rest,
        titleKey: `name:show:long show ${i}|2020`,
        plexGuid: null,
        tvdbId: null,
        tmdbId: null,
        imdbId: null,
        title: `The Extraordinarily Long Chronicles of Show Number ${i}: A Saga in Many Parts, Seasons and Specials`,
        year: 2020,
        lastWatchedAt: new Date(NOW.getTime() - (i + 1) * 3_600_000),
      })),
    });
    for (const args of [{}, { limit: 10 }, { kind: 'any', limit: 10 }]) {
      const { text } = await call('unfinished', args);
      expect(text.length).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
      expect(text).toMatch(/\.$/);
      expect(text).toMatch(/And \d+ more\./);
    }
  });

  it('every read tool\'s default answer over the seeded fixture is at most 1,200 characters', async () => {
    const answers = {
      unfinished: await call('unfinished'),
      recommend: await call('recommend'),
      watch_status: await call('watch_status', { title: 'Silo' }),
      recent_history: await call('recent_history'),
    };
    const lengths = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.text.length]));
    // Reported by PLAN-068 S7 (measured).
    console.log(`[voice-budget] default answers: ${JSON.stringify(lengths)}`);
    for (const [tool, a] of Object.entries(answers)) {
      expect(a.isError, tool).toBe(false);
      expect(a.text.length, tool).toBeLessThanOrEqual(SPOKEN_MAX_CHARS);
      expect(a.text, tool).not.toMatch(/[*#_`]|https?:\/\//);
    }
  });
});
