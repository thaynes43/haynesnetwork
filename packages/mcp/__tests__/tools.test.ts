// ADR-087 / DESIGN-049 D-02 / D-03 / D-05 (PLAN-068 S7; DESIGN-051 D-01, PLAN-071) — the tool contract without a
// database: the exact D-05 names and descriptions, the D-02 instructions, the hand-written `tools/list` schemas pinned to the zod
// schemas that validate every call, the static list, consumer auth (401 / 503 / constant-time match),
// scopes as configuration (a read-only consumer sees and runs only the read tools), and the D-02 deadline's
// two halves: the runner logs an aborted call once, and the late answer's shape.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WatchNotReadyError } from '@hnet/domain';
import { authenticate, type HopConsumer } from '../src/auth';
import { deadlineResponse } from '../src/http';
import { buildServer, runTool, toolList } from '../src/server';
import {
  checkTitlesInput,
  INSTRUCTIONS,
  SERVER_NAME,
  viewingContextInput,
  WATCH_TOOLS,
} from '../src/tools';
import { boundedWatchContent, MAX_STRUCTURED_BYTES } from '../src/structured';

describe('the D-05 contract', () => {
  it('serves the eleven shared tools and the agent-owned research instructions (ADR-107)', () => {
    expect(SERVER_NAME).toBe('Watch history');
    expect(INSTRUCTIONS).toBe(
      'Use viewing_context for personal evidence; plays do not prove liking. Discover broadly, then check_titles and rank for the request using dated research. Released titles beyond theatrical-only are eligible; upcoming/theatrical-only need explicit request. Streaming/rental listings are optional convenience, never a default filter or ranking boost. Plex/watchlist restrict only explicit requests. recommend is a limited cache. No recorded viewing is not proof of never watched; viewingBasis explains recorded status. Reads never acquire titles; set_watchlist may download, mark_watched writes Plex.',
    );
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(600);
    expect(WATCH_TOOLS.map((t) => [t.name, t.scope, t.description])).toEqual([
      [
        'unfinished',
        'watch:read',
        "Shows (or movies) the user started but hasn't finished, most recent first, with the next episode.",
      ],
      [
        'recommend',
        'watch:read',
        'Limited cached ledger/watchlist/TMDB candidates; scope plex or watchlist only when requested. For general choices use viewing_context, broad research and check_titles.',
      ],
      [
        'watch_status',
        'watch:read',
        'Recorded viewing, progress and Plex/watchlist membership for one title; unknowns are stated.',
      ],
      [
        'recent_history',
        'watch:read',
        'Recent recorded plays; a play alone does not establish completion or liking.',
      ],
      [
        'watchlist',
        'watch:read',
        "The user's Plex watchlist, newest first, each title with whether it is on Plex; pass offset for more.",
      ],
      [
        'check_titles',
        'watch:read',
        'Check up to 10 researched titles against personal records, in input order. Returns identity, viewing, feedback, memberships and unknowns; no acquisitions. Supply kind with tmdbId.',
      ],
      [
        'viewing_context',
        'watch:read',
        'Personal viewing and explicit feedback, paginated; plays do not prove completion or liking; personal ratings unavailable. Discover broadly, check_titles, then choose for context/request using dated research, not ratings alone. Released beyond theatrical-only is eligible outside Plex/watchlists. Streaming/rental listings are optional convenience, never a default filter or ranking boost. Upcoming/theatrical-only need explicit request; Plex/watchlist restrict only explicit requests.',
      ],
      [
        'mark_watched',
        'watch:write',
        'Record that the user already watched a title and mark it watched in Plex: the whole show unless a season or episode is given; through=true marks everything up to that episode.',
      ],
      [
        'dismiss',
        'watch:write',
        'Stop suggesting a title: reason not_interested (default) or not_mine (someone else watched it on this account). Never changes Plex.',
      ],
      [
        'set_watchlist',
        'watch:write',
        "Add a title to the user's Plex watchlist or remove it; says back the title it found. Adding a title not on Plex makes Seerr download it.",
      ],
      [
        'undo_last_change',
        'watch:write',
        "Undo the user's last mark_watched, dismiss or set_watchlist from the past day.",
      ],
    ]);
    expect(Object.fromEntries(WATCH_TOOLS.map((t) => [t.name, t.annotations]))).toEqual({
      unfinished: { readOnlyHint: true },
      recommend: { readOnlyHint: true },
      watch_status: { readOnlyHint: true },
      recent_history: { readOnlyHint: true },
      watchlist: { readOnlyHint: true },
      check_titles: { readOnlyHint: true },
      viewing_context: { readOnlyHint: true },
      mark_watched: { destructiveHint: false, idempotentHint: true },
      dismiss: { destructiveHint: false },
      set_watchlist: { destructiveHint: false, idempotentHint: true },
      undo_last_change: { destructiveHint: false },
    });
  });

  it('the hand-written tools/list schemas describe exactly what the zod schemas validate', () => {
    const stripLengths = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(stripLengths);
      if (v && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([k]) => k !== '$schema' && k !== 'minLength' && k !== 'maxLength')
            .map(([k, x]) => [k, stripLengths(x)]),
        );
      }
      return v;
    };
    for (const tool of WATCH_TOOLS) {
      const fromZod = stripLengths(z.toJSONSchema(tool.input, { io: 'input' }));
      expect(tool.jsonSchema, tool.name).toEqual(fromZod);
    }
  });

  it('keeps primitive schemas except the explicitly bounded check_titles array, with no combinators or defaults', () => {
    const hop = { name: 'hop', tokenEnv: 'X', scopes: ['watch:read', 'watch:write'] } as const;
    expect(toolList(hop)).toBe(toolList(hop));
    for (const t of toolList(hop)) {
      const json = JSON.stringify(t.inputSchema);
      expect(json).not.toMatch(/"(anyOf|oneOf|allOf|not|\$ref|\$schema|default|nullable)"/);
      for (const p of Object.values(t.inputSchema.properties ?? {}) as Array<
        Record<string, unknown>
      >) {
        if (p.type === 'array') {
          expect(t.name).toBe('check_titles');
          expect(p.minItems).toBe(1);
          expect(p.maxItems).toBe(10);
          const item = p.items as Record<string, unknown>;
          expect(item.type).toBe('object');
          expect(item.additionalProperties).toBe(false);
          for (const child of Object.values(
            item.properties as Record<string, Record<string, unknown>>,
          )) {
            expect(['string', 'integer']).toContain(child.type);
            if (child.type === 'integer') {
              expect(typeof child.minimum).toBe('number');
              expect(typeof child.maximum).toBe('number');
            }
          }
          continue;
        }
        expect(['string', 'integer', 'boolean']).toContain(p.type);
        if (p.type === 'integer') {
          expect(typeof p.minimum).toBe('number');
          expect(typeof p.maximum).toBe('number');
        }
      }
    }
  });

  it('validates batch identity, namespaces, field lengths and page caps before any read runs', () => {
    expect(
      checkTitlesInput.safeParse({
        titles: [
          { title: 'Dune', year: 2021 },
          { kind: 'show', tmdbId: 63639 },
        ],
      }).success,
    ).toBe(true);
    expect(
      checkTitlesInput.safeParse({
        titles: [{ tvdbId: 280619 }, { imdbId: 'tt3230854' }, { plexGuid: 'plex://show/exp' }],
      }).success,
    ).toBe(true);
    for (const titles of [
      [],
      Array.from({ length: 11 }, () => ({ title: 'Dune' })),
      [{}],
      [{ year: 2021 }],
      [{ title: ' ' }],
      [{ title: 'x'.repeat(201) }],
      [{ tmdbId: 63639 }],
      [{ tmdbId: 0, kind: 'show' }],
      [{ kind: 'movie', tvdbId: 280619 }],
      [{ imdbId: 'not-an-imdb-id' }],
      [{ plexGuid: 'https://plex.test/title' }],
      [{ plexGuid: 'plex://movie/1', kind: 'show' }],
      [{ plexGuid: 'plex://movie/1', tvdbId: 1 }],
      [{ title: 'Dune', acquire: true }],
    ])
      expect(checkTitlesInput.safeParse({ titles }).success).toBe(false);
    expect(viewingContextInput.safeParse({ kind: 'any', limit: 20, offset: 2000 }).success).toBe(
      true,
    );
    for (const args of [{ limit: 21 }, { offset: 2001 }, { section: 'ratings' }, { acquire: true }])
      expect(viewingContextInput.safeParse(args).success).toBe(false);
  });

  it('clips optional metadata under 64KiB without dropping candidate/page items or changing canonical IDs', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      identity: { tmdbId: i + 1, title: 'A long title '.repeat(100) },
      evidence: {
        plays: 100,
        viewingBasis: ['explicit_watched', 'plex_watched_state', 'completed_playback'],
        genres: Array.from({ length: 100 }, () => 'genre'.repeat(30)),
        statements: Array.from({ length: 100 }, () => ({
          action: 'watched',
          at: '2026-10-11T00:00:00Z',
        })),
      },
    }));
    const out = boundedWatchContent({ items, page: { total: 20, hasMore: false } });
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_STRUCTURED_BYTES);
    expect(out.metadataClipped).toBe(true);
    expect((out.items as typeof items).map((x) => x.identity.tmdbId)).toEqual(
      items.map((x) => x.identity.tmdbId),
    );
    expect((out.items as typeof items).every((x) => x.evidence.plays === 100)).toBe(true);
    expect((out.items as typeof items).every((x) => x.evidence.viewingBasis.length === 3)).toBe(
      true,
    );
    expect(items[0]?.evidence.statements).toHaveLength(100);
  });

  it('refuses malformed identities before accessing principal data, with value-free logging', async () => {
    const logs: string[] = [];
    const tool = WATCH_TOOLS.find((t) => t.name === 'check_titles');
    if (!tool) throw new Error('Missing candidate check tool');
    const result = await runTool(
      tool,
      { titles: [{ title: 'private candidate name', tmdbId: 123 }] },
      { log: (line: string) => logs.push(line) } as never,
      { name: 'reader', scopes: ['watch:read'] },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(
      'Provide kind for a TMDB identifier',
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"code":"invalid_args"');
    expect(logs[0]).not.toContain('private candidate name');
  });
});

