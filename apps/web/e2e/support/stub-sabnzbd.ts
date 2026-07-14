// ADR-059 / DESIGN-030 (PLAN-048 — Activity / In-Flight) — the hermetic SABnzbd stub: the query-string
// command API (`/api?mode=queue|history&output=json&apikey=…`) the Activity books adapter reads for the
// download/import stage + strand detection, plus the recorder (`/_stub/calls` + `/_stub/reset`, the
// stub-lazylibrarian idiom). The fixture pairs to the LL stub's wanted rows by nzo_id: `sab-dl-1` is
// downloading (55%), `sab-strand-1` COMPLETED at SAB's haynestower root (the stranded-import class —
// OPS-013 §11), `sab-dead-1` FAILED (dead nzb). The history read is served regardless of `archive` (the
// SAB v5 archive caveat is honored by always returning the aged job).
import { createServer, type Server } from 'node:http';

export const STUB_SABNZBD_API_KEY = 'stub-sab-key';

export interface SabRecordedCall {
  mode: string;
}

export interface StubSabnzbdServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

function queueBody() {
  return {
    queue: {
      slots: [
        {
          nzo_id: 'sab-dl-1',
          filename: 'A Book Downloading Now',
          percentage: '55',
          status: 'Downloading',
          cat: 'lazylibrarian',
        },
      ],
    },
  };
}

function historyBody() {
  return {
    history: {
      slots: [
        {
          nzo_id: 'sab-strand-1',
          name: 'The Stranded Import',
          status: 'Completed',
          category: 'lazylibrarian',
          // The tell of the incident: completed at SAB's haynestower root, not the cephfs category dir.
          storage: '/data/haynestower/usenet/complete-k8s/The Stranded Import',
          fail_message: '',
        },
        {
          nzo_id: 'sab-dead-1',
          name: 'A Dead Usenet Download',
          status: 'Failed',
          category: 'lazylibrarian',
          storage: '',
          fail_message: 'Par2 repair failed — download incomplete',
        },
      ],
    },
  };
}

export async function startStubSabnzbd(): Promise<StubSabnzbdServer> {
  const calls: SabRecordedCall[] = [];

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
      const mode = url.searchParams.get('mode') ?? '';
      calls.push({ mode });
      if (mode === 'queue') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(queueBody()));
        return;
      }
      if (mode === 'history') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(historyBody()));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: true }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `stub-sabnzbd: no handler for ${method} ${path}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub-sabnzbd: no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
