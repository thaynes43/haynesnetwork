import { describe, expect, it } from 'vitest';
import {
  assertOwuiEnv,
  OPENWEBUI_CLUSTER_URL_DEFAULT,
  OwuiConfigError,
  OwuiGroupReadClient,
} from '../src/index';
import { OwuiWriteClient } from '../src/write';

function stubFetch(
  handler: (url: string, init: RequestInit) => { status: number; body: unknown },
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const { status, body } = handler(url, init ?? {});
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('assertOwuiEnv', () => {
  it('defaults the URL to the in-cluster OWUI service and requires the api key', () => {
    const cfg = assertOwuiEnv({ OPENWEBUI_API_KEY: 'k' });
    expect(cfg.baseUrl).toBe(OPENWEBUI_CLUSTER_URL_DEFAULT);
    expect(cfg.apiKey).toBe('k');
  });
  it('throws OwuiConfigError naming only the missing variable', () => {
    expect(() => assertOwuiEnv({})).toThrow(OwuiConfigError);
  });
});

describe('OwuiGroupReadClient', () => {
  it('lists groups with the Bearer api key header-only', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: [{ id: 'g1', name: 'family', description: null }],
    }));
    const client = new OwuiGroupReadClient({ baseUrl: 'http://owui', apiKey: 'sk-x', fetchImpl });
    const groups = await client.listGroups();
    expect(groups.map((g) => g.name)).toEqual(['family']);
    expect(calls[0]!.url).toBe('http://owui/api/v1/groups/');
    expect(calls[0]!.url).not.toContain('sk-x');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-x');
  });
});

describe('OwuiWriteClient', () => {
  it('creates a group via /api/v1/groups/create', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: { id: 'g-friends', name: 'friends', description: 'haynesnetwork Friends tier' },
    }));
    const client = new OwuiWriteClient({ baseUrl: 'http://owui', apiKey: 'k', fetchImpl });
    const g = await client.createGroup('friends', 'haynesnetwork Friends tier');
    expect(g.name).toBe('friends');
    expect(calls[0]!.url).toBe('http://owui/api/v1/groups/create');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      name: 'friends',
      description: 'haynesnetwork Friends tier',
    });
  });
});
