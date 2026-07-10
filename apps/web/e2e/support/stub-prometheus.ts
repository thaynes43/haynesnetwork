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
      // Cluster CPU / load / memory. The Overview uses the sum()/count()-WRAPPED forms; the Hardware
      // sub-tab (PLAN-019) uses the BARE / `by (instance)` forms folded by the `instance` label. The
      // wrapped forms are matched FIRST so the bare branches below are free for the per-instance fold.
      if (q.includes('count by (instance, cpu)')) return vector([sample({}, '132')]); // Overview total cores
      if (q.includes('count(node_load1)')) return vector([sample({}, '6')]); // Overview node count
      if (q.includes('sum(node_load1)')) return vector([sample({}, '18.5')]); // Overview cluster load
      if (q.includes('sum(node_memory_MemTotal')) return vector([sample({}, '529642733568')]);
      if (q.includes('sum(node_memory_MemAvailable')) return vector([sample({}, '384401444864')]);
      // PLAN-019 / DESIGN-020 — the Hardware node group (per-instance load / cores / memory / temp).
      // haynestower is the NAS (role=nas in the app's fold via the instance name); a k8s node alongside.
      if (q.includes('count by (instance) (node_cpu'))
        return vector([sample({ instance: 'haynestower' }, '24'), sample({ instance: '192.168.40.10:9100' }, '8')]);
      if (q.includes('node_hwmon_temp_celsius'))
        return vector([sample({ instance: 'haynestower' }, '48'), sample({ instance: '192.168.40.10:9100' }, '52')]);
      if (q.includes('node_load1'))
        return vector([sample({ instance: 'haynestower' }, '3.2'), sample({ instance: '192.168.40.10:9100' }, '1.5')]);
      if (q.includes('node_memory_MemTotal'))
        return vector([sample({ instance: 'haynestower' }, '128000000000'), sample({ instance: '192.168.40.10:9100' }, '32000000000')]);
      if (q.includes('node_memory_MemAvailable'))
        return vector([sample({ instance: 'haynestower' }, '64000000000'), sample({ instance: '192.168.40.10:9100' }, '16000000000')]);

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

      // PLAN-020 / DESIGN-019 — the Network sub-tab series (unpoller infra performance + site rollups).
      // Device perf carries name+type (INFRASTRUCTURE labels — no client identity). A pdu is included to
      // prove the read drops non-network gear. All matched by substring; the sum()/max() wrappers keep
      // the substrings intact.
      if (q.includes('cpu_utilization_ratio'))
        return vector([
          sample({ name: 'Westford DMSE', type: 'udm' }, '0.454'),
          sample({ name: 'Switch Pro Max 48 PoE', type: 'usw' }, '0.213'),
          sample({ name: 'USW Aggregation', type: 'usw' }, '0.044'),
          sample({ name: 'Garage U7 Outdoor', type: 'uap' }, '0.032'),
          sample({ name: 'Server Room U7 Pro', type: 'uap' }, '0.016'),
          sample({ name: 'Power Distribution Hi-Density', type: 'pdu' }, '0.025'),
        ]);
      if (q.includes('memory_utilization_ratio'))
        return vector([
          sample({ name: 'Westford DMSE', type: 'udm' }, '0.818'),
          sample({ name: 'Switch Pro Max 48 PoE', type: 'usw' }, '0.401'),
          sample({ name: 'Garage U7 Outdoor', type: 'uap' }, '0.372'),
        ]);
      if (q.includes('load_average_1'))
        return vector([sample({ name: 'Westford DMSE', type: 'udm' }, '1.24')]);
      if (q.includes('speedtest_download')) return vector([sample({}, '1526')]);
      if (q.includes('speedtest_upload')) return vector([sample({}, '312')]);
      if (q.includes('speedtest_latency_seconds')) return vector([sample({}, '0.012')]);
      if (q.includes('unpoller_site_latency_seconds')) return vector([sample({}, '0.008')]);
      if (q.includes('uplink_latency_seconds')) return vector([sample({}, '0')]);
      if (q.includes('unpoller_site_aps')) return vector([sample({}, '7')]);
      if (q.includes('unpoller_site_switches')) return vector([sample({}, '15')]);
      if (q.includes('unpoller_site_gateways')) return vector([sample({}, '1')]);
      if (q.includes('unpoller_site_stations')) return vector([sample({}, '181')]);

      // PLAN-019 / DESIGN-020 — the Hardware sub-tab SMART series. Two smartctl jobs: the NAS
      // (instance="haynestower", role="nas") with the four cache NVMe (the LIVE acceptance state:
      // nvme1+nvme2 = Cache-staging, over rated endurance/FAILED/bit-2 but holding; nvme0+nvme3 =
      // Cache-apps mirror, 57–60% worn) + one in-cluster NVMe. Substring-matched on the metric family.
      const nasDev = (device: string, extra: Record<string, string> = {}) => ({
        instance: 'haynestower',
        device,
        role: 'nas',
        ...extra,
      });
      const clDev = (device: string) => ({ instance: '10.42.0.244:9633', device, namespace: 'observability' });
      if (q.includes('smartctl_device_smart_status'))
        return vector([
          sample(nasDev('nvme0'), '1'),
          sample(nasDev('nvme1'), '0'),
          sample(nasDev('nvme2'), '0'),
          sample(nasDev('nvme3'), '1'),
          sample(clDev('nvme0n1'), '1'),
        ]);
      if (q.includes('smartctl_device_percentage_used'))
        return vector([
          sample(nasDev('nvme0'), '57'),
          sample(nasDev('nvme1'), '100'),
          sample(nasDev('nvme2'), '100'),
          sample(nasDev('nvme3'), '60'),
          sample(clDev('nvme0n1'), '25'),
        ]);
      if (q.includes('smartctl_device_temperature'))
        return vector([sample(nasDev('nvme0'), '55'), sample(nasDev('nvme1'), '58'), sample(clDev('nvme0n1'), '40')]);
      if (q.includes('smartctl_device_media_errors'))
        return vector([
          sample(nasDev('nvme0'), '0'),
          sample(nasDev('nvme1'), '0'),
          sample(nasDev('nvme2'), '0'),
          sample(nasDev('nvme3'), '0'),
          sample(clDev('nvme0n1'), '0'),
        ]);
      if (q.includes('smartctl_device_available_spare_threshold'))
        return vector([
          sample(nasDev('nvme0'), '5'),
          sample(nasDev('nvme1'), '5'),
          sample(nasDev('nvme2'), '5'),
          sample(nasDev('nvme3'), '5'),
          sample(clDev('nvme0n1'), '5'),
        ]);
      if (q.includes('smartctl_device_available_spare'))
        return vector([
          sample(nasDev('nvme0'), '100'),
          sample(nasDev('nvme1'), '100'),
          sample(nasDev('nvme2'), '100'),
          sample(nasDev('nvme3'), '100'),
          sample(clDev('nvme0n1'), '100'),
        ]);
      if (q.includes('smartctl_device_critical_warning'))
        return vector([
          sample(nasDev('nvme0'), '0'),
          sample(nasDev('nvme1'), '4'),
          sample(nasDev('nvme2'), '4'),
          sample(nasDev('nvme3'), '0'),
        ]);
      if (q.includes('smartctl_device_power_on_seconds'))
        return vector([sample(nasDev('nvme0'), '18360000'), sample(nasDev('nvme1'), '18360000')]);
      if (q.includes('smartctl_device_capacity_bytes'))
        return vector([sample(nasDev('nvme0'), '2000000000000')]);
      if (q.includes('smartctl_device'))
        return vector([
          sample(nasDev('nvme0', { model_name: 'CT2000P3PSSD8', serial_number: '2331E865B710' }), '1'),
          sample(nasDev('nvme1', { model_name: 'CT2000P3PSSD8', serial_number: '2331E865B76D' }), '1'),
          sample(nasDev('nvme2', { model_name: 'CT2000P3PSSD8', serial_number: '2331E865B74C' }), '1'),
          sample(nasDev('nvme3', { model_name: 'CT2000P3PSSD8', serial_number: '2331E865B742' }), '1'),
        ]);

      // PLAN-019 / DESIGN-020 — the Proxmox showcase (prometheus-pve-exporter). Two nodes + guests,
      // folded by the `id` label (node/NAME, qemu/NNN, lxc/NNN).
      if (q.includes('pve_node_info'))
        return vector([
          sample({ id: 'node/HaynesIntelligence', name: 'HaynesIntelligence' }, '1'),
          sample({ id: 'node/twin-top', name: 'twin-top' }, '1'),
        ]);
      if (q.includes('pve_guest_info'))
        return vector([
          sample({ id: 'qemu/100', node: 'HaynesIntelligence', name: 'plex-vm', type: 'qemu', vmid: '100' }, '1'),
          sample({ id: 'lxc/101', node: 'HaynesIntelligence', name: 'nginx-lxc', type: 'lxc', vmid: '101' }, '1'),
          sample({ id: 'qemu/200', node: 'twin-top', name: 'k8s-worker', type: 'qemu', vmid: '200' }, '1'),
        ]);
      if (q.includes('pve_up'))
        return vector([
          sample({ id: 'node/HaynesIntelligence' }, '1'),
          sample({ id: 'node/twin-top' }, '1'),
          sample({ id: 'qemu/100' }, '1'),
          sample({ id: 'lxc/101' }, '0'),
          sample({ id: 'qemu/200' }, '1'),
        ]);
      if (q.includes('pve_cpu_usage_ratio'))
        return vector([
          sample({ id: 'node/HaynesIntelligence' }, '0.35'),
          sample({ id: 'node/twin-top' }, '0.12'),
          sample({ id: 'qemu/100' }, '0.10'),
          sample({ id: 'qemu/200' }, '0.28'),
        ]);
      if (q.includes('pve_memory_usage_bytes'))
        return vector([
          sample({ id: 'node/HaynesIntelligence' }, '64000000000'),
          sample({ id: 'node/twin-top' }, '20000000000'),
          sample({ id: 'qemu/100' }, '8000000000'),
        ]);
      if (q.includes('pve_memory_size_bytes'))
        return vector([
          sample({ id: 'node/HaynesIntelligence' }, '256000000000'),
          sample({ id: 'node/twin-top' }, '64000000000'),
          sample({ id: 'qemu/100' }, '16000000000'),
        ]);
      if (q.includes('pve_uptime_seconds'))
        return vector([sample({ id: 'node/HaynesIntelligence' }, '1080000'), sample({ id: 'node/twin-top' }, '540000')]);

      // Unknown query → an empty (but still successful) result set.
      return vector([]);
    }

    if (url.pathname === '/api/v1/query_range') {
      if (mode === 'down') return json(500, { status: 'error', error: 'stub prometheus is down' });
      const start = Number(url.searchParams.get('start'));
      const end = Number(url.searchParams.get('end'));
      const step = Number(url.searchParams.get('step'));
      const rangeQuery = url.searchParams.get('query') ?? '';
      if (![start, end, step].every(Number.isFinite) || step <= 0 || end < start) {
        return json(400, { status: 'error', error: 'bad range params' });
      }
      // PLAN-020 / DESIGN-019 — the Network sub-tab's WAN throughput history sparkline. The app issues a
      // range query for sum(unpoller_site_{transmit,receive}_rate_bytes{subsystem="wan"}); synthesize a
      // deterministic diurnal-ish bytes/sec series (transmit ~10× smaller than receive, like a home WAN).
      if (rangeQuery.includes('rate_bytes')) {
        const isUpload = rangeQuery.includes('transmit_rate_bytes');
        const baseBytes = isUpload ? 1_400_000 : 12_000_000; // ~11 Mbps up / ~96 Mbps down
        const values: [number, string][] = [];
        for (let t = start; t <= end; t += step) {
          // deterministic in t: a smooth wave so the sparkline has visible shape across any window.
          const wave = 0.6 + 0.4 * Math.sin(t / 21_600); // period ~6h
          values.push([t, String(Math.round(baseBytes * wave))]);
        }
        const name = isUpload
          ? 'unpoller_site_transmit_rate_bytes'
          : 'unpoller_site_receive_rate_bytes';
        return json(200, {
          status: 'success',
          data: { resultType: 'matrix', result: [{ metric: { __name__: name, subsystem: 'wan' }, values }] },
        });
      }
      // PLAN-019 / DESIGN-020 — the Hardware NVMe-endurance wear history. Scraping only just started, so
      // there is not yet enough history to fit a wear-rate projection ⇒ answer an EMPTY matrix, which the
      // read model renders gracefully as "insufficient history yet" (the live acceptance state).
      if (rangeQuery.includes('smartctl_device_percentage_used')) {
        return json(200, { status: 'success', data: { resultType: 'matrix', result: [] } });
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
