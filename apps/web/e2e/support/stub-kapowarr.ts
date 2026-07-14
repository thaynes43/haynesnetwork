// ADR-056 (PLAN-046) + ADR-059 / DESIGN-030 D-08 (PLAN-048) — the hermetic Kapowarr stub: the REST surface
// the confined @hnet/kapowarr client drives — ComicVine volume search, the root-folder list, add-volume,
// volume detail (for reconcile), the `auto_search` task submit, AND the Activity reads (the live download
// `queue`, the running `tasks`, the completed `history`) — plus a call RECORDER (`/_stub/calls` +
// `/_stub/reset`) and a scriptable Activity stager (`/_stub/queue`, the stub-arr idiom) so a spec can assert
// the comic add + force-search AND drive the live Activity tab's comics leg. Kapowarr wraps every body in
// `{ error, result }`. Canned data mirrors the live 2026-07-14 ComicVine search so the resolver picks the
// ORIGINAL Scott Pilgrim (Oni Press cv 25478) over the translated German reprint. NEVER models MAM/qB/Prowlarr.
import { createServer, type Server } from 'node:http';

export const STUB_KAPOWARR_API_KEY = 'stub-kapowarr-key';

export interface KapowarrRecordedCall {
  method: string;
  path: string;
  comicvineId?: number;
  volumeId?: number;
  cmd?: string;
}

export interface StubKapowarrServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

/** The canned ComicVine search results (query-keyed; Scott Pilgrim → the live-shaped candidate set). */
function searchResultsFor(query: string): unknown[] {
  if (/scott|pilgrim/i.test(query)) {
    return [
      { comicvine_id: 61857, title: 'Scott Pilgrim', year: 2010, volume_number: 1, publisher: 'Panini Verlag', issue_count: 6, translated: true, already_added: null },
      { comicvine_id: 25478, title: 'Scott Pilgrim', year: 2004, volume_number: 1, publisher: 'Oni Press', issue_count: 6, translated: false, already_added: null },
      { comicvine_id: 51110, title: 'Scott Pilgrim Color', year: 2012, volume_number: 1, publisher: 'Oni Press', issue_count: 6, translated: false, already_added: null },
    ];
  }
  return [];
}

/**
 * ADR-059 / DESIGN-030 D-08 (PLAN-048 — Activity / In-Flight) — the Kapowarr Activity queue fixtures: a
 * DOWNLOADING comic (Saga, ~55% → `downloading`) + a FAILED comic (The Dead Grab, Kapowarr `status: 'failed'`
 * → `download_failed`, re-search only). Staged via `POST /_stub/queue` and served by `GET /api/activity/queue`,
 * these drive the live Activity tab's comics leg. Kapowarr entries carry `volume_id` (the comics-wall + ledger
 * join key). Kapowarr acquires from ITS OWN GetComics DDL sources — NEVER MAM/qB/Prowlarr.
 */
export function kapowarrActivityQueueFixture(): Record<string, unknown>[] {
  return [
    {
      id: 91001,
      volume_id: 811,
      issue_id: 8110,
      status: 'downloading',
      progress: 55,
      size: 500_000_000,
      web_title: 'Saga Volume 1 (2012)',
      source: 'GetComics (direct)',
    },
    {
      id: 91002,
      volume_id: 812,
      issue_id: 8120,
      status: 'failed',
      progress: 0,
      web_title: 'The Dead Grab (2019)',
      source: 'GetComics (torrent)',
    },
  ];
}

