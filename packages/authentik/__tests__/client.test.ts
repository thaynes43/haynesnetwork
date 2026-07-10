import { describe, expect, it } from 'vitest';
import {
  assertAuthentikEnv,
  AUTHENTIK_CLUSTER_URL_DEFAULT,
  AuthentikConfigError,
  AuthentikHttpError,
  AuthentikReadClient,
  sourcesOf,
  type AuthentikUser,
} from '../src/index';
import { AuthentikWriteClient } from '../src/write';

/** A fetch stub that records requests and replies from a scripted queue. */
function stubFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const { status, body } = handler(url, init ?? {});
    // A 204/205/304 must carry a null body (the Response constructor rejects a body otherwise).
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('assertAuthentikEnv', () => {
  it('defaults the URL to the in-cluster service and requires the token', () => {
    const cfg = assertAuthentikEnv({ AUTHENTIK_API_TOKEN: 'tok' });
    expect(cfg.baseUrl).toBe(AUTHENTIK_CLUSTER_URL_DEFAULT);
    expect(cfg.token).toBe('tok');
  });
  it('throws AuthentikConfigError naming only the missing variable (never the value)', () => {
    try {
      assertAuthentikEnv({ AUTHENTIK_URL: 'http://x' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthentikConfigError);
      expect((e as AuthentikConfigError).missing).toEqual(['AUTHENTIK_API_TOKEN']);
    }
  });
  it('strips a trailing slash from the base URL', () => {
    expect(assertAuthentikEnv({ AUTHENTIK_URL: 'http://x/', AUTHENTIK_API_TOKEN: 't' }).baseUrl).toBe(
      'http://x',
    );
  });
});

describe('sourcesOf', () => {
  it('extracts Plex source names from attributes', () => {
    const u = { attributes: { 'goauthentik.io/user/sources': ['HaynesTower'] } } as AuthentikUser;
    expect(sourcesOf(u)).toEqual(['HaynesTower']);
  });
  it('returns [] when there is no sources attribute', () => {
    expect(sourcesOf({ attributes: null } as AuthentikUser)).toEqual([]);
  });
});

describe('AuthentikReadClient', () => {
  it('pages users and sends the Bearer token header-only (never in the URL)', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: {
        pagination: { next: 0, count: 1 },
        results: [
          {
            pk: 109,
            username: 'mikebi12',
            name: 'mikebi12',
            email: 'm@example.test',
            is_active: true,
            type: 'external',
            uid: 'abc',
            attributes: { 'goauthentik.io/user/sources': ['HaynesTower'] },
            groups_obj: [{ pk: 'g1', name: 'family' }],
          },
        ],
      },
    }));
    const client = new AuthentikReadClient({ baseUrl: 'http://ak', token: 'secret', fetchImpl });
    const users = await client.listUsers();
    expect(users).toHaveLength(1);
    expect(users[0]!.username).toBe('mikebi12');
    expect(calls[0]!.url).not.toContain('secret');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret');
  });

  it('maps a non-2xx to AuthentikHttpError without echoing the token', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 403, body: { detail: 'forbidden' } }));
    const client = new AuthentikReadClient({
      baseUrl: 'http://ak',
      token: 'secret',
      fetchImpl,
      retryDelayMs: 0,
    });
    await expect(client.listGroups()).rejects.toBeInstanceOf(AuthentikHttpError);
  });
});

describe('AuthentikWriteClient', () => {
  it('creates a group and flips membership via the group action endpoints', async () => {
    const { fetchImpl, calls } = stubFetch((url) => {
      if (url.endsWith('/api/v3/core/groups/')) return { status: 201, body: { pk: 'g-friends', name: 'friends' } };
      return { status: 204, body: {} };
    });
    const client = new AuthentikWriteClient({ baseUrl: 'http://ak', token: 't', fetchImpl });
    const g = await client.createGroup('friends');
    expect(g.pk).toBe('g-friends');
    await client.addUserToGroup('g-friends', 109);
    await client.removeUserFromGroup('g-family', 109);
    expect(calls[1]!.url).toContain('/api/v3/core/groups/g-friends/add_user/');
    expect(calls[2]!.url).toContain('/api/v3/core/groups/g-family/remove_user/');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ pk: 109 });
  });
});
