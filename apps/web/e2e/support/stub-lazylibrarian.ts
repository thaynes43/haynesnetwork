// ADR-055 / DESIGN-028 (PLAN-044) — the hermetic LazyLibrarian stub: the query-string command API
// (`/api?cmd=…&id=…&apikey=…`) the confined LL client drives, plus a call RECORDER (`/_stub/calls` +
// `/_stub/reset`, the stub-arr idiom) so a spec can assert the both-format queueBook push + the manual
// searchBook. Canned per-book statuses: gb-rpo LANDS (Open), gb-tog is Missing (Skipped) — the
// Search-again target. NEVER models LL provider config (out of scope by design).
import { createServer, type Server } from 'node:http';

export const STUB_LAZYLIBRARIAN_API_KEY = 'stub-ll-key';

export interface LlRecordedCall {
  cmd: string;
  id: string | null;
  type: string | null;
}

export interface StubLazyLibrarianServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

/** The per-book status the stub reports (drives the reconcile → per-format request state). */
function bookStatus(id: string): { BookID: string; Status: string; AudioStatus: string } {
  if (id === 'gb-rpo') return { BookID: id, Status: 'Open', AudioStatus: 'Open' }; // landed → covered
  if (id === 'gb-tog') return { BookID: id, Status: 'Skipped', AudioStatus: 'Skipped' }; // Missing
  return { BookID: id, Status: 'Wanted', AudioStatus: 'Wanted' };
}

export async function startStubLazyLibrarian(): Promise<StubLazyLibrarianServer> {
  const calls: LlRecordedCall[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/_stub/calls' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ calls }));
      return;
    }
    if (path === '/_stub/reset' && method === 'POST') {
      calls.length = 0;
      res.writeHead(204);
      res.end();
      return;
    }

    if (path === '/api') {
      const cmd = url.searchParams.get('cmd') ?? '';
      const id = url.searchParams.get('id');
      const type = url.searchParams.get('type');
      if (cmd === 'addBook' || cmd === 'queueBook' || cmd === 'searchBook') {
        calls.push({ cmd, id, type });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('OK');
        return;
      }
      if (cmd === 'getBook') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(id ? bookStatus(id) : null));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('OK');
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `stub-lazylibrarian: no handler for ${method} ${path}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub-lazylibrarian: no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
