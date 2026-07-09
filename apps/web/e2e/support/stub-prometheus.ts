// ADR-030 amendment (2026-07-09) / DESIGN-013 D-07 — a stub Prometheus for the native free-space
// trend: a scriptable `GET /api/v1/query_range` that SYNTHESIZES the exportarr matrix across
// whatever range/step the app asks for, so every window (7d..365d) renders a full, deterministic
// chart. Series wear the LIVE label shapes — the `path` is the *arr ROOTFOLDER
// (`/data/haynestower/Media/Movies`), one level under the STORAGE_ARRAYS mount — so the e2e run
// exercises the same prefix mapping production does. Wired into the default stack env
// (PROMETHEUS_URL) by composeRuntimeEnv; specs script it via POST /_stub/state:
//   { mode: 'down' }  ⇒ query_range answers 500 (the trend's `unavailable` degrade);
//   { mode: 'ok' }    ⇒ back to the synthesized series (the default).
import { createServer, type Server } from 'node:http';

const TB = 1_000_000_000_000;

/** Linear fill/drain per series over the queried range (values are deterministic in t, so a
 *  re-query of the same range yields identical samples). End values mirror the stub *arr
 *  /diskspace numbers, so chart, legend, and meters all agree on the current reading. */
const SERIES: { name: string; path: string; startFree: number; endFree: number }[] = [
  {
    name: 'radarr_rootfolder_freespace_bytes',
    path: '/data/haynestower/Media/Movies',
    startFree: 120 * TB,
    endFree: 112.4304 * TB,
  },
  {
    // Sonarr reports the SAME physical array (identical readings) — proves the radarr-first dedupe.
    name: 'sonarr_rootfolder_freespace_bytes',
    path: '/data/haynestower/Media/TV Shows',
    startFree: 120 * TB,
    endFree: 112.4304 * TB,
  },
  {
    name: 'lidarr_rootfolder_freespace_bytes',
    path: '/data/media/music',
    startFree: 130.45 * TB,
    endFree: 130.45 * TB, // the music pool holds steady — a flat line among drains
  },
];

export interface StubPrometheusServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

export async function startStubPrometheus(): Promise<StubPrometheusServer> {
  let mode: 'ok' | 'down' = 'ok';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/_stub/state') {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        try {
          const next = (JSON.parse(raw) as { mode?: string }).mode;
          if (next === 'ok' || next === 'down') mode = next;
          json(200, { mode });
        } catch {
          json(400, { error: 'bad state body' });
        }
      });
      return;
    }

    if (url.pathname === '/api/v1/query_range') {
      if (mode === 'down') return json(500, { status: 'error', error: 'stub prometheus is down' });
      const start = Number(url.searchParams.get('start'));
      const end = Number(url.searchParams.get('end'));
      const step = Number(url.searchParams.get('step'));
      if (![start, end, step].every(Number.isFinite) || step <= 0 || end < start) {
        return json(400, { status: 'error', error: 'bad range params' });
      }
      const result = SERIES.map((s) => {
        const values: [number, string][] = [];
        for (let t = start; t <= end; t += step) {
          const frac = end === start ? 1 : (t - start) / (end - start);
          const v = s.startFree + (s.endFree - s.startFree) * frac;
          values.push([t, String(Math.round(v))]);
        }
        return { metric: { __name__: s.name, path: s.path }, values };
      });
      return json(200, { status: 'success', data: { resultType: 'matrix', result } });
    }

    return json(404, { error: `stub-prometheus: no handler for ${req.method} ${url.pathname}` });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub-prometheus failed to bind a port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
