// ADR-069 / DESIGN-042 (PLAN-052) — the hermetic Libretto stub: the JSON REST surface the confined
// @hnet/libretto client drives (GET /api/recipes, GET /api/collections, GET /api/runs/:id, POST
// /api/validate, PUT/DELETE /api/recipes/:id, POST /api/apply), plus a call RECORDER (/_stub/calls +
// /_stub/reset, the stub-arr idiom). Canned so the manager screenshots show a real recipe list, a produced
// collection, an invalid-recipe issue, and a validate preview. Bearer auth is accepted but not required
// (the client sends it; the stub does not gatekeep — the app-side gate is the real security boundary).
import { createServer, type Server } from 'node:http';

export const STUB_LIBRETTO_API_KEY = 'stub-libretto-key';

export interface LibrettoRecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export interface StubLibrettoServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

function cannedRecipes(): Array<Record<string, unknown>> {
  return [
    {
      id: 'stormlight-archive',
      name: 'The Stormlight Archive',
      builder: { type: 'hardcover_series', ref: 'the-stormlight-archive' },
      variables: { syncMode: 'sync', ordered: true, acquisitionEnabled: false },
      enabled: true,
    },
    {
      id: 'nyt-hardcover-fiction',
      name: 'NYT Hardcover Fiction',
      builder: { type: 'nyt_list', ref: 'hardcover-fiction' },
      variables: { syncMode: 'sync', ordered: true, acquisitionEnabled: true },
      enabled: true,
    },
    {
      id: 'mistborn',
      name: 'Mistborn',
      builder: { type: 'hardcover_series', ref: 'the-mistborn-saga' },
      variables: { syncMode: 'append', ordered: true, acquisitionEnabled: false },
      enabled: true,
    },
  ];
}

function cannedCollections(): Array<Record<string, unknown>> {
  return [
    { recipeId: 'stormlight-archive', targetCollectionId: 'kav-1', name: 'The Stormlight Archive', itemCount: 4 },
    { recipeId: 'nyt-hardcover-fiction', targetCollectionId: 'kav-2', name: 'NYT Hardcover Fiction', itemCount: 12 },
  ];
}

export async function startStubLibretto(): Promise<StubLibrettoServer> {
  const calls: LibrettoRecordedCall[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (path === '/_stub/calls' && method === 'GET') return json(200, { calls });
    if (path === '/_stub/reset' && method === 'POST') {
      calls.length = 0;
      res.writeHead(204);
      res.end();
      return;
    }

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : undefined;
      if (method !== 'GET') calls.push({ method, path, body });

      if (path === '/api/health') return json(200, { status: 'ok' });
      if (path === '/api/recipes' && method === 'GET') {
        return json(200, {
          recipes: cannedRecipes(),
          issues: [{ recipeId: 'broken-recipe', message: 'unknown builder ref' }],
        });
      }
      if (path === '/api/collections' && method === 'GET') {
        return json(200, { collections: cannedCollections() });
      }
      if (path.startsWith('/api/runs/') && method === 'GET') {
        return json(200, { id: path.split('/').pop(), status: 'warn', counts: { matched: 4, missing: 2, matchedByTitle: 1 } });
      }
      if (path === '/api/validate' && method === 'POST') {
        return json(200, { ok: true, issues: [], resolved: { name: 'The Stormlight Archive', workCount: 5 } });
      }
      if (path.startsWith('/api/recipes/') && method === 'PUT') return json(200, body);
      if (path.startsWith('/api/recipes/') && method === 'DELETE') return json(200, { ok: true });
      if (path === '/api/apply' && method === 'POST') return json(202, { runId: 'run-stub-1' });

      json(404, { message: `stub-libretto: no handler for ${method} ${path}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub-libretto: no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
