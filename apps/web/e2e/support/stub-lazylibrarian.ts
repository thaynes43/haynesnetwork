// ADR-055 / DESIGN-028 (PLAN-044) — the hermetic LazyLibrarian stub: the query-string command API
// (`/api?cmd=…&id=…&apikey=…`) the confined LL client drives, plus a call RECORDER (`/_stub/calls` +
// `/_stub/reset`, the stub-arr idiom) so a spec can assert the both-format queueBook push + the manual
// searchBook. Canned per-book statuses: gb-rpo LANDS (Open), gb-tog is dead-end Missing (Ignored) — the
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

/**
 * The per-book status the stub reports (drives the reconcile → per-format request state). gb-tog is
 * `Ignored` — the remaining DEAD-END Missing (the Search-again target): raw `Skipped` now auto-requeues
 * via the sweep (DESIGN-028 amendment 2026-07-15), so a fixture that must STAY Missing pins Ignored.
 */
function bookStatus(id: string): { BookID: string; Status: string; AudioStatus: string } {
  if (id === 'gb-rpo') return { BookID: id, Status: 'Open', AudioStatus: 'Open' }; // landed → covered
  if (id === 'gb-tog') return { BookID: id, Status: 'Ignored', AudioStatus: 'Ignored' }; // dead-end Missing
  // ADR-057 (PLAN-045) — the READ-shelf covered book: LL already holds it (landed → covered).
  if (id === 'gb-martian') return { BookID: id, Status: 'Open', AudioStatus: 'Open' };
  return { BookID: id, Status: 'Wanted', AudioStatus: 'Wanted' };
}

/** Every book id the stub "knows" — the `getAllBooks` universe (comics never reach LL). */
const KNOWN_BOOK_IDS = ['gb-rpo', 'gb-tog', 'gb-martian', 'gb-hyp', 'gb-phm'];

// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the wanted-table fixture the Activity books
// adapter reads (`cmd=getWanted`). It spans every in-flight stage + the incident: a searching row, a
// SAB-downloading row (paired to the SAB queue slot), the STRANDED import (Snatched + SAB-Completed but
// aged past the horizon — the OPS-013 §11 42-book class), an LL post-process failure, and a dead usenet
// download (Snatched + SAB-Failed). The DownloadIDs join to the SAB stub's queue/history nzo_ids.
const AGED = '2020-01-01 00:00:00'; // well past the strand horizon → the SAB-Completed row reads as stranded
function wantedRows(): Array<Record<string, string>> {
  return [
    { BookID: 'act-search', NZBtitle: 'A Book Still Searching', Status: 'Wanted', AuxInfo: 'eBook' },
    {
      BookID: 'act-dl',
      NZBtitle: 'A Book Downloading Now',
      Status: 'Snatched',
      Source: 'SABNZBD',
      DownloadID: 'sab-dl-1',
      AuxInfo: 'eBook',
      NZBdate: AGED,
    },
    {
      BookID: 'act-strand',
      NZBtitle: 'The Stranded Import',
      Status: 'Snatched',
      Source: 'SABNZBD',
      DownloadID: 'sab-strand-1',
      AuxInfo: 'eBook',
      NZBdate: AGED,
    },
    {
      BookID: 'act-ppfail',
      NZBtitle: 'A Book That Failed To Import',
      Status: 'Failed',
      AuxInfo: 'AudioBook',
      DLResult: 'Postprocessing failed — Progress: 0%',
      NZBdate: AGED,
    },
    {
      BookID: 'act-dlfail',
      NZBtitle: 'A Dead Usenet Download',
      Status: 'Snatched',
      Source: 'SABNZBD',
      DownloadID: 'sab-dead-1',
      AuxInfo: 'eBook',
      NZBdate: AGED,
    },
  ];
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
      if (cmd === 'addBook' || cmd === 'queueBook' || cmd === 'searchBook' || cmd === 'forceProcess') {
        calls.push({ cmd, id, type });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('OK');
        return;
      }
      if (cmd === 'getAllBooks') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(KNOWN_BOOK_IDS.map(bookStatus)));
        return;
      }
      if (cmd === 'getBook') {
        // Mirror the REAL deployed LL build: it has no getBook command (found 2026-07-15) — any caller
        // that reaches for it must fail visibly here too, never get a comforting canned answer.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Success: false, Data: '', Error: { Code: 405, Message: 'Unknown command: getBook, try cmd=help' } }));
        return;
      }
      if (cmd === 'getWanted') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(wantedRows()));
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
