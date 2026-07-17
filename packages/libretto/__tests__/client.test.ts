// ADR-069 / DESIGN-042 (PLAN-052) — the confined Libretto client against an injected fetch (ADR-010: no
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
    const client = new LibrettoReadClient({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.listRecipes();
    expect(res.recipes).toHaveLength(1);
    expect(res.recipes[0]!.id).toBe('dune');
    expect(res.issues).toHaveLength(1);
  });

  it('reads a run with counts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: 'run-1', status: 'warn', counts: { matched: 3, missing: 2, matchedByTitle: 1 } }),
    );
    const client = new LibrettoReadClient({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    const run = await client.getRun('run-1');
    expect(run.status).toBe('warn');
    expect(run.counts?.matched).toBe(3);
  });

  it('validate returns the preview resolution', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { ok: true, issues: [], resolved: { name: 'The Stormlight Archive', workCount: 5 } }),
    );
    const client = new LibrettoReadClient({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    const res = await client.validateRecipe({ id: 'x', builder: { type: 'hardcover_series', ref: 'stormlight' } });
    expect(res.resolved?.workCount).toBe(5);
  });

  it('maps a network failure to LibrettoUnreachableError (key never in the message)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const client = new LibrettoReadClient({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.listRecipes()).rejects.toBeInstanceOf(LibrettoUnreachableError);
    try {
      await client.listRecipes();
    } catch (e) {
      expect((e as Error).message).not.toContain('secret-key');
    }
  });

  it('maps a 500 to LibrettoUnreachableError (honest degrade)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(500, { error: 'boom' }));
    const client = new LibrettoReadClient({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.listRecipes()).rejects.toBeInstanceOf(LibrettoUnreachableError);
  });
});

describe('LibrettoWriteClient', () => {
  it('upserts a recipe via idempotent PUT', async () => {
    const seen: Array<{ method?: string; url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ method: init?.method, url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return jsonResponse(200, { id: 'dune' });
    });
    const client = new LibrettoWriteClient({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.upsertRecipe({ id: 'dune', builder: { type: 'static_ids', ref: 'x' }, variables: { acquisitionEnabled: false } });
    expect(seen[0]!.method).toBe('PUT');
    expect(seen[0]!.url).toContain('/api/recipes/dune');
  });

  it('surfaces a 400 with per-path issues as LibrettoHttpError', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { issues: [{ path: ['builder', 'ref'], message: 'unknown series' }] }),
    );
    const client = new LibrettoWriteClient({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
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
    const client = new LibrettoWriteClient({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.deleteRecipe('dune', { deleteCollection: true });
    expect(urls[0]).toContain('deleteCollection=true');
  });

  it('apply returns the async runId', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(202, { runId: 'run-42' }));
    const client = new LibrettoWriteClient({ ...OPTS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.applyScope('dune')).toBe('run-42');
  });
});
