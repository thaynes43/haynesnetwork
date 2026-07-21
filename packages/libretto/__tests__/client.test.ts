// ADR-070 / DESIGN-043 (PLAN-052) — the confined Libretto client against an injected fetch (ADR-010: no
// live-API tests). Proves: Bearer auth + the key never leaking into errors; the read shapes (recipes +
// issues split, collections, run counts, validate preview); the write shapes (idempotent PUT, delete
// with ?deleteCollection, apply → runId); and the honest error taxonomy (5xx/network/timeout →
// LibrettoUnreachableError, 4xx → LibrettoHttpError carrying per-path issues).
import { describe, expect, it, vi } from 'vitest';
import { LibrettoReadClient } from '../src/read';
import { LibrettoWriteClient } from '../src/write';
import { LibrettoHttpError, LibrettoUnreachableError, assertLibrettoEnv } from '../src/index';

const OPTS = { baseUrl: 'http://libretto.test', apiKey: 'secret-key', retries: 0 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('assertLibrettoEnv', () => {
  it('requires LIBRETTO_API_KEY and never echoes the value', () => {
    expect(() => assertLibrettoEnv({})).toThrow(/LIBRETTO_API_KEY/);
    const cfg = assertLibrettoEnv({ LIBRETTO_API_KEY: 'k' });
    expect(cfg.baseUrl).toContain('libretto');
    try {
      assertLibrettoEnv({});
    } catch (e) {
      expect((e as Error).message).not.toContain('k');
    }
  });
});

describe('LibrettoReadClient', () => {
  it('sends Bearer auth and splits recipes / issues', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
      return jsonResponse(200, {
        recipes: [{ id: 'dune', builder: { type: 'static_ids', ref: 'x' } }],
        issues: [{ recipeId: 'broken', message: 'bad yaml' }],
      });
    });
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.listRecipes();
    expect(res.recipes).toHaveLength(1);
    expect(res.recipes[0]!.id).toBe('dune');
    expect(res.issues).toHaveLength(1);
  });

  it('parses a recipe list mixing scalar refs and MIXED id/slug array refs (hardcover_comics — PR #11 drift)', async () => {
    // The live 2026-07-21 regression: two hardcover_comics recipes emit `builder.ref` as a MIXED array of
    // Hardcover ids (numbers) AND slugs (strings), e.g. [14911, 'guarding-the-globe']. The string-only ACL
    // threw on the WHOLE list ("recipes.15.builder.ref: Invalid input: expected string, received array"),
    // aborting the hourly collection-force-search pass. The ref union must parse every Libretto shape:
    // scalar string, scalar number (hardcover_series id), and the mixed comics array.
    const recipes = [
      { id: 'stormlight', builder: { type: 'hardcover_series', ref: 'the-stormlight-archive' }, variables: { acquisitionEnabled: true } },
      { id: 'nyt-fiction', builder: { type: 'nyt_list', ref: 'hardcover-fiction' } },
      { id: 'goosebumps', builder: { type: 'hardcover_series', ref: 508783 } }, // a NUMERIC Hardcover series id
      // The comics grain: a MIXED number-and-string array (two such recipes are live: indices 15 and 30).
      { id: 'invincible-omni', builder: { type: 'hardcover_comics', ref: [14911, 'guarding-the-globe'] }, variables: { acquisitionEnabled: true } },
      { id: 'saga-comics', builder: { type: 'hardcover_comics', ref: [77, 78, 'saga'] }, variables: { acquisitionEnabled: false } },
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(200, { recipes, issues: [] }));
    const client = new LibrettoReadClient({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await client.listRecipes(); // pre-fix: rejected the whole list and threw
    expect(res.recipes).toHaveLength(5);
    // Every shape survives EXACTLY (no silent coercion): scalar string, scalar number, mixed array.
    expect(res.recipes[0]!.builder?.ref).toBe('the-stormlight-archive');
    expect(res.recipes[2]!.builder?.ref).toBe(508783);
    expect(res.recipes[3]!.builder?.ref).toEqual([14911, 'guarding-the-globe']);
    // The exact field the cron force-search pass filters on stays readable across EVERY ref shape.
    const acquisitionOn = res.recipes.filter((r) => r.variables?.acquisitionEnabled === true).map((r) => r.id);
    expect(acquisitionOn).toEqual(['stormlight', 'invincible-omni']);
  });

  it('reads a run with counts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        id: 'run-1',
        status: 'warn',
        counts: { matched: 3, missing: 2, matchedByTitle: 1 },
      }),
    );
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const run = await client.getRun('run-1');
    expect(run.status).toBe('warn');
    expect(run.counts?.matched).toBe(3);
  });

  it('validate returns the preview resolution', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        ok: true,
        issues: [],
        resolved: { name: 'The Stormlight Archive', workCount: 5 },
      }),
    );
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.validateRecipe({
      id: 'x',
      builder: { type: 'hardcover_series', ref: 'stormlight' },
    });
    expect(res.resolved?.workCount).toBe(5);
  });

  it('maps a network failure to LibrettoUnreachableError (key never in the message)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listRecipes()).rejects.toBeInstanceOf(LibrettoUnreachableError);
    try {
      await client.listRecipes();
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-key');
    }
  });

  it('maps a 500 to LibrettoUnreachableError (honest degrade)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.listRecipes()).rejects.toBeInstanceOf(LibrettoUnreachableError);
  });

  it('lists missing member identities for a recipe (Wanted-tiles data)', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('http://libretto.test/api/collections/stormlight/missing');
      return jsonResponse(200, {
        recipeId: 'stormlight',
        name: 'The Stormlight Archive',
        total: 5,
        heldCount: 3,
        missingCount: 2,
        missing: [
          {
            label: 'Wind and Truth (#5 in The Stormlight Archive)',
            title: 'Wind and Truth',
            authors: ['Brandon Sanderson'],
            isbn: '9781250319890',
            identifiers: ['isbn:9781250319890'],
          },
          {
            label: 'Edgedancer',
            title: 'Edgedancer',
            authors: ['Brandon Sanderson'],
            isbn: null,
            identifiers: [],
          },
        ],
      });
    });
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.listMissingMembers('stormlight');
    expect(res.heldCount).toBe(3);
    expect(res.missingCount).toBe(2);
    expect(res.missing).toHaveLength(2);
    expect(res.missing?.[0]?.isbn).toBe('9781250319890');
  });

  it('resolves an ISBN to a Google-Books volume id via the broker', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://libretto.test/api/resolve');
      expect(init?.method).toBe('POST');
      return jsonResponse(200, {
        resolved: { volumeId: 'VOL_WT', isbn13: '9781250319890', via: 'isbn' },
      });
    });
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const resolved = await client.resolve({ isbn: '9781250319890', title: 'Wind and Truth' });
    expect(resolved?.volumeId).toBe('VOL_WT');
    expect(resolved?.via).toBe('isbn');
  });

  it('returns null on an honest no-match from the broker', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { resolved: null }));
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.resolve({ title: 'Nonexistent Work' })).toBeNull();
  });

  it('searches a builder ref by name (typeahead)', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://libretto.test/api/search?type=hardcover_series&q=storm&limit=5');
      expect(init?.method).toBe('GET');
      return jsonResponse(200, {
        type: 'hardcover_series',
        query: 'storm',
        results: [
          {
            ref: '997',
            name: 'The Stormlight Archive',
            workCount: 10,
            author: 'Brandon Sanderson',
          },
        ],
        truncated: true,
      });
    });
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.search({ type: 'hardcover_series', q: 'storm', limit: 5 });
    expect(res.results?.[0]?.ref).toBe('997');
    expect(res.results?.[0]?.workCount).toBe(10);
    expect(res.truncated).toBe(true);
  });

  it('previews a draft builder to its resolved member identities', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://libretto.test/api/preview');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        builder: { type: 'hardcover_series', ref: '997' },
        limit: 100,
      });
      return jsonResponse(200, {
        builder: { type: 'hardcover_series', ref: '997' },
        total: 3,
        truncated: false,
        members: [
          {
            label: 'The Way of Kings (#1 in The Stormlight Archive)',
            title: 'The Way of Kings',
            author: 'Brandon Sanderson',
            isbn: '9780765326355',
            position: 1,
            identifiers: ['isbn:9780765326355'],
          },
        ],
      });
    });
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const res = await client.preview({
      builder: { type: 'hardcover_series', ref: '997' },
      limit: 100,
    });
    expect(res.total).toBe(3);
    expect(res.members?.[0]?.position).toBe(1);
    expect(res.members?.[0]?.isbn).toBe('9780765326355');
  });

  it('degrades an unconfigured search source (503) to LibrettoUnreachableError', async () => {
    // 5xx is transient in the shared http wrapper: it retries then maps to UNREACHABLE, so a 503 from
    // an unconfigured source is indistinguishable from a down Libretto — both degrade the field honestly.
    const fetchImpl = vi.fn(async () =>
      jsonResponse(503, { error: 'hardcover_series search needs HARDCOVER_TOKEN' }),
    );
    const client = new LibrettoReadClient({
      ...OPTS,
      retries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.search({ type: 'hardcover_series', q: 'storm' })).rejects.toBeInstanceOf(
      LibrettoUnreachableError,
    );
  });

  it('surfaces a 400 (unknown builder type) as a LibrettoHttpError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: 'unknown builder type "nope"' }),
    );
    const client = new LibrettoReadClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.search({ type: 'nope', q: 'x' })).rejects.toBeInstanceOf(LibrettoHttpError);
  });
});

