// DESIGN-005 test strategy — stub *arr HTTP server for e2e (mirrors the stub-OIDC
// pattern; extracted from the packages/sync fetch-stub approach into a real HTTP
// server because the Next dev server calls the *arrs over the network). Serves the
// fixture-shaped READ endpoints the fix flow resolves against and accepts the two
// sanctioned WRITE endpoints (history/failed, command), RECORDING every mutating
// call so specs can assert AC-07's blocklist+search happened with the right ids.
//
// One server stands in for all four services (SONARR_URL etc. all point here) —
// the suite only drives the Sonarr fix journey; the others just need parseable
// endpoints if ever touched.
//
// Control endpoints:
//   GET  /_stub/calls  → { calls: [{method, path, query, body}] } (writes only)
//   POST /_stub/reset  → 204 (clears recorded calls)
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface RecordedArrWrite {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface StubArrServer {
  baseUrl: string;
  port: number;
  /** Recorded mutating calls (POST/DELETE) — the spec-facing audit trail. */
  calls: RecordedArrWrite[];
  stop: () => Promise<void>;
}

/** The seeded Sonarr series the e2e ledger row mirrors (see seed-ledger.ts). */
export const STUB_SERIES_ID = 501;
export const STUB_SERIES_TVDB_ID = 990001;
/** Grab-history ids are derived so specs can predict them: 700000 + episodeId. */
export const grabHistoryIdFor = (episodeId: number) => 700_000 + episodeId;

const EPISODE_COUNT = 10;

function episodes() {
  return Array.from({ length: EPISODE_COUNT }, (_, i) => {
    const n = i + 1;
    const hasFile = n !== 10; // E10 missing → the ledger row shows 9/10
    return {
      id: STUB_SERIES_ID * 100 + n,
      seriesId: STUB_SERIES_ID,
      seasonNumber: 1,
      episodeNumber: n,
      title: `Chapter ${n}`,
      airDateUtc: `2021-03-${String(n).padStart(2, '0')}T01:00:00Z`,
      hasFile,
      monitored: true,
      ...(hasFile ? { episodeFileId: 3000 + n } : {}),
    };
  });
}

function seriesResource(id: number) {
  return {
    id,
    title: 'Breaking Prod',
    sortTitle: 'breaking prod',
    year: 2019,
    tvdbId: STUB_SERIES_TVDB_ID,
    monitored: true,
    monitorNewItems: 'all',
    qualityProfileId: 7,
    rootFolderPath: '/data/haynestower/Media/TV Shows',
    path: '/data/haynestower/Media/TV Shows/Breaking Prod',
    tags: [1],
    statistics: {
      episodeFileCount: 9,
      episodeCount: 10,
      totalEpisodeCount: 10,
      sizeOnDisk: 21_474_836_480,
    },
    seriesType: 'standard',
    seasonFolder: true,
    status: 'ended',
    ended: true,
    added: '2025-01-01T00:00:00Z',
  };
}

function grabRecord(episodeId: number) {
  return {
    id: grabHistoryIdFor(episodeId),
    eventType: 'grabbed',
    date: '2026-07-01T10:00:00Z',
    sourceTitle: `Breaking.Prod.S01E${String(episodeId % 100).padStart(2, '0')}.MULTi.1080p.WEB-DL`,
    downloadId: `dl-${episodeId}`,
    quality: { quality: { id: 4, name: 'WEBDL-1080p' } },
    data: { indexer: 'StubIndexer', releaseGroup: 'STUB' },
    episodeId,
    seriesId: STUB_SERIES_ID,
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

export async function startStubArr(): Promise<StubArrServer> {
  const calls: RecordedArrWrite[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      // Normalize the API base away: /api/v3/... and /api/v1/... share handlers.
      const path = url.pathname.replace(/^\/api\/v[13]/, '');
      const query = Object.fromEntries(url.searchParams.entries());

      // ---- control surface ----
      if (url.pathname === '/_stub/calls') {
        return json(res, 200, { calls });
      }
      if (url.pathname === '/_stub/reset' && method === 'POST') {
        calls.length = 0;
        res.writeHead(204);
        return res.end();
      }

      if (method === 'POST' || method === 'DELETE') {
        const raw = await readBody(req);
        const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
        calls.push({ method, path, query, body });

        // POST /history/failed/{id} — the AC-07 blocklist write. No response body.
        if (method === 'POST' && /^\/history\/failed\/\d+$/.test(path)) {
          return json(res, 200, {});
        }
        // POST /command — search trigger; echo the command name back with an id.
        if (method === 'POST' && path === '/command') {
          const name =
            typeof body === 'object' && body !== null && 'name' in body
              ? String((body as { name: unknown }).name)
              : 'UnknownCommand';
          return json(res, 201, { id: 4242, name });
        }
        // File deletes (AC-08 fallback) — accepted, recorded.
        if (method === 'DELETE' && /^\/(episodefile|moviefile|trackfile)\/\d+$/.test(path)) {
          return json(res, 200, {});
        }
        // POST /series|/movie|/artist|/tag (restore surface) — echo minimal resources.
        if (method === 'POST' && path === '/tag') {
          return json(res, 201, {
            id: 99,
            label: String((body as { label?: unknown })?.label ?? ''),
          });
        }
        if (method === 'POST' && path === '/series') {
          return json(res, 201, seriesResource(9001));
        }
        return json(res, 404, { message: `stub-arr: no write handler for ${method} ${path}` });
      }

      // ---- reads ----
      switch (path) {
        case '/system/status':
          return json(res, 200, { appName: 'StubArr', version: '0.0.0-e2e' });
        case '/series':
          return json(res, 200, [seriesResource(STUB_SERIES_ID)]);
        case '/movie':
        case '/artist':
          return json(res, 200, []);
        case '/episode': {
          if (Number(query.seriesId) !== STUB_SERIES_ID) return json(res, 200, []);
          return json(res, 200, episodes());
        }
        case '/history': {
          // Latest-grab lookup: ?episodeId=&eventType=grabbed (paged envelope).
          const episodeId = Number(query.episodeId ?? Number.NaN);
          const records =
            query.eventType === 'grabbed' && Number.isFinite(episodeId)
              ? [grabRecord(episodeId)]
              : [];
          return json(res, 200, {
            page: 1,
            pageSize: 20,
            sortKey: 'date',
            sortDirection: 'descending',
            totalRecords: records.length,
            records,
          });
        }
        case '/history/movie':
          return json(res, 200, []);
        case '/qualityprofile':
          return json(res, 200, [
            { id: 7, name: 'HD-1080p' },
            { id: 1, name: 'Any' },
          ]);
        case '/metadataprofile':
          return json(res, 200, [{ id: 1, name: 'Standard' }]);
        case '/rootfolder':
          return json(res, 200, [{ id: 1, path: '/data/haynestower/Media/TV Shows' }]);
        case '/tag':
          return json(res, 200, [{ id: 1, label: 'mediarequests' }]);
        case '/trackfile':
          return json(res, 200, []);
        default:
          return json(res, 404, { message: `stub-arr: no read handler for GET ${path}` });
      }
    })().catch((err: unknown) => {
      json(res, 500, { message: `stub-arr error: ${String(err)}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-arr failed to bind a port');
  }
  const port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    calls,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
