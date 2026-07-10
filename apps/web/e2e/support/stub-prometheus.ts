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

    // PLAN-017 / DESIGN-016 — INSTANT queries for the Metrics Overview. The Overview server code
    // issues each PromQL `expr` via GET /api/v1/query; we return a canned instant VECTOR chosen by
    // substring match on `query`, so a re-query yields identical (deterministic) samples that mirror
    // the WAN/cluster readings the page renders. `{ mode: 'down' }` degrades to 500 like the range
    // handler. More-specific matches are checked FIRST (the count()-wrapped node_load1 forms before
    // the bare node_load1; the WAN sum()s before anything).
    if (url.pathname === '/api/v1/query') {
      if (mode === 'down') return json(500, { status: 'error', error: 'stub prometheus is down' });
      const q = url.searchParams.get('query') ?? '';
      const sample = (metric: Record<string, string>, v: string) => ({
        metric,
        value: [Math.floor(Date.now() / 1000), v] as [number, string],
      });
      const vector = (result: ReturnType<typeof sample>[]) =>
        json(200, { status: 'success', data: { resultType: 'vector', result } });

      // WAN throughput (aggregate bytes/sec) — the sum() wrappers still carry these substrings.
      if (q.includes('transmit_rate_bytes')) return vector([sample({ subsystem: 'wan' }, '1454880')]);
      if (q.includes('receive_rate_bytes')) return vector([sample({ subsystem: 'wan' }, '844568')]);
      // Per-uplink capacity kbps (FULL level only) — two uplinks, labelled by wan_name/wan_id.
      if (q.includes('provider_upload_kbps'))
        return vector([
          sample({ wan_name: 'Internet 1', wan_id: 'a' }, '316000'),
          sample({ wan_name: 'Internet 2', wan_id: 'b' }, '350000'),
        ]);
      if (q.includes('provider_download_kbps'))
        return vector([
          sample({ wan_name: 'Internet 1', wan_id: 'a' }, '2256000'),
          sample({ wan_name: 'Internet 2', wan_id: 'b' }, '2300000'),
        ]);
      // Cluster CPU / load / memory. The count()-wrapped forms are MORE specific than the bare
      // node_load1, so they must be matched before it.
      if (q.includes('count by (instance, cpu)')) return vector([sample({}, '132')]); // total cores
      if (q.includes('count(node_load1)')) return vector([sample({}, '6')]); // node count
      if (q.includes('node_load1')) return vector([sample({}, '18.5')]); // sum(node_load1) — cluster load
      if (q.includes('MemTotal')) return vector([sample({}, '529642733568')]); // total mem bytes
      if (q.includes('MemAvailable')) return vector([sample({}, '384401444864')]); // available mem bytes

      // PLAN-018 / DESIGN-018 — the Apps sub-tab series (*arr + downloaders + indexers). Substring
      // matches (more-specific *_monitored_/_missing_/_cutoff_unmet_total forms are distinct from the
      // bare *_total, so order among these does not matter). Values mirror the live 2026-07-10 magnitudes.
      // Collection — Radarr / Sonarr / Lidarr library counts.
      if (q.includes('radarr_movie_monitored_total')) return vector([sample({}, '9000')]);
      if (q.includes('radarr_movie_missing_total')) return vector([sample({}, '120')]);
      if (q.includes('radarr_movie_cutoff_unmet_total')) return vector([sample({}, '45')]);
      if (q.includes('radarr_movie_total')) return vector([sample({}, '9564')]);
      if (q.includes('sonarr_series_monitored_total')) return vector([sample({}, '800')]);
      if (q.includes('sonarr_episode_missing_total')) return vector([sample({}, '300')]);
      if (q.includes('sonarr_episode_cutoff_unmet_total')) return vector([sample({}, '60')]);
      if (q.includes('sonarr_episode_total')) return vector([sample({}, '114118')]);
      if (q.includes('lidarr_artists_monitored_total')) return vector([sample({}, '2100')]);
      if (q.includes('lidarr_albums_missing_total')) return vector([sample({}, '500')]);
      if (q.includes('lidarr_albums_total')) return vector([sample({}, '55507')]);
      // Acquisition pipeline — queue depth / grabs-per-hr (rate ×3600) / system-health issues.
      if (q.includes('radarr_queue_total')) return vector([sample({}, '3')]);
      if (q.includes('sonarr_queue_total')) return vector([sample({}, '5')]);
      if (q.includes('lidarr_queue_total')) return vector([sample({}, '2')]);
      if (q.includes('radarr_history_total')) return vector([sample({}, '0')]);
      if (q.includes('sonarr_history_total')) return vector([sample({}, '18')]);
      if (q.includes('lidarr_history_total')) return vector([sample({}, '0')]);
      if (q.includes('radarr_system_health_issues')) return vector([sample({}, '1')]);
      if (q.includes('sonarr_system_health_issues')) return vector([sample({}, '0')]);
      if (q.includes('lidarr_system_health_issues')) return vector([sample({}, '0')]);
      // Download clients — SABnzbd per lane (job), qbittorrent + slskd reachability.
      if (q.includes('sabnzbd_speed_bps'))
        return vector([sample({ job: 'sabnzbd' }, '12000000'), sample({ job: 'sabnzbd-fast' }, '0')]);
      if (q.includes('sabnzbd_downloaded_bytes'))
        return vector([
          sample({ job: 'sabnzbd' }, '848000000000'),
          sample({ job: 'sabnzbd-fast' }, '60000000000'),
        ]);
      if (q.includes('sabnzbd_remaining_bytes'))
        return vector([sample({ job: 'sabnzbd' }, '5000000000'), sample({ job: 'sabnzbd-fast' }, '0')]);
      if (q.includes('sabnzbd_queue_length'))
        return vector([sample({ job: 'sabnzbd' }, '4'), sample({ job: 'sabnzbd-fast' }, '0')]);
      if (q.includes('up{job=~"sabnzbd'))
        return vector([sample({ job: 'sabnzbd' }, '1'), sample({ job: 'sabnzbd-fast' }, '1')]);
      if (q.includes('up{job="qbittorrent"}')) return vector([sample({}, '1')]);
      if (q.includes('qbittorrent_torrents_count')) return vector([sample({}, '12')]);
      if (q.includes('up{job="slskd"}')) return vector([sample({}, '1')]);
      if (q.includes('slskd_enqueue_queue_depth_current')) return vector([sample({}, '0')]);
      // Indexers — Prowlarr fleet + per-indexer response time / query rate.
      if (q.includes('prowlarr_indexer_enabled_total')) return vector([sample({}, '4')]);
      if (q.includes('prowlarr_indexer_unavailable')) return vector([sample({}, '0')]);
      if (q.includes('prowlarr_indexer_average_response_time_ms'))
        return vector([
          sample({ indexer: 'DrunkenSlug' }, '335'),
          sample({ indexer: 'NinjaCentral' }, '225'),
        ]);
      if (q.includes('rate(prowlarr_indexer_queries_total'))
        return vector([sample({ indexer: 'DrunkenSlug' }, '12'), sample({ indexer: 'NinjaCentral' }, '6')]);

      // Unknown query → an empty (but still successful) result set.
      return vector([]);
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