describe('LibrettoWriteClient', () => {
  it('upserts a recipe via idempotent PUT', async () => {
    const seen: Array<{ method?: string; url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        method: init?.method,
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      return jsonResponse(200, { id: 'dune' });
    });
    const client = new LibrettoWriteClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.upsertRecipe({
      id: 'dune',
      builder: { type: 'static_ids', ref: 'x' },
      variables: { acquisitionEnabled: false },
    });
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.url).toContain('/api/recipes/dune');
  });

  it('upserts a comics recipe whose builder.ref is a mixed id/slug array (round-trip re-PUT)', async () => {
    // setCollectionFindMissing reads a hardcover_comics recipe (mixed number/string array) back via
    // recipeToDraft and re-PUTs it: the write ACL must accept the array unchanged, not throw on it.
    const seen: Array<{ body: unknown }> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
      return jsonResponse(200, { id: 'invincible-omni' });
    });
    const client = new LibrettoWriteClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.upsertRecipe({
      id: 'invincible-omni',
      builder: { type: 'hardcover_comics', ref: [14911, 'guarding-the-globe'] },
      variables: { acquisitionEnabled: true },
    });
    expect((seen[0]!.body as { builder: { ref: unknown } }).builder.ref).toEqual([14911, 'guarding-the-globe']);
  });

  it('surfaces a 400 with per-path issues as LibrettoHttpError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { issues: [{ path: ['builder', 'ref'], message: 'unknown series' }] }),
    );
    const client = new LibrettoWriteClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    try {
      await client.upsertRecipe({ id: 'x', builder: { type: 'hardcover_series', ref: 'bad' } });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LibrettoHttpError);
      expect((e as LibrettoHttpError).issues).toEqual(['builder.ref: unknown series']);
    }
  });

  it('delete passes ?deleteCollection when opted in', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 204 });
    });
    const client = new LibrettoWriteClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.deleteRecipe('dune', { deleteCollection: true });
    expect(urls[0]).toContain('deleteCollection=true');
  });

  it('apply returns the async runId', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(202, { runId: 'run-42' }));
    const client = new LibrettoWriteClient({
      ...OPTS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await client.applyScope('dune')).toBe('run-42');
  });
});
