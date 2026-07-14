import { describe, expect, it } from 'vitest';
import { KapowarrReadClient } from '../src/read';
import { KapowarrWriteClient } from '../src/write';
import { KapowarrHttpError, KapowarrParseError } from '../src/errors';
import { assertKapowarrEnv, KAPOWARR_CLUSTER_URL_DEFAULT } from '../src/config';

// ADR-056 (PLAN-046) — the Kapowarr client ACL: search/add/monitor/force-search over an injected fetchImpl
// (offline; ADR-010 — no live-API tests in CI). Kapowarr wraps every body in `{ error, result }`; the client
// unwraps it and treats a non-null `error` as a failure. The api_key rides the query string, never a header,
// and is redacted from every error.

/** Build a fetchImpl that returns the Kapowarr envelope for a matched path, recording the calls it saw. */
function stubFetch(
  routes: Array<{ match: (url: string, method: string) => boolean; status?: number; body: unknown }>,
) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes.find((r) => r.match(u, method));
    if (!route) return new Response(JSON.stringify({ error: 'NotFound', result: {} }), { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const OPTS = (fetchImpl: typeof fetch) => ({
  baseUrl: 'http://kapowarr.test:5656',
  apiKey: 'k-secret',
  fetchImpl,
  retries: 1,
  backoffMs: 1,
  sleepImpl: async () => {},
});

describe('assertKapowarrEnv', () => {
  it('defaults the URL and requires the key (never echoing it)', () => {
    expect(assertKapowarrEnv({ KAPOWARR_API_KEY: 'abc' })).toEqual({
      baseUrl: KAPOWARR_CLUSTER_URL_DEFAULT,
      apiKey: 'abc',
    });
    expect(() => assertKapowarrEnv({})).toThrowError(/KAPOWARR_API_KEY/);
    try {
      assertKapowarrEnv({});
    } catch (e) {
      expect(String(e)).not.toContain('abc');
    }
  });
});

describe('KapowarrReadClient.searchVolumes', () => {
  it('normalizes ComicVine candidates (translated + already_added)', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: (u) => u.includes('/api/volumes/search'),
        body: {
          error: null,
          result: [
            { comicvine_id: 61857, title: 'Scott Pilgrim', year: 2010, publisher: 'Panini Verlag', issue_count: 6, translated: true, already_added: null },
            { comicvine_id: 25478, title: 'Scott Pilgrim', year: 2004, publisher: 'Oni Press', issue_count: 6, translated: false, already_added: null },
          ],
        },
      },
    ]);
    const client = new KapowarrReadClient(OPTS(fetchImpl));
    const results = await client.searchVolumes('Scott Pilgrim');
    expect(results).toHaveLength(2);
    expect(results[1]).toMatchObject({ comicvineId: 25478, translated: false, publisher: 'Oni Press' });
    // api_key rides the query string, not a header.
    expect(calls[0]!.url).toContain('api_key=k-secret');
    expect(calls[0]!.url).toContain('query=Scott+Pilgrim');
  });
});

describe('KapowarrWriteClient', () => {
  it('addVolume posts the ComicVine id + root folder and returns the new local id', async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        match: (u, m) => u.includes('/api/volumes') && !u.includes('/search') && m === 'POST',
        status: 201,
        body: { error: null, result: { id: 42, comicvine_id: 25478, monitored: true, issue_count: 6, issues_downloaded: 0 } },
      },
    ]);
    const client = new KapowarrWriteClient(OPTS(fetchImpl));
    const id = await client.addVolume({ comicvineId: 25478, rootFolderId: 1 });
    expect(id).toBe(42);
    expect(calls[0]!.body).toMatchObject({
      comicvine_id: 25478,
      root_folder_id: 1,
      monitor: true,
      auto_search: true,
      monitoring_scheme: 'all',
    });
  });

  it('searchVolume queues the auto_search task for the volume (the Force-Search idiom)', async () => {
    const { fetchImpl, calls } = stubFetch([
      { match: (u, m) => u.includes('/api/system/tasks') && m === 'POST', body: { error: null, result: null } },
    ]);
    const client = new KapowarrWriteClient(OPTS(fetchImpl));
    await client.searchVolume(42);
    expect(calls[0]!.body).toEqual({ cmd: 'auto_search', volume_id: 42 });
  });

  it('setMonitored PUTs the monitored flag', async () => {
    const { fetchImpl, calls } = stubFetch([
      { match: (u, m) => /\/api\/volumes\/42/.test(u) && m === 'PUT', body: { error: null, result: null } },
    ]);
    const client = new KapowarrWriteClient(OPTS(fetchImpl));
    await client.setMonitored(42, true);
    expect(calls[0]!.body).toEqual({ monitored: true });
  });
});

describe('envelope + error handling', () => {
  it('treats a non-null envelope error on a 2xx as a parse error', async () => {
    const { fetchImpl } = stubFetch([
      { match: (u) => u.includes('/api/rootfolder'), body: { error: 'VolumeNotMatched', result: null } },
    ]);
    const client = new KapowarrReadClient(OPTS(fetchImpl));
    await expect(client.getRootFolders()).rejects.toBeInstanceOf(KapowarrParseError);
  });

  it('redacts the api_key in an HTTP error', async () => {
    const { fetchImpl } = stubFetch([
      { match: (u) => u.includes('/api/volumes/search'), status: 500, body: { error: 'boom', result: null } },
    ]);
    const client = new KapowarrReadClient(OPTS(fetchImpl));
    try {
      await client.searchVolumes('x');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(KapowarrHttpError);
      expect((e as KapowarrHttpError).url).not.toContain('k-secret');
      expect((e as KapowarrHttpError).url).toContain('api_key=REDACTED');
    }
  });

  it('getVolume returns null on a 404 rather than throwing (nothing to reconcile)', async () => {
    const { fetchImpl } = stubFetch([]); // every path 404s
    const client = new KapowarrReadClient(OPTS(fetchImpl));
    expect(await client.getVolume(999)).toBeNull();
  });

  it('retries a transient 503 then succeeds', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n === 1) return new Response(JSON.stringify({ error: 'busy', result: null }), { status: 503 });
      return new Response(JSON.stringify({ error: null, result: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new KapowarrReadClient(OPTS(fetchImpl));
    expect(await client.listVolumes()).toEqual([]);
    expect(n).toBe(2);
  });
});
