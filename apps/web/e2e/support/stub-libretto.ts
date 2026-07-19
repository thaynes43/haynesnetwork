// ADR-070 / DESIGN-043 (PLAN-052) — the hermetic Libretto stub: the JSON REST surface the confined
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
        // A ref/id carrying "over" resolves to a membership above the default size cap (25, migration
        // 0067) so the direct-add over-cap → collection_override ticket path (D-11) is exercisable
        // hermetically; every other ref stays comfortably within the cap.
        const draft = body as { id?: string; builder?: { ref?: string } } | undefined;
        const ref = draft?.builder?.ref ?? '';
        const id = draft?.id ?? '';
        const overCap = /over/i.test(ref) || /over/i.test(id);
        return json(200, {
          ok: true,
          issues: [],
          resolved: overCap
            ? { name: 'The Cosmere (everything)', workCount: 40 }
            : { name: 'The Stormlight Archive', workCount: 5 },
        });
      }
      // DESIGN-044 D-04 — the builder page's typeahead ref search. Canned series hits filtered by substring
      // so the gallery shows a populated result list; static_ids returns nothing (free-form).
      if (path === '/api/search' && method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const type = url.searchParams.get('type') ?? '';
        const all =
          type === 'nyt_list'
            ? [
                { ref: 'hardcover-fiction', name: 'Hardcover Fiction' },
                { ref: 'hardcover-nonfiction', name: 'Hardcover Nonfiction' },
                { ref: 'young-adult-hardcover', name: 'Young Adult Hardcover' },
              ]
            : type === 'static_ids'
              ? []
              : [
                  { ref: 'stormlight-archive', name: 'The Stormlight Archive', author: 'Brandon Sanderson', workCount: 5 },
                  { ref: 'mistborn-era-one', name: 'Mistborn: Era One', author: 'Brandon Sanderson', workCount: 3 },
                  { ref: 'the-reckoners', name: 'The Reckoners', author: 'Brandon Sanderson', workCount: 4 },
                ];
        const results = q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all;
        return json(200, { type, query: q, results, truncated: false });
      }
      // DESIGN-044 D-05 — the member preview a draft builder resolves to. A ref carrying "over" resolves to
      // 40 members (the over-cap meter state); every other ref resolves to 5, three of which carry ISBNs the
      // seeded library holds (held) and two that it does not (missing) — a populated split for the gallery.
      if (path === '/api/preview' && method === 'POST') {
        const req = body as { builder?: { ref?: unknown; type?: unknown } } | undefined;
        const ref = String(req?.builder?.ref ?? '');
        const builderType = String(req?.builder?.type ?? '');
        // DESIGN-044 D-05 (owner "gotta catch em all" redesign) — a ref carrying "complete" resolves to three
        // members the seeded Audiobookshelf library holds by ISBN (so every tile is HELD with a real cover via
        // the /api/books/cover proxy) — the caught-em-all celebration for the gallery + owner review.
        if (/complete/i.test(ref)) {
          return json(200, {
            builder: req?.builder,
            total: 3,
            truncated: false,
            members: [
              { title: 'A Christmas Carol', author: 'Charles Dickens', isbn: '9780140620481', position: 1 },
              { title: 'Oliver Twist', author: 'Charles Dickens', isbn: '9780141439747', position: 2 },
              { title: 'The Hobbit', author: 'J. R. R. Tolkien', isbn: '9780007487295', position: 3 },
            ],
          });
        }
        // A New York Times list resolves to a fifteen-member wall (three held audiobooks + twelve missing) so
        // the full-width preview reads as a Library wall, never a skinny column (the big-list owner review).
        if (builderType === 'nyt_list' || /\bnyt|big|list\b/i.test(ref)) {
          const held = [
            { title: 'A Christmas Carol', author: 'Charles Dickens', isbn: '9780140620481' },
            { title: 'Oliver Twist', author: 'Charles Dickens', isbn: '9780141439747' },
            { title: 'The Hobbit', author: 'J. R. R. Tolkien', isbn: '9780007487295' },
          ];
          const missing = Array.from({ length: 12 }, (_, i) => ({
            title: `Bestseller No. ${i + 1}`,
            author: 'Various',
            isbn: `97800000000${String(i).padStart(2, '0')}`,
          }));
          const members = [...held, ...missing].map((m, i) => ({ ...m, position: i + 1 }));
          return json(200, { builder: req?.builder, total: members.length, truncated: false, members });
        }
        if (/over/i.test(ref)) {
          const members = Array.from({ length: 40 }, (_, i) => ({
            title: `Cosmere Book ${i + 1}`,
            author: 'Brandon Sanderson',
            isbn: null,
            position: i + 1,
          }));
          return json(200, { builder: req?.builder, total: 40, truncated: false, members });
        }
        return json(200, {
          builder: req?.builder,
          total: 5,
          truncated: false,
          members: [
            { title: 'The Way of Kings', author: 'Brandon Sanderson', isbn: '9780765326355', position: 1 },
            { title: 'Words of Radiance', author: 'Brandon Sanderson', isbn: '9780765326362', position: 2 },
            { title: 'Oathbringer', author: 'Brandon Sanderson', isbn: '9780765326379', position: 3 },
            { title: 'Rhythm of War', author: 'Brandon Sanderson', isbn: '9780765326386', position: 4 },
            { title: 'Wind and Truth', author: 'Brandon Sanderson', isbn: '9781250319180', position: 5 },
          ],
        });
      }
      if (path.startsWith('/api/recipes/') && method === 'PUT') return json(200, body);
      if (path.startsWith('/api/recipes/') && method === 'DELETE') return json(200, { ok: true });
      if (path === '/api/apply' && method === 'POST') return json(202, { runId: 'run-stub-1' });
      // Member-level MISSING (DESIGN-043 D-08) — drives the on-demand collection Force Search (ADR-071):
      // two missing members, both resolvable, so the fire path mints + searches hermetically.
      if (/^\/api\/collections\/[^/]+\/missing$/.test(path) && method === 'GET') {
        const recipeId = decodeURIComponent(path.split('/')[3] ?? '');
        return json(200, {
          recipeId,
          total: 6,
          heldCount: 4,
          missingCount: 2,
          missing: [
            { title: 'Wind and Truth', authors: ['Brandon Sanderson'], isbn: '9780765326386' },
            { title: 'Edgedancer', authors: ['Brandon Sanderson'], isbn: '9781250166548' },
          ],
        });
      }
      // The ISBN-first resolve broker — every member resolves (volumeId keyed off the ISBN/title).
      if (path === '/api/resolve' && method === 'POST') {
        const req = body as { isbn?: string; title?: string } | undefined;
        const key = req?.isbn ?? req?.title ?? 'unknown';
        return json(200, { resolved: { volumeId: `stub-vol-${key.replace(/[^a-z0-9]/gi, '').slice(0, 12)}` } });
      }

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