export async function startStubKapowarr(): Promise<StubKapowarrServer> {
  const calls: KapowarrRecordedCall[] = [];
  // Added volumes: id → live state (drives the reconcile → comic_status).
  const volumes = new Map<number, { comicvine_id: number; monitored: boolean; issue_count: number; issues_downloaded: number }>();
  let nextId = 700;
  // PLAN-048 / DESIGN-030 D-08 — the scriptable Activity state (staged via POST /_stub/queue). Empty by
  // default so a spec that never stages sees no comics leg.
  let queueRecords: Record<string, unknown>[] = [];
  let historyRecords: Record<string, unknown>[] = [];
  let taskRecords: Record<string, unknown>[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    const sendJson = (status: number, result: unknown, error: unknown = null): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error, result }));
    };

    if (path === '/_stub/calls' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ calls }));
      return;
    }
    if (path === '/_stub/reset' && method === 'POST') {
      calls.length = 0;
      volumes.clear();
      queueRecords = [];
      historyRecords = [];
      taskRecords = [];
      res.writeHead(204);
      res.end();
      return;
    }
    // PLAN-048 — stage the Activity state: { queue?, history?, tasks? }.
    if (path === '/_stub/queue' && method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = body
          ? (JSON.parse(body) as { queue?: Record<string, unknown>[]; history?: Record<string, unknown>[]; tasks?: Record<string, unknown>[] })
          : {};
        queueRecords = Array.isArray(parsed.queue) ? parsed.queue : [];
        historyRecords = Array.isArray(parsed.history) ? parsed.history : [];
        taskRecords = Array.isArray(parsed.tasks) ? parsed.tasks : [];
        res.writeHead(204);
        res.end();
      });
      return;
    }
    // PLAN-048 — the Activity reads the adapter folds (all READ-ONLY).
    if (path === '/api/activity/queue' && method === 'GET') {
      sendJson(200, queueRecords);
      return;
    }
    if (path === '/api/activity/history' && method === 'GET') {
      sendJson(200, historyRecords);
      return;
    }
    if (path === '/api/system/tasks' && method === 'GET') {
      sendJson(200, taskRecords);
      return;
    }
    // The added-volume LIST (only paged by the adapter when a search task is running).
    if (path === '/api/volumes' && method === 'GET') {
      sendJson(
        200,
        [...volumes.entries()].map(([id, v]) => ({ id, title: 'Scott Pilgrim', ...v })),
      );
      return;
    }

    // ComicVine volume search.
    if (path === '/api/volumes/search' && method === 'GET') {
      calls.push({ method, path });
      sendJson(200, searchResultsFor(url.searchParams.get('query') ?? ''));
      return;
    }
    // Root folders.
    if (path === '/api/rootfolder' && method === 'GET') {
      sendJson(200, [{ id: 1, folder: '/data/media/books/Comics/', size: { total: 1, used: 0, free: 1 } }]);
      return;
    }
    // Add a volume (monitored) → returns the new volume public data.
    if (path === '/api/volumes' && method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = body ? (JSON.parse(body) as { comicvine_id: number }) : { comicvine_id: 0 };
        const id = nextId++;
        volumes.set(id, { comicvine_id: parsed.comicvine_id, monitored: true, issue_count: 6, issues_downloaded: 0 });
        calls.push({ method, path, comicvineId: parsed.comicvine_id, volumeId: id });
        sendJson(201, { id, comicvine_id: parsed.comicvine_id, title: 'Scott Pilgrim', monitored: true, issue_count: 6, issues_downloaded: 0 });
      });
      return;
    }
    // Volume detail (reconcile).
    const volMatch = /^\/api\/volumes\/(\d+)$/.exec(path);
    if (volMatch && method === 'GET') {
      const id = Number(volMatch[1]);
      const v = volumes.get(id);
      if (!v) {
        sendJson(404, null, 'VolumeNotFound');
        return;
      }
      sendJson(200, { id, title: 'Scott Pilgrim', ...v });
      return;
    }
    // The task submit (auto_search — the force-search).
    if (path === '/api/system/tasks' && method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = body ? (JSON.parse(body) as { cmd?: string; volume_id?: number }) : {};
        calls.push({ method, path, cmd: parsed.cmd, volumeId: parsed.volume_id });
        sendJson(200, null);
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'NotFound', result: null, message: `stub-kapowarr: no handler for ${method} ${path}` }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub-kapowarr: no port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
