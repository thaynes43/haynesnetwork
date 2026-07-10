import { describe, expect, it } from 'vitest';
import {
  OpenWebUiClient,
  OpenWebUiConfigError,
  fetchOwuiUsage,
  normalizeOwuiChat,
  normalizeOwuiUser,
  openWebUiClientFromEnv,
} from '../src/openwebui';

// ADR-044 / DESIGN-022 (PLAN-021) — the OWUI blob normalizer + read client. These tests are the
// image-generation heuristic proof: an image generation is an ASSISTANT-role message file of type
// 'image'; a USER-role image (an upload) is NEVER counted. Plus the ns→ms duration + token sums, and the
// client's tolerant users-endpoint shape ({users:[…]} or a bare array) + best-effort user degrade.

// A raw chat mirroring the live OWUI 0.7.2 wire shape (created_at/updated_at are epoch SECONDS).
const RAW_CHAT = {
  id: 'c1',
  user_id: 'u1',
  title: 'test',
  created_at: 1772073810,
  updated_at: 1772075572,
  archived: false,
  chat: {
    models: ['gpt-oss:latest'],
    messages: [
      { role: 'user', content: 'hi', timestamp: 1 },
      {
        role: 'assistant',
        model: 'gpt-oss:latest',
        content: 'hello',
        timestamp: 2,
        usage: { total_tokens: 173, total_duration: 91_330_801_530 },
      },
      // A USER image UPLOAD — attaches to a user message; must NOT be counted as a generation.
      { role: 'user', content: 'edit this', files: [{ type: 'image', url: '/up' }], timestamp: 3 },
      // An ASSISTANT-GENERATED image — the one that counts.
      {
        role: 'assistant',
        model: 'gpt-oss:latest',
        content: 'here you go',
        timestamp: 4,
        files: [{ type: 'image', url: '/api/v1/files/x/content' }],
        usage: { total_tokens: 10, total_duration: 1_000_000 },
      },
    ],
  },
};

describe('normalizeOwuiChat (the image-gen heuristic)', () => {
  it('counts only ASSISTANT image files (a user upload is not a generation)', () => {
    const c = normalizeOwuiChat(RAW_CHAT)!;
    expect(c).not.toBeNull();
    expect(c.messageCount).toBe(4);
    expect(c.imageCount).toBe(1); // the assistant image only — the user upload is excluded
    expect(c.models).toEqual(['gpt-oss:latest']);
    expect(c.primaryModel).toBe('gpt-oss:latest');
    expect(c.totalTokens).toBe(183);
    // (91_330_801_530 + 1_000_000) ns → ms, rounded.
    expect(c.totalDurationMs).toBe(91_332);
    expect(c.chatCreatedAt.getTime()).toBe(1772073810 * 1000);
    expect(c.chatUpdatedAt.getTime()).toBe(1772075572 * 1000);
    expect(c.owuiUserId).toBe('u1');
  });

  it('picks the most-used assistant model as primary, unions declared + message models', () => {
    const c = normalizeOwuiChat({
      id: 'c2',
      user_id: 'u2',
      created_at: 1,
      updated_at: 1,
      chat: {
        models: ['declared-model'],
        messages: [
          { role: 'assistant', model: 'a', content: 'x' },
          { role: 'assistant', model: 'b', content: 'y' },
          { role: 'assistant', model: 'b', content: 'z' },
        ],
      },
    })!;
    expect(c.primaryModel).toBe('b'); // used twice
    expect(c.models.sort()).toEqual(['a', 'b', 'declared-model']);
    expect(c.imageCount).toBe(0);
  });

  it('skips a chat with no id', () => {
    expect(normalizeOwuiChat({ user_id: 'u1' })).toBeNull();
  });

  it('falls back to now when created_at is missing', () => {
    const now = new Date('2026-07-10T00:00:00Z');
    const c = normalizeOwuiChat({ id: 'c3', user_id: 'u', chat: { messages: [] } }, now)!;
    expect(c.chatCreatedAt.getTime()).toBe(now.getTime());
    expect(c.messageCount).toBe(0);
  });
});

describe('normalizeOwuiUser', () => {
  it('maps the identity fields, skips a user with no id', () => {
    expect(normalizeOwuiUser({ id: 'u1', name: 'Alice', email: 'a@x.test', role: 'admin' })).toEqual({
      id: 'u1',
      name: 'Alice',
      email: 'a@x.test',
      role: 'admin',
    });
    expect(normalizeOwuiUser({ name: 'nobody' })).toBeNull();
  });
});

/** A fake fetch that routes the two OWUI GETs to canned bodies. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>): typeof fetch {
  return (async (url: string) => {
    const path = new URL(url).pathname;
    const hit = routes[path];
    if (!hit) return { ok: false, status: 404, json: async () => ({}) } as Response;
    const status = hit.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => hit.body } as Response;
  }) as unknown as typeof fetch;
}

describe('OpenWebUiClient + fetchOwuiUsage', () => {
  const config = { baseUrl: 'http://owui.test', apiKey: 'k' };

  it('fetches + normalizes chats and users', async () => {
    const client = new OpenWebUiClient({
      ...config,
      fetch: stubFetch({
        '/api/v1/chats/all/db': { body: [RAW_CHAT] },
        '/api/v1/users/': { body: { users: [{ id: 'u1', name: 'Alice', email: 'a@x.test', role: 'admin' }] } },
      }),
    });
    const snap = await fetchOwuiUsage(client);
    expect(snap.chats).toHaveLength(1);
    expect(snap.chats[0]!.imageCount).toBe(1);
    expect(snap.users).toEqual([{ id: 'u1', name: 'Alice', email: 'a@x.test', role: 'admin' }]);
  });

  it('tolerates a bare-array users endpoint', async () => {
    const client = new OpenWebUiClient({
      ...config,
      fetch: stubFetch({
        '/api/v1/chats/all/db': { body: [] },
        '/api/v1/users/': { body: [{ id: 'u9', name: 'Zed', email: 'z@x.test', role: 'user' }] },
      }),
    });
    const users = await client.getUsers();
    expect(users).toHaveLength(1);
  });

  it('degrades to an empty user set when the users read fails (chats still sync)', async () => {
    const client = new OpenWebUiClient({
      ...config,
      fetch: stubFetch({
        '/api/v1/chats/all/db': { body: [RAW_CHAT] },
        '/api/v1/users/': { status: 500, body: {} },
      }),
    });
    const snap = await fetchOwuiUsage(client);
    expect(snap.chats).toHaveLength(1);
    expect(snap.users).toEqual([]);
  });

  it('throws HTTP status when the chats read fails', async () => {
    const client = new OpenWebUiClient({
      ...config,
      fetch: stubFetch({ '/api/v1/chats/all/db': { status: 401, body: {} } }),
    });
    await expect(client.getAllChats()).rejects.toThrow(/HTTP 401/);
  });
});

describe('openWebUiClientFromEnv', () => {
  it('defaults the URL to the in-cluster DNS and requires the API key', () => {
    expect(() => openWebUiClientFromEnv({})).toThrow(OpenWebUiConfigError);
    expect(openWebUiClientFromEnv({ OPENWEBUI_API_KEY: 'k' })).toBeInstanceOf(OpenWebUiClient);
  });
});
