// ADR-087 / DESIGN-049 D-02 / D-03 / D-05 (PLAN-068 S7) — the tool contract without a database: the exact
// D-05 names and descriptions, the D-02 instructions, the hand-written `tools/list` schemas pinned to the zod
// schemas that validate every call, the static list, consumer auth (401 / 503 / constant-time match) and
// scopes as configuration (a read-only consumer sees and runs only the read tools).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { authenticate, type McpConsumer } from '../src/auth';
import { runTool, toolList } from '../src/server';
import { INSTRUCTIONS, SERVER_NAME, WATCH_TOOLS } from '../src/tools';

describe('the D-05 contract', () => {
  it('serves exactly the seven tools with the D-05 descriptions, and the D-02 name and instructions', () => {
    expect(SERVER_NAME).toBe('Watch history');
    expect(INSTRUCTIONS).toBe(
      "Watch history for the owner's Plex account across HaynesOps, HaynesKube and HaynesTower. Every result is short plain text meant to be read aloud. unfinished: shows started and not finished. recommend: never-watched picks with reasons (pass offset for more). watch_status: one title. recent_history: recent plays. mark_watched writes to Plex; dismiss never does; undo_last_change reverses the last change.",
    );
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(600);
    expect(WATCH_TOOLS.map((t) => [t.name, t.scope, t.description])).toEqual([
      ['unfinished', 'watch:read', "Shows (or movies) the user started but hasn't finished, most recent first, with the next episode."],
      ['recommend', 'watch:read', 'Titles the user has never watched, best first, each with a short reason; titles on Plex first.'],
      ['watch_status', 'watch:read', 'Whether the user has seen a title, how far along he is, and whether it is on Plex.'],
      ['recent_history', 'watch:read', 'What the user watched recently.'],
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
      ['undo_last_change', 'watch:write', "Undo the user's last mark_watched or dismiss from the past day."],
    ]);
    expect(Object.fromEntries(WATCH_TOOLS.map((t) => [t.name, t.annotations]))).toEqual({
      unfinished: { readOnlyHint: true },
      recommend: { readOnlyHint: true },
      watch_status: { readOnlyHint: true },
      recent_history: { readOnlyHint: true },
      mark_watched: { destructiveHint: false, idempotentHint: true },
      dismiss: { destructiveHint: false },
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

  it('the list is built once and follows the schema rules (flat, no defaults, no unions, bounded ints)', () => {
    const hop = { name: 'hop', tokenEnv: 'X', scopes: ['watch:read', 'watch:write'] } as const;
    expect(toolList(hop)).toBe(toolList(hop));
    for (const t of toolList(hop)) {
      const json = JSON.stringify(t.inputSchema);
      expect(json).not.toMatch(/"(anyOf|oneOf|allOf|not|\$ref|\$schema|default|nullable)"/);
      for (const p of Object.values(t.inputSchema.properties ?? {}) as Array<Record<string, unknown>>) {
        expect(['string', 'integer', 'boolean']).toContain(p.type);
        if (p.type === 'integer') {
          expect(typeof p.minimum).toBe('number');
          expect(typeof p.maximum).toBe('number');
        }
      }
    }
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
    for (const header of [undefined, 'Bearer', 'Bearer wrong', 'Basic c2VjcmV0LXRva2Vu', 'secret-token']) {
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
    const reader: McpConsumer = { name: 'reader', tokenEnv: 'READER_TOKEN', scopes: ['watch:read'] };
    const consumers = [{ name: 'hop', tokenEnv: 'HNET_MCP_HOP_TOKEN', scopes: ['watch:read', 'watch:write'] as const }, reader];
    const r = authenticate(req('Bearer read-only'), { READER_TOKEN: 'read-only' }, consumers);
    expect(r).toMatchObject({ ok: true, consumer: { name: 'reader' } });
    expect(toolList(reader).map((t) => t.name)).toEqual(['unfinished', 'recommend', 'watch_status', 'recent_history']);
    const logs: string[] = [];
    const mark = WATCH_TOOLS.find((t) => t.name === 'mark_watched');
    if (!mark) throw new Error('no mark tool');
    const out = await runTool(mark, { title: 'x' }, { log: (l: string) => logs.push(l) } as never, reader);
    expect(out.isError).toBe(true);
    expect(logs[0]).toMatch(/"tool":"mark_watched","consumer":"reader".*"ok":false.*"code":"scope"/);
  });
});
