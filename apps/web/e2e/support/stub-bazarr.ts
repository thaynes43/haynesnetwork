// ADR-016 / DESIGN-005 D-19 — stub Bazarr HTTP server for e2e (mirrors stub-arr.ts). The
// missing_subtitles Fix routes to Bazarr, so the suite drives it against this hermetic
// stand-in: it serves the fixture-shaped subtitle-state READ endpoints (each echoing the
// requested id with one missing English sub) and accepts the `search-missing` PATCH writes,
// RECORDING every mutating call (PATCH/POST/DELETE) so specs can assert the search fired
// with the right id. Base path `/api` is NOT stripped (Bazarr endpoints are /api/movies,
// /api/series, /api/episodes). Auth header X-API-KEY is accepted but not checked (stub).
//
// Control endpoints:
//   GET  /_stub/calls  → { calls: [{method, path, query, body}] } (writes only)
//   POST /_stub/reset  → 204 (clears recorded calls)
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface RecordedBazarrCall {
  method: string;
  /** Full pathname (base path NOT stripped), e.g. '/api/series'. */
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface StubBazarrServer {
  baseUrl: string;
  port: number;
  /** Every request the app made (reads + writes), in order — the spec-facing audit trail. */
  calls: RecordedBazarrCall[];
  stop: () => Promise<void>;
}

/** The throwaway key the stub accepts (never a real credential). */
export const STUB_BAZARR_API_KEY = 'stub-bazarr-key';

/** One missing English subtitle — the canned "wanted" state every title reports. */
const MISSING_ENGLISH = { name: 'English', code2: 'en', code3: 'eng', forced: false, hi: false };

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function startStubBazarr(): Promise<StubBazarrServer> {
  const calls: RecordedBazarrCall[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const method = req.method ?? 'GET';
      const path = url.pathname; // base path /api NOT stripped
      const query = Object.fromEntries(url.searchParams.entries());

      // ---- control surface (never recorded) ----
      if (url.pathname === '/_stub/calls') {
        return json(res, 200, { calls });
      }
      if (url.pathname === '/_stub/reset' && method === 'POST') {
        calls.length = 0;
        res.writeHead(204);
        return res.end();
      }

      // Record every app request (reads + writes) so specs can assert the pre-read GET and
      // the search-missing PATCH alike.
      const raw = method === 'GET' ? '' : await readBody(req);
      const body = raw === '' ? undefined : (JSON.parse(raw) as unknown);
      calls.push({ method, path, query, body });

      // ---- writes (PATCH search-missing; POST/DELETE tolerated) ----
      if (method === 'PATCH' || method === 'POST' || method === 'DELETE') {
        // PATCH /api/movies|/api/series?...&action=search-missing → async/queued (HTTP 204).
        if (method === 'PATCH' && (path === '/api/movies' || path === '/api/series')) {
          res.writeHead(204);
          return res.end();
        }
        return json(res, 404, { message: `stub-bazarr: no write handler for ${method} ${path}` });
      }

      // ---- reads: subtitle state, echoing the requested id with one missing English sub ----
      if (path === '/api/movies') {
        const radarrId = Number(url.searchParams.get('radarrid[]') ?? Number.NaN);
        const data = Number.isFinite(radarrId)
          ? [{ radarrId, title: 'Stub Movie', missing_subtitles: [MISSING_ENGLISH] }]
          : [];
        return json(res, 200, { data });
      }
      if (path === '/api/episodes') {
        const episodeId = Number(url.searchParams.get('episodeid[]') ?? Number.NaN);
        const data = Number.isFinite(episodeId)
          ? [
              {
                sonarrSeriesId: 501,
                sonarrEpisodeId: episodeId,
                season: 1,
                episode: 1,
                title: 'Stub Episode',
                missing_subtitles: [MISSING_ENGLISH],
              },
            ]
          : [];
        return json(res, 200, { data });
      }
      if (path === '/api/system/status' || path === '/api/system/ping') {
        return json(res, 200, { data: { bazarr_version: '1.5.6-e2e' } });
      }
      return json(res, 404, { message: `stub-bazarr: no read handler for GET ${path}` });
    })().catch((err: unknown) => {
      json(res, 500, { message: `stub-bazarr error: ${String(err)}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-bazarr failed to bind a port');
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
