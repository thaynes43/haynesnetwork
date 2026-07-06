// ADR-023 / DESIGN-010 e2e — stub Maintainerr HTTP server (mirrors stub-arr). Serves the
// fixture-shaped READ endpoints the Trash flow resolves against (collections + paged content with
// sizes/deleteAfterDays, rules, rules/constants with all integrations configured, exclusions,
// settings, app/status, settings/test/plex) and accepts the WRITE endpoints (exclusion CRUD,
// collection handle/expedite), RECORDING every mutating call so specs can assert them. Wired into
// harness.ts / env.ts so both Playwright e2e and `pnpm dev:local` boot a complete Trash stack.
//
// Control endpoints:
//   GET  /_stub/calls  → { calls: [{method, path, query, body}] } (writes only)
//   POST /_stub/reset  → 204 (clears recorded calls + resets exclusions)
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface RecordedMaintainerrWrite {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface StubMaintainerrServer {
  baseUrl: string;
  port: number;
  calls: RecordedMaintainerrWrite[];
  stop: () => Promise<void>;
}

/** The throwaway key the stub Maintainerr accepts (never a real credential). */
export const STUB_MAINTAINERR_API_KEY = 'stub-maintainerr-key';

/** A movie collection with two fixture items (sizes + addDate → derived scheduled-delete date). */
const COLLECTION = {
  id: 7,
  title: 'Least watched movies',
  isActive: true,
  deleteAfterDays: 30,
  type: 'movie',
  media: [] as unknown[],
};
const COLLECTION_ITEMS = [
  { mediaServerId: 'ms-9001', tmdbId: 990001, sizeBytes: 1_500_000_000, addDate: '2026-06-01T00:00:00Z' },
  { mediaServerId: 'ms-9002', tmdbId: 990002, sizeBytes: 2_500_000_000, addDate: '2026-06-05T00:00:00Z' },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export async function startStubMaintainerr(): Promise<StubMaintainerrServer> {
  const calls: RecordedMaintainerrWrite[] = [];
  const exclusions = new Set<string>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const path = url.pathname.replace(/^\/api/, '');
      const query = Object.fromEntries(url.searchParams.entries());

      if (url.pathname === '/_stub/calls') return json(res, 200, { calls });
      if (url.pathname === '/_stub/reset' && method === 'POST') {
        calls.length = 0;
        exclusions.clear();
        res.writeHead(204);
        return res.end();
      }

      if (method === 'POST' || method === 'DELETE' || method === 'PUT' || method === 'PATCH') {
        const raw = await readBody(req);
        const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
        calls.push({ method, path, query, body });
        if (method === 'POST' && path === '/rules/exclusion') {
          exclusions.add(String((body as { mediaId?: unknown })?.mediaId ?? ''));
          return json(res, 201, { code: 1 });
        }
        if (method === 'DELETE' && /^\/rules\/exclusions\/.+$/.test(path)) {
          exclusions.delete(decodeURIComponent(path.split('/').pop() ?? ''));
          return json(res, 200, { code: 1 });
        }
        if (method === 'POST' && (path === '/collections/handle' || path === '/collections/media/handle')) {
          return json(res, 201, {});
        }
        if ((method === 'POST' || method === 'PUT') && path === '/rules') return json(res, 201, { code: 1 });
        if (method === 'DELETE' && /^\/rules\/\d+$/.test(path)) return json(res, 200, { code: 1 });
        if (method === 'PATCH' && path === '/settings') return json(res, 200, {});
        return json(res, 404, { message: `stub-maintainerr: no write handler for ${method} ${path}` });
      }

      // ---- reads ----
      switch (true) {
        case path === '/app/status':
          return json(res, 200, { status: 'ok', version: '3.17.0', commitTag: 'e2e', updateAvailable: false });
        case path === '/settings/test/plex':
          return json(res, 200, { status: 'OK', code: 1, message: 'Plex 1.40 (stub)' });
        case path === '/rules/constants':
          return json(res, 200, {
            applications: [
              { id: 0, name: 'Plex' },
              { id: 2, name: 'Radarr' },
              { id: 3, name: 'Sonarr' },
              { id: 4, name: 'Overseerr' },
              { id: 5, name: 'Tautulli' },
            ],
          });
        case path === '/rules':
          return json(res, 200, []);
        case path === '/settings':
          return json(res, 200, {
            radarr_tag_exclusions: true,
            radarr_exclusion_tag: 'dnd',
            radarr_untag_on_unexclude: true,
            sonarr_tag_exclusions: true,
            sonarr_exclusion_tag: 'dnd',
            sonarr_untag_on_unexclude: true,
          });
        case path === '/collections':
          return json(res, 200, [{ ...COLLECTION }]);
        case /^\/collections\/media\/\d+\/content\/\d+$/.test(path): {
          const cid = Number(path.split('/')[3]);
          const items = cid === COLLECTION.id ? COLLECTION_ITEMS : [];
          return json(res, 200, { totalSize: items.length, items });
        }
        case path === '/rules/exclusion': {
          const id = query.mediaServerId;
          return json(res, 200, id !== undefined && exclusions.has(id) ? [{ id: 1, mediaServerId: id, ruleGroupId: null }] : []);
        }
        default:
          return json(res, 404, { message: `stub-maintainerr: no read handler for GET ${path}` });
      }
    })().catch((err: unknown) => json(res, 500, { message: `stub-maintainerr error: ${String(err)}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-maintainerr failed to bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
