// ADR-079 / DESIGN-004 D-25 e2e — stub Gatus HTTP server (mirrors stub-maintainerr). Serves
// the two reads the uptime badge resolves against, with the LIVE wire quirks preserved:
// the uptimes endpoints answer a PLAIN-TEXT float 0..1 (Content-Type text/plain), and the
// statuses endpoint carries a top-level `uptime: null` (proving the app never parses it —
// current status comes from `results[last].success`). Wired into harness.ts / env.ts so
// both Playwright e2e and `pnpm dev:local` boot a complete Home stack.
//
// Control endpoints:
//   POST /_stub/state → 204; body { mode?: 'up'|'down'|'unreachable', uptimes?: {…} } —
//                       flip the badge state (unreachable ⇒ every API read answers 503,
//                       which the app degrades to the honest "unmeasured" badge).
//   POST /_stub/reset → 204 (back to the up-state defaults).
import { createServer } from 'node:http';

/** The endpoint key the harness pins via GATUS_UPTIME_ENDPOINT_KEY (the live apex check's). */
export const STUB_GATUS_ENDPOINT_KEY = 'external_haynesnetwork';

export type StubGatusMode = 'up' | 'down' | 'unreachable';

export interface StubGatusUptimes {
  '1h': number;
  '24h': number;
  '7d': number;
  '30d': number;
}

/** The up-state defaults (live-shaped ratios; 30d renders as "99.98%"). */
export const STUB_GATUS_DEFAULT_UPTIMES: StubGatusUptimes = {
  '1h': 1,
  '24h': 1,
  '7d': 0.99913,
  '30d': 0.999783,
};

export interface StubGatusServer {
  baseUrl: string;
  port: number;
  stop: () => Promise<void>;
}

export async function startStubGatus(): Promise<StubGatusServer> {
  let mode: StubGatusMode = 'up';
  let uptimes: StubGatusUptimes = { ...STUB_GATUS_DEFAULT_UPTIMES };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      if (req.method === 'POST' && path === '/_stub/state') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as {
          mode?: StubGatusMode;
          uptimes?: Partial<StubGatusUptimes>;
        };
        if (body.mode) mode = body.mode;
        if (body.uptimes) uptimes = { ...uptimes, ...body.uptimes };
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'POST' && path === '/_stub/reset') {
        mode = 'up';
        uptimes = { ...STUB_GATUS_DEFAULT_UPTIMES };
        res.writeHead(204).end();
        return;
      }

      if (mode === 'unreachable') {
        // The app's GET retries (502/503/504 ×2) all land here — then it degrades honestly.
        return json(503, { message: 'stub-gatus: unreachable mode' });
      }

      const uptimeMatch = /^\/api\/v1\/endpoints\/([^/]+)\/uptimes\/(1h|24h|7d|30d)$/.exec(path);
      if (req.method === 'GET' && uptimeMatch) {
        if (uptimeMatch[1] !== STUB_GATUS_ENDPOINT_KEY) {
          return json(404, { message: `stub-gatus: unknown endpoint key ${uptimeMatch[1]}` });
        }
        // The LIVE quirk: a bare plain-text float, not JSON.
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(String(uptimes[uptimeMatch[2] as keyof StubGatusUptimes]));
        return;
      }

      const statusMatch = /^\/api\/v1\/endpoints\/([^/]+)\/statuses$/.exec(path);
      if (req.method === 'GET' && statusMatch) {
        if (statusMatch[1] !== STUB_GATUS_ENDPOINT_KEY) {
          return json(404, { message: `stub-gatus: unknown endpoint key ${statusMatch[1]}` });
        }
        // Live shape: top-level `uptime` is null (never a ratio source); newest result LAST.
        return json(200, {
          name: 'haynesnetwork.com',
          group: 'external',
          key: STUB_GATUS_ENDPOINT_KEY,
          uptime: null,
          results: [
            { success: true, timestamp: new Date(Date.now() - 120_000).toISOString() },
            { success: mode === 'up', timestamp: new Date().toISOString() },
          ],
        });
      }

      return json(404, { message: `stub-gatus: no handler for ${req.method} ${path}` });
    })().catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: `stub-gatus error: ${String(err)}` }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-gatus failed to bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