const req = (authorization?: string) =>
  new Request('http://x/api/mcp', {
    method: 'POST',
    headers: authorization ? { authorization } : {},
  });

describe('consumer auth (D-03)', () => {
  const env = { HNET_MCP_HOP_TOKEN: 'secret-token' };

  it('503 when no consumer token is configured, 401 (WWW-Authenticate: Bearer) without or with a wrong bearer', async () => {
    const unset = authenticate(req('Bearer secret-token'), {});
    expect(unset.ok).toBe(false);
    if (!unset.ok) expect(unset.response.status).toBe(503);
    for (const header of [
      undefined,
      'Bearer',
      'Bearer wrong',
      'Basic c2VjcmV0LXRva2Vu',
      'secret-token',
    ]) {
      const r = authenticate(req(header), env);
      expect(r.ok, String(header)).toBe(false);
      if (!r.ok) {
        expect(r.response.status).toBe(401);
        expect(r.response.headers.get('www-authenticate')).toBe('Bearer');
      }
    }
    const ok = authenticate(req('Bearer secret-token'), env);
    expect(ok).toMatchObject({ ok: true, consumer: { name: 'hop' } });
    expect(authenticate(req('bearer   secret-token'), env).ok).toBe(true);
  });

  it('a second, read-only consumer is configuration: it lists and runs only the read tools', async () => {
    const reader: HopConsumer = {
      name: 'reader',
      tokenEnv: 'READER_TOKEN',
      scopes: ['watch:read'],
    };
    const consumers = [
      {
        name: 'hop',
        tokenEnv: 'HNET_MCP_HOP_TOKEN',
        scopes: ['watch:read', 'watch:write'] as const,
      },
      reader,
    ];
    const r = authenticate(req('Bearer read-only'), { READER_TOKEN: 'read-only' }, consumers);
    expect(r).toMatchObject({ ok: true, consumer: { name: 'reader' } });
    expect(toolList(reader).map((t) => t.name)).toEqual([
      'unfinished',
      'recommend',
      'watch_status',
      'recent_history',
      'watchlist',
      'check_titles',
      'viewing_context',
    ]);
    const logs: string[] = [];
    const mark = WATCH_TOOLS.find((t) => t.name === 'mark_watched');
    if (!mark) throw new Error('no mark tool');
    const out = await runTool(
      mark,
      { title: 'x' },
      { log: (l: string) => logs.push(l) } as never,
      reader,
    );
    expect(out.isError).toBe(true);
    expect(logs[0]).toMatch(
      /"tool":"mark_watched","consumer":"reader".*"ok":false.*"code":"scope"/,
    );
  });

  it('over the protocol, an out-of-scope tool is not registered: tools/list omits it and a call answers "not found" (D-27)', async () => {
    const reader: HopConsumer = {
      name: 'reader',
      tokenEnv: 'READER_TOKEN',
      scopes: ['watch:read'],
    };
    const logs: string[] = [];
    const server = buildServer({ log: (l: string) => logs.push(l) } as never, reader);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'vitest', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
        'unfinished',
        'recommend',
        'watch_status',
        'recent_history',
        'watchlist',
        'check_titles',
        'viewing_context',
      ]);
      // DESIGN-051 D-01: a watch:read-only token sees `watchlist` but never `set_watchlist`.
      const change = await client.callTool({
        name: 'set_watchlist',
        arguments: { title: 'x', action: 'add' },
      });
      expect(change.isError).toBe(true);
      expect(change.content).toEqual([
        { type: 'text', text: expect.stringMatching(/Tool set_watchlist not found/) },
      ]);
      const out = await client.callTool({ name: 'mark_watched', arguments: { title: 'x' } });
      expect(out.isError).toBe(true);
      expect(out.content).toEqual([
        { type: 'text', text: expect.stringMatching(/Tool mark_watched not found/) },
      ]);
      // The runner never ran, so no D-06 line (the SDK refused before it).
      expect(logs).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('the D-02 deadline', () => {
  const hop: HopConsumer = {
    name: 'hop',
    tokenEnv: 'HNET_MCP_HOP_TOKEN',
    scopes: ['watch:read', 'watch:write'],
  };

  /** A database whose every query answers `rows` after `ms`. */
  function lateDb(ms: number, rows: unknown[]) {
    const late: unknown = new Proxy(function late() {}, {
      get: (_target, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void) => setTimeout(() => resolve(rows), ms)
          : late,
      apply: () => late,
    });
    return late;
  }

  /** A database the call must never reach. */
  function untouchableDb() {
    return new Proxy(
      {},
      {
        get: () => {
          throw new Error('the database must not be touched');
        },
      },
    );
  }

  /** A database whose first query answers `first` and whose next query rejects with `error`. */
  function ownerThenThrows(first: unknown[], error: Error) {
    let calls = 0;
    const db: unknown = new Proxy(function db() {}, {
      get: (_target, prop) =>
        prop === 'then'
          ? (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
              calls++ === 0 ? resolve(first) : reject(error)
          : db,
      apply: () => db,
    });
    return db;
  }

  it('a WatchNotReadyError thrown below the owner read is an ordinary "not ready" answer, not isError', async () => {
    const logs: string[] = [];
    const owner = { plexAccountId: 12874060, username: 'owner', role: 'owner', tracked: true };
    const deps = {
      db: ownerThenThrows([owner], new WatchNotReadyError(owner.plexAccountId)),
      revalidatePlex: () => null,
      markPlex: () => null,
      tmdb: () => null,
      now: () => new Date(),
      log: (l: string) => logs.push(l),
    } as never;
    const tool = WATCH_TOOLS.find((t) => t.name === 'dismiss');
    if (!tool) throw new Error('no dismiss');
    const out = await runTool(tool, { title: 'Severance' }, deps, hop);
    expect(out).toEqual({ content: [{ type: 'text', text: "Watch history isn't ready yet." }] });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"ok":true');
    expect(logs[0]).not.toContain('"code"');
  });

  it('an aborted call is finished at once (one "deadline" line) and its late completion logs nothing', async () => {
    const logs: string[] = [];
    const deps = { db: lateDb(80, []), log: (l: string) => logs.push(l) } as never;
    const tool = WATCH_TOOLS.find((t) => t.name === 'unfinished');
    if (!tool) throw new Error('no unfinished');
    const controller = new AbortController();
    const running = runTool(tool, {}, deps, hop, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(
      /^\[mcp\] tool_called \{"tool":"unfinished","consumer":"hop","ms":\d+,"ok":false,"chars":50,"code":"deadline"\}$/,
    );
    // The abandoned work still settles (the SDK drops its result) — without a second line.
    await expect(running).resolves.toEqual({
      content: [{ type: 'text', text: "Watch history isn't ready yet." }],
    });
    expect(logs).toHaveLength(1);
  });

  it('a call that finished first is not re-logged when the server closes afterwards', async () => {
    const logs: string[] = [];
    const deps = { db: lateDb(0, []), log: (l: string) => logs.push(l) } as never;
    const tool = WATCH_TOOLS.find((t) => t.name === 'recommend');
    if (!tool) throw new Error('no recommend');
    const controller = new AbortController();
    await runTool(tool, undefined, deps, hop, controller.signal);
    controller.abort();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"ok":true');
    // Already aborted before the call starts: answered and logged as a deadline without running.
    const aborted = new AbortController();
    aborted.abort();
    const out = await runTool(
      tool,
      {},
      { db: untouchableDb(), log: (l: string) => logs.push(l) } as never,
      hop,
      aborted.signal,
    );
    expect(out.isError).toBe(true);
    expect(logs[1]).toContain('"code":"deadline"');
  });

  it('answers a timed-out tools/call as an isError result with its id, anything else as a 504 JSON-RPC error', async () => {
    const call = deadlineResponse({
      jsonrpc: '2.0',
      id: 'abc',
      method: 'tools/call',
      params: { name: 'mark_watched' },
    });
    expect(call.status).toBe(200);
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(await call.json()).toEqual({
      jsonrpc: '2.0',
      id: 'abc',
      result: {
        content: [{ type: 'text', text: 'Watch history hit an error. Try again in a minute.' }],
        isError: true,
      },
    });
    for (const body of [
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { jsonrpc: '2.0', method: 'tools/call' },
      null,
      [1],
    ]) {
      const res = deadlineResponse(body);
      expect(res.status, JSON.stringify(body)).toBe(504);
      expect(await res.json()).toEqual({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Request timed out' },
        id: null,
      });
    }
  });
});
